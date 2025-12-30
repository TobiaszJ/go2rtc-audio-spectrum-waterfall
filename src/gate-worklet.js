class SoftExpanderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    // Runtime-controllable parameters exposed to AudioParam.
    return [
      { name: "enabled", defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: "thresholdDb", defaultValue: -45, minValue: -120, maxValue: 0 },
      { name: "ratio", defaultValue: 3.0, minValue: 1.0, maxValue: 20.0 },
      { name: "attackMs", defaultValue: 10, minValue: 0.1, maxValue: 2000 },
      { name: "releaseMs", defaultValue: 200, minValue: 1, maxValue: 5000 },
    ];
  }

  constructor() {
    super();
    // Smoothed gain value for attack/release behavior.
    this.gainSmooth = 1.0;
  }

  // dB <-> linear helpers.
  dbToLin(db) { return Math.pow(10, db / 20); }
  linToDb(x) { return 20 * Math.log10(Math.max(x, 1e-12)); }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    // Use k-rate values (first sample) if not automated at a-rate.
    const enabled = (params.enabled.length ? params.enabled[0] : 1) >= 0.5;
    const thrDb   = params.thresholdDb.length ? params.thresholdDb[0] : -45;
    const ratio   = params.ratio.length ? params.ratio[0] : 3.0;
    const atkMs   = params.attackMs.length ? params.attackMs[0] : 10;
    const relMs   = params.releaseMs.length ? params.releaseMs[0] : 200;

    // Convert attack/release times into smoothing coefficients.
    const atk = Math.exp(-1 / (sampleRate * (atkMs / 1000)));
    const rel = Math.exp(-1 / (sampleRate * (relMs / 1000)));

    const thr = this.dbToLin(thrDb);

    for (let ch = 0; ch < input.length; ch++) {
      const x = input[ch];
      const y = output[ch];

      // RMS ueber den Block.
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);

      // Downward expander:
      // Wenn rms < threshold: outputDb = thrDb + (inputDb - thrDb) * ratio
      // -> leise wird leiser, aber nicht hart stumm (soft).
      let gTarget = 1.0;
      if (enabled && rms > 0 && rms < thr) {
        const inDb = this.linToDb(rms);
        const outDb = thrDb + (inDb - thrDb) * ratio;
        const gDb = outDb - inDb; // negativ
        gTarget = this.dbToLin(gDb);
      }

      // Smooth gain (attack/release).
      if (gTarget < this.gainSmooth) {
        // Staerker daempfen: attack (schnell).
        this.gainSmooth = gTarget + (this.gainSmooth - gTarget) * atk;
      } else {
        // Wieder oeffnen: release (langsamer).
        this.gainSmooth = gTarget + (this.gainSmooth - gTarget) * rel;
      }

      for (let i = 0; i < x.length; i++) y[i] = x[i] * this.gainSmooth;
    }

    return true;
  }
}

// Register worklet under a stable name used by AudioWorkletNode.
registerProcessor("soft-expander", SoftExpanderProcessor);
