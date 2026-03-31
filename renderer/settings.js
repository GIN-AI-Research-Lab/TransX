/**
 * renderer/settings.js — Settings page logic
 */

'use strict';

/* eslint-disable no-undef */
const ipc = window.electron;

// ── Tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Range value display helpers ───────────────────────────────────────────
function bindRange(id) {
  const el  = document.getElementById(id);
  const val = document.getElementById(`${id}-val`);
  if (!el || !val) return;
  el.addEventListener('input', () => { val.textContent = el.value; });
}
['overlayFontSize','overlayOpacity',
 'chunkMaxMs','silenceMs','silenceRMS'].forEach(bindRange);

// ── Load config → form ────────────────────────────────────────────────────
let cfg = {};

function formSet(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value ?? '';
  // Trigger display update for ranges
  if (el.type === 'range') {
    const v = document.getElementById(`${id}-val`);
    if (v) v.textContent = value;
  }
}

function loadForm(c) {
  cfg = c;
  formSet('audioSource',        c.audioSource);
  formSet('audioInputDevice',   c.audioInputDevice);
  formSet('audioOutputDevice',  c.audioOutputDevice);
  formSet('sourceLanguage',     c.sourceLanguage);
  formSet('targetLanguage',     c.targetLanguage);
  formSet('overlayFontSize',    c.overlayFontSize);
  formSet('overlayOpacity',     c.overlayOpacity);
  formSet('hotkey',             c.hotkey);
  formSet('startMinimized',     c.startMinimized);
  formSet('chunkMaxMs',         c.chunkMaxMs);
  formSet('silenceMs',          c.silenceMs);
  formSet('silenceRMS',         c.silenceRMS);
}

// ── Read form → partial config ────────────────────────────────────────────
function readForm() {
  const gv  = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const gch = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
  const gn  = (id) => parseFloat(gv(id));
  const gi  = (id) => parseInt(gv(id), 10);

  return {
    audioSource:        gv('audioSource'),
    audioInputDevice:   gv('audioInputDevice').trim(),
    audioOutputDevice:  gv('audioOutputDevice').trim(),
    sourceLanguage:     gv('sourceLanguage'),
    targetLanguage:     gv('targetLanguage').trim(),
    overlayFontSize:    gi('overlayFontSize'),
    overlayOpacity:     gn('overlayOpacity'),
    hotkey:             gv('hotkey').trim(),
    startMinimized:     gch('startMinimized'),
    chunkMaxMs:         gi('chunkMaxMs'),
    silenceMs:          gi('silenceMs'),
    silenceRMS:         gi('silenceRMS'),
  };
}

// ── Save ──────────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', async () => {
  const partial = readForm();
  await ipc.invoke('config:save', partial);

  const el = document.getElementById('save-status');
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
});

document.getElementById('btn-cancel').addEventListener('click', () => window.close());

// ── Device listing ────────────────────────────────────────────────────────
async function fetchDevices() {
  try { return await ipc.invoke('audio:listDevices'); }
  catch { return { capture: [], render: [] }; }
}

document.getElementById('btn-list-capture').addEventListener('click', async () => {
  const box    = document.getElementById('capture-list');
  const select = document.getElementById('capture-device-select');
  const shown  = box.style.display !== 'none';
  if (shown) { box.style.display = 'none'; return; }

  select.innerHTML = '<option>Đang lấy danh sách…</option>';
  box.style.display = 'block';

  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    // Nếu labels chưa hiển (chưa cấp quyền) → xin quyền tạm thời
    const mics = devices.filter(d => d.kind === 'audioinput');
    if (mics.length && mics.every(d => !d.label)) {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
    const inputs = devices.filter(d => d.kind === 'audioinput');
    select.innerHTML = '';
    if (!inputs.length) {
      select.innerHTML = '<option disabled>Không tìm thấy microphone nào</option>';
    } else {
      inputs.forEach(d => {
        const label = d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`;
        select.add(new Option(label, label));
      });
      // Tự chọn nếu đang có thiết bị được lưu
      const current = document.getElementById('audioInputDevice').value;
      if (current) {
        const opt = Array.from(select.options).find(o => o.value === current);
        if (opt) select.value = current;
      }
    }
  } catch (e) {
    select.innerHTML = `<option disabled>Lỗi: ${e.message}</option>`;
  }

  select.onchange = () => {
    document.getElementById('audioInputDevice').value = select.value;
  };
});

document.getElementById('btn-list-render').addEventListener('click', async () => {
  const box    = document.getElementById('render-list');
  const select = document.getElementById('render-device-select');
  const shown  = box.style.display !== 'none';
  if (shown) { box.style.display = 'none'; return; }

  select.innerHTML = '<option>Loading…</option>';
  box.style.display = 'block';
  const { render } = await fetchDevices();
  select.innerHTML = '';
  if (!render.length) {
    select.innerHTML = '<option disabled>No devices found</option>';
  } else {
    render.forEach((d) => select.add(new Option(d, d)));
  }
  select.addEventListener('change', () => {
    document.getElementById('audioOutputDevice').value = select.value;
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────
(async () => {
  const c = await ipc.invoke('config:get');
  loadForm(c);
})();
