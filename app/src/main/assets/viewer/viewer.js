import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('c');
const post = (m) => { try { window.AndroidBridge && window.AndroidBridge.post(JSON.stringify(m)); } catch (e) {} };
window.addEventListener('error', e => post({ type: 'error', text: String(e.message) }));
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };

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
controls.enableDamping = true; controls.dampingFactor = 0.12;
controls.rotateSpeed = 0.85; controls.panSpeed = 0.9;

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
scene.add(new THREE.HemisphereLight(0xffffff, 0x30363f, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.7); scene.add(key);
const fill = new THREE.DirectionalLight(0x8ab4ff, 0.6); fill.position.set(-1, 1, -1); scene.add(fill);

let grid = null;
const axes = new THREE.AxesHelper(1); axes.visible = false; scene.add(axes);
const modelRoot = new THREE.Group(); scene.add(modelRoot);
const measureRoot = new THREE.Group(); scene.add(measureRoot);
const pointRoot = new THREE.Group(); scene.add(pointRoot);
const sectionRoot = new THREE.Group(); scene.add(sectionRoot);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x0c1016 });

let parts = [], origToPart = [], treeData = null, modelName = 'model.step';
let radius = 1, triCount = 0, dims = [0, 0, 0], half = [1, 1, 1];
let modelOffset = new THREE.Vector3();
let wireOn = false, edgesOn = false, orthoOn = false, gridOn = false, darkOn = true, snapOn = true;
let deflection = 0.001, mode = 'select', selected = -1, treeOpen = false;
let measures = [], measId = 1, pendingPoint = null, pendingKind = 'surface', pendingMarker = null;
let points = [], pointId = 1, lastPoint = null;
let treeSel = new Set(), collapsed = new Set();
let sectionState = { show: true, axis: 'x', x: { on: false, off: 0, flip: false }, y: { on: false, off: 0, flip: false }, z: { on: false, off: 0, flip: false } };
const AX = { x: 0, y: 1, z: 2 };
const kindColor = k => k === 'vertex' ? 0x22c55e : k === 'edge' ? 0x38bdf8 : 0xfbbf24;
const kindRu = k => k === 'vertex' ? 'Вершина' : k === 'edge' ? 'Ребро' : 'Поверхность';
const kindShort = k => k === 'vertex' ? 'В' : k === 'edge' ? 'Р' : 'П';

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = (async () => {
      let factory = window.occtimportjs;
      if (typeof factory !== 'function') { const mod = await import('./lib/occt-import-js.js'); factory = mod.default || window.occtimportjs; }
      if (typeof factory !== 'function') throw new Error('Не удалось загрузить ядро OpenCascade.');
      return await factory({ locateFile: (f) => new URL('lib/' + f, document.baseURI).href });
    })();
  }
  return occtPromise;
}
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

async function open(url, name) {
  try {
    modelName = name || 'model.step';
    post({ type: 'status', text: 'Чтение файла…' }); await nextFrame();
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error('Не удалось прочитать файл (' + resp.status + ')');
    const data = new Uint8Array(await resp.arrayBuffer());
    post({ type: 'status', text: 'Запуск ядра OpenCascade…' }); await nextFrame();
    const occt = await getOcct();
    post({ type: 'status', text: 'Разбор геометрии и триангуляция…' }); await nextFrame();
    const t0 = performance.now();
    const ext = (name.split('.').pop() || '').toLowerCase();
    const fn = (ext === 'igs' || ext === 'iges') ? 'ReadIgesFile' : (ext === 'brep') ? 'ReadBrepFile' : 'ReadStepFile';
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: deflection, angularDeflection: 0.5 };
    const reader = occt[fn];
    let res;
    try { res = reader.call(occt, data, params); } catch (e) { res = reader.call(occt, data, null); }
    if (!res || !res.success || !res.meshes || !res.meshes.length) throw new Error('В файле не найдена геометрия либо формат не поддерживается.');
    build(res, name);
    post({ type: 'loaded', parts: parts.map(p => p.name), triangles: triCount, bbox: dims, time: performance.now() - t0, tree: !!treeData });
    postMeasures(); postPoints(); postVisibility(); postState();
  } catch (err) { post({ type: 'error', text: (err && err.message) ? err.message : String(err) }); }
}

