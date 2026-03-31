/**
 * renderer/audioCapture.js
 *
 * Capture audio hoàn toàn trong Electron renderer — KHÔNG cần ffmpeg.
 *
 * Nguồn hỗ trợ:
 *  - 'microphone' → getUserMedia({audio})
 *  - 'system'     → desktopCapturer (WASAPI loopback nội bộ Electron/Chrome)
 *  - 'both'       → cả hai, mix lại
 *
 * Sau khi có audio → resample về 16 kHz (qua AudioContext) → Int16 PCM
 * → gửi về main process qua IPC (audio:sendChunk) → AudioBuffer → Whisper.
 *
 * Yêu cầu: `window.electron` (preload contextBridge) phải expose:
 *   invoke('audio:getSources')  → [{id, name}]
 *   invoke('audio:sendChunk', arr)
 */

'use strict';

const TARGET_RATE   = 16000;
const CHUNK_SAMPLES = 8192; // ~512ms ở 16 kHz

class RendererAudioCapture {
  /**
   * @param {object}   ipc      window.electron
   * @param {Function} onError  callback(message: string)
   * @param {Function} onStatus callback(message: string)
   */
  constructor(ipc, onError, onStatus) {
    this._ipc        = ipc;
    this._onError    = onError  || (() => {});
    this._onStatus   = onStatus || (() => {});
    this._ctx        = null;
    this._streams    = [];
    this._worklet    = null;
    this._inputDevice = '';
    this.isRunning   = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────
  /**
   * @param {string} source       'microphone' | 'system' | 'both'
   * @param {string} [inputDevice] Tên hiển thị của thiết bị micro (để trống = mặc định)
   */
  async start(source = 'microphone', inputDevice = '') {
    if (this.isRunning) return;
    this._inputDevice = inputDevice.trim();
    try {
      this._onStatus('Đang mở thiết bị audio…');
      const streams = await this._openStreams(source);
      if (!streams.length) throw new Error('Không mở được bất kỳ nguồn audio nào.');
      this._streams = streams;
      await this._startWorklet(streams);
      this.isRunning = true;
      this._onStatus(null); // xóa trạng thái
    } catch (err) {
      this._cleanup();
      this._onError(err.message);
      throw err;
    }
  }

  stop() {
    this._cleanup();
    this.isRunning = false;
  }

  // ── Private ─────────────────────────────────────────────────────────────
  async _openStreams(source) {
    const streams = [];

    if (source === 'microphone' || source === 'both') {
      try {
        // Tìm deviceId tương ứng với tên thiết bị được chọn trong Settings
        const deviceId = await this._resolveDeviceId(this._inputDevice);
        const audioConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl:  false,
        };
        if (deviceId) audioConstraints.deviceId = { exact: deviceId };

        const s = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false,
        });
        streams.push(s);
        this._onStatus('Microphone OK');
      } catch (e) {
        if (source === 'both') {
          this._onError(`Mic bị từ chối: ${e.message}`);
        } else {
          throw new Error(`Không mở được microphone: ${e.message}`);
        }
      }
    }

    if (source === 'system' || source === 'both') {
      try {
        const s = await this._openSystemAudio();
        streams.push(s);
        this._onStatus('System audio OK');
      } catch (e) {
        if (source === 'both') {
          this._onError(`System audio: ${e.message}`);
        } else {
          throw new Error(`Không mở được system audio: ${e.message}`);
        }
      }
    }

    return streams;
  }

  /**
   * Tìm deviceId khớp với tên label của thiết bị.
   * Nếu preference rỗng hoặc không khớp → trả về null (dùng mic mặc định).
   * @param {string} preference  Tên hiển thị (label) từ Settings
   * @returns {Promise<string|null>}
   */
  async _resolveDeviceId(preference) {
    if (!preference) return null;
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      // Nếu label chưa hiển (điều xảy ra trước khi cấp quyền) → xin quyền tạm thời
      const mics = devices.filter(d => d.kind === 'audioinput');
      if (mics.length && !mics[0].label) {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach(t => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      }
      const match = devices.find(d =>
        d.kind === 'audioinput' && d.label === preference
      );
      return match ? match.deviceId : null;
    } catch {
      return null;
    }
  }

  /**
   * Capture system audio (loopback) qua Electron desktopCapturer.
   * Chrome/Electron dùng WASAPI loopback nội bộ — không cần ffmpeg.
   */
  async _openSystemAudio() {
    // Lấy danh sách desktop sources từ main process
    const sources = await this._ipc.invoke('audio:getSources');
    if (!sources.length) throw new Error('Không tìm thấy desktop source.');

    // Ưu tiên source đầu tiên (thường là màn hình chính)
    const src = sources[0];

    // getUserMedia với chromeMediaSource:desktop → Electron capture system audio
    const constraints = {
      audio: {
        mandatory: {
          chromeMediaSource:   'desktop',
          chromeMediaSourceId: src.id,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource:   'desktop',
          chromeMediaSourceId: src.id,
          maxWidth:    1,
          maxHeight:   1,
          maxFrameRate: 1,
        },
      },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // Dừng video track — chỉ cần audio
    stream.getVideoTracks().forEach((t) => t.stop());
    return stream;
  }

  /** Kết nối tất cả stream vào AudioContext 16kHz → AudioWorklet → IPC */
  async _startWorklet(streams) {
    // AudioContext ở 16kHz: browser tự resample từ 44.1/48kHz
    this._ctx = new AudioContext({ sampleRate: TARGET_RATE });
    await this._ctx.audioWorklet.addModule('./pcm-worklet.js');

    // Merge tất cả stream → 1 ChannelMerger → worklet
    const merger = this._ctx.createChannelMerger(streams.length);

    streams.forEach((stream, i) => {
      const src = this._ctx.createMediaStreamSource(stream);
      src.connect(merger, 0, i);
    });

    this._worklet = new AudioWorkletNode(this._ctx, 'pcm-processor', {
      processorOptions: { chunkSamples: CHUNK_SAMPLES },
      numberOfInputs:   1,
      numberOfOutputs:  1,
    });

    this._worklet.port.onmessage = (ev) => {
      if (ev.data.type === 'pcm' && this.isRunning) {
        // ArrayBuffer → Array<number> để gửi qua IPC an toàn
        const arr = Array.from(new Int16Array(ev.data.buf));
        this._ipc.invoke('audio:sendChunk', arr);
      }
    };

    this._worklet.port.onmessageerror = (ev) => {
      this._onError(`Audio worklet error: ${ev}`);
    };

    merger.connect(this._worklet);
    // Không connect worklet.output → loa (không muốn nghe lại)
  }

  _cleanup() {
    if (this._worklet) {
      this._worklet.port.onmessage = null;
      this._worklet.disconnect();
      this._worklet = null;
    }
    this._streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this._streams = [];
    if (this._ctx) {
      this._ctx.close();
      this._ctx = null;
    }
  }
}

// Expose toàn cục để renderer.js dùng (không cần bundler)
window.RendererAudioCapture = RendererAudioCapture;
