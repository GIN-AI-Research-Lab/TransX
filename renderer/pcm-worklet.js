/**
 * renderer/pcm-worklet.js — AudioWorklet Processor
 *
 * Chạy trong Audio Worklet thread (tách biệt với main renderer thread).
 * Nhận float32 samples, mix stereo→mono, convert → Int16, gom thành chunk
 * rồi post về renderer để gửi qua IPC sang main process → Whisper.
 *
 * Không import / require — chỉ dùng spec chuẩn AudioWorkletProcessor.
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Số sample mỗi chunk (16 000 samples = 1 giây ở 16 kHz)
    this._chunkSamples = options.processorOptions?.chunkSamples || 8192;
    this._buf = [];
  }

  process(inputs /*, outputs, parameters */) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const numChannels = input.length;
    const len = input[0].length; // thường 128 samples/block

    for (let i = 0; i < len; i++) {
      // Mix tất cả kênh thành mono
      let sample = 0;
      for (let c = 0; c < numChannels; c++) sample += input[c][i];
      sample /= numChannels;

      this._buf.push(sample);

      if (this._buf.length >= this._chunkSamples) {
        // Float32 → Int16
        const int16 = new Int16Array(this._chunkSamples);
        for (let j = 0; j < this._chunkSamples; j++) {
          int16[j] = Math.round(
            Math.max(-1, Math.min(1, this._buf[j])) * 32767
          );
        }
        // Transfer ArrayBuffer (zero-copy) sang renderer thread
        this.port.postMessage({ type: 'pcm', buf: int16.buffer }, [int16.buffer]);
        this._buf = [];
      }
    }
    return true; // giữ processor sống
  }
}

registerProcessor('pcm-processor', PCMProcessor);