function build(res, name) {
  clearModel();
  const g = new THREE.Group(); triCount = 0; origToPart = [];
  res.meshes.forEach((m, i) => {
    const pos = m.attributes && m.attributes.position && m.attributes.position.array;
    if (!pos || pos.length < 9) { origToPart[i] = -1; return; }
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
    origToPart[i] = parts.length;
    parts.push({ mesh, name: mesh.name, baseColor: '#' + color.getHexString(), edges: null, visible: true, tris });
    triCount += tris;
  });
  if (!parts.length) throw new Error('Не удалось построить ни одной поверхности.');
  const box = new THREE.Box3().setFromObject(g);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  modelOffset.copy(center);
  g.position.sub(center);
  modelRoot.add(g);
  dims = [size.x, size.y, size.z]; half = [size.x / 2, size.y / 2, size.z / 2];
  radius = Math.max(size.length() / 2, 1e-3); triCount = Math.round(triCount);
  treeData = buildTree(res, name);
  makeGrid(radius * 3); makeSectionVisuals(); rebuildSection();
  if (edgesOn) applyEdges();
  fit(new THREE.Vector3(1, -1, 0.8));
  renderTree(); renderPointPanel();
}

function clearModel() {
  selected = -1; treeSel.clear(); collapsed.clear(); treeData = null;
  clearMeasures(true); clearPoints(true);
  modelRoot.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== edgeMat) o.material.dispose(); });
  modelRoot.clear(); parts = []; origToPart = []; triCount = 0;
}

function buildTree(res, name) {
  const conv = (node) => {
    let idx = [];
    const ms = node && node.meshes;
    if (Array.isArray(ms)) for (const m of ms) {
      const oi = typeof m === 'number' ? m : (m && typeof m.index === 'number' ? m.index : -1);
      const pi = origToPart[oi]; if (pi !== undefined && pi >= 0) idx.push(pi);
    }
    const children = Array.isArray(node && node.children) ? node.children.map(conv) : [];
    return { name: (node && node.name && String(node.name).trim()) || 'Узел', parts: idx, children };
  };
  let root = (res && res.root) ? conv(res.root) : { name: name || 'Сборка', parts: [], children: [] };
  if (!root.children.length) root.children = parts.map((p, i) => ({ name: p.name, parts: [i], children: [] }));
  if (!root.parts.length) root.parts = parts.map((_, i) => i);
  return root;
}
function nodeParts(node) { const s = new Set(node.parts || []); (node.children || []).forEach(c => nodeParts(c).forEach(i => s.add(i))); return [...s]; }

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
function screenPos(v, rect) { const p = v.clone().project(camera); return { x: (p.x * 0.5 + 0.5) * rect.width, y: (-p.y * 0.5 + 0.5) * rect.height }; }
function closestOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { t, x: ax + t * dx, y: ay + t * dy };
}
function snapHit(cx, cy) {
  const hit = surfaceHit(cx, cy); if (!hit) return null;
  const mesh = hit.object, rect = canvas.getBoundingClientRect();
  const px = cx - rect.left, py = cy - rect.top;
  if (!snapOn || !hit.face) return { point: hit.point.clone(), kind: 'surface', mesh };
  const pos = mesh.geometry.attributes.position, f = hit.face, mw = mesh.matrixWorld;
  const verts = [f.a, f.b, f.c].map(i => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mw));
  const scr = verts.map(v => screenPos(v, rect));
  const TH = 22; let best = null;
  for (let i = 0; i < 3; i++) { const d = Math.hypot(px - scr[i].x, py - scr[i].y); if (d < TH && (!best || d < best.d)) best = { d, kind: 'vertex', point: verts[i].clone() }; }
  if (best) return { point: best.point, kind: 'vertex', mesh };
  for (const pair of [[0, 1], [1, 2], [2, 0]]) {
    const i = pair[0], j = pair[1];
    const c = closestOnSeg(px, py, scr[i].x, scr[i].y, scr[j].x, scr[j].y);
    const d = Math.hypot(px - c.x, py - c.y);
    if (d < TH && (!best || d < best.d)) best = { d, kind: 'edge', point: verts[i].clone().lerp(verts[j], c.t) };
  }
  if (best) return { point: best.point, kind: 'edge', mesh };
  return { point: hit.point.clone(), kind: 'surface', mesh };
}

