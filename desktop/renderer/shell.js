const D = window.desktop;
const $ = (id) => document.getElementById(id);
const qsa = (s) => Array.from(document.querySelectorAll(s));
const nf = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const mb = (b) => (b / 1048576).toFixed(2) + ' МБ';

const S = {
  ready: false, model: null, mode: 'select',
  snap: true, tree: true, wire: false, edges: false, ortho: false, grid: false, dark: true,
  quality: 0.001, sharp: 20,
  limits: { model: 1500000, stl: 600000, step: 20000, edges: 400000 },
  sec: { show: true, axis: 'x', x: { on: false, off: 0, flip: false }, y: { on: false, off: 0, flip: false }, z: { on: false, off: 0, flip: false } },
  names: [], visible: [], meas: [], sel: -1, selName: '',
  props: null, state: '', fileBuf: [], appInfo: null
};

const PALETTE = [
  ['Стальной', '#9fb0c0'], ['Красный', '#e53935'], ['Оранжевый', '#fb8c00'], ['Жёлтый', '#fdd835'], ['Зелёный', '#43a047'],
  ['Бирюзовый', '#00acc1'], ['Синий', '#1e88e5'], ['Фиолетовый', '#8e24aa'], ['Белый', '#f5f5f5'], ['Графит', '#455a64']
];
const HINTS = {
  select: '', measure: 'Тапните первую точку', point: 'Тапните точку для координат XYZ',
  angle: 'Тапните первое ребро или грань', min: 'Тапните первое ребро', radius: 'Тапните по круговому ребру или цилиндру'
};
const ICONS = { dist: '↔', min: '⇢', angle: '∠', circle: '◯' };

function sv(call) { if (window.SV) { try { window.SV[call.fn].apply(null, call.args || []); } catch (e) { toast(e.message, 'err'); } } }
function js(fn, ...args) { sv({ fn, args }); }

function toast(text, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.transition = '.3s'; t.style.opacity = '0'; t.style.transform = 'translateX(24px)'; setTimeout(() => t.remove(), 320); }, kind === 'err' ? 6000 : 3200);
}
function status(l, r) { if (l !== undefined) $('statusLeft').textContent = l; if (r !== undefined) $('statusRight').textContent = r; }

function dialog(title, bodyNode, buttons) {
  const inner = $('dlgInner');
  inner.innerHTML = '';
  const h = document.createElement('div'); h.className = 'dlgHead'; h.textContent = title;
  const b = document.createElement('div'); b.className = 'dlgBody'; b.appendChild(bodyNode);
  const f = document.createElement('div'); f.className = 'dlgFoot';
  (buttons || [{ label: 'Закрыть' }]).forEach(btn => {
    const el = document.createElement('button');
    el.className = 'dlgBtn' + (btn.primary ? ' primary' : '');
    el.textContent = btn.label;
    el.onclick = () => { if (!btn.action || btn.action() !== false) $('dlg').close(); };
    f.appendChild(el);
  });
  inner.append(h, b, f);
  $('dlg').showModal();
}

function limitsPayload() {
  return { model: S.limits.model, stl: S.limits.stl, step: S.limits.step, edges: S.limits.edges, sharp: S.sharp };
}
function pushAll() {
  js('setWireframe', S.wire); js('setEdges', S.edges); js('setOrtho', S.ortho);
  js('setGrid', S.grid); js('setDark', S.dark); js('setQuality', S.quality);
  js('setSnap', S.snap); js('setMode', S.mode); js('setSection', S.sec);
  js('setLimits', limitsPayload());
  js('setTreeOpen', S.tree);
}

