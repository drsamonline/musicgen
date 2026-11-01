// A sample-clock tick. setInterval jitters when the main thread is busy;
// this posts a message every N frames from the audio thread instead.

class ClockProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frames = (options?.processorOptions?.frames) || 1024;
    this.count = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'stop') this.running = false;
      if (e.data?.type === 'start') this.running = true;
    };
  }

  process(inputs, outputs) {
    if (!this.running) return true;
    this.count += 128;
    if (this.count >= this.frames) {
      this.count = 0;
      this.port.postMessage({ type: 'tick', time: currentTime });
    }
    return true;
  }
}

registerProcessor('clock-tick', ClockProcessor);
