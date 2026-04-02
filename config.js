/**
 * config.js — Central configuration with persistent save/load
 * Stored at %USERPROFILE%\.trans-overlay\config.json
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const CONFIG_DIR  = path.join(os.homedir(), '.trans-overlay');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const defaults = {
  // ── Audio ──────────────────────────────────────────────────────────
  audioSource:       'microphone',   // 'microphone' | 'system' | 'both'
  audioInputDevice:  '',             // WASAPI capture device name (empty = default)
  audioOutputDevice: '',             // WASAPI render device name for loopback (empty = default)
  sampleRate:        16000,
  chunkMaxMs:        8000,           // max ms of audio before forced flush (8s — longer for complete sentences)
  silenceMs:         1200,            // ms of silence that triggers flush (1.2s — English speakers pause 0.5-1s mid-sentence)
  silenceRMS:        200,             // RMS amplitude below this = silence (lower = less sensitive to background noise)
  minSpeechMs:       500,             // min speech content before silence flush triggers

  // ── Whisper STT ───────────────────────────────────────────────────
  whisperEndpoint:   'http://127.0.0.1:8080',  // use IP directly to avoid Node.js resolving localhost as IPv6
  whisperTimeout:    30000,
  whisperModel:      'base',                   // tiny | base | small | medium
  whisperLanguage:   'auto',                   // ISO language code or 'auto'

  // ── Translation ─────────────────────────────────────────────────
  translateEnabled:  true,
  sourceLanguage:    'English',      // 'English' | 'Japanese' | 'Vietnamese'
  targetLanguage:    'Vietnamese',

  // ── TTS ───────────────────────────────────────────────────────────
  ttsEnabled: false,
  ttsVoice:   '',                    // substring of SpeechSynthesis voice name
  ttsRate:    1.0,
  ttsVolume:  1.0,

  // ── Overlay ───────────────────────────────────────────────────────
  overlayX:       100,
  overlayY:        50,
  overlayWidth:   820,
  overlayHeight:  210,
  overlayOpacity:   1,
  overlayFontSize: 16,
  overlayBg:     'rgba(8,8,8,0.82)',

  // ── App ───────────────────────────────────────────────────────────
  hotkey:          'Ctrl+Shift+T',
  startMinimized:  false,
  maxHistoryItems: 50,
  uiLanguage:      'vi',             // 'vi' | 'en' | 'ja'

  // ── NLLB CTranslate2 server (optional, ~600 MB RAM, 2-3× faster) ─
  nllbEndpoint:    'http://127.0.0.1:8081',
  nllbTimeout:     15000,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...defaults, ...saved };
    }
  } catch (e) {
    console.error('[config] load error:', e.message);
  }
  return { ...defaults };
}

function saveConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.error('[config] save error:', e.message);
  }
}

module.exports = { loadConfig, saveConfig, defaults };
