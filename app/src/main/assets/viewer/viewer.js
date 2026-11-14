import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('c');
const post = (m) => { try { window.AndroidBridge && window.AndroidBridge.post(JSON.stringify(m)); } catch (e) {} };
window.addEventListener('error', e => post({ type: 'error', text: String(e.message) }));

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const BG_DARK = 0x141922, BG_LIGHT = 0xeef1f5;
scene.background = new THREE.Color(BG_DARK);

const persp = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
let camera = persp, halfH = 1;
for (const c of [persp, ortho]) { c.up.set(0, 0, 1); c.position.set(1, -1, 0.8); }

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.rotateSpeed = 0.85;
controls.panSpeed = 0.9;

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
scene.add(new THREE.HemisphereLight(0xffffff, 0x30363f, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.7); scene.add(key);
const fill = new THREE.DirectionalLight(0x8ab4ff, 0.6); fill.position.set(-1, 1, -1); scene.add(fill);

let grid = null;
const axes = new THREE.AxesHelper(1); axes.visible = false; scene.add(axes);
const modelRoot = new THREE.Group(); scene.add(modelRoot);
const measureRoot = new THREE.Group(); scene.add(measureRoot);
const sectionRoot = new THREE.Group(); scene.add(sectionRoot);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x0c1016 });

let parts = [];
let radius = 1, triCount = 0, dims = [0, 0, 0], half = [1, 1, 1];
let wireOn = false, edgesOn = false, orthoOn = false, gridOn = false, darkOn = true;
let deflection = 0.001, mode = 'select', selected = -1;
let measures = [], measId = 1, pendingPoint = null, pendingMarker = null;
let originalStepText = null;
let sectionState = { show: true, axis: 'x', x: { on: false, off: 0, flip: false }, y: { on: false, off: 0, flip: false }, z: { on: false, off: 0, flip: false } };
const AX = { x: 0, y: 1, z: 2 };

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = (async () => {
      let factory = window.occtimportjs;
      if (typeof factory !== 'function') {
        const mod = await import('./lib/occt-import-js.js');
        factory = mod.default || window.occtimportjs;
      }
      if (typeof factory !== 'function') throw new Error('Не удалось загрузить ядро OpenCascade.');
      return await factory({ locateFile: (f) => new URL('lib/' + f, document.baseURI).href });
    })();
  }
  return occtPromise;
}
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

async function open(url, name) {
  try {
    post({ type: 'status', text: 'Чтение файла…' }); await nextFrame();
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error('Не удалось прочитать файл (' + resp.status + ')');
    const data = new Uint8Array(await resp.arrayBuffer());
    const ext = (name.split('.').pop() || '').toLowerCase();
    originalStepText = (ext === 'step' || ext === 'stp') ? new TextDecoder('utf-8').decode(data) : null;
    post({ type: 'status', text: 'Запуск ядра OpenCascade…' }); await nextFrame();
    const occt = await getOcct();
    post({ type: 'status', text: 'Разбор геометрии и триангуляция…' }); await nextFrame();
    const t0 = performance.now();
    const fn = (ext === 'igs' || ext === 'iges') ? 'ReadIgesFile' : (ext === 'brep') ? 'ReadBrepFile' : 'ReadStepFile';
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: deflection, angularDeflection: 0.5 };
    const reader = occt[fn];
    let res;
    try { res = reader.call(occt, data, params); } catch (e) { res = reader.call(occt, data, null); }
    if (!res || !res.success || !res.meshes || !res.meshes.length) throw new Error('В файле не найдена геометрия либо формат не поддерживается.');
    build(res);
    post({ type: 'loaded', parts: parts.map(p => p.name), triangles: triCount, bbox: dims, time: performance.now() - t0 });
    postMeasures(); postState();
  } catch (err) { post({ type: 'error', text: (err && err.message) ? err.message : String(err) }); }
}

