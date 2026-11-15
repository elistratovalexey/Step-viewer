import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('c');
const post = (m) => { try { window.AndroidBridge && window.AndroidBridge.post(JSON.stringify(m)); } catch (e) {} };
window.addEventListener('error', e => post({ type: 'error', text: String(e.message) }));
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nfmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

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
const annoRoot = new THREE.Group(); scene.add(annoRoot);
const pointRoot = new THREE.Group(); scene.add(pointRoot);
const sectionRoot = new THREE.Group(); scene.add(sectionRoot);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x0c1016 });

let parts = [], origToPart = [], treeData = null, modelName = 'model.step';
let radius = 1, triCount = 0, dims = [0, 0, 0], half = [1, 1, 1];
let modelOffset = new THREE.Vector3();
let wireOn = false, edgesOn = false, orthoOn = false, gridOn = false, darkOn = true, snapOn = true;
let deflection = 0.001, usedDeflection = 0.001;
let mode = 'select', selected = -1, treeOpen = false;
let annos = [], annoId = 1;
let pending = null;
let points = [], pointId = 1, lastPoint = null;
let treeSel = new Set(), collapsed = new Set();
let limits = { model: 1500000, stl: 600000, step: 20000, edges: 400000, sharp: 20 };
let sectionState = { show: true, axis: 'x', x: { on: false, off: 0, flip: false }, y: { on: false, off: 0, flip: false }, z: { on: false, off: 0, flip: false } };
const AX = { x: 0, y: 1, z: 2 };
const COL = { dist: 0xfbbf24, angle: 0xa78bfa, min: 0x34d399, circle: 0xf472b6, vertex: 0x22c55e, edge: 0x38bdf8, surface: 0xfbbf24 };
const kindColor = k => COL[k] || COL.surface;
const kindRu = k => k === 'vertex' ? 'Вершина' : k === 'edge' ? 'Ребро' : 'Поверхность';
const kindShort = k => k === 'vertex' ? 'В' : k === 'edge' ? 'Р' : 'П';
const MODE_HINT = {
  measure: 'Тапните первую точку',
  point: 'Тапните точку для координат XYZ',
  angle: 'Тапните первое ребро или грань',
  min: 'Тапните первое ребро',
  radius: 'Тапните по круговому ребру или цилиндру'
};

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = (async () => {
      let f = window.occtimportjs;
      if (typeof f !== 'function') { const m = await import('./lib/occt-import-js.js'); f = m.default || window.occtimportjs; }
      if (typeof f !== 'function') throw new Error('Не удалось загрузить ядро OpenCascade.');
      return await f({ locateFile: (x) => new URL('lib/' + x, document.baseURI).href });
    })();
  }
  return occtPromise;
}
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

function countTris(res) {
  let t = 0;
  res.meshes.forEach(m => {
    const p = m.attributes && m.attributes.position && m.attributes.position.array;
    if (!p || p.length < 9) return;
    const i = m.index && m.index.array;
    t += (i ? i.length : p.length / 3) / 3;
  });
  return Math.round(t);
}

async function importWithBudget(occt, data, fn) {
  const reader = occt[fn];
  let defl = deflection, res = null;
  for (let a = 0; a < 5; a++) {
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: defl, angularDeflection: 0.5 };
    try { res = reader.call(occt, data, params); } catch (e) { res = reader.call(occt, data, null); }
    if (!res || !res.success || !res.meshes || !res.meshes.length) throw new Error('В файле не найдена геометрия либо формат не поддерживается.');
    const tris = countTris(res);
    usedDeflection = defl;
    if (!limits.model || tris <= limits.model) return res;
    if (a === 4) { post({ type: 'toast', text: 'Лимит ' + nfmt(limits.model) + ' не достигнут: ' + nfmt(tris) + ' треуг.' }); return res; }
    post({ type: 'status', text: 'Сетка ' + nfmt(tris) + ' треуг. > лимита ' + nfmt(limits.model) + '. Упрощаю…' });
    await nextFrame();
    defl = defl * 2.5;
  }
  return res;
}

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
    const res = await importWithBudget(occt, data, fn);
    build(res, name);
    post({ type: 'loaded', parts: parts.map(p => p.name), triangles: triCount, bbox: dims, time: performance.now() - t0, deflection: usedDeflection });
    postAnnos(); postPoints(); postVisibility(); postState();
  } catch (e) { post({ type: 'error', text: (e && e.message) ? e.message : String(e) }); }
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
    parts.push({ mesh, name: mesh.name, baseColor: '#' + color.getHexString(), edges: null, visible: true, tris, topo: null });
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
  clearAnnos(true); clearPoints(true);
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
function nodeParts(n) { const s = new Set(n.parts || []); (n.children || []).forEach(c => nodeParts(c).forEach(i => s.add(i))); return [...s]; }

