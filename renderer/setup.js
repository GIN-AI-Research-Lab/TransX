'use strict';

/* eslint-disable no-undef */
const ipc = window.electron;

// ── DOM ───────────────────────────────────────────────────────────────────────
const stepDownload = document.getElementById('step-download');
const stepDone     = document.getElementById('step-done');
const stepError    = document.getElementById('step-error');
const errorMsg     = document.getElementById('error-msg');

// ── Buttons ───────────────────────────────────────────────────────────────────
document.getElementById('btn-cancel').addEventListener('click', () => {
  ipc.invoke('setup:cancel');
});

document.getElementById('btn-retry').addEventListener('click', () => {
  ipc.invoke('setup:cancel');
});

// ── Progress events from main (model_missing confirmation) ────────────────────
ipc.on('setup:progress', ({ status }) => {
  if (status === 'model_missing') {
    // Step-download already visible — nothing extra to do
  } else if (status === 'success') {
    stepDownload.style.display = 'none';
    stepDone.style.display     = 'block';
  } else if (status && /error/i.test(status)) {
    stepDownload.style.display = 'none';
    stepError.style.display    = 'block';
    if (errorMsg) errorMsg.textContent = status;
  }
});

// Notify main that the setup window is ready (triggers the model_missing status)
ipc.invoke('setup:start-pull').catch((e) => {
  stepDownload.style.display = 'none';
  stepError.style.display    = 'block';
  if (errorMsg) errorMsg.textContent = e.message || String(e);
});
