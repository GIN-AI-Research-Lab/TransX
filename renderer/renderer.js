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
let segments     = [];   // [{ id, el, transEl }] currently visible
let _lastTransEl = null; // transEl của segment đang chờ dịch (pending)
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
    _lastTransEl = null;
    pendingSegEl.classList.add('hidden');
    statusMsg.textContent = 'Đang nghe…';
  } else {
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
  // Xóa tất cả segment đã hiển thị
  segments.forEach((s) => s.el.remove());
  segments     = [];
  _lastTransEl = null;
  // Ẩn pending segment nếu có
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

// pipeline:transcript — thêm segment ngay với trạng thái đang dịch
ipc.on('pipeline:transcript', ({ text, timestamp }) => {
  _lastTransEl = addSegment({
    id:         `pending-${Date.now()}`,
    timestamp,
    original:   text,
    translated: null,
    pending:    true,
  });
  clearError();
});

// pipeline:translation — update in-place trên segment đã có
ipc.on('pipeline:translation', ({ original, translated, timestamp, id }) => {
  if (_lastTransEl) {
    // Cập nhật bản dịch vào đúng segment đó
    _lastTransEl.innerHTML = translated
      ? escHtml(translated)
      : '<em style="opacity:.35">—</em>';
    _lastTransEl.closest('.segment')?.classList.remove('segment--pending');
    // Cập nhật id thật từ pipeline
    const seg = segments.find(s => s.transEl === _lastTransEl);
    if (seg) seg.id = id;
    _lastTransEl = null;
  } else {
    // Không có pending (hiếm gặp) — thêm mới
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