function ensureEdges(p) {
  if (p.edges) return;
  if (limits.edges && p.tris > limits.edges) { post({ type: 'toast', text: 'Рёбра пропущены: ' + p.name }); return; }
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

function eig3(m) {
  const a = m.map(r => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let s = 0; s < 40; s++) {
    let p = 0, q = 1, mx = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > mx) { mx = Math.abs(a[0][2]); p = 0; q = 2; }
    if (Math.abs(a[1][2]) > mx) { mx = Math.abs(a[1][2]); p = 1; q = 2; }
    if (mx < 1e-16) break;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const th = (aqq - app) / (2 * apq);
    const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
    const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
    for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = cs * x - sn * y; a[k][q] = sn * x + cs * y; }
    for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = cs * x - sn * y; a[q][k] = sn * x + cs * y; }
    for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = cs * x - sn * y; v[k][q] = sn * x + cs * y; }
  }
  const vals = [a[0][0], a[1][1], a[2][2]];
  const vecs = [0, 1, 2].map(i => new THREE.Vector3(v[0][i], v[1][i], v[2][i]));
  return { vals, vecs };
}

function buildTopo(p) {
  if (p.topo) return p.topo;
  if (limits.edges && p.tris > limits.edges) { post({ type: 'toast', text: 'Анализ рёбер пропущен: ' + p.name + ' слишком тяжёлая. Поднимите лимит в Настройках.' }); return null; }
  const geo = p.mesh.geometry, pos = geo.attributes.position, idx = geo.index;
  const triN = idx ? idx.count / 3 : pos.count / 3;
  const map = new Map(), verts = [], remap = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = x.toFixed(4) + '|' + y.toFixed(4) + '|' + z.toFixed(4);
    let j = map.get(k);
    if (j === undefined) { j = verts.length; verts.push(new THREE.Vector3(x, y, z)); map.set(k, j); }
    remap[i] = j;
  }
  p.mesh.updateWorldMatrix(true, false);
  const mw = p.mesh.matrixWorld;
  const wv = verts.map(v => v.clone().applyMatrix4(mw));
  const em = new Map();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < triN; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const v0 = remap[i0], v1 = remap[i1], v2 = remap[i2];
    if (v0 === v1 || v1 === v2 || v0 === v2) continue;
    A.copy(verts[v0]); B.copy(verts[v1]); C.copy(verts[v2]);
    e1.subVectors(B, A); e2.subVectors(C, A); n.crossVectors(e1, e2);
    if (n.lengthSq() < 1e-20) continue;
    n.normalize();
    for (const pr of [[v0, v1], [v1, v2], [v2, v0]]) {
      const u = Math.min(pr[0], pr[1]), w = Math.max(pr[0], pr[1]);
      const k = u + '_' + w;
      let r = em.get(k);
      if (!r) { r = { u, w, n0: n.clone(), maxAng: 0, count: 1 }; em.set(k, r); }
      else { const d = clamp(r.n0.dot(n), -1, 1); const ang = Math.acos(d); if (ang > r.maxAng) r.maxAng = ang; r.count++; }
    }
  }
  const thr = limits.sharp * Math.PI / 180;
  const sharp = [];
  em.forEach(r => { if (r.count === 1 || r.maxAng > thr) sharp.push({ a: wv[r.u], b: wv[r.w], ia: r.u, ib: r.w }); });
  const adj = new Map();
  sharp.forEach((e, i) => {
    if (!adj.has(e.ia)) adj.set(e.ia, []);
    if (!adj.has(e.ib)) adj.set(e.ib, []);
    adj.get(e.ia).push(i); adj.get(e.ib).push(i);
  });
  const seen = new Set(), comps = [];
  adj.forEach((list, start) => {
    if (seen.has(start)) return;
    const stack = [start], vs = new Set(), es = new Set();
    while (stack.length) {
      const v = stack.pop();
      if (seen.has(v)) continue;
      seen.add(v); vs.add(v);
      for (const ei of adj.get(v) || []) {
        es.add(ei);
        const e = sharp[ei];
        const o = e.ia === v ? e.ib : e.ia;
        if (!seen.has(o)) stack.push(o);
      }
    }
    const vlist = [...vs];
    const closed = vlist.every(v => (adj.get(v) || []).length === 2);
    comps.push({ verts: vlist.map(v => wv[v]), edges: [...es].map(i => sharp[i]), closed });
  });
  p.topo = { wv, sharp, adj, comps };
  return p.topo;
}

function chainOf(topo, edge) {
  const ei = topo.sharp.indexOf(edge);
  if (ei < 0) return [edge];
  const out = [edge], used = new Set([ei]);
  for (const dir of [0, 1]) {
    let cur = dir === 0 ? edge.ia : edge.ib;
    let guard = 0;
    while (guard++ < 20000) {
      const list = topo.adj.get(cur) || [];
      if (list.length !== 2) break;
      const next = list.find(i => !used.has(i));
      if (next === undefined) break;
      used.add(next);
      const e = topo.sharp[next];
      out.push(e);
      cur = e.ia === cur ? e.ib : e.ia;
    }
  }
  return out;
}

const raycaster = new THREE.Raycaster();
function ndc(cx, cy) { const r = canvas.getBoundingClientRect(); return new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); }
function surfaceHit(cx, cy) {
  if (!parts.length) return null;
  raycaster.setFromCamera(ndc(cx, cy), camera);
  const hits = raycaster.intersectObjects(parts.filter(p => p.visible).map(p => p.mesh), false);
  return hits.length ? hits[0] : null;
}
function screenPos(v, r) { const p = v.clone().project(camera); return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height }; }
function closestOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return { t, x: ax + t * dx, y: ay + t * dy };
}
function worldPerPixel(dist) {
  const h = canvas.clientHeight || 1;
  if (camera.isOrthographicCamera) return (2 * halfH / camera.zoom) / h;
  return (2 * dist * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) / h;
}

