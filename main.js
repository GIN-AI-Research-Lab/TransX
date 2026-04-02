/**
 * main.js — Electron main process
 */

'use strict';

const {
  app, BrowserWindow, ipcMain,
  Tray, Menu, globalShortcut, nativeImage,
  desktopCapturer, session,
} = require('electron');

// ── Performance flags (before any window is created) ────────────────────────────
app.disableHardwareAcceleration();   // overlay is text-only — GPU not needed, saves RAM
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');  // avoid cache Access Denied errors
app.commandLine.appendSwitch('disable-http-cache');             // disable Chromium HTTP disk cache
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');

const path           = require('path');
const { loadConfig, saveConfig } = require('./config');
const Pipeline       = require('./src/pipeline/Pipeline');
const NLLBTranslator = require('./src/ai/NLLBTranslator');
const { createSolidPNG } = require('./src/utils/pngHelper');
const svcMgr         = require('./src/services/ServiceManager');

// ── State ─────────────────────────────────────────────────────────────────────
let overlayWin, tray;
let pipeline = null;
let cfg      = loadConfig();
cfg.whisperLanguage = svcMgr.sourceLangToWhisperLang(cfg.sourceLanguage) || 'auto';

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

  // Open DevTools when launched with the --dev flag
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
  pipeline.on('listening',  (d) => overlayWin?.webContents.send('pipeline:listening',  d));
  pipeline.on('transcript', (t) => overlayWin?.webContents.send('pipeline:transcript',  t));
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
    // Auto-derive whisperLanguage from sourceLanguage (no manual user setting)
    if (partial.sourceLanguage !== undefined) {
      const lang = svcMgr.sourceLangToWhisperLang(cfg.sourceLanguage);
      cfg.whisperLanguage = lang || 'auto';
    }
    saveConfig(cfg);
    // Re-register hotkey if changed
    if (partial.hotkey !== undefined) {
      globalShortcut.unregisterAll();
      if (cfg.hotkey) globalShortcut.register(cfg.hotkey, togglePipeline);
    }
    // Rebuild pipeline with updated settings (only when stopped)
    if (pipeline && !pipeline.isRunning) buildPipeline();
    // If already running: update languages immediately (hot-swap)
    if (pipeline && pipeline.isRunning) {
      pipeline.updateLanguages(cfg);
    }
    return cfg;
  });

  ipcMain.handle('config:reset', () => {
    const { defaults } = require('./config');
    cfg = { ...defaults };
    // Sync whisperLanguage from default sourceLanguage
    cfg.whisperLanguage = svcMgr.sourceLangToWhisperLang(cfg.sourceLanguage) || 'auto';
    saveConfig(cfg);
    // Re-register hotkey with the default value
    globalShortcut.unregisterAll();
    if (cfg.hotkey) globalShortcut.register(cfg.hotkey, togglePipeline);
    // Rebuild pipeline
    if (pipeline && !pipeline.isRunning) buildPipeline();
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

  ipcMain.handle('whisper:status', () => ({
    running: svcMgr.whisperRunning,
  }));

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
      // int16Arr is Array<number> (16-bit integers) sent from audioCapture.js
      const buf = Buffer.from(new Int16Array(int16Arr).buffer);
      pipeline.receivePCM(buf);
    } catch (e) {
      console.error('[audio:sendChunk]', e.message);
    }
  });

  ipcMain.handle('audio:listDevices', async () => {
    // Kept for Settings > Audio device list
    return { capture: ['Default microphone'], render: ['System audio (desktopCapturer)'] };
  });

  // ── Setup (first-run): NLLB model check handled silently ──────────────
  ipcMain.handle('setup:start-pull', async () => {});
  ipcMain.handle('setup:cancel', () => { app.quit(); });
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

  // ── Start services ──────────────────────────────────────
  await svcMgr.startWhisper(cfg).catch((e) => console.warn('[whisper]', e.message));
  await svcMgr.startNLLB(cfg).catch((e) => console.warn('[nllb-ct2]', e.message));

  if (cfg.translateEnabled && !NLLBTranslator.modelExists(svcMgr.nllbModelDir)) {
    console.warn('[app] NLLB model not found. Run: npm run download-model-fast');
  }

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