function build(res) {
  clearModel();
  const g = new THREE.Group(); triCount = 0;
  res.meshes.forEach((m, i) => {
    const pos = m.attributes && m.attributes.position && m.attributes.position.array;
    if (!pos || pos.length < 9) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const nrm = m.attributes.normal && m.attributes.normal.array;
    if (nrm && nrm.length === pos.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); else geo.computeVertexNormals();
    const idx = m.index && m.index.array;
    if (idx && idx.length) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    const color = new THREE.Color(0x9fb0c0);
    if (m.color && m.color.length >= 3) color.setRGB(m.color[0], m.color[1], m.color[2], THREE.SRGBColorSpace);
    const mat = new THREE.MeshPhongMaterial({ color, specular: 0x2a2a2a, shininess: 28, side: THREE.DoubleSide, wireframe: wireOn });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = (m.name && m.name.trim()) ? m.name : 'Деталь ' + (i + 1);
    g.add(mesh);
    const tris = (idx ? idx.length : pos.length / 3) / 3;
    parts.push({ mesh, name: mesh.name, baseColor: '#' + color.getHexString(), edges: null, visible: true, tris });
    triCount += tris;
  });
  if (!parts.length) throw new Error('Не удалось построить ни одной поверхности.');
  const box = new THREE.Box3().setFromObject(g);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  g.position.sub(center);
  modelRoot.add(g);
  dims = [size.x, size.y, size.z]; half = [size.x / 2, size.y / 2, size.z / 2];
  radius = Math.max(size.length() / 2, 1e-3); triCount = Math.round(triCount);
  makeGrid(radius * 3); makeSectionVisuals(); rebuildSection();
  if (edgesOn) applyEdges();
  fit(new THREE.Vector3(1, -1, 0.8));
}

function clearModel() {
  selected = -1; clearMeasures(true);
  modelRoot.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== edgeMat) o.material.dispose(); });
  modelRoot.clear(); parts = []; triCount = 0;
}

function ensureEdges(p) {
  if (p.edges) return;
  if (p.tris > 400000) { post({ type: 'toast', text: 'Слишком много граней для рёбер: ' + p.name }); return; }
  p.edges = new THREE.LineSegments(new THREE.EdgesGeometry(p.mesh.geometry, 25), edgeMat);
  p.mesh.add(p.edges);
}
function applyEdges() { parts.forEach(p => { if (edgesOn) ensureEdges(p); if (p.edges) p.edges.visible = edgesOn; }); }

function makeGrid(size) {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  const s = Math.max(size, 1);
  grid = new THREE.GridHelper(s, 20, 0x3a4656, 0x232c38);
  grid.rotation.x = Math.PI / 2; grid.visible = gridOn; scene.add(grid);
  axes.scale.setScalar(s / 4); axes.visible = gridOn;
}

