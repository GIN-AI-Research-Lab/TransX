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
  chunkMaxMs:        3000,           // max ms of audio before forced flush
  silenceMs:         500,            // ms of silence that triggers flush
  silenceRMS:        300,            // RMS amplitude below this = silence
  minSpeechMs:       200,            // min speech content before silence flush triggers

  // ── Whisper STT ───────────────────────────────────────────────────
  whisperEndpoint:   'http://127.0.0.1:8080',  // dùng IP trực tiếp, tránh Node.js resolve localhost → IPv6
  whisperLanguage:   'auto',         // ISO code or 'auto'
  whisperTimeout:    30000,

  // ── Translation ─────────────────────────────────────────────────
  translateEnabled:  true,
  sourceLanguage:    'auto',         // display name or 'auto' (defaults to English for NLLB)
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