function snapHit(cx, cy) {
  const hit = surfaceHit(cx, cy); if (!hit) return null;
  const mesh = hit.object;
  const p = parts.find(x => x.mesh === mesh);
  const base = { point: hit.point.clone(), kind: 'surface', mesh, part: p, hit };
  if (!snapOn || !p) return base;
  const topo = buildTopo(p);
  if (!topo || !topo.sharp.length) return base;
  const r = canvas.getBoundingClientRect();
  const px = cx - r.left, py = cy - r.top;
  const wpp = worldPerPixel(camera.position.distanceTo(hit.point));
  const near = 30 * wpp;
  let best = null;
  for (const v of topo.wv) {
    if (v.distanceTo(hit.point) > near) continue;
    const s = screenPos(v, r);
    const d = Math.hypot(px - s.x, py - s.y);
    if (d < 22 && (!best || d < best.d)) best = { d, kind: 'vertex', point: v.clone() };
  }
  if (best) return { point: best.point, kind: 'vertex', mesh, part: p, hit };
  for (const e of topo.sharp) {
    const mid = e.a.clone().add(e.b).multiplyScalar(0.5);
    if (mid.distanceTo(hit.point) > near + e.a.distanceTo(e.b)) continue;
    const sa = screenPos(e.a, r), sb = screenPos(e.b, r);
    const c = closestOnSeg(px, py, sa.x, sa.y, sb.x, sb.y);
    const d = Math.hypot(px - c.x, py - c.y);
    if (d < 22 && (!best || d < best.d)) best = { d, kind: 'edge', point: e.a.clone().lerp(e.b, c.t), edge: e };
  }
  if (best) return { point: best.point, kind: 'edge', mesh, part: p, hit, edge: best.edge };
  return base;
}

function faceNormal(hit) {
  const n = new THREE.Vector3();
  if (hit && hit.face) {
    n.copy(hit.face.normal).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
    if (n.lengthSq() > 1e-12) return n.normalize();
  }
  return new THREE.Vector3(0, 0, 1);
}

function setHighlight(idx) {
  parts.forEach(p => p.mesh.material.emissive.setHex(0x000000));
  idx.forEach(i => { if (parts[i]) parts[i].mesh.material.emissive.setHex(0x1a3f7a); });
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

function marker(pt, color, scale) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius * (scale || 0.012), 14, 10), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.copy(pt); m.renderOrder = 999; return m;
}
function line(pts, color, dashed) {
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const m = dashed ? new THREE.LineDashedMaterial({ color, depthTest: false, dashSize: radius * 0.03, gapSize: radius * 0.02 })
                   : new THREE.LineBasicMaterial({ color, depthTest: false });
  const l = new THREE.Line(g, m);
  if (dashed) l.computeLineDistances();
  l.renderOrder = 998; return l;
}
function label(text, pt, color) {
  const lines = String(text).split('\n');
  const cv = document.createElement('canvas'); cv.width = 420; cv.height = 60 + lines.length * 52;
  const ctx = cv.getContext('2d');
  const hex = '#' + new THREE.Color(color).getHexString();
  ctx.fillStyle = 'rgba(14,19,26,0.94)'; ctx.strokeStyle = hex; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.roundRect(4, 4, cv.width - 8, cv.height - 8, 20); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((t, i) => {
    ctx.fillStyle = i === 0 ? '#ffffff' : '#b8c4d0';
    ctx.font = (i === 0 ? 'bold 44px' : '32px') + ' sans-serif';
    ctx.fillText(t, cv.width / 2, 40 + i * 52);
  });
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.position.copy(pt);
  const w = radius * 0.42;
  sp.scale.set(w, w * cv.height / cv.width, 1);
  sp.renderOrder = 1000; return sp;
}
function fmtLen(d) { return d >= 1000 ? (d / 1000).toFixed(3) + ' м' : d.toFixed(2) + ' мм'; }

function segSeg(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  const EPS = 1e-14;
  let s = 0, t = 0;
  if (a <= EPS && e <= EPS) { const c1 = p1.clone(), c2 = p2.clone(); return { d: c1.distanceTo(c2), c1, c2 }; }
  if (a <= EPS) { s = 0; t = clamp(f / e, 0, 1); }
  else if (e <= EPS) { t = 0; s = clamp(-d1.dot(r) / a, 0, 1); }
  else {
    const b = d1.dot(d2), c = d1.dot(r), den = a * e - b * b;
    s = den > EPS ? clamp((b * f - c * e) / den, 0, 1) : 0;
    t = (b * s + f) / e;
    if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
    else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
  }
  const c1 = p1.clone().addScaledVector(d1, s), c2 = p2.clone().addScaledVector(d2, t);
  return { d: c1.distanceTo(c2), c1, c2 };
}