function setHighlight(indices) {
  parts.forEach(p => p.mesh.material.emissive.setHex(0x000000));
  indices.forEach(i => { if (parts[i]) parts[i].mesh.material.emissive.setHex(0x1a3f7a); });
}
function clearSelection() { selected = -1; treeSel.clear(); setHighlight([]); post({ type: 'deselect' }); renderTree(); }
function selectPart(i) {
  if (i < 0 || i >= parts.length) return;
  selected = i; treeSel.clear(); setHighlight([i]);
  post({ type: 'select', index: i, name: parts[i].name, color: '#' + parts[i].mesh.material.color.getHexString() });
  renderTree();
}
function selectNode(node) {
  const idx = nodeParts(node); if (!idx.length) return;
  treeSel = new Set(idx); selected = -1; setHighlight(idx);
  post({ type: 'treeSelect', name: node.name, count: idx.length });
  renderTree();
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
function createMeasure(a, b, id, ka, kb) {
  const d = a.distanceTo(b), grp = new THREE.Group();
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false }));
  line.renderOrder = 998;
  grp.add(line, makeMarker(a, kindColor(ka || 'surface')), makeMarker(b, kindColor(kb || 'surface')), makeLabel(fmtDist(d), a.clone().add(b).multiplyScalar(0.5)));
  measureRoot.add(grp);
  measures.push({ id, a: a.clone(), b: b.clone(), d, ka: ka || 'surface', kb: kb || 'surface', grp });
}
function addMeasurePoint(pt, kind) {
  if (!pendingPoint) {
    pendingPoint = pt.clone(); pendingKind = kind; pendingMarker = makeMarker(pt, kindColor(kind)); measureRoot.add(pendingMarker);
    post({ type: 'measureHint', text: 'Тапните вторую точку (' + kindRu(kind) + ')' }); return;
  }
  createMeasure(pendingPoint, pt.clone(), measId++, pendingKind, kind);
  disposePending();
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
  measures = []; disposePending();
  if (!silent) { postMeasures(); postState(); }
}
function disposePending() { if (pendingMarker) { measureRoot.remove(pendingMarker); pendingMarker.geometry.dispose(); pendingMarker.material.dispose(); } pendingPoint = null; pendingMarker = null; }
function postMeasures() { post({ type: 'measures', list: measures.map(m => ({ id: m.id, d: m.d })) }); }

function createPoint(pt, kind, id) {
  const grp = new THREE.Group();
  grp.add(makeMarker(pt, kindColor(kind)));
  const o = pt.clone().add(modelOffset);
  grp.add(makeLabel(o.x.toFixed(1) + ', ' + o.y.toFixed(1) + ', ' + o.z.toFixed(1), pt.clone().add(new THREE.Vector3(0, 0, radius * 0.05))));
  pointRoot.add(grp);
  points.push({ id, p: pt.clone(), kind, grp });
  pointId = Math.max(pointId, id + 1);
}
function addPoint(sn) {
  createPoint(sn.point, sn.kind, pointId++);
  lastPoint = { p: sn.point.clone(), orig: sn.point.clone().add(modelOffset), kind: sn.kind };
  post({ type: 'point', x: lastPoint.orig.x, y: lastPoint.orig.y, z: lastPoint.orig.z, kind: sn.kind });
  renderPointPanel(); postPoints(); postState();
}
function deletePoint(id) {
  const p = points.find(x => x.id === id); if (!p) return;
  pointRoot.remove(p.grp); p.grp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  points = points.filter(x => x.id !== id);
  lastPoint = points.length ? { p: points[points.length - 1].p, orig: points[points.length - 1].p.clone().add(modelOffset), kind: points[points.length - 1].kind } : null;
  renderPointPanel(); postPoints(); postState();
}
function clearPoints(silent) {
  points.forEach(p => { pointRoot.remove(p.grp); p.grp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); });
  points = []; lastPoint = null;
  if (!silent) { renderPointPanel(); postPoints(); postState(); }
}
function postPoints() { post({ type: 'points', list: points.map(p => { const o = p.p.clone().add(modelOffset); return { id: p.id, x: o.x, y: o.y, z: o.z, kind: p.kind }; }) }); }

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
  if (mode === 'measure') { const sn = snapHit(x, y); if (sn) addMeasurePoint(sn.point, sn.kind); return; }
  if (mode === 'point') { const sn = snapHit(x, y); if (sn) addPoint(sn); return; }
  if (now - lastTap < 320) { clearTimeout(pickTimer); lastTap = 0; fit(); }
  else { lastTap = now; clearTimeout(pickTimer); pickTimer = setTimeout(() => { const h = surfaceHit(x, y); if (!h) { clearSelection(); return; } selectPart(parts.findIndex(p => p.mesh === h.object)); }, 240); }
});
canvas.addEventListener('pointercancel', e => { active.delete(e.pointerId); tapOk = false; if (active.size === 0) multi = false; });