const VIEWS = { iso: [1, -1, 0.8], front: [0, -1, 0.0001], back: [0, 1, 0.0001], top: [0, -0.0001, 1], bottom: [0, 0.0001, -1], right: [1, 0, 0.0001], left: [-1, 0, 0.0001] };
function fit(dirVec) {
  if (!parts.length) return;
  const dir = (dirVec ? dirVec.clone() : camera.position.clone().sub(controls.target));
  if (dir.lengthSq() < 1e-12) dir.set(1, -1, 0.8);
  dir.normalize();
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(persp.fov) / 2) * 1.15;
  controls.target.set(0, 0, 0);
  persp.position.copy(dir).multiplyScalar(dist); ortho.position.copy(dir).multiplyScalar(dist);
  persp.near = Math.max(dist / 5000, 0.001); persp.far = dist * 20 + radius * 20; persp.updateProjectionMatrix();
  ortho.near = -dist * 20; ortho.far = dist * 20; ortho.zoom = 1; halfH = radius * 1.15;
  resize(); controls.update();
}
function resize() {
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  const a = w / Math.max(h, 1);
  persp.aspect = a; persp.updateProjectionMatrix();
  ortho.left = -halfH * a; ortho.right = halfH * a; ortho.top = halfH; ortho.bottom = -halfH; ortho.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
function tick() { requestAnimationFrame(tick); if (document.hidden) return; controls.update(); key.position.copy(camera.position); renderer.render(scene, camera); }
resize(); tick();

const raycaster = new THREE.Raycaster();
function ndc(cx, cy) { const r = canvas.getBoundingClientRect(); return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); }
function surfaceHit(cx, cy) {
  if (!parts.length) return null;
  raycaster.setFromCamera(ndc(cx, cy), camera);
  const hits = raycaster.intersectObjects(parts.filter(p => p.visible).map(p => p.mesh), false);
  return hits.length ? hits[0] : null;
}
function clearSelection() { if (selected >= 0 && parts[selected]) parts[selected].mesh.material.emissive.setHex(0x000000); selected = -1; post({ type: 'deselect' }); }
function selectPart(i) {
  if (i < 0 || i >= parts.length) return;
  if (selected >= 0 && parts[selected]) parts[selected].mesh.material.emissive.setHex(0x000000);
  selected = i; parts[i].mesh.material.emissive.setHex(0x1a3f7a);
  post({ type: 'select', index: i, name: parts[i].name, color: '#' + parts[i].mesh.material.color.getHexString() });
}

function makeMarker(pt, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.014, 14, 10), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.copy(pt); m.renderOrder = 999; return m;
}
function makeLabel(text, pt) {
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 110;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(16,21,28,0.92)'; ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.roundRect(4, 4, 312, 102, 18); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fde68a'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 160, 57);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.position.copy(pt); sp.scale.set(radius * 0.34, radius * 0.117, 1); sp.renderOrder = 1000; return sp;
}
function fmtDist(d) { return d >= 1000 ? (d / 1000).toFixed(3) + ' м' : d.toFixed(2) + ' мм'; }
function createMeasure(a, b, id) {
  const d = a.distanceTo(b);
  const grp = new THREE.Group();
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false }));
  line.renderOrder = 998;
  grp.add(line, makeMarker(a, 0xfbbf24), makeMarker(b, 0xfbbf24), makeLabel(fmtDist(d), a.clone().add(b).multiplyScalar(0.5)));
  measureRoot.add(grp);
  measures.push({ id, a: a.clone(), b: b.clone(), d, grp });
}
function addMeasurePoint(pt) {
  if (!pendingPoint) { pendingPoint = pt.clone(); pendingMarker = makeMarker(pt, 0xfbbf24); measureRoot.add(pendingMarker); post({ type: 'measureHint', text: 'Тапните вторую точку' }); return; }
  createMeasure(pendingPoint, pt.clone(), measId++);
  if (pendingMarker) { measureRoot.remove(pendingMarker); pendingMarker.geometry.dispose(); pendingMarker.material.dispose(); }
  pendingPoint = null; pendingMarker = null;
  post({ type: 'measureHint', text: 'Тапните первую точку следующего измерения' });
  postMeasures(); postState();
}
function deleteMeasure(id) {
  const m = measures.find(x => x.id === id); if (!m) return;
  measureRoot.remove(m.grp); m.grp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  measures = measures.filter(x => x.id !== id); postMeasures(); postState();
}
function clearMeasures(silent) {
  measures.forEach(m => { measureRoot.remove(m.grp); m.grp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); });
  measures = []; if (pendingMarker) { measureRoot.remove(pendingMarker); pendingMarker.geometry.dispose(); pendingMarker.material.dispose(); }
  pendingPoint = null; pendingMarker = null;
  if (!silent) { postMeasures(); postState(); }
}
function postMeasures() { post({ type: 'measures', list: measures.map(m => ({ id: m.id, d: m.d })) }); }

