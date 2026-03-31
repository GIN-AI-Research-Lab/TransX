/**
 * renderer/renderer.js — Overlay UI logic
 *
 * Communicates with main process exclusively through window.electron
 * (the contextBridge API defined in preload.js).
 *
 * Audio capture dùng RendererAudioCapture (Web Audio API) — không cần ffmpeg.
 * audioCapture.js được load trước script này trong index.html.
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
let segments     = [];           // [{ id, el, transEl }] các segment đã hiển thị
let _liveEl      = null;         // segment đang ghi live (typing)
let _liveOrigEl  = null;         // .seg-orig trong live segment
const _pendingTrans = new Map(); // id → transEl — đang chờ dịch
const MAX_SEG    = 6;

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
    statusMsg.textContent = 'Đang nghe…';
  } else {
    // Remove stray live segment if pipeline stopped mid-word
    if (_liveEl) { _liveEl.remove(); _liveEl = null; _liveOrigEl = null; }
    statusMsg.textContent = 'Nhấn ▶ để bắt đầu';
  }
}

function setStage(stage) {
  if (stage === 'stt') {
    dot.className = 'dot dot--stt';
    statusMsg.textContent = 'Đang nhận dạng…';
    spin.classList.remove('hidden');
  } else if (stage === 'translation') {
    dot.className = 'dot dot--translate';
    statusMsg.textContent = 'Đang dịch…';
    spin.classList.remove('hidden');
  } else {
    spin.classList.add('hidden');
    if (running) {
      dot.className = 'dot dot--running';
      statusMsg.textContent = 'Đang nghe…';
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
    ? '&#x231B; Đang dịch…'
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
  segContainer.scrollTop = segContainer.scrollHeight;
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
    // Nếu đang chạy → dừng
    if (running) {
      stopAudioCapture();
      await ipc.invoke('pipeline:toggle');
      setRunning(false);
      return;
    }

    // Bắt đầu: gọi toggle — bên trong đã ping whisper, nếu fail sẽ emit error
    statusMsg.textContent = 'Đang kết nối…';
    const res = await ipc.invoke('pipeline:toggle');

    if (res.running) {
      setRunning(true);
      try {
        statusMsg.textContent = 'Đang mở audio…';
        await startAudioCapture();
        clearError();
      } catch (e) {
        // Audio thất bại → dừng pipeline
        await ipc.invoke('pipeline:toggle');
        setRunning(false);
        showError('Không mở được audio: ' + e.message);
      }
    } else {
      // pipeline.start() đã emit error (whipser chưa chạy hoặc lỗi khác)
      // lỗi đã hiển thị qua sự kiện pipeline:error
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

btnSettings.addEventListener('click', () => ipc.invoke('settings:open'));

btnPass.addEventListener('click', async () => {
  clickThrough = !clickThrough;
  await ipc.invoke('overlay:setIgnoreMouse', clickThrough);
  btnPass.classList.toggle('cbtn--active', !clickThrough);
  btnPass.title = clickThrough ? 'Click-through: ON — click tray để tương tác' : 'Click-through: OFF';
});

btnHide.addEventListener('click', () => window.close());

// ── IPC events from main ──────────────────────────────────────────────────
ipc.on('pipeline:status', (d) => {
  if (!d.running) {
    stopAudioCapture();
  }
  setRunning(d.running);
});

ipc.on('pipeline:processing', (d) => setStage(d.stage));

// pipeline:partial-transcript — hiển thị live typing trong chat
ipc.on('pipeline:partial-transcript', ({ text, timestamp }) => {
  if (!_liveEl) {
    _liveEl = document.createElement('div');
    _liveEl.className = 'segment segment--live';
    _liveEl.innerHTML =
      `<span class="seg-ts">${fmtTime(timestamp)}</span>` +
      `<div class="seg-body">` +
        `<div class="seg-orig"></div>` +
        `<div class="seg-trans"></div>` +
      `</div>`;
    segContainer.appendChild(_liveEl);
    _liveOrigEl = _liveEl.querySelector('.seg-orig');
    // Giới hạn số segment hiển thị
    while (segments.length >= MAX_SEG) segments.shift().el.remove();
  }
  _liveOrigEl.innerHTML = escHtml(text) + '<span class="typing-cursor"> ▌</span>';
  segContainer.scrollTop = segContainer.scrollHeight;
});

// pipeline:transcript — chốt live segment thành pending dịch
ipc.on('pipeline:transcript', ({ text, timestamp, id }) => {
  if (_liveEl) {
    // Nâng cấp live → pending
    _liveEl.className = 'segment segment--pending';
    _liveOrigEl.innerHTML = escHtml(text);
    const transEl = _liveEl.querySelector('.seg-trans');
    transEl.innerHTML = '⏳ Đang dịch…';
    segments.push({ id, el: _liveEl, transEl });
    while (segments.length > MAX_SEG) segments.shift().el.remove();
    _pendingTrans.set(id, transEl);
    _liveEl = null;
    _liveOrigEl = null;
  } else {
    // Không có live segment (audio rất ngắn, chưa kịp emit partial)
    const transEl = addSegment({ id, timestamp, original: text, translated: null, pending: true });
    _pendingTrans.set(id, transEl);
  }
  clearError();
});

// pipeline:translation — cập nhật theo id
ipc.on('pipeline:translation', ({ original, translated, timestamp, id }) => {
  const transEl = _pendingTrans.get(id);
  if (transEl) {
    transEl.innerHTML = translated
      ? escHtml(translated)
      : '<em style="opacity:.35">—</em>';
    transEl.closest('.segment')?.classList.remove('segment--pending');
    _pendingTrans.delete(id);
  } else {
    // Fallback: không tìm thấy segment theo id
    addSegment({ id, timestamp, original, translated });
  }
  clearError();
});

ipc.on('pipeline:error', (msg) => showError(msg));

// ── Bootstrap ─────────────────────────────────────────────────────────────
(async () => {
  const status = await ipc.invoke('pipeline:status');
  setRunning(status.running);
  statusMsg.textContent = 'Nhấn ▶ để bắt đầu';
})();