function chip(el, on) { if (el) el.classList.toggle('on', !!on); }
function syncDeck() {
  qsa('[data-mode]').forEach(b => chip(b, b.dataset.mode === S.mode));
  chip($('btnSnap'), S.snap); chip($('btnTree'), S.tree); chip($('btnWire'), S.wire);
  chip($('btnEdges'), S.edges); chip($('btnOrtho'), S.ortho); chip($('btnGrid'), S.grid); chip($('btnDark'), S.dark);
  qsa('[data-axis]').forEach(b => chip(b, b.dataset.axis === S.sec.axis));
  const a = S.sec[S.sec.axis];
  chip($('secEnable'), a.on); chip($('secFlip'), a.flip); chip($('secShow'), S.sec.show);
  $('secSeek').value = Math.round(a.off * 100);
  $('secVal').textContent = Math.round(a.off * 100) + '%';
  $('sharpRange').value = S.sharp;
  $('sharpVal').textContent = S.sharp + '°';
  $('qualitySel').value = String(S.quality);
  const h = HINTS[S.mode] || '';
  $('hint').textContent = h;
  $('hint').classList.toggle('hidden', !h || !S.model);
}
function setMode(m) { S.mode = m; js('setMode', m); syncDeck(); }
function pushSec() { js('setSection', S.sec); syncDeck(); }
function pushVis() { js('setPartsVisible', S.visible); }

async function persist() {
  await D.setSettings({
    maxTrisModel: S.limits.model, maxTrisStl: S.limits.stl, maxTrisStep: S.limits.step,
    maxTrisEdges: S.limits.edges, sharpAngle: S.sharp, quality: S.quality, dark: S.dark
  });
}

function modelUrl() { return 'app://model/current.bin?v=' + Date.now(); }
function loadCurrent() {
  if (!S.model) return;
  $('loading').classList.remove('hidden');
  $('loadingText').textContent = 'Открываю ' + S.model.name + '…';
  $('startScreen').classList.add('hidden');
  js('clear');
  js('open', modelUrl(), S.model.name);
}
async function adopt(meta) {
  if (!meta) return;
  if (meta.error) { toast(meta.error, 'err'); return; }
  S.model = meta;
  S.meas = []; S.sel = -1; S.names = []; S.visible = [];
  renderMeas(); renderSel();
  $('fileName').textContent = meta.name;
  $('fileMeta').textContent = mb(meta.size);
  document.title = meta.name + ' — STEP Viewer';
  if (S.ready) loadCurrent();
}
async function openDialog() { adopt(await D.openModel()); }
async function openPath(p) { if (p) adopt(await D.openPath(p)); }

