const { app, BrowserWindow, ipcMain, screen, dialog, shell, nativeImage, Tray, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildGraph, resolveLinks, scanVaultAsync, scanVaultIncrementalAsync, makeNode, relId } = require('./lib/parser');

// ─── Logging (file: %APPDATA%/Obsidian Graph Widget/logs/main.log) ─
let log = console;
try {
  log = require('electron-log/main');
  log.initialize();
  log.transports.file.level = 'info';
  log.transports.console.level = app.isPackaged ? false : 'info';
  log.errorHandler.startCatching(); // uncaught exceptions + rejections → log file
} catch (e) { /* logging is best-effort */ }

let mainWindow;
let tray = null;
let vaultPath = null;
let isAlwaysOnTop = false;
let panelVisible = true;
let isQuitting = false;
const startHidden = process.argv.includes('--hidden');

// ─── Single instance ──────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

// ─── Config ───────────────────────────────────────────────────────
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {}
  return {};
}

function saveConfig(data) {
  const existing = loadConfig();
  fs.writeFileSync(configPath, JSON.stringify({ ...existing, ...data }, null, 2));
}

// ─── Startup registration ─────────────────────────────────────────
function setStartup(enable) {
  if (process.platform === 'win32') {
    // Portable build: execPath points to the temp extraction dir —
    // PORTABLE_EXECUTABLE_FILE holds the real exe path.
    // Packaged (installer): execPath is the app exe itself.
    // Dev: execPath is electron.exe — it needs the app folder as argument,
    // otherwise Windows just launches an empty Electron shell.
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const args = app.isPackaged
      ? ['--hidden']
      : [path.resolve(__dirname), '--hidden'];
    app.setLoginItemSettings({
      openAtLogin: enable,
      path: exePath,
      args
    });
  } else if (process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enable });
  }
  saveConfig({ runOnStartup: enable });
  updateTrayMenu();
}

function getStartup() {
  if (process.platform === 'win32') {
    // Must query with the same path/args used in setStartup,
    // otherwise the registry entry is not matched.
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const args = app.isPackaged
      ? ['--hidden']
      : [path.resolve(__dirname), '--hidden'];
    return app.getLoginItemSettings({ path: exePath, args }).openAtLogin;
  }
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().openAtLogin;
  }
  return false;
}

// ─── Graph state, cache & incremental parsing ─────────────────────
// (Parsing itself lives in lib/parser.js — pure and unit-tested.)
let graphState = null;          // { nodes, links } — single source of truth
let parseInFlight = null;

function cacheFilePath() {
  return path.join(app.getPath('userData'), 'graph-cache.json');
}

function graphSignature(g) {
  let mtimeSum = 0;
  for (const n of g.nodes) mtimeSum += n.mtime;
  return `${g.nodes.length}:${g.links.length}:${mtimeSum}`;
}

function loadGraphCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf8'));
    if (c && c.vaultPath === vaultPath && Array.isArray(c.nodes) && Array.isArray(c.links)) {
      return { nodes: c.nodes, links: c.links };
    }
  } catch (e) { /* no/invalid cache is fine */ }
  return null;
}

let cacheSaveTimer = null;
function saveGraphCacheDebounced() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    if (!graphState || !vaultPath) return;
    const payload = JSON.stringify({
      vaultPath, savedAt: Date.now(),
      nodes: graphState.nodes, links: graphState.links
    });
    fs.writeFile(cacheFilePath(), payload, err => {
      if (err) log.warn('cache write failed:', err.message);
    });
  }, 1500);
}

// Throttled parse-progress emitter → renderer (always sends the final
// done===total event so the indicator can clear).
function makeProgressEmitter() {
  let last = 0;
  return (done, total) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const now = Date.now();
    if (done === total || now - last > 120) {
      last = now;
      mainWindow.webContents.send('parse-progress', { done, total });
    }
  };
}

async function fullParse(onProgress = null) {
  if (!vaultPath) return null;
  if (parseInFlight) return parseInFlight;
  parseInFlight = (async () => {
    const t0 = Date.now();
    // Reuse unchanged nodes (mtime match) — only changed files are read.
    const known = new Map((graphState?.nodes || []).map(n => [n.id, n]));
    const nodes = known.size
      ? await scanVaultIncrementalAsync(vaultPath, known, 32, onProgress)
      : buildGraph(await scanVaultAsync(vaultPath, 32, onProgress)).nodes;
    const g = { nodes, links: resolveLinks(nodes) };
    log.info(`vault parsed: ${g.nodes.length} notes, ${g.links.length} links in ${Date.now() - t0}ms (${known.size ? 'incremental' : 'full'})`);
    return g;
  })().finally(() => { parseInFlight = null; });
  return parseInFlight;
}

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault-changed');
  }
}

