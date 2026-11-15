const { app, BrowserWindow, protocol, ipcMain, dialog, Menu, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

const RENDERER = path.join(__dirname, 'renderer');
const MODEL_EXT = ['step', 'stp', 'iges', 'igs', 'brep'];

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const state = { modelPath: null, win: null };
let store = { settings: {}, recent: [], bounds: null };

function storeFile() { return path.join(app.getPath('userData'), 'store.json'); }
function loadStore() {
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(storeFile(), 'utf8'))); } catch (e) {}
  if (!store.settings || typeof store.settings !== 'object') store.settings = {};
  if (!Array.isArray(store.recent)) store.recent = [];
}
function saveStore() {
  try { fs.mkdirSync(path.dirname(storeFile()), { recursive: true }); fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2)); } catch (e) {}
}

const DEFAULTS = { maxTrisModel: 1500000, maxTrisStl: 600000, maxTrisStep: 20000, maxTrisEdges: 400000, sharpAngle: 20, quality: 0.001, dark: true };
function settings() { return Object.assign({}, DEFAULTS, store.settings); }

function mime(p) {
  const e = path.extname(p).slice(1).toLowerCase();
  return ({ html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', wasm: 'application/wasm', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', map: 'application/json' })[e] || 'application/octet-stream';
}
const TEXTUAL = new Set(['html', 'js', 'mjs', 'css', 'json', 'svg', 'map']);

async function serveFile(full, type) {
  let st;
  try { st = await fsp.stat(full); } catch (e) { return new Response('Not found', { status: 404 }); }
  if (!st.isFile()) return new Response('Not found', { status: 404 });
  const ext = path.extname(full).slice(1).toLowerCase();
  const headers = {
    'Content-Type': type || mime(full),
    'Content-Length': String(st.size),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  };
  if (st.size > 4 * 1024 * 1024) {
    return new Response(Readable.toWeb(fs.createReadStream(full)), { status: 200, headers });
  }
  const buf = await fsp.readFile(full);
  return new Response(TEXTUAL.has(ext) ? buf.toString('utf8') : buf, { status: 200, headers });
}

function pushRecent(p) {
  store.recent = [p].concat(store.recent.filter(x => x !== p)).slice(0, 12);
  saveStore();
}
async function metaFor(p) {
  const st = await fsp.stat(p);
  return { path: p, name: path.basename(p), size: st.size, mtime: st.mtimeMs };
}
async function adoptModel(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!MODEL_EXT.includes(ext)) throw new Error('Неподдерживаемое расширение: .' + ext);
  const meta = await metaFor(p);
  state.modelPath = p;
  pushRecent(p);
  if (state.win) state.win.setTitle(meta.name + ' — STEP Viewer');
  return meta;
}