function renderMeas() {
  const box = $('measList');
  box.innerHTML = '';
  $('measCount').textContent = String(S.meas.length);
  if (!S.meas.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Измерений нет. Выберите режим внизу.'; box.appendChild(e); return; }
  S.meas.forEach(m => {
    const row = document.createElement('div'); row.className = 'measRow';
    const ic = document.createElement('div'); ic.className = 'measIcon ' + (m.type || 'dist'); ic.textContent = ICONS[m.type] || '•';
    const tx = document.createElement('div'); tx.className = 'measText'; tx.textContent = m.text || '';
    const del = document.createElement('button'); del.className = 'measDel'; del.textContent = '✕'; del.title = 'Удалить';
    del.onclick = () => js('deleteMeasure', m.id);
    row.append(ic, tx, del); box.appendChild(row);
  });
}
function renderSel() {
  const p = $('selPanel');
  if (S.sel < 0) { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  $('selName').textContent = S.selName;
}
function renderProps() {
  const b = $('propsBody');
  b.innerHTML = '';
  if (!S.props) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Модель не загружена'; b.appendChild(e); return; }
  S.props.forEach(([k, v]) => {
    const r = document.createElement('div'); r.className = 'propRow';
    const s = document.createElement('span'); s.textContent = k;
    const t = document.createElement('b'); t.textContent = v;
    r.append(s, t); b.appendChild(r);
  });
}
async function renderRecent() {
  const list = await D.getRecent();
  const box = $('recentList');
  box.innerHTML = '';
  if (!list.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Пока пусто'; box.appendChild(e); return; }
  list.forEach(m => {
    const r = document.createElement('div'); r.className = 'recentItem';
    const n = document.createElement('div'); n.className = 'rn'; n.textContent = m.name; n.title = m.path;
    const s = document.createElement('div'); s.className = 'rs'; s.textContent = mb(m.size);
    r.append(n, s);
    r.onclick = () => openPath(m.path);
    box.appendChild(r);
  });
}

function b64FromChunks(chunks) {
  let total = 0;
  chunks.forEach(c => { total += c.length; });
  const all = new Uint8Array(total);
  let off = 0;
  chunks.forEach(c => { all.set(c, off); off += c.length; });
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < all.length; i += CH) bin += String.fromCharCode.apply(null, all.subarray(i, i + CH));
  return btoa(bin);
}
function decodeB64(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }

async function flushExport(name) {
  const b64 = b64FromChunks(S.fileBuf);
  S.fileBuf = [];
  const ext = name.split('.').pop().toLowerCase();
  const filters = ext === 'stl' ? [{ name: 'STL модель', extensions: ['stl'] }] : [{ name: 'STEP модель', extensions: ['step', 'stp'] }];
  const r = await D.saveBinary(name, b64, filters);
  if (r) { toast('Сохранено: ' + r.path + ' (' + mb(r.bytes) + ')', 'ok'); status('Файл сохранён', r.path); }
}

function settingsDialog() {
  const wrap = document.createElement('div');
  const fields = [
    ['model', 'Макс. треугольников в модели (0 = без лимита)', S.limits.model],
    ['stl', 'Макс. треугольников для экспорта STL', S.limits.stl],
    ['step', 'Макс. треугольников для экспорта STEP', S.limits.step],
    ['edges', 'Макс. треугольников на деталь для рёбер и привязки', S.limits.edges],
    ['sharp', 'Порог острого ребра, градусы (1–89)', S.sharp]
  ];
  const inputs = {};
  fields.forEach(([k, label, val]) => {
    const f = document.createElement('div'); f.className = 'fld';
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.type = 'number'; i.min = '0'; i.value = String(val);
    f.append(l, i); wrap.appendChild(f); inputs[k] = i;
  });
  const note = document.createElement('div'); note.className = 'note';
  note.textContent = 'Если сетка тяжелее лимита, шаг триангуляции укрупняется и разбор повторяется (до 5 попыток). Порог 20° отсекает диагонали триангуляции; для галтелей снизьте до 8–12°. Изменение лимитов модели и рёбер перезагрузит файл.';
  wrap.appendChild(note);

  dialog('Настройки', wrap, [
    { label: 'По умолчанию', action: () => { S.limits = { model: 1500000, stl: 600000, step: 20000, edges: 400000 }; S.sharp = 20; persist(); js('setLimits', limitsPayload()); syncDeck(); loadCurrent(); toast('Значения сброшены'); } },
    { label: 'Отмена' },
    {
      label: 'Сохранить', primary: true, action: () => {
        const num = (i, d, hi) => { const v = parseInt(i.value, 10); return isFinite(v) ? Math.max(0, Math.min(hi, v)) : d; };
        const om = S.limits.model, oe = S.limits.edges;
        S.limits.model = num(inputs.model, S.limits.model, 20000000);
        S.limits.stl = num(inputs.stl, S.limits.stl, 20000000);
        S.limits.step = num(inputs.step, S.limits.step, 20000000);
        S.limits.edges = num(inputs.edges, S.limits.edges, 20000000);
        S.sharp = Math.max(1, Math.min(89, num(inputs.sharp, S.sharp, 89)));
        persist(); js('setLimits', limitsPayload()); syncDeck();
        if (om !== S.limits.model || oe !== S.limits.edges) loadCurrent();
        toast('Настройки сохранены', 'ok');
      }
    }
  ]);
}

async function aboutDialog() {
  const i = S.appInfo || await D.info();
  const w = document.createElement('div');
  const g = document.createElement('div'); g.className = 'aboutGrid';
  [['Версия', i.version], ['Electron', i.electron], ['Chromium', i.chrome], ['Ядро', 'OpenCascade WASM'], ['Рендер', 'three.js / WebGL'], ['Папка настроек', i.userData]]
    .forEach(([k, v]) => { const a = document.createElement('span'); a.textContent = k; const b = document.createElement('b'); b.textContent = v; g.append(a, b); });
  const n = document.createElement('div'); n.className = 'note';
  n.textContent = 'Все вычисления выполняются локально. Геометрия STEP хранится как B-rep, но импортёр отдаёт только триангуляцию, поэтому радиусы и окружности аппроксимируются по контуру острых рёбер, а экспорт STEP пишет гранёную геометрию (FACETED_BREP), а не исходные NURBS.';
  w.append(g, n);
  dialog('STEP Viewer для Windows', w, [{ label: 'Закрыть', primary: true }]);
}

function propsDialog() {
  const w = document.createElement('div');
  if (!S.props) { w.textContent = 'Модель не загружена'; }
  else {
    const g = document.createElement('div'); g.className = 'aboutGrid';
    S.props.forEach(([k, v]) => { const a = document.createElement('span'); a.textContent = k; const b = document.createElement('b'); b.textContent = v; g.append(a, b); });
    w.appendChild(g);
  }
  dialog('Свойства модели', w, [{ label: 'Закрыть', primary: true }]);
}

function onEvent(o) {
  switch (o.type) {
    case 'ready':
      S.ready = true; pushAll(); syncDeck();
      if (S.model) loadCurrent();
      break;
    case 'status': $('loadingText').textContent = o.text || ''; status(o.text || ''); break;
    case 'toast': toast(o.text || ''); break;
    case 'measureHint':
      $('hint').textContent = o.text || '';
      $('hint').classList.toggle('hidden', !o.text || S.mode === 'select');
      status(o.text || '');
      break;
    case 'loaded': {
      $('loading').classList.add('hidden');
      $('startScreen').classList.add('hidden');
      S.names = o.parts || [];
      S.visible = S.names.map(() => true);
      const b = o.bbox || [0, 0, 0];
      S.props = [
        ['Файл', S.model ? S.model.name : '—'],
        ['Размер', S.model ? mb(S.model.size) : '—'],
        ['Деталей', nf(S.names.length)],
        ['Треугольников', nf(o.triangles || 0)],
        ['Шаг триангуляции', (o.deflection || S.quality).toFixed(5)],
        ['Лимит треугольников', S.limits.model ? nf(S.limits.model) : 'без лимита'],
        ['Порог острого ребра', S.sharp + '°'],
        ['Габариты, мм', f2(b[0]) + ' × ' + f2(b[1]) + ' × ' + f2(b[2])],
        ['Время загрузки', f2((o.time || 0) / 1000) + ' с']
      ];
      renderProps();
      status('Модель загружена', nf(S.names.length) + ' дет. · ' + nf(o.triangles || 0) + ' треуг.');
      $('fileMeta').textContent = mb(S.model ? S.model.size : 0) + ' · ' + nf(o.triangles || 0) + ' треуг.';
      syncDeck();
      break;
    }
    case 'error':
      $('loading').classList.add('hidden');
      if (!S.names.length) $('startScreen').classList.remove('hidden');
      toast(o.text || 'Ошибка', 'err');
      status('Ошибка');
      break;
    case 'select':
      S.sel = o.index; S.selName = o.name || ''; renderSel();
      status('Выбрано: ' + S.selName);
      break;
    case 'deselect': S.sel = -1; renderSel(); break;
    case 'treeSelect': status('Узел: ' + o.name + ' · ' + o.count + ' дет.'); break;
    case 'tree': S.tree = !!o.open; syncDeck(); break;
    case 'mode': S.mode = o.mode || 'select'; syncDeck(); break;
    case 'measures': S.meas = o.list || []; renderMeas(); break;
    case 'visibility': S.visible = o.arr || []; break;
    case 'point': status('XYZ: ' + f2(o.x) + ', ' + f2(o.y) + ', ' + f2(o.z)); break;
    case 'copy':
      navigator.clipboard.writeText(o.text || '').then(() => toast('Скопировано', 'ok')).catch(() => toast('Не удалось скопировать', 'err'));
      break;
    case 'state': S.state = JSON.stringify(o.state || {}); break;
    case 'fileChunk':
      if (o.seq === 0) S.fileBuf = [];
      S.fileBuf.push(decodeB64(o.data || ''));
      status('Подготовка файла… ' + (o.seq + 1) + '/' + o.total);
      break;
    case 'fileDone': flushExport(o.name || 'export.bin'); break;
  }
}

function wire() {
  $('btnOpen').onclick = openDialog;
  $('btnOpenStart').onclick = openDialog;
  $('btnLoadProjectStart').onclick = () => loadProject();
  $('btnClearRecent').onclick = async () => { await D.clearRecent(); renderRecent(); };
  $('btnSettings').onclick = settingsDialog;
  $('btnAbout').onclick = aboutDialog;
  $('btnSaveProject').onclick = saveProject;
  $('btnLoadProject').onclick = loadProject;
  $('btnExportStl').onclick = () => { S.fileBuf = []; js('exportSTL'); };
  $('btnExportStep').onclick = () => { S.fileBuf = []; js('exportSTEP'); };

  qsa('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  qsa('[data-view]').forEach(b => b.onclick = () => js('setView', b.dataset.view));
  $('btnFitPad').onclick = () => js('fit');

  $('btnSnap').onclick = () => { S.snap = !S.snap; js('setSnap', S.snap); syncDeck(); };
  $('btnTree').onclick = () => { S.tree = !S.tree; js('setTreeOpen', S.tree); syncDeck(); };
  $('btnWire').onclick = () => { S.wire = !S.wire; js('setWireframe', S.wire); syncDeck(); };
  $('btnEdges').onclick = () => { S.edges = !S.edges; js('setEdges', S.edges); syncDeck(); };
  $('btnOrtho').onclick = () => { S.ortho = !S.ortho; js('setOrtho', S.ortho); syncDeck(); };
  $('btnGrid').onclick = () => { S.grid = !S.grid; js('setGrid', S.grid); syncDeck(); };
  $('btnDark').onclick = () => { S.dark = !S.dark; js('setDark', S.dark); persist(); syncDeck(); };
  $('btnResetEdits').onclick = () => { js('resetEdits'); toast('Правки сброшены'); };

  $('qualitySel').onchange = (e) => { S.quality = parseFloat(e.target.value) || 0.001; js('setQuality', S.quality); persist(); loadCurrent(); };
  $('sharpRange').oninput = (e) => { $('sharpVal').textContent = e.target.value + '°'; };
  $('sharpRange').onchange = (e) => { S.sharp = parseInt(e.target.value, 10) || 20; js('setLimits', limitsPayload()); persist(); toast('Порог ребра: ' + S.sharp + '°'); };

  qsa('[data-axis]').forEach(b => b.onclick = () => { S.sec.axis = b.dataset.axis; pushSec(); });
  $('secEnable').onclick = () => { const a = S.sec[S.sec.axis]; a.on = !a.on; pushSec(); };
  $('secFlip').onclick = () => { const a = S.sec[S.sec.axis]; a.flip = !a.flip; pushSec(); };
  $('secShow').onclick = () => { S.sec.show = !S.sec.show; pushSec(); };
  $('secOff').onclick = () => { ['x', 'y', 'z'].forEach(k => { S.sec[k].on = false; }); pushSec(); };
  $('secSeek').oninput = (e) => { S.sec[S.sec.axis].off = parseInt(e.target.value, 10) / 100; $('secVal').textContent = e.target.value + '%'; js('setSection', S.sec); };

  $('btnMeasClear').onclick = () => js('clearMeasures');
  $('btnMeasCopy').onclick = () => {
    if (!S.meas.length) { toast('Измерений нет'); return; }
    navigator.clipboard.writeText(S.meas.map(m => m.text).join('\n')).then(() => toast('Список скопирован', 'ok'));
  };

  $('btnSelClear').onclick = () => js('clearSelection');
  $('btnSelHide').onclick = () => { if (S.sel >= 0) { S.visible[S.sel] = false; pushVis(); js('clearSelection'); } };
  $('btnSelIsolate').onclick = () => { if (S.sel >= 0) { S.visible = S.visible.map((_, i) => i === S.sel); pushVis(); } };
  $('btnSelShowAll').onclick = () => { S.visible = S.visible.map(() => true); pushVis(); };

  const sw = $('selSwatches');
  PALETTE.forEach(([name, hex]) => {
    const b = document.createElement('button');
    b.className = 'sw'; b.style.background = hex; b.title = name;
    b.onclick = () => js('setColor', hex);
    sw.appendChild(b);
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropZone').classList.remove('hidden'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropZone').classList.add('hidden'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('dropZone').classList.add('hidden');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = D.pathForFile(f);
    if (p) openPath(p); else toast('Не удалось получить путь к файлу', 'err');
  });

  D.onMenu((id) => {
    if (id.startsWith('mode:')) { setMode(id.slice(5)); return; }
    const map = {
      open: openDialog, reload: loadCurrent, saveProject, loadProject,
      exportStl: () => { S.fileBuf = []; js('exportSTL'); },
      exportStep: () => { S.fileBuf = []; js('exportSTEP'); },
      fit: () => js('fit'), iso: () => js('setView', 'iso'), front: () => js('setView', 'front'),
      top: () => js('setView', 'top'), right: () => js('setView', 'right'),
      wire: () => $('btnWire').click(), edges: () => $('btnEdges').click(), ortho: () => $('btnOrtho').click(),
      grid: () => $('btnGrid').click(), dark: () => $('btnDark').click(), tree: () => $('btnTree').click(),
      snap: () => $('btnSnap').click(), clearMeasures: () => js('clearMeasures'),
      settings: settingsDialog, about: aboutDialog, props: propsDialog
    };
    if (map[id]) map[id]();
  });

  window.addEventListener('sv-event', (e) => { try { onEvent(JSON.parse(e.detail)); } catch (err) { console.error(err); } });
  window.addEventListener('resize', () => window.dispatchEvent(new Event('resize')));
}

async function saveProject() {
  if (!S.model) { toast('Модель не открыта'); return; }
  js('requestState');
  setTimeout(async () => {
    const base = S.model.name.replace(/\.[^.]+$/, '');
    const r = await D.saveText(base + '.stepview.json', S.state || '{}', [{ name: 'Проект STEP Viewer', extensions: ['json'] }]);
    if (r) toast('Проект сохранён: ' + r.path, 'ok');
  }, 120);
}
async function loadProject() {
  const r = await D.readText();
  if (!r) return;
  if (!S.model) { toast('Сначала откройте модель, к которой относится проект', 'err'); return; }
  try { JSON.parse(r.text); js('applyState', JSON.parse(r.text)); toast('Проект загрушен: ' + r.name, 'ok'); }
  catch (e) { toast('Файл проекта повреждён', 'err'); }
}

(async function init() {
  const s = await D.getSettings();
  S.limits = { model: s.maxTrisModel, stl: s.maxTrisStl, step: s.maxTrisStep, edges: s.maxTrisEdges };
  S.sharp = s.sharpAngle; S.quality = s.quality; S.dark = s.dark;
  S.appInfo = await D.info();
  $('appVersion').textContent = 'v' + S.appInfo.version;
  wire();
  syncDeck();
  renderMeas();
  renderProps();
  await renderRecent();
  status('Готово · перетащите файл или нажмите «Открыть»', 'OpenCascade WASM · three.js');
})();
