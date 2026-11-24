// AudioWorklet: collects microphone PCM into blocks and posts them to the main thread.
class TapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ch = (options.processorOptions && options.processorOptions.channels) || 1;
    this.size = 2048; // multiple of 128
    this.alloc();
    this.frame = 0; // index of first sample of current block
    this.stopped = false;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.stopped = true; };
  }
  alloc() {
    this.buf = new Float32Array(this.ch * this.size); // planar
    this.n = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const inp = inputs[0];
    const len = (inp && inp[0]) ? inp[0].length : 128;
    for (let c = 0; c < this.ch; c++) {
      const src = inp && (inp[c] || inp[0]);
      if (src) this.buf.set(src, c * this.size + this.n);
      // missing input = silence (already zeros)
    }
    this.n += len;
    if (this.n >= this.size) {
      const data = this.buf;
      this.port.postMessage({ frame: this.frame, frames: this.size, data }, [data.buffer]);
      this.frame += this.size;
      this.alloc();
    }
    return true;
  }
}
registerProcessor('tap-processor', TapProcessor);