function fitCircle(pts) {
  const n = pts.length;
  if (n < 8) return null;
  const c = new THREE.Vector3();
  pts.forEach(p => c.add(p)); c.divideScalar(n);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  pts.forEach(p => { const d = p.clone().sub(c); xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z; yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z; });
  const eg = eig3([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
  let mi = 0;
  for (let i = 1; i < 3; i++) if (eg.vals[i] < eg.vals[mi]) mi = i;
  const nrm = eg.vecs[mi].clone().normalize();
  let u = eg.vecs[(mi + 1) % 3].clone().normalize();
  if (Math.abs(u.dot(nrm)) > 0.9) u = new THREE.Vector3(1, 0, 0).cross(nrm).normalize();
  u.sub(nrm.clone().multiplyScalar(u.dot(nrm))).normalize();
  const v = nrm.clone().cross(u).normalize();
  const pl = pts.map(p => { const d = p.clone().sub(c); return { x: d.dot(u), y: d.dot(v), h: d.dot(nrm) }; });
  const planarRms = Math.sqrt(pl.reduce((s, p) => s + p.h * p.h, 0) / n);
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sz = 0, Sxz = 0, Syz = 0;
  pl.forEach(p => { const z = p.x * p.x + p.y * p.y; Sx += p.x; Sy += p.y; Sxx += p.x * p.x; Syy += p.y * p.y; Sxy += p.x * p.y; Sz += z; Sxz += p.x * z; Syz += p.y * z; });
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
  const rhs = [-Sxz, -Syz, -Sz];
  const sol = solve3(M, rhs);
  if (!sol) return null;
  const cx = -sol[0] / 2, cy = -sol[1] / 2;
  const r2 = cx * cx + cy * cy - sol[2];
  if (!(r2 > 0)) return null;
  const R = Math.sqrt(r2);
  const rms = Math.sqrt(pl.reduce((s, p) => { const d = Math.hypot(p.x - cx, p.y - cy) - R; return s + d * d; }, 0) / n);
  const center = c.clone().addScaledVector(u, cx).addScaledVector(v, cy);
  return { center, normal: nrm, R, rms, planarRms, u, v };
}
function solve3(M, b) {
  const a = M.map((r, i) => [r[0], r[1], r[2], b[i]]);
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(a[k][i]) > Math.abs(a[piv][i])) piv = k;
    if (Math.abs(a[piv][i]) < 1e-18) return null;
    const tmp = a[i]; a[i] = a[piv]; a[piv] = tmp;
    for (let k = i + 1; k < 3; k++) {
      const f = a[k][i] / a[i][i];
      for (let j = i; j < 4; j++) a[k][j] -= f * a[i][j];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = a[i][3];
    for (let j = i + 1; j < 3; j++) s -= a[i][j] * x[j];
    x[i] = s / a[i][i];
  }
  return x;
}

function drawAnno(type, pts, meta) {
  const grp = new THREE.Group();
  const col = COL[type] || COL.dist;
  let text = '', value = 0;
  if (type === 'dist' || type === 'min') {
    const a = pts[0], b = pts[1];
    value = a.distanceTo(b);
    grp.add(line([a, b], col, type === 'min'));
    grp.add(marker(a, kindColor(meta.ka || 'surface')), marker(b, kindColor(meta.kb || 'surface')));
    text = (type === 'min' ? 'min ' : '') + fmtLen(value);
    grp.add(label(text, a.clone().add(b).multiplyScalar(0.5), col));
  } else if (type === 'angle') {
    const o = pts[0], d1 = pts[1].clone().sub(o).normalize(), d2 = pts[2].clone().sub(o).normalize();
    const raw = Math.acos(clamp(d1.dot(d2), -1, 1)) * 180 / Math.PI;
    const both = meta.k1 === 'edge' && meta.k2 === 'edge';
    value = both ? Math.min(raw, 180 - raw) : raw;
    const L = radius * 0.28;
    grp.add(line([o, o.clone().addScaledVector(d1, L)], col), line([o, o.clone().addScaledVector(d2, L)], col));
    grp.add(marker(o, col, 0.014));
    let ax = d1.clone().cross(d2);
    if (ax.lengthSq() < 1e-10) ax = Math.abs(d1.x) < 0.9 ? new THREE.Vector3(1, 0, 0).cross(d1).normalize() : new THREE.Vector3(0, 1, 0).cross(d1).normalize();
    ax.normalize();
    const arc = [];
    const steps = 28;
    for (let i = 0; i <= steps; i++) arc.push(o.clone().addScaledVector(d1.clone().applyAxisAngle(ax, (value * Math.PI / 180) * i / steps), L * 0.55));
    grp.add(line(arc, col));
    const bis = d1.clone().add(d2);
    if (bis.lengthSq() < 1e-10) bis.copy(d1);
    bis.normalize();
    text = value.toFixed(2) + '°';
    grp.add(label(text + '\n' + kindRu(meta.k1) + ' / ' + kindRu(meta.k2) + '\nсмежный ' + (180 - value).toFixed(2) + '°', o.clone().addScaledVector(bis, L * 0.95), col));
  } else if (type === 'circle') {
    const c = pts[0], nrm = new THREE.Vector3().fromArray(meta.n), R = meta.R;
    let u = new THREE.Vector3().fromArray(meta.u);
    const v = nrm.clone().cross(u).normalize();
    const ring = [];
    for (let i = 0; i <= 96; i++) {
      const t = i / 96 * Math.PI * 2;
      ring.push(c.clone().addScaledVector(u, Math.cos(t) * R).addScaledVector(v, Math.sin(t) * R));
    }
    grp.add(line(ring, col));
    grp.add(marker(c, col, 0.014));
    grp.add(line([c, ring[0]], col, true));
    value = R;
    text = 'R ' + fmtLen(R) + '\nD ' + fmtLen(2 * R) + '\nL ' + fmtLen(meta.L);
    grp.add(label(text + '\nпогрешность ' + meta.rms.toFixed(3) + ' мм', c.clone().addScaledVector(nrm, radius * 0.06), col));
  }
  annoRoot.add(grp);
  return { grp, text, value };
}

function addAnno(type, pts, meta) {
  const d = drawAnno(type, pts, meta);
  annos.push({ id: annoId++, type, pts: pts.map(p => p.clone()), meta: Object.assign({}, meta), grp: d.grp, text: d.text, value: d.value });
  postAnnos(); postState();
}
function removeAnno(id) {
  const a = annos.find(x => x.id === id); if (!a) return;
  disposeGrp(a.grp); annoRoot.remove(a.grp);
  annos = annos.filter(x => x.id !== id); postAnnos(); postState();
}
function disposeGrp(g) { g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
function clearAnnos(silent) {
  annos.forEach(a => { disposeGrp(a.grp); annoRoot.remove(a.grp); });
  annos = []; dropPending();
  if (!silent) { postAnnos(); postState(); }
}
function dropPending() { if (pending && pending.marker) { annoRoot.remove(pending.marker); disposeGrp(pending.marker); } pending = null; }
function postAnnos() { post({ type: 'measures', list: annos.map(a => ({ id: a.id, type: a.type, text: a.text.replace(/\n/g, ' · '), d: a.value })) }); }

function setHint(t) { post({ type: 'measureHint', text: t || '' }); }

function handleTap(x, y) {
  if (mode === 'select') {
    const h = surfaceHit(x, y);
    if (!h) { clearSelection(); return; }
    selectPart(parts.findIndex(p => p.mesh === h.object));
    return;
  }
  const sn = snapHit(x, y);
  if (!sn) { setHint('Промах — тапните по модели'); return; }

  if (mode === 'point') { addPoint(sn); return; }

  if (mode === 'measure') {
    if (!pending) {
      pending = { point: sn.point.clone(), kind: sn.kind, marker: marker(sn.point, kindColor(sn.kind)) };
      annoRoot.add(pending.marker);
      setHint('Вторая точка (' + kindRu(sn.kind) + ' поймана)');
      return;
    }
    addAnno('dist', [pending.point, sn.point], { ka: pending.kind, kb: sn.kind });
    dropPending(); setHint(MODE_HINT.measure);
    return;
  }

  if (mode === 'angle') {
    const isEdge = sn.kind === 'edge' && sn.edge;
    const dir = isEdge ? sn.edge.b.clone().sub(sn.edge.a).normalize() : faceNormal(sn.hit);
    const kind = isEdge ? 'edge' : 'face';
    if (!pending) {
      pending = { point: sn.point.clone(), dir, kind, marker: marker(sn.point, COL.angle) };
      annoRoot.add(pending.marker);
      setHint('Второе ребро или грань (первое: ' + (isEdge ? 'ребро' : 'грань') + ')');
      return;
    }
    const o = pending.point.clone().add(sn.point).multiplyScalar(0.5);
    addAnno('angle', [o, o.clone().add(pending.dir), o.clone().add(dir)], { k1: pending.kind === 'edge' ? 'edge' : 'surface', k2: kind === 'edge' ? 'edge' : 'surface' });
    dropPending(); setHint(MODE_HINT.angle);
    return;
  }

  if (mode === 'min') {
    if (sn.kind !== 'edge' || !sn.edge) { setHint('Нужно попасть в ребро (голубой маркер)'); return; }
    const topo = sn.part.topo;
    const chain = chainOf(topo, sn.edge);
    if (!pending) {
      pending = { chain, point: sn.point.clone(), marker: marker(sn.point, COL.min) };
      annoRoot.add(pending.marker);
      setHint('Второе ребро (цепочка из ' + chain.length + ' сегм.)');
      return;
    }
    if (pending.chain === chain) { setHint('Выбрано то же ребро — тапните другое'); return; }
    let best = null, pairs = 0;
    for (const e1 of pending.chain) for (const e2 of chain) {
      if (++pairs > 400000) break;
      const r = segSeg(e1.a, e1.b, e2.a, e2.b);
      if (!best || r.d < best.d) best = r;
    }
    if (!best) { setHint('Не удалось вычислить расстояние'); dropPending(); return; }
    addAnno('min', [best.c1, best.c2], { ka: 'edge', kb: 'edge' });
    dropPending(); setHint(MODE_HINT.min);
    return;
  }

  if (mode === 'radius') {
    if (!sn.part) return;
    const topo = buildTopo(sn.part);
    if (!topo || !topo.comps.length) { setHint('Острых рёбер не найдено. Снизьте порог угла в Настройках.'); return; }
    let bestC = null, bestD = Infinity;
    for (const c of topo.comps) {
      if (c.verts.length < 8) continue;
      let d = Infinity;
      for (const v of c.verts) { const dd = v.distanceTo(sn.point); if (dd < d) d = dd; }
      if (d < bestD) { bestD = d; bestC = c; }
    }
    if (!bestC) { setHint('Рядом нет замкнутого контура из рёбер'); return; }
    const f = fitCircle(bestC.verts);
    if (!f) { setHint('Контур не похож на окружность'); return; }
    if (f.rms / f.R > 0.03 || f.planarRms > f.R * 0.03) {
      setHint('Это не окружность (отклонение ' + (100 * f.rms / f.R).toFixed(1) + '%). Тапните ближе к круговому ребру.');
      return;
    }
    let L;
    if (bestC.closed) L = 2 * Math.PI * f.R;
    else { L = 0; bestC.edges.forEach(e => { L += e.a.distanceTo(e.b); }); }
    addAnno('circle', [f.center], { R: f.R, L, n: f.normal.toArray(), u: f.u.toArray(), rms: f.rms, closed: bestC.closed });
    setHint(bestC.closed ? 'Окружность найдена. Тапните следующую.' : 'Дуга найдена. Тапните следующую.');
    return;
  }
}

function createPoint(pt, kind, id) {
  const grp = new THREE.Group();
  grp.add(marker(pt, kindColor(kind)));
  const o = pt.clone().add(modelOffset);
  grp.add(label(o.x.toFixed(1) + '\n' + o.y.toFixed(1) + '\n' + o.z.toFixed(1), pt.clone().add(new THREE.Vector3(0, 0, radius * 0.06)), kindColor(kind)));
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
  pointRoot.remove(p.grp); disposeGrp(p.grp);
  points = points.filter(x => x.id !== id);
  lastPoint = points.length ? { p: points[points.length - 1].p, orig: points[points.length - 1].p.clone().add(modelOffset), kind: points[points.length - 1].kind } : null;
  renderPointPanel(); postPoints(); postState();
}
function clearPoints(silent) {
  points.forEach(p => { pointRoot.remove(p.grp); disposeGrp(p.grp); });
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
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: 0.85 })));
    mesh.userData.axis = ax; sectionRoot.add(mesh);
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
  sectionRoot.children.forEach(m => {
    const ax = m.userData.axis, st = sectionState[ax], o = st.off * half[AX[ax]];
    m.visible = sectionState.show && st.on;
    m.position.set(0, 0, 0); m.rotation.set(0, 0, 0);
    if (ax === 'x') { m.rotation.y = Math.PI / 2; m.position.x = o; }
    else if (ax === 'y') { m.rotation.x = -Math.PI / 2; m.position.y = o; }
    else m.position.z = o;
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
  if (mode === 'select') {
    if (now - lastTap < 320) { clearTimeout(pickTimer); lastTap = 0; fit(); }
    else { lastTap = now; clearTimeout(pickTimer); pickTimer = setTimeout(() => handleTap(x, y), 240); }
    return;
  }
  handleTap(x, y);
});
canvas.addEventListener('pointercancel', e => { active.delete(e.pointerId); tapOk = false; if (active.size === 0) multi = false; });

