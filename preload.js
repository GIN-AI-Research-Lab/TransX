/**
 * preload.js — Secure contextBridge between renderer and main process.
 * Only whitelisted channels are exposed; no raw ipcRenderer access.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Channels renderer may invoke (request → response)
const INVOKE_CHANNELS = new Set([
  'config:get',
  'config:save',
  'config:reset',
  'whisper:ping',
  'whisper:status',
  'pipeline:toggle',
  'pipeline:status',
  'overlay:setIgnoreMouse',
  'audio:listDevices',
  'audio:getSources',
  'audio:sendChunk',
]);

// Channels renderer may listen to (main → renderer events)
const LISTEN_CHANNELS = new Set([
  'pipeline:status',
  'pipeline:processing',
  'pipeline:listening',
  'pipeline:partial',
  'pipeline:transcript',
  'pipeline:translation',
  'pipeline:error',
]);

contextBridge.exposeInMainWorld('electron', {
  /**
   * Send a request to main and await a response.
   * @param {string} channel
   * @param {...any} args
   * @returns {Promise<any>}
   */
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`[preload] blocked invoke: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  /**
   * Subscribe to events pushed from main.
   * Returns an unsubscribe function.
   * @param {string} channel
   * @param {Function} callback  — called with (...args), no 'event' prefix
   * @returns {() => void}
   */
  on(channel, callback) {
    if (!LISTEN_CHANNELS.has(channel)) return () => {};
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  /** Remove all listeners for a channel (useful on page unload). */
  removeAllListeners(channel) {
    if (LISTEN_CHANNELS.has(channel)) ipcRenderer.removeAllListeners(channel);
  },
});