function makeSectionVisuals() {
  sectionRoot.clear();
  const s = radius * 2.6;
  for (const ax of ['x', 'y', 'z']) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s, s), mat);
    const border = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: 0.85 }));
    mesh.add(border); mesh.userData.axis = ax; sectionRoot.add(mesh);
  }
}
function rebuildSection() {
  const planes = [];
  for (const ax of ['x', 'y', 'z']) {
    const st = sectionState[ax]; if (!st.on) continue;
    const o = st.off * half[AX[ax]];
    const n = new THREE.Vector3(); n[ax] = st.flip ? 1 : -1;
    planes.push(new THREE.Plane(n, st.flip ? -o : o));
  }
  parts.forEach(p => { p.mesh.material.clippingPlanes = planes; p.mesh.material.clipShadows = true; p.mesh.material.needsUpdate = true; });
  edgeMat.clippingPlanes = planes; edgeMat.needsUpdate = true;
  sectionRoot.children.forEach(mesh => {
    const ax = mesh.userData.axis, st = sectionState[ax], o = st.off * half[AX[ax]];
    mesh.visible = sectionState.show && st.on;
    mesh.position.set(0, 0, 0); mesh.rotation.set(0, 0, 0);
    if (ax === 'x') { mesh.rotation.y = Math.PI / 2; mesh.position.x = o; }
    else if (ax === 'y') { mesh.rotation.x = -Math.PI / 2; mesh.position.y = o; }
    else { mesh.position.z = o; }
  });
}

const active = new Set();
let multi = false, tapOk = false, tapT = 0, tapX = 0, tapY = 0, lastTap = 0, pickTimer = 0;
canvas.addEventListener('pointerdown', e => { active.add(e.pointerId); if (active.size === 1) { multi = false; tapOk = true; tapT = Date.now(); tapX = e.clientX; tapY = e.clientY; } else { multi = true; tapOk = false; clearTimeout(pickTimer); } });
canvas.addEventListener('pointermove', e => { if (tapOk && (Math.abs(e.clientX - tapX) > 12 || Math.abs(e.clientY - tapY) > 12)) tapOk = false; });
canvas.addEventListener('pointerup', e => {
  active.delete(e.pointerId);
  const wasTap = tapOk && !multi && active.size === 0 && (Date.now() - tapT) < 300;
  if (active.size === 0) { tapOk = false; multi = false; }
  if (!wasTap) return;
  const now = Date.now(), x = e.clientX, y = e.clientY;
  if (mode === 'measure') { const h = surfaceHit(x, y); if (h) addMeasurePoint(h.point); return; }
  if (now - lastTap < 320) { clearTimeout(pickTimer); lastTap = 0; fit(); }
  else { lastTap = now; clearTimeout(pickTimer); pickTimer = setTimeout(() => { const h = surfaceHit(x, y); if (!h) { clearSelection(); return; } selectPart(parts.findIndex(p => p.mesh === h.object)); }, 240); }
});
canvas.addEventListener('pointercancel', e => { active.delete(e.pointerId); tapOk = false; if (active.size === 0) multi = false; });

