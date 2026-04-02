/**
 * renderer/renderer.js — Overlay UI logic
 *
 * Communicates with main process exclusively through window.electron
 * (the contextBridge API defined in preload.js).
 *
 * Audio capture uses RendererAudioCapture (Web Audio API) — no ffmpeg required.
 * audioCapture.js is loaded before this script in index.html.
 */

'use strict';

/* eslint-disable no-undef */
const ipc = window.electron;

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const dot          = $('dot');
const btnToggle    = $('btn-toggle');
const btnClear     = $('btn-clear');
const btnSettings  = $('btn-settings');
const btnPass      = $('btn-pass');
const btnHide      = $('btn-hide');
const statusMsg    = $('status-msg');
const spin         = $('spin');
const segContainer = $('segments-container');
const pendingSegEl = $('pending-segment');
const pendingTsEl  = $('pending-ts');
const pendingOrigEl= $('pending-orig');
const pendingTransEl=$('pending-trans');

// ── State ─────────────────────────────────────────────────────────────────
let running      = false;
let clickThrough = false;
/** @type {RendererAudioCapture|null} */
let audioCapture = null;
let segments     = [];           // [{ id, el, transEl }] all displayed segments
let _liveEl      = null;         // currently recording live segment (typing)
let _liveOrigEl  = null;         // .seg-orig element inside the live segment
const _pendingTrans = new Map(); // id → transEl — awaiting translation
const MAX_SEG    = 200;          // keep at most 200 segments in the DOM