// Incremental update: re-parse only the changed files, then re-resolve
// links from the stored raw targets (no I/O for unchanged notes).
async function applyFileChanges(changes) {
  if (!graphState || !vaultPath) { notifyRenderer(); return; }
  const byId = new Map(graphState.nodes.map(n => [n.id, n]));

  for (const [id, event] of changes) {
    if (event === 'unlink') {
      byId.delete(id);
      continue;
    }
    try {
      const full = path.join(vaultPath, id);
      const [content, stat] = await Promise.all([
        fs.promises.readFile(full, 'utf8'),
        fs.promises.stat(full)
      ]);
      byId.set(id, makeNode(id, content, stat));
    } catch (e) {
      byId.delete(id); // vanished between event and read
    }
  }

  graphState = { nodes: [...byId.values()], links: [] };
  graphState.links = resolveLinks(graphState.nodes);
  saveGraphCacheDebounced();
  notifyRenderer();
}

// ─── Vault watcher (live refresh, incremental) ────────────────────
let watcher = null;
function watchVault(dir) {
  if (watcher) { try { watcher.close(); } catch (e) {} watcher = null; }
  if (!dir) return;
  try {
    const chokidar = require('chokidar');
    const pending = new Map();   // id → last event
    let debounce = null;
    watcher = chokidar.watch(dir, {
      // skip hidden dirs like .obsidian, .git, .trash
      ignored: (p) => p.split(path.sep).some(seg => seg.startsWith('.')),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
    });
    watcher.on('all', (event, p) => {
      if (!p || !p.endsWith('.md')) return;
      pending.set(relId(dir, p), event === 'unlink' ? 'unlink' : 'change');
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const changes = new Map(pending);
        pending.clear();
        applyFileChanges(changes).catch(e => log.warn('incremental update failed:', e.message));
      }, 600);
    });
    watcher.on('error', e => log.warn('watcher error:', e.message));
  } catch (e) { log.warn('watcher init failed:', e.message); }
}

// ─── Read single note content (for preview) ──────────────────────
function readNoteContent(vaultDir, noteId) {
  if (!vaultDir || !noteId) return null;
  const fullPath = path.join(vaultDir, noteId);
  // Safety: ensure path is inside vault
  const resolved = path.resolve(fullPath);
  const vaultResolved = path.resolve(vaultDir);
  if (!resolved.startsWith(vaultResolved + path.sep) && resolved !== vaultResolved) return null;
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    // Strip frontmatter for display
    return raw.replace(/^---[\r\n][\s\S]*?[\r\n]---[\r\n]?/, '').trim();
  } catch(e) { return null; }
}

// ─── IPC ─────────────────────────────────────────────────────────
ipcMain.handle('select-vault', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select your Obsidian Vault folder'
  });
  if (!result.canceled && result.filePaths[0]) {
    vaultPath = result.filePaths[0];
    graphState = null; // new vault — old graph is invalid
    saveConfig({ vaultPath });
    watchVault(vaultPath);
    return vaultPath;
  }
  return null;
});

ipcMain.handle('get-vault-path', () => vaultPath);

// Fast path: serve in-memory graph; on cold start serve the disk cache
// instantly and re-parse in the background (notify only if changed).
ipcMain.handle('load-graph', async () => {
  if (!vaultPath) return null;
  if (graphState) return graphState;

  const cached = loadGraphCache();
  if (cached) {
    graphState = cached;
    const cachedSig = graphSignature(cached);
    // Background reparse — progress stays silent (graph already on screen).
    fullParse().then(fresh => {
      if (!fresh) return;
      graphState = fresh;
      saveGraphCacheDebounced();
      if (graphSignature(fresh) !== cachedSig) notifyRenderer();
    }).catch(e => log.warn('background reparse failed:', e.message));
    return graphState;
  }

  // Cold start, no cache — this is the blocking-feel case the progress
  // indicator is for (large vaults).
  graphState = await fullParse(makeProgressEmitter());
  saveGraphCacheDebounced();
  return graphState;
});
ipcMain.handle('read-note', (_, noteId) => readNoteContent(vaultPath, noteId));