let stateTimer = 0;
function gatherState() {
  const colors = {}, hidden = [];
  parts.forEach((p, i) => { const hex = '#' + p.mesh.material.color.getHexString(); if (hex !== p.baseColor) colors[i] = hex; if (!p.visible) hidden.push(i); });
  return {
    v: 2, colors, hidden, snap: snapOn, section: sectionState,
    measures: measures.map(m => ({ id: m.id, a: m.a.toArray(), b: m.b.toArray(), d: m.d, ka: m.ka, kb: m.kb })),
    points: points.map(p => ({ id: p.id, p: p.p.toArray(), kind: p.kind })),
    cam: { pos: camera.position.toArray(), target: controls.target.toArray(), ortho: orthoOn, zoom: ortho.zoom, halfH }
  };
}
function postState() { clearTimeout(stateTimer); stateTimer = setTimeout(() => post({ type: 'state', state: gatherState() }), 350); }
controls.addEventListener('change', postState);
function applyState(s) {
  try {
    if (!s || typeof s !== 'object') return;
    if (s.colors) Object.keys(s.colors).forEach(k => { const i = +k; if (parts[i]) parts[i].mesh.material.color.set(s.colors[k]); });
    const hid = new Set(s.hidden || []);
    parts.forEach((p, i) => { p.visible = !hid.has(i); p.mesh.visible = p.visible; });
    if (typeof s.snap === 'boolean') snapOn = s.snap;
    if (s.section) { sectionState = Object.assign(sectionState, s.section); rebuildSection(); }
    clearMeasures(true); clearPoints(true);
    if (s.measures) s.measures.forEach(m => { createMeasure(new THREE.Vector3().fromArray(m.a), new THREE.Vector3().fromArray(m.b), m.id || measId++, m.ka, m.kb); measId = Math.max(measId, (m.id || 0) + 1); });
    if (s.points) s.points.forEach(p => { createPoint(new THREE.Vector3().fromArray(p.p), p.kind || 'surface', p.id || pointId++); });
    if (s.cam) {
      orthoOn = !!s.cam.ortho; camera = orthoOn ? ortho : persp; controls.object = camera;
      camera.position.fromArray(s.cam.pos); controls.target.fromArray(s.cam.target);
      if (s.cam.halfH) halfH = s.cam.halfH; if (s.cam.zoom) ortho.zoom = s.cam.zoom;
      resize(); controls.update();
    }
    if (selected >= 0 && parts[selected] && !parts[selected].visible) clearSelection();
    postMeasures(); postPoints(); postVisibility(); renderTree(); renderPointPanel(); postState();
  } catch (e) { post({ type: 'toast', text: 'Не удалось применить сохранённое состояние' }); }
}
function resetEdits() {
  parts.forEach(p => { p.mesh.material.color.set(p.baseColor); p.visible = true; p.mesh.visible = true; });
  clearSelection(); clearMeasures(true); clearPoints(true);
  sectionState = { show: true, axis: 'x', x: { on: false, off: 0, flip: false }, y: { on: false, off: 0, flip: false }, z: { on: false, off: 0, flip: false } };
  rebuildSection(); postMeasures(); postPoints(); postVisibility(); renderTree(); renderPointPanel(); postState();
}