function createWindow() {
  const b = store.bounds || {};
  const win = new BrowserWindow({
    width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y,
    minWidth: 1024, minHeight: 680,
    backgroundColor: '#0b0f15',
    show: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  state.win = win;
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  const persist = () => {
    if (!win.isDestroyed()) {
      store.bounds = Object.assign({}, win.getNormalBounds(), { maximized: win.isMaximized() });
      saveStore();
    }
  };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('close', persist);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL('app://local/index.html');
}

function buildMenu() {
  const send = (id) => () => { if (state.win) state.win.webContents.send('menu', id); };
  const template = [
    {
      label: 'Файл', submenu: [
        { label: 'Открыть модель…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Открыть заново', accelerator: 'CmdOrCtrl+R', click: send('reload') },
        { type: 'separator' },
        { label: 'Сохранить проект…', accelerator: 'CmdOrCtrl+S', click: send('saveProject') },
        { label: 'Загрузить проект…', accelerator: 'CmdOrCtrl+Shift+O', click: send('loadProject') },
        { type: 'separator' },
        { label: 'Экспорт STL…', accelerator: 'CmdOrCtrl+E', click: send('exportStl') },
        { label: 'Экспорт STEP…', accelerator: 'CmdOrCtrl+Shift+E', click: send('exportStep') },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' }
      ]
    },
    {
      label: 'Вид', submenu: [
        { label: 'Вписать', accelerator: 'F', click: send('fit') },
        { label: 'Изометрия', accelerator: '1', click: send('iso') },
        { label: 'Спереди', accelerator: '2', click: send('front') },
        { label: 'Сверху', accelerator: '3', click: send('top') },
        { label: 'Справа', accelerator: '4', click: send('right') },
        { type: 'separator' },
        { label: 'Каркас', accelerator: 'W', click: send('wire') },
        { label: 'Рёбра', accelerator: 'E', click: send('edges') },
        { label: 'Ортографическая проекция', accelerator: 'O', click: send('ortho') },
        { label: 'Сетка и оси', accelerator: 'G', click: send('grid') },
        { label: 'Тёмный фон', accelerator: 'B', click: send('dark') },
        { type: 'separator' },
        { label: 'Дерево сборки', accelerator: 'CmdOrCtrl+T', click: send('tree') },
        { label: 'Свойства модели', accelerator: 'CmdOrCtrl+I', click: send('props') }
      ]
    },
    {
      label: 'Инструменты', submenu: [
        { label: 'Выбор', accelerator: 'CmdOrCtrl+1', click: send('mode:select') },
        { label: 'Расстояние', accelerator: 'CmdOrCtrl+2', click: send('mode:measure') },
        { label: 'Точка XYZ', accelerator: 'CmdOrCtrl+3', click: send('mode:point') },
        { label: 'Угол', accelerator: 'CmdOrCtrl+4', click: send('mode:angle') },
        { label: 'Минимальное расстояние', accelerator: 'CmdOrCtrl+5', click: send('mode:min') },
        { label: 'Радиус и длина окружности', accelerator: 'CmdOrCtrl+6', click: send('mode:radius') },
        { type: 'separator' },
        { label: 'Привязка к вершинам и рёбрам', accelerator: 'S', click: send('snap') },
        { label: 'Очистить измерения', click: send('clearMeasures') },
        { type: 'separator' },
        { label: 'Настройки…', accelerator: 'CmdOrCtrl+,', click: send('settings') }
      ]
    },
    {
      label: 'Справка', submenu: [
        { label: 'О программе', click: send('about') },
        { label: 'Открыть папку настроек', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { label: 'Инструменты разработчика', accelerator: 'F12', click: () => state.win && state.win.webContents.toggleDevTools() }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  loadStore();

  protocol.handle('app', async (req) => {
    try {
      const u = new URL(req.url);
      if (u.hostname === 'model') {
        if (!state.modelPath) return new Response('No model', { status: 404 });
        return serveFile(state.modelPath, 'application/octet-stream');
      }
      let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (!rel) rel = 'index.html';
      const full = path.normalize(path.join(RENDERER, rel));
      if (!full.startsWith(RENDERER)) return new Response('Forbidden', { status: 403 });
      return serveFile(full);
    } catch (e) {
      return new Response('Error: ' + e.message, { status: 500 });
    }
  });

  ipcMain.handle('model:open', async () => {
    const r = await dialog.showOpenDialog(state.win, {
      title: 'Открыть 3D-модель',
      properties: ['openFile'],
      filters: [
        { name: 'CAD модели', extensions: MODEL_EXT },
        { name: 'STEP', extensions: ['step', 'stp'] },
        { name: 'IGES', extensions: ['iges', 'igs'] },
        { name: 'BREP', extensions: ['brep'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePaths.length) return null;
    return adoptModel(r.filePaths[0]);
  });

  ipcMain.handle('model:openPath', async (_e, p) => { try { return await adoptModel(p); } catch (e) { return { error: e.message }; } });

  ipcMain.handle('file:saveText', async (_e, name, text, filters) => {
    const r = await dialog.showSaveDialog(state.win, { defaultPath: name, filters: filters || [{ name: 'Файл', extensions: ['*'] }] });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, text, 'utf8');
    return { path: r.filePath, bytes: Buffer.byteLength(text, 'utf8') };
  });

  ipcMain.handle('file:saveBinary', async (_e, name, b64, filters) => {
    const r = await dialog.showSaveDialog(state.win, { defaultPath: name, filters: filters || [{ name: 'Файл', extensions: ['*'] }] });
    if (r.canceled || !r.filePath) return null;
    const buf = Buffer.from(b64, 'base64');
    await fsp.writeFile(r.filePath, buf);
    return { path: r.filePath, bytes: buf.length };
  });

  ipcMain.handle('file:readText', async () => {
    const r = await dialog.showOpenDialog(state.win, {
      title: 'Загрузить проект', properties: ['openFile'],
      filters: [{ name: 'Проект STEP Viewer', extensions: ['json'] }, { name: 'Все файлы', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths.length) return null;
    return { name: path.basename(r.filePaths[0]), text: await fsp.readFile(r.filePaths[0], 'utf8') };
  });

  ipcMain.handle('settings:get', () => settings());
  ipcMain.handle('settings:set', (_e, s) => { store.settings = Object.assign({}, store.settings, s || {}); saveStore(); return settings(); });
  ipcMain.handle('recent:get', async () => {
    const out = [];
    for (const p of store.recent) { try { out.push(await metaFor(p)); } catch (e) {} }
    store.recent = out.map(x => x.path); saveStore();
    return out;
  });
  ipcMain.handle('recent:clear', () => { store.recent = []; saveStore(); return []; });
  ipcMain.handle('shell:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); return true; });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, userData: app.getPath('userData') }));

  buildMenu();
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