ipcMain.handle('open-in-obsidian', (_, noteId) => {
  if (!vaultPath || !noteId) return false;
  // Use obsidian:// URI protocol
  const vaultName = path.basename(vaultPath);
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(noteId.replace(/\.md$/, ''))}`;
  shell.openExternal(uri);
  return true;
});

ipcMain.handle('open-in-explorer', (_, noteId) => {
  if (!vaultPath || !noteId) return false;
  const fullPath = path.join(vaultPath, noteId);
  shell.showItemInFolder(fullPath);
  return true;
});

ipcMain.handle('toggle-always-on-top', (_, enable) => {
  isAlwaysOnTop = enable;
  saveConfig({ isAlwaysOnTop });
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(enable, enable ? 'screen-saver' : 'normal');
  }
  return isAlwaysOnTop;
});

ipcMain.handle('get-always-on-top', () => isAlwaysOnTop);

ipcMain.handle('set-startup', (_, enable) => { setStartup(enable); return enable; });
ipcMain.handle('get-startup', () => getStartup());

ipcMain.handle('save-prefs', (_, prefs) => saveConfig({ prefs }));
ipcMain.handle('load-prefs', () => loadConfig().prefs || {});

// Close button hides to tray; quitting happens via tray menu
ipcMain.handle('close-app', () => mainWindow?.hide());
ipcMain.handle('minimize-app', () => mainWindow?.hide());

ipcMain.handle('toggle-fullscreen', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
});
ipcMain.handle('get-fullscreen', () => mainWindow?.isFullScreen() || false);

// ─── PNG export ───────────────────────────────────────────────────
ipcMain.handle('export-png', async (_, dataUrl) => {
  if (!mainWindow || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return false;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export graph as PNG',
    defaultPath: `obsidian-graph-${new Date().toISOString().slice(0, 10)}.png`,
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return false;
  try {
    fs.writeFileSync(result.filePath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
    return true;
  } catch (e) { return false; }
});

// ─── Update check (GitHub releases) ───────────────────────────────
const UPDATE_REPO = 'NimrodLeFay/obsidian-desktop-widget';

function isNewerVersion(latest, current) {
  const a = latest.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

ipcMain.handle('check-update', async () => {
  if (UPDATE_REPO.startsWith('__')) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'obsidian-graph-widget', 'Accept': 'application/vnd.github+json' }
    });
    if (!res.ok) return null;
    const j = await res.json();
    const latest = (j.tag_name || '').replace(/^v/, '');
    if (!latest) return null;
    return { latest, current: app.getVersion(), url: j.html_url, newer: isNewerVersion(latest, app.getVersion()) };
  } catch (e) { return null; }
});

ipcMain.handle('open-url', (_, url) => {
  if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
});

// ─── Global hotkey (remappable) ───────────────────────────────────
const DEFAULT_HOTKEY = 'Control+Shift+G';
let currentHotkey = DEFAULT_HOTKEY;

function registerHotkey(accel) {
  try {
    if (currentHotkey) globalShortcut.unregister(currentHotkey);
  } catch (e) {}
  try {
    if (globalShortcut.register(accel, toggleWindow)) {
      currentHotkey = accel;
      return true;
    }
  } catch (e) { log.warn('hotkey register failed:', e.message); }
  // restore previous binding
  try { globalShortcut.register(currentHotkey, toggleWindow); } catch (e) {}
  return false;
}

ipcMain.handle('get-hotkey', () => currentHotkey);
ipcMain.handle('set-hotkey', (_, accel) => {
  if (typeof accel !== 'string' || !accel || accel.length > 64) return false;
  const ok = registerHotkey(accel);
  if (ok) saveConfig({ hotkey: accel });
  return ok;
});

// ─── Tray ─────────────────────────────────────────────────────────
function getTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  return img.resize({ width: 16, height: 16 });
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: mainWindow && mainWindow.isVisible() ? 'Hide widget' : 'Show widget',
      click: () => toggleWindow()
    },
    { type: 'separator' },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: isAlwaysOnTop,
      click: (item) => {
        isAlwaysOnTop = item.checked;
        saveConfig({ isAlwaysOnTop });
        mainWindow?.setAlwaysOnTop(isAlwaysOnTop, isAlwaysOnTop ? 'screen-saver' : 'normal');
      }
    },
    {
      label: 'Run on startup',
      type: 'checkbox',
      checked: getStartup(),
      click: (item) => setStartup(item.checked)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { isQuitting = true; app.quit(); }
    }
  ]);
  tray.setContextMenu(menu);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
  updateTrayMenu();
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('Obsidian Graph Widget');
  tray.on('click', toggleWindow);
  updateTrayMenu();
}

// ─── Window ───────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const config = loadConfig();

  if (config.vaultPath && fs.existsSync(config.vaultPath)) vaultPath = config.vaultPath;
  if (config.isAlwaysOnTop !== undefined) isAlwaysOnTop = config.isAlwaysOnTop;

  const winW = config.winW || Math.min(960, width);
  const winH = config.winH || Math.min(740, height);
  const winX = config.winX !== undefined ? config.winX : width - winW - 20;
  const winY = config.winY !== undefined ? config.winY : 40;

  mainWindow = new BrowserWindow({
    width: winW, height: winH, x: winX, y: winY,
    transparent: true,
    frame: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    hasShadow: false,
    resizable: true,
    show: !startHidden,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isAlwaysOnTop) mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Save window bounds on move/resize
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);

  // Hide to tray instead of closing/minimizing
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); updateTrayMenu(); }
  });
  mainWindow.on('minimize', (e) => {
    e.preventDefault(); mainWindow.hide(); updateTrayMenu();
  });
  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);

  // Keep renderer in sync with fullscreen state
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('fullscreen-changed', true));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('fullscreen-changed', false));
}

function saveBounds() {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  const [w, h] = mainWindow.getSize();
  saveConfig({ winX: x, winY: y, winW: w, winH: h });
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  watchVault(vaultPath);
  // Global hotkey: toggle widget visibility (remappable via settings)
  currentHotkey = loadConfig().hotkey || DEFAULT_HOTKEY;
  try { globalShortcut.register(currentHotkey, toggleWindow); }
  catch (e) { log.warn('hotkey registration failed:', e.message); }
});
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (watcher) { try { watcher.close(); } catch (e) {} }
});
// App lives in the tray — don't quit when the window is hidden/closed
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && isQuitting) app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
