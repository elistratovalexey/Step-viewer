import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('c');
const post = (m) => { try { window.AndroidBridge && window.AndroidBridge.post(JSON.stringify(m)); } catch (e) {} };
window.addEventListener('error', e => post({ type: 'error', text: String(e.message) }));

/* ---------- рендерер и сцена ---------- */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const BG_DARK = 0x1b1e23, BG_LIGHT = 0xeef1f5;
scene.background = new THREE.Color(BG_DARK);

const persp = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
let camera = persp, halfH = 1;
for (const c of [persp, ortho]) { c.up.set(0, 0, 1); c.position.set(1, -1, 0.8); }

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.rotateSpeed = 0.85;
controls.panSpeed = 0.9;

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.7); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-1, 1, -1); scene.add(fill);

let grid = null;
const axes = new THREE.AxesHelper(1); axes.visible = false; scene.add(axes);

const modelRoot = new THREE.Group(); scene.add(modelRoot);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x11161c });

let parts = [];
let radius = 1, triCount = 0;
let wireOn = false, edgesOn = false, orthoOn = false, gridOn = false, darkOn = true;
let deflection = 0.001;

/* ---------- OpenCascade (WASM) ---------- */
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

/* ---------- загрузка модели ---------- */
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

async function open(url, name) {
  try {
    post({ type: 'status', text: 'Чтение файла…' });
    await nextFrame();
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error('Не удалось прочитать файл (' + resp.status + ')');
    const data = new Uint8Array(await resp.arrayBuffer());

    post({ type: 'status', text: 'Запуск ядра OpenCascade…' });
    await nextFrame();
    const occt = await getOcct();

    post({ type: 'status', text: 'Разбор геометрии и триангуляция…' });
    await nextFrame();

    const t0 = performance.now();
    const ext = (name.split('.').pop() || '').toLowerCase();
    const fn = (ext === 'igs' || ext === 'iges') ? 'ReadIgesFile'
             : (ext === 'brep') ? 'ReadBrepFile' : 'ReadStepFile';
    const params = {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: deflection,
      angularDeflection: 0.5
    };
    let res;
    const reader = occt[fn];
    try { res = reader.call(occt, data, params); } catch (e) { res = reader.call(occt, data, null); }

    if (!res || !res.success || !res.meshes || !res.meshes.length)
      throw new Error('В файле не найдена геометрия либо формат не поддерживается.');

    build(res);
    post({
      type: 'loaded',
      parts: parts.map(p => p.name),
      triangles: triCount,
      bbox: dims,
      time: performance.now() - t0
    });
  } catch (err) {
    post({ type: 'error', text: (err && err.message) ? err.message : String(err) });
  }
}

let dims = [0, 0, 0];

function build(res) {
  clearModel();
  const g = new THREE.Group();
  triCount = 0;

  res.meshes.forEach((m, i) => {
    const pos = m.attributes && m.attributes.position && m.attributes.position.array;
    if (!pos || pos.length < 9) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const nrm = m.attributes.normal && m.attributes.normal.array;
    if (nrm && nrm.length === pos.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    else geo.computeVertexNormals();
    const idx = m.index && m.index.array;
    if (idx && idx.length) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));

    const color = new THREE.Color(0x9fb0c0);
    if (m.color && m.color.length >= 3)
      color.setRGB(m.color[0], m.color[1], m.color[2], THREE.SRGBColorSpace);

    const mat = new THREE.MeshPhongMaterial({
      color, specular: 0x2a2a2a, shininess: 28,
      side: THREE.DoubleSide, wireframe: wireOn
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = (m.name && m.name.trim()) ? m.name : 'Деталь ' + (i + 1);
    g.add(mesh);
    parts.push({ mesh, name: mesh.name, edges: null, visible: true, tris: (idx ? idx.length : pos.length / 3) / 3 });
    triCount += (idx ? idx.length : pos.length / 3) / 3;
  });

  if (!parts.length) throw new Error('Не удалось построить ни одной поверхности.');

  const box = new THREE.Box3().setFromObject(g);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  g.position.sub(center);
  modelRoot.add(g);

  dims = [size.x, size.y, size.z];
  radius = Math.max(size.length() / 2, 1e-3);
  triCount = Math.round(triCount);

  makeGrid(radius * 3);
  if (edgesOn) applyEdges();
  fit(new THREE.Vector3(1, -1, 0.8));
}

function clearModel() {
  modelRoot.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && o.material !== edgeMat) o.material.dispose();
  });
  modelRoot.clear();
  parts = [];
  triCount = 0;
}

