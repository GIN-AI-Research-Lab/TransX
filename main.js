/**
 * main.js — Electron main process
 * Manages overlay window, tray, global hotkey, IPC, and the translation pipeline.
 */

'use strict';

const {
  app, BrowserWindow, ipcMain,
  Tray, Menu, globalShortcut, nativeImage, screen,
  desktopCapturer, session,
} = require('electron');
const path         = require('path');
const { loadConfig, saveConfig } = require('./config');
const Pipeline     = require('./src/pipeline/Pipeline');
const NLLBTranslator = require('./src/ai/NLLBTranslator');
const { createSolidPNG } = require('./src/utils/pngHelper');
const svcMgr       = require('./src/services/ServiceManager');

// ── State ─────────────────────────────────────────────────────────────────────
let overlayWin, settingsWin, setupWin, tray;
let pipeline    = null;
let cfg         = loadConfig();
let _setupDone  = null; // resolve() khi setup window hoàn thành

// ── Tray icon (generated programmatically — no external asset needed) ─────────
function makeTrayImage(running) {
  const color = running ? [76, 175, 80] : [120, 120, 120];
  const buf   = createSolidPNG(16, 16, ...color, 255);
  return nativeImage.createFromBuffer(buf);
}

// ── Overlay window ────────────────────────────────────────────────────────────
function createOverlay() {
  overlayWin = new BrowserWindow({
    x: cfg.overlayX,
    y: cfg.overlayY,
    width:  cfg.overlayWidth,
    height: cfg.overlayHeight,
    frame:          false,
    transparent:    true,
    alwaysOnTop:    true,
    skipTaskbar:    true,
    resizable:      true,
    hasShadow:      false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  overlayWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  overlayWin.setAlwaysOnTop(true, 'screen-saver');

  // Mở DevTools khi chạy với flag --dev
  if (process.argv.includes('--dev')) {
    overlayWin.webContents.openDevTools({ mode: 'detach' });
  }

  // Persist position & size on change
  const persistBounds = () => {
    const [x, y] = overlayWin.getPosition();
    const [w, h] = overlayWin.getSize();
    Object.assign(cfg, { overlayX: x, overlayY: y, overlayWidth: w, overlayHeight: h });
    saveConfig(cfg);
  };
  overlayWin.on('moved',   persistBounds);
  overlayWin.on('resized', persistBounds);

  overlayWin.on('closed', () => { overlayWin = null; });
}

// ── Settings window ───────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width:  720,
    height: 640,
    title:  'Trans Overlay — Settings',
    parent: overlayWin || undefined,
    center: true,
    resizable: false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ── First-run setup window ─────────────────────────────────────────────────────────
function createSetupWindow() {
  setupWin = new BrowserWindow({
    width:  500,
    height: 380,
    center: true,
    resizable:  false,
    frame:      true,
    title:      'Trans Overlay — First Run Setup',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWin.on('closed', () => {
    setupWin = null;
    // If user closes window without finishing, still continue startup
    _setupDone?.();
    _setupDone = null;
  });
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(makeTrayImage(false));
  tray.setToolTip('Trans Overlay');
  rebuildTrayMenu();

  tray.on('click', () => {
    if (!overlayWin) createOverlay();
    else if (overlayWin.isVisible()) overlayWin.hide();
    else overlayWin.show();
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const running = pipeline?.isRunning || false;
  tray.setImage(makeTrayImage(running));

  const menu = Menu.buildFromTemplate([
    {
      label: running ? '⏹  Stop Translation' : '▶  Start Translation',
      click: togglePipeline,
    },
    { type: 'separator' },
    {
      label: '⚙  Settings',
      click: openSettings,
    },
    {
      label: overlayWin?.isVisible() ? '👁  Hide Overlay' : '👁  Show Overlay',
      click: () => {
        if (!overlayWin) createOverlay();
        else if (overlayWin.isVisible()) overlayWin.hide();
        else overlayWin.show();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { pipeline?.stop(); app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
function buildPipeline() {
  if (pipeline) {
    pipeline.removeAllListeners();
    pipeline.stop();
  }
  pipeline = new Pipeline(cfg);

  pipeline.on('started',  () => {
    overlayWin?.webContents.send('pipeline:status', { running: true });
    rebuildTrayMenu();
  });
  pipeline.on('stopped',  () => {
    overlayWin?.webContents.send('pipeline:status', { running: false });
    rebuildTrayMenu();
  });
  pipeline.on('processing', (d) => overlayWin?.webContents.send('pipeline:processing', d));
  pipeline.on('transcript', (t) => overlayWin?.webContents.send('pipeline:transcript',  t));
  pipeline.on('translation:partial', (d) => overlayWin?.webContents.send('pipeline:translation:partial', d));
  pipeline.on('translation', (d) => {
    overlayWin?.webContents.send('pipeline:translation', d);
  });
  pipeline.on('error', (err) => {
    console.error('[pipeline]', err.message);
    overlayWin?.webContents.send('pipeline:error', err.message);
  });
}

async function togglePipeline() {
  if (!pipeline) buildPipeline();
  if (pipeline.isRunning) {
    pipeline.stop();
  } else {
    await pipeline.start();
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('config:get', () => cfg);

  ipcMain.handle('config:save', (_e, partial) => {
    cfg = { ...cfg, ...partial };
    saveConfig(cfg);
    // Re-register hotkey if changed
    if (partial.hotkey !== undefined) {
      globalShortcut.unregisterAll();
      if (cfg.hotkey) globalShortcut.register(cfg.hotkey, togglePipeline);
    }
    // Rebuild pipeline với settings mới (nếu đang dừng)
    if (pipeline && !pipeline.isRunning) buildPipeline();
    // Nếu đang chạy: cập nhật ngôn ngữ dịch ngay lập tức (hot-swap)
    if (pipeline && pipeline.isRunning && pipeline.translator) {
      pipeline.translator.updateLanguage(cfg);
    }
    return cfg;
  });

  ipcMain.handle('pipeline:toggle', async () => {
    await togglePipeline();
    return { running: pipeline?.isRunning || false };
  });

  ipcMain.handle('pipeline:status', () => ({
    running: pipeline?.isRunning || false,
  }));

  ipcMain.handle('overlay:setIgnoreMouse', (_e, ignore) => {
    overlayWin?.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.handle('whisper:ping', async () => {
    try {
      const cfg2 = loadConfig();
      const WhisperClient = require('./src/ai/WhisperClient');
      const w = new WhisperClient(cfg2);
      return { ok: await w.ping() };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('audio:getSources', async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      return sources.map((s) => ({ id: s.id, name: s.name }));
    } catch (e) {
      console.error('[desktopCapturer]', e.message);
      return [];
    }
  });

  ipcMain.handle('audio:sendChunk', (_e, int16Arr) => {
    if (!pipeline?.isRunning) return;
    try {
      // int16Arr là Array<number> (số nguyên 16-bit) được gửi từ audioCapture.js
      const buf = Buffer.from(new Int16Array(int16Arr).buffer);
      pipeline.receivePCM(buf);
    } catch (e) {
      console.error('[audio:sendChunk]', e.message);
    }
  });

  ipcMain.handle('audio:listDevices', async () => {
    // Giữ lại cho Settings > Audio device list
    return { capture: ['Microphone mặc định'], render: ['System audio (desktopCapturer)'] };
  });

  ipcMain.handle('settings:open', () => openSettings());

  // ── Setup (first-run): NLLB model check ──────────────
  ipcMain.handle('setup:start-pull', async () => {
    // Model is pre-bundled — this handler just confirms OK and closes the setup window.
    // If we reach here the model was already verified missing; instruct the user.
    setupWin?.webContents.send('setup:progress', { status: 'model_missing', pct: -1 });
  });

  ipcMain.handle('setup:cancel', () => {
    setupWin?.close();
    _setupDone?.();
    _setupDone = null;
    app.quit();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Permissions for mic + desktop capture
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'mediaKeySystem'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'display-capture', 'screen'].includes(permission);
  });

  createTray();
  setupIPC();

  if (cfg.hotkey) {
    try { globalShortcut.register(cfg.hotkey, togglePipeline); }
    catch (e) { console.warn('[hotkey] could not register:', cfg.hotkey); }
  }

  // ── Start background services ──────────────────────
  console.log('[app] Starting Whisper service…');
  await svcMgr.startWhisper(8080).catch((e) => console.warn('[whisper]', e.message));

  // ── First-run: verify NLLB model files are present ───────────────
  if (cfg.translateEnabled) {
    const nllbDir = svcMgr.nllbModelDir;
    if (!NLLBTranslator.modelExists(nllbDir)) {
      console.log('[app] NLLB model missing — showing setup window');
      await new Promise((resolve) => {
        _setupDone = resolve;
        createSetupWindow();
      });
    } else {
      // Pre-warm the model pipeline in the background
      NLLBTranslator.prewarm(nllbDir);
    }
  }

  // ── Open main overlay ─────────────────────────
  createOverlay();
  if (!cfg.startMinimized) overlayWin?.show();
});

app.on('window-all-closed', () => {
  // Keep running in tray on Windows even with no windows open
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  pipeline?.stop();
  svcMgr.stopAll();
});