function sendText(kind, filename, lines) {
  const CH = 1500, total = Math.ceil(lines.length / CH);
  for (let s = 0; s < total; s++) {
    const text = lines.slice(s * CH, (s + 1) * CH).join('\n') + '\n';
    post({ type: 'fileChunk', kind, seq: s, total, data: btoa(text) });
  }
  post({ type: 'fileDone', kind, name: filename });
}
function sendBinary(kind, filename, bytes) {
  const CH = 96 * 1024, total = Math.ceil(bytes.length / CH);
  for (let s = 0; s < total; s++) {
    const slice = bytes.subarray(s * CH, (s + 1) * CH);
    let bin = ''; for (let i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
    post({ type: 'fileChunk', kind, seq: s, total, data: btoa(bin) });
  }
  post({ type: 'fileDone', kind, name: filename });
}

function exportSTL() {
  const vis = parts.filter(p => p.visible);
  let total = 0; vis.forEach(p => { const g = p.mesh.geometry; total += (g.index ? g.index.count : g.attributes.position.count) / 3; });
  if (!total) { post({ type: 'toast', text: 'Нет видимых деталей для экспорта' }); return; }
  if (total > 600000) { post({ type: 'toast', text: 'STL ограничен: >600k треугольников. Скройте лишние детали.' }); return; }
  post({ type: 'status', text: 'Подготовка STL…' });
  const buf = new ArrayBuffer(84 + total * 50), dv = new DataView(buf);
  dv.setUint32(80, total, true);
  let off = 84;
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), cb = new THREE.Vector3(), ab = new THREE.Vector3();
  vis.forEach(p => {
    const m = p.mesh; m.updateWorldMatrix(true, false);
    const pos = m.geometry.attributes.position, idx = m.geometry.index, mw = m.matrixWorld;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      vA.fromBufferAttribute(pos, a).applyMatrix4(mw).add(modelOffset);
      vB.fromBufferAttribute(pos, b).applyMatrix4(mw).add(modelOffset);
      vC.fromBufferAttribute(pos, c).applyMatrix4(mw).add(modelOffset);
      cb.subVectors(vC, vB); ab.subVectors(vA, vB); cb.cross(ab).normalize();
      dv.setFloat32(off, cb.x, true); dv.setFloat32(off + 4, cb.y, true); dv.setFloat32(off + 8, cb.z, true); off += 12;
      for (const v of [vA, vB, vC]) { dv.setFloat32(off, v.x, true); dv.setFloat32(off + 4, v.y, true); dv.setFloat32(off + 8, v.z, true); off += 12; }
      dv.setUint16(off, 0, true); off += 2;
    }
  });
  sendBinary('stl', modelName.replace(/\.[^.]+$/, '') + '.stl', new Uint8Array(buf));
}

const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
function ascii(s) {
  let r = '';
  for (const ch of String(s)) {
    const low = ch.toLowerCase();
    if (TR[low] !== undefined) { const t = TR[low]; r += (ch === low) ? t : (t ? t[0].toUpperCase() + t.slice(1) : ''); }
    else if (ch.charCodeAt(0) < 128) r += ch;
    else r += '_';
  }
  return r;
}