let stateTimer = 0;
function gatherState() {
  const colors = {}, hidden = [];
  parts.forEach((p, i) => { const hex = '#' + p.mesh.material.color.getHexString(); if (hex !== p.baseColor) colors[i] = hex; if (!p.visible) hidden.push(i); });
  return { v: 1, colors, hidden, section: sectionState, measures: measures.map(m => ({ id: m.id, a: m.a.toArray(), b: m.b.toArray(), d: m.d })), cam: { pos: camera.position.toArray(), target: controls.target.toArray(), ortho: orthoOn, zoom: ortho.zoom, halfH } };
}
function postState() { clearTimeout(stateTimer); stateTimer = setTimeout(() => post({ type: 'state', state: gatherState() }), 350); }
controls.addEventListener('change', postState);
function applyState(s) {
  try {
    if (!s || typeof s !== 'object') return;
    if (s.colors) Object.keys(s.colors).forEach(k => { const i = +k; if (parts[i]) parts[i].mesh.material.color.set(s.colors[k]); });
    const hid = new Set(s.hidden || []);
    parts.forEach((p, i) => { p.visible = !hid.has(i); p.mesh.visible = p.visible; });
    if (s.section) { sectionState = Object.assign(sectionState, s.section); rebuildSection(); }
    clearMeasures(true);
    if (s.measures) s.measures.forEach(m => { createMeasure(new THREE.Vector3().fromArray(m.a), new THREE.Vector3().fromArray(m.b), m.id || measId++); measId = Math.max(measId, (m.id || 0) + 1); });
    if (s.cam) {
      orthoOn = !!s.cam.ortho; camera = orthoOn ? ortho : persp; controls.object = camera;
      camera.position.fromArray(s.cam.pos); controls.target.fromArray(s.cam.target);
      if (s.cam.halfH) halfH = s.cam.halfH; if (s.cam.zoom) ortho.zoom = s.cam.zoom;
      resize(); controls.update();
    }
    if (selected >= 0 && parts[selected] && !parts[selected].visible) clearSelection();
    postMeasures(); postState();
  } catch (e) { post({ type: 'toast', text: 'Не удалось применить сохранённое состояние' }); }
}
function resetEdits() {
  parts.forEach(p => { p.mesh.material.color.set(p.baseColor); p.visible = true; p.mesh.visible = true; });
  clearSelection(); clearMeasures(true);
  sectionState = { show: true, axis: 'x', x: { on: false, off: 0, flip: false }, y: { on: false, off: 0, flip: false }, z: { on: false, off: 0, flip: false } };
  rebuildSection(); postMeasures(); postState();
}

function sendBytes(bytes, kind) {
  const CH = 96 * 1024, n = Math.ceil(bytes.length / CH);
  for (let s = 0; s < n; s++) {
    const slice = bytes.subarray(s * CH, (s + 1) * CH);
    let bin = ''; for (let i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
    post({ type: kind + 'Chunk', seq: s, total: n, data: btoa(bin) });
  }
}

function exportSTL() {
  const meshes = parts.filter(p => p.visible).map(p => p.mesh);
  let total = 0; meshes.forEach(m => { const g = m.geometry; total += (g.index ? g.index.count : g.attributes.position.count) / 3; });
  if (!total) { post({ type: 'toast', text: 'Нет видимых деталей для экспорта' }); return; }
  if (total > 600000) { post({ type: 'toast', text: 'Экспорт ограничен: >600k треугольников. Скройте лишние детали.' }); return; }
  const buf = new ArrayBuffer(84 + total * 50), dv = new DataView(buf);
  dv.setUint32(80, total, true);
  let off = 84;
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), cb = new THREE.Vector3(), ab = new THREE.Vector3();
  meshes.forEach(m => {
    m.updateWorldMatrix(true, false);
    const pos = m.geometry.attributes.position, idx = m.geometry.index, mw = m.matrixWorld;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      vA.fromBufferAttribute(pos, a).applyMatrix4(mw); vB.fromBufferAttribute(pos, b).applyMatrix4(mw); vC.fromBufferAttribute(pos, c).applyMatrix4(mw);
      cb.subVectors(vC, vB); ab.subVectors(vA, vB); cb.cross(ab).normalize();
      dv.setFloat32(off, cb.x, true); dv.setFloat32(off + 4, cb.y, true); dv.setFloat32(off + 8, cb.z, true); off += 12;
      for (const v of [vA, vB, vC]) { dv.setFloat32(off, v.x, true); dv.setFloat32(off + 4, v.y, true); dv.setFloat32(off + 8, v.z, true); off += 12; }
      dv.setUint16(off, 0, true); off += 2;
    }
  });
  sendBytes(new Uint8Array(buf), 'stl');
  post({ type: 'stlDone', tris: total });
}