let stateTimer = 0;
function gatherState() {
  const colors = {}, hidden = [];
  parts.forEach((p, i) => { const h = '#' + p.mesh.material.color.getHexString(); if (h !== p.baseColor) colors[i] = h; if (!p.visible) hidden.push(i); });
  return {
    v: 3, colors, hidden, snap: snapOn, section: sectionState,
    annos: annos.map(a => ({ id: a.id, type: a.type, pts: a.pts.map(p => p.toArray()), meta: a.meta })),
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
    clearAnnos(true); clearPoints(true);
    if (s.annos) s.annos.forEach(a => {
      const pts = a.pts.map(x => new THREE.Vector3().fromArray(x));
      const d = drawAnno(a.type, pts, a.meta || {});
      annos.push({ id: a.id || annoId++, type: a.type, pts, meta: a.meta || {}, grp: d.grp, text: d.text, value: d.value });
      annoId = Math.max(annoId, (a.id || 0) + 1);
    });
    if (s.points) s.points.forEach(p => createPoint(new THREE.Vector3().fromArray(p.p), p.kind || 'surface', p.id || pointId++));
    if (s.cam) {
      orthoOn = !!s.cam.ortho; camera = orthoOn ? ortho : persp; controls.object = camera;
      camera.position.fromArray(s.cam.pos); controls.target.fromArray(s.cam.target);
      if (s.cam.halfH) halfH = s.cam.halfH; if (s.cam.zoom) ortho.zoom = s.cam.zoom;
      resize(); controls.update();
    }
    if (selected >= 0 && parts[selected] && !parts[selected].visible) clearSelection();
    postAnnos(); postPoints(); postVisibility(); renderTree(); renderPointPanel(); postState();
  } catch (e) { post({ type: 'toast', text: 'Не удалось применить сохранённое состояние' }); }
}
function resetEdits() {
  parts.forEach(p => { p.mesh.material.color.set(p.baseColor); p.visible = true; p.mesh.visible = true; });
  clearSelection(); clearAnnos(true); clearPoints(true);
  sectionState = { show: true, axis: 'x', x: { on: false, off: 0, flip: false }, y: { on: false, off: 0, flip: false }, z: { on: false, off: 0, flip: false } };
  rebuildSection(); postAnnos(); postPoints(); postVisibility(); renderTree(); renderPointPanel(); postState();
}