function exportSTEP() {
  const vis = parts.filter(p => p.visible);
  if (!vis.length) { post({ type: 'toast', text: 'Нет видимых деталей для экспорта' }); return; }
  let total = 0; vis.forEach(p => { const g = p.mesh.geometry; total += (g.index ? g.index.count : g.attributes.position.count) / 3; });
  if (total > 20000) {
    post({ type: 'toast', text: 'STEP: нужно не больше 20000 треугольников, сейчас ' + Math.round(total) + '. Поставьте качество «Быстро» или скройте детали.' });
    return;
  }
  post({ type: 'status', text: 'Подготовка STEP…' });

  const body = [];
  let nid = 0;
  const A = s => { nid++; body.push('#' + nid + '=' + s + ';'); return nid; };
  const R = i => '#' + i;
  const N = v => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(6);
  const PV = v => '(' + N(v.x) + ',' + N(v.y) + ',' + N(v.z) + ')';
  const Q = s => "'" + ascii(s).replace(/'/g, "''") + "'";

  const appCtx = A("APPLICATION_CONTEXT('automotive design')");
  A("APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000," + R(appCtx) + ")");
  const pdCtx = A("PRODUCT_DEFINITION_CONTEXT('part definition'," + R(appCtx) + ",'design')");
  const pCtx = A("PRODUCT_CONTEXT(''," + R(appCtx) + ",'mechanical')");
  const prodName = ascii(modelName.replace(/\.[^.]+$/, '')) || 'Model';
  const prod = A("PRODUCT(" + Q(prodName) + "," + Q(prodName) + "('',(" + R(pCtx) + "))").replace("(''", "''"));
  const pdf = A("PRODUCT_DEFINITION_FORMATION('',''," + R(prod) + ")");
  const pd = A("PRODUCT_DEFINITION('design',''," + R(pdf) + "," + R(pdCtx) + ")");
  const pds = A("PRODUCT_DEFINITION_SHAPE('',''," + R(pd) + ")");

  const lenU = A("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const angU = A("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const solU = A("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const unc = A("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06)," + R(lenU) + ",'distance_accuracy_value','confusion accuracy')");
  const ctx = A("(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((" + R(unc) + "))GLOBAL_UNIT_ASSIGNED_CONTEXT((" + R(lenU) + "," + R(angU) + "," + R(solU) + "))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))");

  const origin = A("CARTESIAN_POINT('',(0.,0.,0.))");
  const zDir = A("DIRECTION('',(0.,0.,1.))");
  const xDir = A("DIRECTION('',(1.,0.,0.))");
  const axis0 = A("AXIS2_PLACEMENT_3D(''," + R(origin) + "," + R(zDir) + "," + R(xDir) + ")");

  const items = [axis0], styled = [];
  const tmp = new THREE.Vector3(), va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const nrm = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  let made = 0;

  vis.forEach(p => {
    const mesh = p.mesh; mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry, pos = geo.attributes.position, idx = geo.index, mw = mesh.matrixWorld;
    const count = idx ? idx.count : pos.count;
    const vmap = new Map(), pts = [], cps = [], vps = [];
    const vid = (i) => {
      tmp.fromBufferAttribute(pos, i).applyMatrix4(mw).add(modelOffset);
      const k = tmp.x.toFixed(5) + '|' + tmp.y.toFixed(5) + '|' + tmp.z.toFixed(5);
      let j = vmap.get(k);
      if (j === undefined) {
        const cp = A("CARTESIAN_POINT(''," + PV(tmp) + ")");
        const vp = A("VERTEX_POINT(''," + R(cp) + ")");
        j = pts.length; pts.push(tmp.clone()); cps.push(cp); vps.push(vp); vmap.set(k, j);
      }
      return j;
    };
    const emap = new Map();
    const getEdge = (a, b) => {
      const k = Math.min(a, b) + '_' + Math.max(a, b);
      let e = emap.get(k);
      if (!e) {
        const d = new THREE.Vector3().subVectors(pts[b], pts[a]);
        const len = d.length(); if (len < 1e-9) return null;
        d.divideScalar(len);
        const dir = A("DIRECTION(''," + PV(d) + ")");
        const vec = A("VECTOR(''," + R(dir) + ",1.0)");
        const ln = A("LINE(''," + R(cps[a]) + "," + R(vec) + ")");
        const ec = A("EDGE_CURVE(''," + R(vps[a]) + "," + R(vps[b]) + "," + R(ln) + ",.T.)");
        e = { id: ec, a, b }; emap.set(k, e);
      }
      return e;
    };
    const faces = [];
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      const a = vid(i0), b = vid(i1), c = vid(i2);
      if (a === b || b === c || a === c) continue;
      va.copy(pts[a]); vb.copy(pts[b]); vc.copy(pts[c]);
      e1.subVectors(vb, va); e2.subVectors(vc, va); nrm.crossVectors(e1, e2);
      if (nrm.lengthSq() < 1e-18) continue;
      nrm.normalize();
      const rd = e1.clone().normalize();
      const nId = A("DIRECTION(''," + PV(nrm) + ")");
      const rId = A("DIRECTION(''," + PV(rd) + ")");
      const ap = A("AXIS2_PLACEMENT_3D(''," + R(cps[a]) + "," + R(nId) + "," + R(rId) + ")");
      const pl = A("PLANE(''," + R(ap) + ")");
      const oe = []; let ok = true;
      for (const pair of [[a, b], [b, c], [c, a]]) {
        const e = getEdge(pair[0], pair[1]);
        if (!e) { ok = false; break; }
        oe.push(A("ORIENTED_EDGE('',*,*," + R(e.id) + "," + (e.a === pair[0] ? '.T.' : '.F.') + ")"));
      }
      if (!ok) continue;
      const loop = A("EDGE_LOOP('',(" + oe.map(R).join(',') + "))");
      const bound = A("FACE_OUTER_BOUND(''," + R(loop) + ",.T.)");
      faces.push(A("ADVANCED_FACE('',(" + R(bound) + ")," + R(pl) + ",.T.)"));
    }
    if (!faces.length) return;
    const shell = A("CLOSED_SHELL('',(" + faces.map(R).join(',') + "))");
    const solid = A("FACETED_BREP(" + Q(p.name) + "," + R(shell) + ")");
    items.push(solid); made += faces.length;
    const srgb = p.mesh.material.color.clone().convertLinearToSRGB();
    const col = A("COLOUR_RGB(''," + N(srgb.r) + "," + N(srgb.g) + "," + N(srgb.b) + ")");
    const fc = A("FILL_AREA_STYLE_COLOUR(''," + R(col) + ")");
    const fas = A("FILL_AREA_STYLE('',(" + R(fc) + "))");
    const ssf = A("SURFACE_STYLE_FILL_AREA(" + R(fas) + ")");
    const sss = A("SURFACE_SIDE_STYLE('',(" + R(ssf) + "))");
    const ssu = A("SURFACE_STYLE_USAGE(.BOTH.," + R(sss) + ")");
    const psa = A("PRESENTATION_STYLE_ASSIGNMENT((" + R(ssu) + "))");
    styled.push(A("STYLED_ITEM('',(" + R(psa) + ")," + R(solid) + ")"));
  });

  if (!made) { post({ type: 'toast', text: 'Не удалось построить грани для STEP' }); return; }

  const rep = A("ADVANCED_BREP_SHAPE_REPRESENTATION('',(" + items.map(R).join(',') + ")," + R(ctx) + ")");
  A("SHAPE_DEFINITION_REPRESENTATION(" + R(pds) + "," + R(rep) + ")");
  if (styled.length) A("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(" + styled.map(R).join(',') + ")," + R(ctx) + ")");

  const stamp = new Date().toISOString().slice(0, 19);
  const fname = ascii(modelName.replace(/\.[^.]+$/, '')) + '.step';
  const head = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('STEP Viewer faceted export'),'2;1');",
    "FILE_NAME(" + Q(fname) + ",'" + stamp + "',('STEP Viewer'),(''),'STEP Viewer','STEP Viewer','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;'
  ];
  const tail = ['ENDSEC;', 'END-ISO-10303-21;'];
  sendText('step', fname, head.concat(body, tail));
  post({ type: 'toast', text: 'STEP готов: ' + made + ' граней' });
}