// ---------- запись цветов в исходный STEP ----------
function splitStepParams(s) {
  const out = []; let depth = 0, inStr = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { cur += ch; if (ch === "'") { if (s[i + 1] === "'") { cur += s[i + 1]; i++; } else inStr = false; } continue; }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function stepRef(p) { const m = /^#(\d+)$/.exec((p || '').trim()); return m ? +m[1] : null; }
function stepStr(p) { return (p || '').trim().replace(/^'|'$/g, '').replace(/''/g, "'"); }
function parseStepEntities(text) {
  const entities = new Map(); let i = 0, maxId = 0;
  while (i < text.length) {
    const h = text.indexOf('#', i); if (h < 0) break;
    let j = h + 1, idStr = '';
    while (j < text.length && text[j] >= '0' && text[j] <= '9') { idStr += text[j]; j++; }
    if (!idStr) { i = h + 1; continue; }
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== '=') { i = j; continue; }
    j++;
    const start = j; let inStr = false, k = j;
    while (k < text.length) {
      const ch = text[k];
      if (inStr) { if (ch === "'") { if (text[k + 1] === "'") { k += 2; continue; } inStr = false; } k++; continue; }
      if (ch === "'") { inStr = true; k++; continue; }
      if (ch === ';') break;
      k++;
    }
    if (k >= text.length) break;
    const body = text.slice(start, k).trim();
    const m = /^([A-Za-z0-9_]+)\s*\(/.exec(body);
    if (m) {
      const id = +idStr;
      const params = body.slice(m[0].length, body.lastIndexOf(')'));
      entities.set(id, { id, type: m[1].toUpperCase(), params, raw: text.slice(h, k + 1) });
      if (id > maxId) maxId = id;
    }
    i = k + 1;
  }
  return { entities, maxId };
}
function buildEditedStep(text) {
  const parsed = parseStepEntities(text);
  const entities = parsed.entities;
  const products = new Map(), pdf = new Map(), pd = new Map(), pds = new Map(), sdr = [];
  for (const e of entities.values()) {
    const ps = splitStepParams(e.params);
    if (e.type === 'PRODUCT') products.set(e.id, stepStr(ps[1]));
    else if (e.type === 'PRODUCT_DEFINITION_FORMATION') pdf.set(e.id, stepRef(ps[2]));
    else if (e.type === 'PRODUCT_DEFINITION') pd.set(e.id, stepRef(ps[2]));
    else if (e.type === 'PRODUCT_DEFINITION_SHAPE') pds.set(e.id, stepRef(ps[2]));
    else if (e.type === 'SHAPE_DEFINITION_REPRESENTATION') sdr.push({ def: stepRef(ps[0]), rep: stepRef(ps[1]) });
  }
  const nameToRep = new Map();
  for (const r of sdr) {
    const pdId = pds.get(r.def); if (pdId == null) continue;
    const formId = pd.get(pdId); if (formId == null) continue;
    const prodId = pdf.get(formId); if (prodId == null) continue;
    const name = products.get(prodId); if (name == null) continue;
    if (!nameToRep.has(name)) nameToRep.set(name, r.rep);
  }
  const targets = new Map();
  for (const p of parts) {
    if (!p.visible) continue;
    const hex = '#' + p.mesh.material.color.getHexString();
    const rep = nameToRep.get(p.name);
    if (rep == null) continue;
    if (!targets.has(rep)) targets.set(rep, hex);
  }
  if (!targets.size) return null;
  let out = text;
  for (const e of entities.values()) {
    if (e.type !== 'STYLED_ITEM') continue;
    const ps = splitStepParams(e.params);
    const target = stepRef(ps[ps.length - 1]);
    if (target != null && targets.has(target)) out = out.replace(e.raw, '');
  }
  let id = parsed.maxId;
  const add = [];
  for (const [rep, hex] of targets) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const c = ++id, fac = ++id, fa = ++id, ssfa = ++id, sss = ++id, ssu = ++id, psa = ++id, si = ++id;
    add.push('#' + c + " = COLOUR_RGB(''," + r.toFixed(6) + ',' + g.toFixed(6) + ',' + b.toFixed(6) + ');');
    add.push('#' + fac + " = FILL_AREA_STYLE_COLOUR('',#" + c + ');');
    add.push('#' + fa + " = FILL_AREA_STYLE('',(#" + fac + '));');
    add.push('#' + ssfa + ' = SURFACE_STYLE_FILL_AREA(#' + fa + ');');
    add.push('#' + sss + " = SURFACE_SIDE_STYLE('',(#" + ssfa + '));');
    add.push('#' + ssu + ' = SURFACE_STYLE_USAGE(.BOTH.,#' + sss + ');');
    add.push('#' + psa + ' = PRESENTATION_STYLE_ASSIGNMENT((#' + ssu + '));');
    add.push('#' + si + " = STYLED_ITEM('',(#" + psa + '),#' + rep + ');');
  }
  const endIdx = out.indexOf('END-ISO-10303-21');
  const secIdx = out.lastIndexOf('ENDSEC;', endIdx < 0 ? out.length : endIdx);
  if (secIdx < 0) return null;
  out = out.slice(0, secIdx) + '\n' + add.join('\n') + '\n' + out.slice(secIdx);
  return { text: out, matched: targets.size };
}
function exportStepEdited() {
  if (!originalStepText) { post({ type: 'toast', text: 'Запись в STEP доступна только для исходных .step/.stp' }); return; }
  let result;
  try { result = buildEditedStep(originalStepText); } catch (e) { result = null; }
  if (!result) { post({ type: 'toast', text: 'Не удалось сопоставить детали с именем продукта в STEP. Цвета сохранены в проекте JSON.' }); return; }
  sendBytes(new TextEncoder().encode(result.text), 'step');
  post({ type: 'stepDone', matched: result.matched });
}

window.SV = {
  open, clear: clearModel, fit: () => fit(),
  setView: k => { const v = VIEWS[k] || VIEWS.iso; fit(new THREE.Vector3(v[0], v[1], v[2])); },
  setWireframe: on => { wireOn = !!on; parts.forEach(p => p.mesh.material.wireframe = wireOn); },
  setEdges: on => { edgesOn = !!on; applyEdges(); },
  setOrtho: on => { orthoOn = !!on; const n = orthoOn ? ortho : persp; if (n !== camera) { n.position.copy(camera.position); n.up.copy(camera.up); camera = n; controls.object = camera; controls.update(); } postState(); },
  setGrid: on => { gridOn = !!on; if (grid) grid.visible = gridOn; axes.visible = gridOn; },
  setDark: on => { darkOn = !!on; scene.background = new THREE.Color(darkOn ? BG_DARK : BG_LIGHT); },
  setQuality: v => { deflection = Number(v) || 0.001; },
  setPartsVisible: arr => { parts.forEach((p, i) => { p.visible = arr[i] !== false; p.mesh.visible = p.visible; }); if (selected >= 0 && parts[selected] && !parts[selected].visible) clearSelection(); postState(); },
  clearSelection,
  setColor: hex => { if (selected < 0 || !parts[selected]) return; parts[selected].mesh.material.color.set(hex); post({ type: 'color', index: selected, color: hex }); postState(); },
  setMode: m => { mode = m === 'measure' ? 'measure' : 'select'; if (mode !== 'measure' && pendingMarker) { measureRoot.remove(pendingMarker); pendingMarker.geometry.dispose(); pendingMarker.material.dispose(); pendingPoint = null; pendingMarker = null; } post({ type: 'measureHint', text: mode === 'measure' ? 'Тапните первую точку' : '' }); },
  setSection: s => { sectionState = Object.assign(sectionState, s || {}); rebuildSection(); postState(); },
  clearMeasures: () => clearMeasures(false),
  deleteMeasure,
  requestState: () => post({ type: 'state', state: gatherState() }),
  applyState, resetEdits, exportSTL, exportStepEdited
};
post({ type: 'ready' });