// Auto-scroll only when already at the bottom (don't force-scroll while user is reviewing history)
function _isAtBottom() {
  return segContainer.scrollHeight - segContainer.scrollTop - segContainer.clientHeight < 80;
}
function _scrollToBottom() {
  // Use rAF to scroll after DOM re-layout (especially when translated text updates in-place)
  const atBottom = _isAtBottom();
  requestAnimationFrame(() => {
    if (atBottom) segContainer.scrollTop = segContainer.scrollHeight;
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────
function setRunning(r) {
  running = r;
  btnToggle.textContent = r ? '⏹' : '▶';
  btnToggle.classList.toggle('cbtn--running', r);
  dot.className = `dot dot--${r ? 'running' : 'idle'}`;
  if (r) {
    // Starting new session — clear previous segments
    segments.forEach((s) => s.el.remove());
    segments     = [];
    if (_liveEl) { _liveEl.remove(); _liveEl = null; _liveOrigEl = null; }
    _pendingTrans.clear();
    pendingSegEl.classList.add('hidden');
    statusMsg.textContent = 'Listening…';
  } else {
    statusMsg.textContent = 'Press ▶ to start';
  }
}

function setStage(stage) {
  if (stage === 'stt') {
    dot.className = 'dot dot--stt';
    statusMsg.textContent = 'Recognising…';
    spin.classList.remove('hidden');
  } else if (stage === 'translation') {
    dot.className = 'dot dot--translate';
    statusMsg.textContent = 'Translating…';
    spin.classList.remove('hidden');
  } else {
    spin.classList.add('hidden');
    if (running) {
      dot.className = 'dot dot--running';
      statusMsg.textContent = 'Listening…';
    }
  }
}

function showError(msg) {
  dot.className = 'dot dot--error';
  statusMsg.textContent = String(msg).slice(0, 100);
  spin.classList.add('hidden');
}

function clearError() {}

// ── Segment helpers ──────────────────────────────────────────────────────
function fmtTime(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function addSegment({ id, timestamp, original, translated, pending = false }) {
  const el = document.createElement('div');
  el.className = 'segment' + (pending ? ' segment--pending' : '');
  const transHtml = pending
    ? '&#x231B; Translating…'
    : (translated ? escHtml(translated) : '<em style="opacity:.35">—</em>');
  el.innerHTML =
    `<span class="seg-ts">${fmtTime(timestamp)}</span>` +
    `<div class="seg-body">` +
      `<div class="seg-orig">${escHtml(original)}</div>` +
      `<div class="seg-trans">${transHtml}</div>` +
    `</div>`;
  segContainer.appendChild(el);
  const transEl = el.querySelector('.seg-trans');
  segments.push({ id, el, transEl });
  while (segments.length > MAX_SEG) segments.shift().el.remove();
  _scrollToBottom();
  return transEl;
}

// ── Audio capture ─────────────────────────────────────────────────────────
async function startAudioCapture() {
  const cfg = await ipc.invoke('config:get');
  audioCapture = new window.RendererAudioCapture(
    ipc,
    (err) => showError(err),
    (msg) => { if (msg) statusMsg.textContent = msg; },
  );
  await audioCapture.start(cfg.audioSource || 'microphone', cfg.audioInputDevice || '');
}

function stopAudioCapture() {
  audioCapture?.stop();
  audioCapture = null;
}

// ── Toggle Pipeline + Audio ───────────────────────────────────────────────
async function handleToggle() {
  btnToggle.disabled = true;
  try {
    // If running → stop
    if (running) {
      stopAudioCapture();
      await ipc.invoke('pipeline:toggle');
      setRunning(false);
      return;
    }

    // Start: invoke toggle — it will ping whisper internally; on failure it emits an error
    statusMsg.textContent = 'Connecting…';
    const res = await ipc.invoke('pipeline:toggle');

    if (res.running) {
      setRunning(true);
      try {
        statusMsg.textContent = 'Opening audio…';
        await startAudioCapture();
        clearError();
      } catch (e) {
        // Audio failed → stop pipeline
        await ipc.invoke('pipeline:toggle');
        setRunning(false);
        showError('Failed to open audio: ' + e.message);
      }
    } else {
      // pipeline.start() already emitted an error (whisper not running or other failure)
      // error already displayed via pipeline:error event
      setRunning(false);
    }
  } finally {
    btnToggle.disabled = false;
  }
}

// ── Button handlers ───────────────────────────────────────────────────────
btnToggle.addEventListener('click', handleToggle);

btnClear.addEventListener('click', () => {
  segments.forEach((s) => s.el.remove());
  segments     = [];
  if (_liveEl) { _liveEl.remove(); _liveEl = null; _liveOrigEl = null; }
  _pendingTrans.clear();
  pendingSegEl.classList.add('hidden');
});

btnSettings.addEventListener('click', toggleSettingsPanel);

btnPass.addEventListener('click', async () => {
  clickThrough = !clickThrough;
  await ipc.invoke('overlay:setIgnoreMouse', clickThrough);
  btnPass.classList.toggle('cbtn--active', !clickThrough);
  btnPass.title = clickThrough ? 'Click-through: ON — click tray to interact' : 'Click-through: OFF';
});

btnHide.addEventListener('click', () => window.close());

// ── IPC events from main ──────────────────────────────────────────────────
ipc.on('pipeline:status', (d) => {
  if (!d.running) {
    stopAudioCapture();
    // Remove incomplete live segment (audio not yet processed by Whisper)
    if (_liveEl) { _liveEl.remove(); _liveEl = null; _liveOrigEl = null; }
  }
  setRunning(d.running);
});

ipc.on('pipeline:processing', (d) => setStage(d.stage));

// pipeline:listening — audio is incoming, show a live "..." bubble
ipc.on('pipeline:listening', ({ timestamp }) => {
  if (_liveEl) return; // bubble already exists, do not create another
  _liveEl = document.createElement('div');
  _liveEl.className = 'segment segment--live';
  _liveEl.innerHTML =
    `<span class="seg-ts">${fmtTime(timestamp)}</span>` +
    `<div class="seg-body">` +
      `<div class="seg-orig"><span class="typing-cursor">…</span></div>` +
      `<div class="seg-trans"></div>` +
    `</div>`;
  segContainer.appendChild(_liveEl);
  _liveOrigEl = _liveEl.querySelector('.seg-orig');
  while (segments.length >= MAX_SEG) segments.shift().el.remove();
  _scrollToBottom();
});

// pipeline:transcript — finalise live segment as pending translation
ipc.on('pipeline:transcript', ({ text, timestamp, id }) => {
  if (_liveEl) {
    // Upgrade live segment → pending
    _liveEl.className = 'segment segment--pending';
    _liveOrigEl.innerHTML = escHtml(text);
    const transEl = _liveEl.querySelector('.seg-trans');
    transEl.innerHTML = '⏳ Translating…';
    segments.push({ id, el: _liveEl, transEl });
    while (segments.length > MAX_SEG) segments.shift().el.remove();
    _pendingTrans.set(id, transEl);
    _liveEl = null;
    _liveOrigEl = null;
  } else {
    // No live segment (audio too short, partial event was not emitted in time)
    const transEl = addSegment({ id, timestamp, original: text, translated: null, pending: true });
    _pendingTrans.set(id, transEl);
  }
  clearError();
});

// pipeline:translation — update segment by id
ipc.on('pipeline:translation', ({ original, translated, timestamp, id }) => {
  const transEl = _pendingTrans.get(id);
  if (transEl) {
    transEl.innerHTML = translated
      ? escHtml(translated)
      : '<em style="opacity:.35">—</em>';
    transEl.closest('.segment')?.classList.remove('segment--pending');
    _pendingTrans.delete(id);
    _scrollToBottom();
  } else {
    // Fallback: segment not found by id
    addSegment({ id, timestamp, original, translated });
  }
  clearError();
});

ipc.on('pipeline:error', (msg) => showError(msg));

// ── Settings panel (inline dropdown) ────────────────────────────────────────
const settingsPanel = $('settings-panel');

// Bind range inputs → live value display
['sp-overlayFontSize','sp-overlayOpacity','sp-chunkMaxMs','sp-silenceMs','sp-silenceRMS']
  .forEach(id => {
    const el  = document.getElementById(id);
    const val = document.getElementById(`${id}-val`);
    if (el && val) el.addEventListener('input', () => { val.textContent = el.value; });
  });

function spFormSet(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') { el.checked = !!value; return; }
  el.value = value ?? '';
  const valSpan = document.getElementById(`${id}-val`);
  if (valSpan) valSpan.textContent = value;
}

async function spLoad() {
  const c = await ipc.invoke('config:get');
  spFormSet('sp-audioSource',      c.audioSource      ?? 'microphone');
  spFormSet('sp-audioInputDevice', c.audioInputDevice ?? '');
  spFormSet('sp-sourceLanguage',   c.sourceLanguage   ?? 'English');
  spFormSet('sp-targetLanguage',   c.targetLanguage   ?? 'Vietnamese');
  spFormSet('sp-overlayFontSize',  c.overlayFontSize  ?? 16);
  spFormSet('sp-overlayOpacity',   c.overlayOpacity   ?? 1.0);
  spFormSet('sp-hotkey',           c.hotkey           ?? '');
  spFormSet('sp-startMinimized',   c.startMinimized   ?? false);
  spFormSet('sp-chunkMaxMs',       c.chunkMaxMs       ?? 10000);
  spFormSet('sp-silenceMs',        c.silenceMs        ?? 1200);
  spFormSet('sp-silenceRMS',       c.silenceRMS        ?? 250);
}

function spRead() {
  const gv  = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const gch = (id) => { const el = document.getElementById(id); return !!el && el.checked; };
  return {
    audioSource:      gv('sp-audioSource'),
    audioInputDevice: (gv('sp-audioInputDevice') || '').trim(),
    sourceLanguage:   gv('sp-sourceLanguage'),
    targetLanguage:   gv('sp-targetLanguage'),
    overlayFontSize:  parseInt(gv('sp-overlayFontSize'), 10),
    overlayOpacity:   parseFloat(gv('sp-overlayOpacity')),
    hotkey:           (gv('sp-hotkey') || '').trim(),
    startMinimized:   gch('sp-startMinimized'),
    chunkMaxMs:       parseInt(gv('sp-chunkMaxMs'), 10),
    silenceMs:        parseInt(gv('sp-silenceMs'), 10),
    silenceRMS:       parseInt(gv('sp-silenceRMS'), 10),
  };
}

let _spOpen = false;
function toggleSettingsPanel() {
  _spOpen = !_spOpen;
  settingsPanel.classList.toggle('hidden', !_spOpen);
  btnSettings.classList.toggle('cbtn--active', _spOpen);
  if (_spOpen) spLoad();
}

// Close panel when clicking outside of it
document.addEventListener('click', (e) => {
  if (_spOpen && !settingsPanel.contains(e.target) && e.target !== btnSettings) {
    _spOpen = false;
    settingsPanel.classList.add('hidden');
    btnSettings.classList.remove('cbtn--active');
  }
});

$('sp-btn-save').addEventListener('click', async () => {
  await ipc.invoke('config:save', spRead());
  const st = $('sp-save-status');
  st.classList.add('visible');
  setTimeout(() => st.classList.remove('visible'), 2000);
});

$('sp-btn-reset').addEventListener('click', async () => {
  if (!confirm('Reset all settings to defaults?\n(Overlay position will not be affected)')) return;
  await ipc.invoke('config:reset');
  await spLoad();
  const st = $('sp-save-status');
  st.textContent = '↺ Reset';
  st.classList.add('visible');
  setTimeout(() => { st.classList.remove('visible'); st.textContent = '✓ Saved'; }, 2500);
});

$('sp-btn-list-capture').addEventListener('click', async () => {
  const sel = $('sp-capture-select');
  const wasHidden = sel.classList.contains('hidden');
  sel.classList.toggle('hidden');
  if (wasHidden) {
    sel.innerHTML = '<option disabled>Loading devices…</option>';
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      if (devices.filter(d => d.kind === 'audioinput').every(d => !d.label)) {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach(t => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }
      const inputs = devices.filter(d => d.kind === 'audioinput');
      sel.innerHTML = inputs.length
        ? inputs.map(d => `<option value="${escHtml(d.label)}">${escHtml(d.label || `Mic (${d.deviceId.slice(0,8)}…)`)}</option>`).join('')
        : '<option disabled>No microphones found</option>';
      const cur = $('sp-audioInputDevice').value;
      const match = Array.from(sel.options).find(o => o.value === cur);
      if (match) sel.value = cur;
    } catch (e) {
      sel.innerHTML = `<option disabled>Error: ${escHtml(e.message)}</option>`;
    }
  }
});

$('sp-capture-select').addEventListener('change', () => {
  $('sp-audioInputDevice').value = $('sp-capture-select').value;
});

// ── Bootstrap ─────────────────────────────────────────────────────────────
(async () => {
  const status = await ipc.invoke('pipeline:status');
  setRunning(status.running);
  statusMsg.textContent = 'Press ▶ to start';
})();