function renderTree() {
  const body = document.getElementById('treeBody'); if (!body) return;
  body.innerHTML = '';
  if (!treeData) { body.appendChild(el('div', 'phint', 'Откройте модель, чтобы увидеть дерево сборки')); return; }
  const q = (document.getElementById('treeSearch').value || '').toLowerCase().trim();
  const matches = n => n.name.toLowerCase().includes(q);
  const hasMatch = n => matches(n) || (n.children || []).some(hasMatch);
  const walk = (node, depth) => {
    if (q && !hasMatch(node)) return;
    const idx = nodeParts(node);
    const row = el('div', 'trow'); row.style.paddingLeft = (6 + depth * 14) + 'px';
    const kids = node.children || [];
    const arrow = el('span', 'tarrow', kids.length ? (collapsed.has(node) ? '▸' : '▾') : '');
    if (kids.length) arrow.addEventListener('click', ev => { ev.stopPropagation(); if (collapsed.has(node)) collapsed.delete(node); else collapsed.add(node); renderTree(); });
    row.appendChild(arrow);
    const allVis = idx.length > 0 && idx.every(i => parts[i] && parts[i].visible);
    const eye = el('button', 'teye' + (allVis ? '' : ' off'), allVis ? '👁' : '🚫');
    eye.addEventListener('click', ev => { ev.stopPropagation(); toggleNodeVis(node); });
    row.appendChild(eye);
    const name = el('span', 'tname', node.name);
    name.addEventListener('click', () => selectNode(node));
    row.appendChild(name);
    row.appendChild(el('span', 'tcount', String(idx.length)));
    if (treeSel.size && idx.length && idx.every(i => treeSel.has(i))) row.classList.add('sel');
    body.appendChild(row);
    if (!collapsed.has(node) || q) kids.forEach(c => walk(c, depth + 1));
  };
  walk(treeData, 0);
}
function toggleNodeVis(node) {
  const idx = nodeParts(node); if (!idx.length) return;
  const allVis = idx.every(i => parts[i].visible);
  idx.forEach(i => { parts[i].visible = !allVis; parts[i].mesh.visible = parts[i].visible; });
  if (selected >= 0 && !parts[selected].visible) clearSelection();
  postVisibility(); postState(); renderTree();
}
function isolateTreeSel() {
  if (!treeSel.size) { post({ type: 'toast', text: 'Сначала выберите узел в дереве' }); return; }
  parts.forEach((p, i) => { p.visible = treeSel.has(i); p.mesh.visible = p.visible; });
  postVisibility(); postState(); renderTree();
}
function showAllParts() { parts.forEach(p => { p.visible = true; p.mesh.visible = true; }); postVisibility(); postState(); renderTree(); }
function postVisibility() { post({ type: 'visibility', arr: parts.map(p => p.visible) }); }
function setTreeOpen(on) { treeOpen = !!on; document.getElementById('treePanel').classList.toggle('hidden', !treeOpen); if (treeOpen) renderTree(); post({ type: 'tree', open: treeOpen }); }