/* ---------- отображение ---------- */
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
  grid = new THREE.GridHelper(s, 20, 0x5a6472, 0x39414c);
  grid.rotation.x = Math.PI / 2;
  grid.visible = gridOn;
  scene.add(grid);
  axes.scale.setScalar(s / 4);
  axes.visible = gridOn;
}

const VIEWS = {
  iso: [1, -1, 0.8], front: [0, -1, 0.0001], back: [0, 1, 0.0001],
  top: [0, -0.0001, 1], bottom: [0, 0.0001, -1], right: [1, 0, 0.0001], left: [-1, 0, 0.0001]
};

function fit(dirVec) {
  if (!parts.length) return;
  const dir = (dirVec ? dirVec.clone() : camera.position.clone().sub(controls.target));
  if (dir.lengthSq() < 1e-12) dir.set(1, -1, 0.8);
  dir.normalize();
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(persp.fov) / 2) * 1.15;
  controls.target.set(0, 0, 0);
  persp.position.copy(dir).multiplyScalar(dist);
  ortho.position.copy(dir).multiplyScalar(dist);
  persp.near = Math.max(dist / 5000, 0.001);
  persp.far = dist * 20 + radius * 20;
  persp.updateProjectionMatrix();
  ortho.near = -dist * 20; ortho.far = dist * 20; ortho.zoom = 1;
  halfH = radius * 1.15;
  resize();
  controls.update();
}

function resize() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  const a = w / Math.max(h, 1);
  persp.aspect = a; persp.updateProjectionMatrix();
  ortho.left = -halfH * a; ortho.right = halfH * a;
  ortho.top = halfH; ortho.bottom = -halfH;
  ortho.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);

function tick() {
  requestAnimationFrame(tick);
  if (document.hidden) return;
  controls.update();
  key.position.copy(camera.position);
  renderer.render(scene, camera);
}
resize(); tick();

/* двойной тап — вписать */
let lastTap = 0;
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType !== 'touch') return;
  const now = Date.now();
  if (now - lastTap < 300) fit();
  lastTap = now;
});

/* ---------- API для Kotlin ---------- */
window.SV = {
  open,
  clear: clearModel,
  fit: () => fit(),
  setView: (k) => { const v = VIEWS[k] || VIEWS.iso; fit(new THREE.Vector3(v[0], v[1], v[2])); },
  setWireframe: (on) => { wireOn = !!on; parts.forEach(p => p.mesh.material.wireframe = wireOn); },
  setEdges: (on) => { edgesOn = !!on; applyEdges(); },
  setOrtho: (on) => {
    orthoOn = !!on;
    const next = orthoOn ? ortho : persp;
    if (next !== camera) {
      next.position.copy(camera.position);
      next.up.copy(camera.up);
      camera = next;
      controls.object = camera;
      controls.update();
    }
  },
  setGrid: (on) => { gridOn = !!on; if (grid) grid.visible = gridOn; axes.visible = gridOn; },
  setDark: (on) => { darkOn = !!on; scene.background = new THREE.Color(darkOn ? BG_DARK : BG_LIGHT); },
  setQuality: (v) => { deflection = Number(v) || 0.001; },
  setPartsVisible: (arr) => {
    parts.forEach((p, i) => {
      const v = arr[i] !== false;
      p.visible = v; p.mesh.visible = v;
    });
  }
};

post({ type: 'ready' });