function sendText(kind, filename, lines) {
  const CH = 1500, total = Math.ceil(lines.length / CH);
  for (let s = 0; s < total; s++) post({ type: 'fileChunk', kind, seq: s, total, data: btoa(lines.slice(s * CH, (s + 1) * CH).join('\n') + '\n') });
  post({ type: 'fileDone', kind, name: filename });
}
function sendBinary(kind, filename, bytes) {
  const CH = 96 * 1024, total = Math.ceil(bytes.length / CH);
  for (let s = 0; s < total; s++) {
    const sl = bytes.subarray(s * CH, (s + 1) * CH);
    let bin = ''; for (let i = 0; i < sl.length; i++) bin += String.fromCharCode(sl[i]);
    post({ type: 'fileChunk', kind, seq: s, total, data: btoa(bin) });
  }
  post({ type: 'fileDone', kind, name: filename });
}

function exportSTL() {
  const vis = parts.filter(p => p.visible);
  let total = 0; vis.forEach(p => { const g = p.mesh.geometry; total += (g.index ? g.index.count : g.attributes.position.count) / 3; });
  if (!total) { post({ type: 'toast', text: 'Нет видимых деталей' }); return; }
  if (limits.stl && total > limits.stl) { post({ type: 'toast', text: 'STL: ' + nfmt(total) + ' треуг. > лимита ' + nfmt(limits.stl) }); return; }
  const buf = new ArrayBuffer(84 + total * 50), dv = new DataView(buf);
  dv.setUint32(80, total, true);
  let off = 84;
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), cb = new THREE.Vector3(), ab = new THREE.Vector3();
  vis.forEach(p => {
    const m = p.mesh; m.updateWorldMatrix(true, false);
    const pos = m.geometry.attributes.position, idx = m.geometry.index, mw = m.matrixWorld;
    const cnt = idx ? idx.count : pos.count;
    for (let i = 0; i < cnt; i += 3) {
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
    else if (ch.charCodeAt(0) < 128) r += ch; else r += '_';
  }
  return r;
}

function exportSTEP() {
  const vis = parts.filter(p => p.visible);
  if (!vis.length) { post({ type: 'toast', text: 'Нет видимых деталей' }); return; }
  let total = 0; vis.forEach(p => { const g = p.mesh.geometry; total += (g.index ? g.index.count : g.attributes.position.count) / 3; });
  if (limits.step && total > limits.step) { post({ type: 'toast', text: 'STEP: ' + nfmt(total) + ' треуг. > лимита ' + nfmt(limits.step) }); return; }
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
  const pn = ascii(modelName.replace(/\.[^.]+$/, '')) || 'Model';
  const prod = A("PRODUCT(" + Q(pn) + "," + Q(pn) + ",'',(" + R(pCtx) + "))");
  const pdf = A("PRODUCT_DEFINITION_FORMATION('',''," + R(prod) + ")");
  const pd = A("PRODUCT_DEFINITION('design',''," + R(pdf) + "," + R(pdCtx) + ")");
  const pds = A("PRODUCT_DEFINITION_SHAPE('',''," + R(pd) + ")");
  const lenU = A("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const angU = A("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const solU = A("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const unc = A("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06)," + R(lenU) + ",'distance_accuracy_value','confusion accuracy')");
  const ctx = A("(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((" + R(unc) + "))GLOBAL_UNIT_ASSIGNED_CONTEXT((" + R(lenU) + "," + R(angU) + "," + R(solU) + "))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))");
  const origin = A("CARTESIAN_POINT('',(0.,0.,0.))");
  const zD = A("DIRECTION('',(0.,0.,1.))");
  const xD = A("DIRECTION('',(1.,0.,0.))");
  const items = [A("AXIS2_PLACEMENT_3D(''," + R(origin) + "," + R(zD) + "," + R(xD) + ")")], styled = [];
  const tmp = new THREE.Vector3(), va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const nrm = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  let made = 0;
  vis.forEach(p => {
    const mesh = p.mesh; mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry, pos = geo.attributes.position, idx = geo.index, mw = mesh.matrixWorld;
    const cnt = idx ? idx.count : pos.count;
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
        e = { id: A("EDGE_CURVE(''," + R(vps[a]) + "," + R(vps[b]) + "," + R(ln) + ",.T.)"), a, b };
        emap.set(k, e);
      }
      return e;
    };
    const faces = [];
    for (let i = 0; i < cnt; i += 3) {
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
      for (const pr of [[a, b], [b, c], [c, a]]) {
        const e = getEdge(pr[0], pr[1]);
        if (!e) { ok = false; break; }
        oe.push(A("ORIENTED_EDGE('',*,*," + R(e.id) + "," + (e.a === pr[0] ? '.T.' : '.F.') + ")"));
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
  if (!made) { post({ type: 'toast', text: 'Не удалось построить грани' }); return; }
  const rep = A("ADVANCED_BREP_SHAPE_REPRESENTATION('',(" + items.map(R).join(',') + ")," + R(ctx) + ")");
  A("SHAPE_DEFINITION_REPRESENTATION(" + R(pds) + "," + R(rep) + ")");
  if (styled.length) A("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(" + styled.map(R).join(',') + ")," + R(ctx) + ")");
  const fname = ascii(modelName.replace(/\.[^.]+$/, '')) + '.step';
  const head = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('STEP Viewer faceted export'),'2;1');",
    "FILE_NAME(" + Q(fname) + ",'" + new Date().toISOString().slice(0, 19) + "',('STEP Viewer'),(''),'STEP Viewer','STEP Viewer','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;'];
  sendText('step', fname, head.concat(body, ['ENDSEC;', 'END-ISO-10303-21;']));
  post({ type: 'toast', text: 'STEP готов: ' + nfmt(made) + ' граней' });
}

function renderTree() {
  const body = document.getElementById('treeBody'); if (!body) return;
  body.innerHTML = '';
  if (!treeData) { body.appendChild(el('div', 'phint', 'Откройте модель')); return; }
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
  if (!treeSel.size) { post({ type: 'toast', text: 'Сначала выберите узел' }); return; }
  parts.forEach((p, i) => { p.visible = treeSel.has(i); p.mesh.visible = p.visible; });
  postVisibility(); postState(); renderTree();
}
function showAllParts() { parts.forEach(p => { p.visible = true; p.mesh.visible = true; }); postVisibility(); postState(); renderTree(); }
function postVisibility() { post({ type: 'visibility', arr: parts.map(p => p.visible) }); }
function setTreeOpen(on) { treeOpen = !!on; document.getElementById('treePanel').classList.toggle('hidden', !treeOpen); if (treeOpen) renderTree(); post({ type: 'tree', open: treeOpen }); }

function renderPointPanel() {
  const panel = document.getElementById('pointPanel'), body = document.getElementById('pointBody');
  if (mode !== 'point') { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  body.innerHTML = '';
  if (lastPoint) {
    const o = lastPoint.orig, card = el('div', 'pcard');
    card.appendChild(el('span', 'badge ' + lastPoint.kind, kindRu(lastPoint.kind)));
    const g = el('div', 'pgrid');
    ['X', 'Y', 'Z'].forEach((ax, i) => {
      const row = el('div', 'prow'); row.appendChild(el('span', 'pax', ax));
      const val = el('span', 'pval', o.getComponent(i).toFixed(3)); val.appendChild(el('span', 'punit', 'мм'));
      row.appendChild(val); g.appendChild(row);
    });
    card.appendChild(g);
    const copy = el('button', 'copybtn', 'Копировать XYZ');
    copy.addEventListener('click', () => post({ type: 'copy', text: o.x.toFixed(3) + ', ' + o.y.toFixed(3) + ', ' + o.z.toFixed(3) }));
    card.appendChild(copy); body.appendChild(card);
  } else {
    body.appendChild(el('div', 'phint', 'Тапните по модели.\nЗелёный — вершина, голубой — ребро, жёлтый — поверхность.'));
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
    const cl = el('button', 'pbtn', 'Очистить точки'); cl.style.margin = '6px'; cl.style.width = 'calc(100% - 12px)';
    cl.addEventListener('click', () => clearPoints(false)); body.appendChild(cl);
  }
}
function setModeInternal(m) {
  const allowed = ['select', 'measure', 'point', 'angle', 'min', 'radius'];
  mode = allowed.indexOf(m) >= 0 ? m : 'select';
  dropPending();
  if (mode !== 'select') setHint(MODE_HINT[mode]);
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
  setLimits: o => {
    if (!o) return;
    const pick = (v, d) => { const n = Number(v); return isFinite(n) && n >= 0 ? n : d; };
    limits.model = Math.round(pick(o.model, limits.model));
    limits.stl = Math.round(pick(o.stl, limits.stl));
    limits.step = Math.round(pick(o.step, limits.step));
    limits.edges = Math.round(pick(o.edges, limits.edges));
    limits.sharp = clamp(pick(o.sharp, limits.sharp), 1, 89);
    parts.forEach(p => { p.topo = null; });
  },
  setPartsVisible: arr => { parts.forEach((p, i) => { p.visible = arr[i] !== false; p.mesh.visible = p.visible; }); if (selected >= 0 && parts[selected] && !parts[selected].visible) clearSelection(); postVisibility(); postState(); renderTree(); },
  clearSelection,
  setColor: hex => { if (selected < 0 || !parts[selected]) return; parts[selected].mesh.material.color.set(hex); post({ type: 'color', index: selected, color: hex }); postState(); },
  setSection: s => { sectionState = Object.assign(sectionState, s || {}); rebuildSection(); postState(); },
  clearMeasures: () => clearAnnos(false),
  deleteMeasure: removeAnno,
  clearPoints: () => clearPoints(false),
  deletePoint,
  requestState: () => post({ type: 'state', state: gatherState() }),
  applyState, resetEdits, exportSTL, exportSTEP
};
post({ type: 'ready' });