function renderPointPanel() {
  const panel = document.getElementById('pointPanel');
  const body = document.getElementById('pointBody');
  if (mode !== 'point') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  body.innerHTML = '';
  if (lastPoint) {
    const o = lastPoint.orig, card = el('div', 'pcard');
    card.appendChild(el('span', 'badge ' + lastPoint.kind, kindRu(lastPoint.kind)));
    const grid = el('div', 'pgrid');
    ['X', 'Y', 'Z'].forEach((ax, i) => {
      const row = el('div', 'prow'); row.appendChild(el('span', 'pax', ax));
      const val = el('span', 'pval', o.getComponent(i).toFixed(3)); val.appendChild(el('span', 'punit', 'мм'));
      row.appendChild(val); grid.appendChild(row);
    });
    card.appendChild(grid);
    const copy = el('button', 'copybtn', 'Копировать XYZ');
    copy.addEventListener('click', () => post({ type: 'copy', text: o.x.toFixed(3) + ', ' + o.y.toFixed(3) + ', ' + o.z.toFixed(3) }));
    card.appendChild(copy); body.appendChild(card);
  } else {
    body.appendChild(el('div', 'phint', 'Тапните по модели — координаты появятся здесь.\nЗелёный — вершина, голубой — ребро, жёлтый — поверхность.'));
  }
  if (points.length) {
    const list = el('div', 'plist');
    points.forEach(pt => {
      const o = pt.p.clone().add(modelOffset);
      const row = el('div', 'pitem');
      row.appendChild(el('span', 'pkind ' + pt.kind, kindShort(pt.kind)));
      row.appendChild(el('span', 'pcoords', o.x.toFixed(2) + ', ' + o.y.toFixed(2) + ', ' + o.z.toFixed(2)));
      const del = el('button', 'pdel', '✕'); del.addEventListener('click', () => deletePoint(pt.id));
      row.appendChild(del); list.appendChild(row);
    });
    body.appendChild(list);
    const clear = el('button', 'pbtn', 'Очистить точки'); clear.style.margin = '6px'; clear.style.width = 'calc(100% - 12px)';
    clear.addEventListener('click', () => clearPoints(false)); body.appendChild(clear);
  }
}
function setModeInternal(m) {
  mode = (m === 'measure' || m === 'point') ? m : 'select';
  if (mode !== 'measure') disposePending();
  if (mode === 'measure') post({ type: 'measureHint', text: 'Тапните первую точку' });
  renderPointPanel();
}

document.getElementById('treeClose').addEventListener('click', () => setTreeOpen(false));
document.getElementById('treeShowAll').addEventListener('click', showAllParts);
document.getElementById('treeIsolate').addEventListener('click', isolateTreeSel);
document.getElementById('treeSearch').addEventListener('input', renderTree);
document.getElementById('pointClose').addEventListener('click', () => { setModeInternal('select'); post({ type: 'mode', mode: 'select' }); });

window.SV = {
  open, clear: clearModel, fit: () => fit(),
  setView: k => { const v = VIEWS[k] || VIEWS.iso; fit(new THREE.Vector3(v[0], v[1], v[2])); },
  setWireframe: on => { wireOn = !!on; parts.forEach(p => p.mesh.material.wireframe = wireOn); },
  setEdges: on => { edgesOn = !!on; applyEdges(); },
  setOrtho: on => { orthoOn = !!on; const n = orthoOn ? ortho : persp; if (n !== camera) { n.position.copy(camera.position); n.up.copy(camera.up); camera = n; controls.object = camera; controls.update(); } postState(); },
  setGrid: on => { gridOn = !!on; if (grid) grid.visible = gridOn; axes.visible = gridOn; },
  setDark: on => { darkOn = !!on; scene.background = new THREE.Color(darkOn ? BG_DARK : BG_LIGHT); },
  setQuality: v => { deflection = Number(v) || 0.001; },
  setSnap: on => { snapOn = !!on; postState(); },
  setMode: m => setModeInternal(m),
  setTreeOpen: on => setTreeOpen(on),
  setPartsVisible: arr => { parts.forEach((p, i) => { p.visible = arr[i] !== false; p.mesh.visible = p.visible; }); if (selected >= 0 && parts[selected] && !parts[selected].visible) clearSelection(); postVisibility(); postState(); renderTree(); },
  clearSelection,
  setColor: hex => { if (selected < 0 || !parts[selected]) return; parts[selected].mesh.material.color.set(hex); post({ type: 'color', index: selected, color: hex }); postState(); },
  setSection: s => { sectionState = Object.assign(sectionState, s || {}); rebuildSection(); postState(); },
  clearMeasures: () => clearMeasures(false),
  deleteMeasure,
  clearPoints: () => clearPoints(false),
  deletePoint,
  requestState: () => post({ type: 'state', state: gatherState() }),
  applyState, resetEdits, exportSTL, exportSTEP
};
post({ type: 'ready' });
