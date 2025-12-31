export class DSP {
  constructor(config, ui) {
    // External dependencies
    this.config = config;
    this.ui = ui;

    // Signaling + WebRTC state
    this.ws = null;
    this.pc = null;
    this.audioCtx = null;

    // Audio graph nodes
    this.sourceNode = null;
    this.hpNode = null;
    this.lpNode = null;
    this.expNode = null;
    this.analyser = null;
    this.outGain = null;

    // FFT data buffer
    this.freqData = null;

    // Render loop state
    this.running = false;
    this.raf = 0;
    this.lastWfTime = 0;

    // Source mode + file processing state
    this.mode = "live";
    this.fileBuffer = null;
    this.fileSampleRate = 0;
    this.fileDuration = 0;
    this.fileMono = null;
    this.fileName = "";
    this.fileWaterfall = null;
    this.fileCursorTime = 0;
    this.isProcessingFile = false;

    // Offline FFT helpers (file mode)
    this.offlineFftSize = 0;
    this.offlineWindow = null;
    this.offlineRe = null;
    this.offlineIm = null;
    this.offlineMinDb = -100;
    this.offlineMaxDb = -30;

    // Analysis mode helpers
    this.analysisMode = "fixed";
    this.analysisSampleRate = 0;
    this.analysisTimeSize = 0;
    this.analysisMinDb = -100;
    this.analysisMaxDb = -30;
    this.multiFftConfig = [
      { maxHz: 600, size: 16384 },
      { maxHz: 2000, size: 8192 },
      { maxHz: Infinity, size: 2048 },
    ];
    this.cqtBinsPerOctave = 24;
    this.waveletBinsPerOctave = 12;
    this.waveletQScale = 0.6;
    this.cqtMaxSize = 16384;
    this.waveletMaxSize = 8192;
    this.fftCache = new Map();
    this.timeCache = new Map();
    this.windowCache = {
      hann: new Map(),
      gauss: new Map(),
    };
    this.timeData = null;
    this.logBins = {
      cqt: null,
      wavelet: null,
    };
    this.logBinAmps = null;
    this.logBinSmooth = null;
    this.lineSmooth = null;
    this.lineRaw = null;
    this.lineOut = null;
    this.lastAnalysisKey = "";

    // Display noise floor estimator (optional).
    this.noiseFloor = null;
    this.useNoiseFloor = false;

    // Auto gain for display only
    this.renderGain = 1.0;
    this.AUTO_TARGET = 190;
    this.AUTO_SMOOTH = 0.03;

    // External marker frequency (Hz) for overlay.
    this.markerHz = null;
    this.markerFanHz = null;
    this.markerColor = "#f6b21a";
    this.markerFanColor = "#3bd4ff";
    this.markerHarmonics = true;
    this.markerHarmonicsMax = 8;
    this.avgLine = null;

    // File scrub preview audio (short playback snippets).
    this.previewCtx = null;
    this.previewGain = null;
    this.previewNode = null;
    this.previewDuration = 0.25;
    this.previewFadeSec = 0.02;

    // Canvas setup
    this.spec = ui.el.spec;
    this.wf = ui.el.wf;
    this.specG = this.spec.getContext("2d", { alpha:false });
    this.wfG = this.wf.getContext("2d", { alpha:false });
    this.wfCursor = ui.el.wfCursor || null;
    this.wfCursorG = this.wfCursor ? this.wfCursor.getContext("2d") : null;

    // Cursor overlay uses ui.cursorX (local tracking here)
    this.spec.addEventListener("mousemove", (e) => {
      const rect = this.spec.getBoundingClientRect();
      this.cursorX = e.clientX - rect.left;
    });
    this.spec.addEventListener("mouseleave", () => { this.cursorX = null; });
  }

  // Clamp numeric values to an inclusive range.
  clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }

  setMode(mode) {
    const next = mode === "file" ? "file" : "live";
    if (this.mode === next) return;
    this.mode = next;
    if (this.mode !== "file") {
      this.clearFileCursor();
      this.stopPreviewAudio();
    }
  }

  nextPow2(v) {
    let n = 1;
    while (n < v) n <<= 1;
    return n;
  }

  getWindow(type, size) {
    const cache = this.windowCache[type];
    if (cache && cache.has(size)) return cache.get(size);
    const win = new Float32Array(size);
    if (type === "gauss") {
      const center = (size - 1) / 2;
      const sigma = Math.max(1, size * 0.18);
      const denom = 2 * sigma * sigma;
      for (let i = 0; i < size; i++) {
        const x = i - center;
        win[i] = Math.exp(-(x * x) / denom);
      }
    } else {
      const n1 = size - 1;
      for (let i = 0; i < size; i++) {
        win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n1));
      }
    }
    if (cache) cache.set(size, win);
    return win;
  }

  getFftBuffers(size) {
    if (this.fftCache.has(size)) return this.fftCache.get(size);
    const entry = {
      re: new Float32Array(size),
      im: new Float32Array(size),
      win: this.getWindow("hann", size),
      amps: new Float32Array(size / 2),
    };
    this.fftCache.set(size, entry);
    return entry;
  }

  ensureTimeData(size) {
    if (!this.timeData || this.timeData.length !== size) {
      this.timeData = new Float32Array(size);
    }
  }

  updateAnalysisConfig(settings, sampleRate) {
    const mode = settings.analysisMode || "fixed";
    const detail = settings.analysisDetail || "med";
    const prevMode = this.analysisMode;
    this.analysisMode = mode;
    this.analysisSampleRate = sampleRate || this.analysisSampleRate;
    if (this.analyser) {
      this.analysisMinDb = this.analyser.minDecibels;
      this.analysisMaxDb = this.analyser.maxDecibels;
    } else {
      this.analysisMinDb = this.offlineMinDb;
      this.analysisMaxDb = this.offlineMaxDb;
    }

    const cqtDetailMap = {
      low: { bins: 12, maxSize: 4096 },
      med: { bins: 24, maxSize: 8192 },
      high: { bins: 36, maxSize: 16384 },
    };
    const waveDetailMap = {
      low: { bins: 8, maxSize: 4096 },
      med: { bins: 12, maxSize: 8192 },
      high: { bins: 18, maxSize: 16384 },
    };
    const cqtDetail = cqtDetailMap[detail] || cqtDetailMap.med;
    const waveDetail = waveDetailMap[detail] || waveDetailMap.med;
    this.cqtBinsPerOctave = cqtDetail.bins;
    this.cqtMaxSize = cqtDetail.maxSize;
    this.waveletBinsPerOctave = waveDetail.bins;
    this.waveletMaxSize = waveDetail.maxSize;

    if (mode === "multi") {
      const maxSize = this.multiFftConfig.reduce((m, b) => Math.max(m, b.size), 0);
      this.analysisTimeSize = maxSize;
    } else if (mode === "cqt") {
      this.analysisTimeSize = this.cqtMaxSize;
    } else if (mode === "wavelet") {
      this.analysisTimeSize = this.waveletMaxSize;
    } else {
      this.analysisTimeSize = settings.fftSize;
    }
    this.analysisTimeSize = this.clamp(this.nextPow2(this.analysisTimeSize), 32, 32768);

    if (mode !== prevMode) {
      this.logBinSmooth = null;
      this.lineSmooth = null;
      this.lineRaw = null;
      this.renderGain = 1.0;
    }

    if ((mode === "cqt" || mode === "wavelet") && this.analysisSampleRate) {
      const r = this.getRange();
      const key = [
        mode,
        this.analysisSampleRate,
        r.fMin.toFixed(2),
        r.fMax.toFixed(2),
        mode === "cqt" ? this.cqtBinsPerOctave : this.waveletBinsPerOctave,
        mode === "cqt" ? this.cqtMaxSize : this.waveletMaxSize,
      ].join("|");
      if (key !== this.lastAnalysisKey) {
        this.buildLogBins(mode, this.analysisSampleRate, r, this.analysisTimeSize);
        this.lastAnalysisKey = key;
      }
    }
  }

  buildLogBins(mode, sampleRate, range, bufferSize) {
    const binsPerOct = mode === "cqt" ? this.cqtBinsPerOctave : this.waveletBinsPerOctave;
    const qBase = 1 / (Math.pow(2, 1 / binsPerOct) - 1);
    const q = mode === "wavelet" ? qBase * this.waveletQScale : qBase;
    const minHz = Math.max(10, Math.min(range.fMin || 10, range.fMax));
    const nyq = sampleRate ? sampleRate / 2 : this.currentNyq();
    let maxHz = Math.min(range.fMax || nyq, nyq);
    if (maxHz <= minHz) maxHz = Math.min(nyq, minHz * 2);
    const ratio = Math.pow(2, 1 / binsPerOct);
    const bins = [];
    for (let f = minHz; f <= maxHz; f *= ratio) {
      let size = Math.round((q * sampleRate) / f);
      size = this.clamp(size, 64, bufferSize);
      const winType = mode === "wavelet" ? "gauss" : "hann";
      const win = this.getWindow(winType, size);
      const omega = (2 * Math.PI * f) / sampleRate;
      const cos = Math.cos(omega);
      const sin = Math.sin(omega);
      const offset = Math.floor((bufferSize - size) / 2);
      bins.push({ f, size, win, cos, sin, offset });
    }
    const freqs = new Float32Array(bins.length);
    for (let i = 0; i < bins.length; i++) freqs[i] = bins[i].f;
    this.logBins[mode] = { bins, freqs, minHz, maxHz, bufferSize };
    this.logBinAmps = null;
    this.logBinSmooth = null;
  }

  sampleFftAmp(amps, f, nyq) {
    const maxIndex = amps.length - 1;
    const pos = (f / nyq) * maxIndex;
    const i0 = Math.floor(pos);
    if (i0 <= 0) return amps[0] || 0;
    if (i0 >= maxIndex) return amps[maxIndex] || 0;
    const t = pos - i0;
    return amps[i0] * (1 - t) + amps[i0 + 1] * t;
  }

  sampleLogAmp(freqs, amps, f) {
    const n = freqs.length;
    if (!n) return 0;
    if (f <= freqs[0]) return amps[0] || 0;
    if (f >= freqs[n - 1]) return amps[n - 1] || 0;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (freqs[mid] <= f) lo = mid;
      else hi = mid;
    }
    const f0 = freqs[lo];
    const f1 = freqs[hi];
    const t = f1 > f0 ? (f - f0) / (f1 - f0) : 0;
    return amps[lo] * (1 - t) + amps[hi] * t;
  }

  computeFftAmps(timeData, size) {
    const { re, im, win, amps } = this.getFftBuffers(size);
    const offset = Math.max(0, Math.floor((timeData.length - size) / 2));
    for (let i = 0; i < size; i++) {
      const sample = offset + i < timeData.length ? timeData[offset + i] : 0;
      re[i] = sample * win[i];
      im[i] = 0;
    }
    this.fftRadix2(re, im);
    const minDb = this.analysisMinDb;
    const maxDb = this.analysisMaxDb;
    const half = size / 2;
    for (let i = 0; i < half; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / half;
      let db = 20 * Math.log10(mag);
      if (!Number.isFinite(db)) db = minDb;
      db = this.clamp(db, minDb, maxDb);
      amps[i] = Math.pow(10, (db - maxDb) / 20);
    }
    return amps;
  }

  computeLogBinAmps(timeData, mode) {
    const log = this.logBins[mode];
    if (!log || !log.bins || !log.bins.length) return null;
    const bins = log.bins;
    const count = bins.length;
    if (!this.logBinAmps || this.logBinAmps.length !== count) {
      this.logBinAmps = new Float32Array(count);
    }
    const minDb = this.analysisMinDb;
    const maxDb = this.analysisMaxDb;
    for (let i = 0; i < count; i++) {
      const bin = bins[i];
      const size = bin.size;
      const win = bin.win;
      const cosStep = bin.cos;
      const sinStep = bin.sin;
      let cosN = 1;
      let sinN = 0;
      let re = 0;
      let im = 0;
      let idx = bin.offset;
      for (let n = 0; n < size; n++) {
        const sample = timeData[idx + n] || 0;
        const w = sample * win[n];
        re += w * cosN;
        im -= w * sinN;
        const nextCos = cosN * cosStep - sinN * sinStep;
        const nextSin = sinN * cosStep + cosN * sinStep;
        cosN = nextCos;
        sinN = nextSin;
      }
      const mag = Math.sqrt(re * re + im * im) / (size / 2);
      let db = 20 * Math.log10(mag);
      if (!Number.isFinite(db)) db = minDb;
      db = this.clamp(db, minDb, maxDb);
      this.logBinAmps[i] = Math.pow(10, (db - maxDb) / 20);
    }
    return this.logBinAmps;
  }

  smoothLineValues(values, smoothing) {
    if (!this.lineSmooth || this.lineSmooth.length !== values.length) {
      this.lineSmooth = new Float32Array(values.length);
      for (let i = 0; i < values.length; i++) this.lineSmooth[i] = values[i];
      return this.lineSmooth;
    }
    const alpha = this.clamp(smoothing, 0, 0.95);
    for (let i = 0; i < values.length; i++) {
      this.lineSmooth[i] = this.lineSmooth[i] * alpha + values[i] * (1 - alpha);
    }
    return this.lineSmooth;
  }

  applyAutoGainToLine(values) {
    const r = this.getRange();
    let peak = 1;
    for (let i = 0; i < values.length; i++) if (values[i] > peak) peak = values[i];
    if (r.autoGain) {
      const target = peak > 0 ? (this.AUTO_TARGET / peak) : 1.0;
      this.renderGain = this.renderGain + (target - this.renderGain) * this.AUTO_SMOOTH;
    } else {
      this.renderGain = 1.0;
    }
    if (!this.isProcessingFile) this.ui.setAutoGainValue(this.renderGain);
    if (!this.lineOut || this.lineOut.length !== values.length) {
      this.lineOut = new Uint8Array(values.length);
    }
    const scale = this.renderGain;
    for (let i = 0; i < values.length; i++) {
      this.lineOut[i] = this.clamp(values[i] * scale, 0, 255);
    }
    return this.lineOut;
  }

  buildLineFromSampler(sampleFn) {
    const r = this.getRange();
    const plotW = this.spec.width - r.pad.left - r.pad.right;
    if (!this.lineRaw || this.lineRaw.length !== plotW) {
      this.lineRaw = new Float32Array(plotW);
    }
    const hp = Number.isFinite(r.hpHz) ? this.clamp(r.hpHz, 0, r.nyq) : 0;
    const lp = Number.isFinite(r.lpHz) ? this.clamp(r.lpHz, 0, r.nyq) : r.nyq;
    for (let px = 0; px < plotW; px++) {
      const f = this.xNormToF(px / plotW);
      const amp = (f < hp || f > lp) ? 0 : sampleFn(f);
      this.lineRaw[px] = Math.min(255, amp * 255 * r.gain);
    }
    const values = (this.mode === "live" && r.smoothing > 0)
      ? this.smoothLineValues(this.lineRaw, r.smoothing)
      : this.lineRaw;
    return this.applyAutoGainToLine(values);
  }

  computeLineMultiFft(timeData, sampleRate) {
    const nyq = sampleRate / 2;
    const ampsBySize = new Map();
    for (const band of this.multiFftConfig) {
      ampsBySize.set(band.size, this.computeFftAmps(timeData, band.size));
    }
    const overlapHz = 120;
    const sampler = (f) => {
      let idx = 0;
      while (idx < this.multiFftConfig.length - 1 && f > this.multiFftConfig[idx].maxHz) idx++;
      const band = this.multiFftConfig[idx];
      let amp = this.sampleFftAmp(ampsBySize.get(band.size), f, nyq);
      if (idx < this.multiFftConfig.length - 1) {
        const edge = band.maxHz;
        if (f > edge - overlapHz) {
          const next = this.multiFftConfig[idx + 1];
          const t = (f - (edge - overlapHz)) / overlapHz;
          const ampNext = this.sampleFftAmp(ampsBySize.get(next.size), f, nyq);
          amp = amp * (1 - t) + ampNext * t;
        }
      } else if (idx > 0) {
        const prev = this.multiFftConfig[idx - 1];
        const edge = prev.maxHz;
        if (f < edge + overlapHz) {
          const t = (edge + overlapHz - f) / overlapHz;
          const ampPrev = this.sampleFftAmp(ampsBySize.get(prev.size), f, nyq);
          amp = amp * (1 - t) + ampPrev * t;
        }
      }
      return amp;
    };
    return this.buildLineFromSampler(sampler);
  }

  computeLineLogBins(timeData, mode) {
    const log = this.logBins[mode];
    if (!log) return null;
    const amps = this.computeLogBinAmps(timeData, mode);
    if (!amps) return null;
    const freqs = log.freqs;
    return this.buildLineFromSampler((f) => this.sampleLogAmp(freqs, amps, f));
  }

  computeLineFromTimeData(timeData, sampleRate) {
    if (this.analysisMode === "multi") return this.computeLineMultiFft(timeData, sampleRate);
    if (this.analysisMode === "cqt") return this.computeLineLogBins(timeData, "cqt");
    if (this.analysisMode === "wavelet") return this.computeLineLogBins(timeData, "wavelet");
    return null;
  }

  // Build WebSocket URL from configured HTTP(S) base.
  wsUrl() {
    const u = new URL(this.config.go2rtcHost);
    const proto = (u.protocol === "https:") ? "wss:" : "ws:";
    return `${proto}//${u.host}/api/ws?src=${encodeURIComponent(this.config.src)}`;
  }

  // Current Nyquist frequency based on the AudioContext sample rate.
  currentNyq() {
    if (this.mode === "file" && this.fileSampleRate) return this.fileSampleRate / 2;
    const fs = this.audioCtx ? this.audioCtx.sampleRate : 48000;
    return fs/2;
  }

  // Normalize and validate display settings (freq range, log scale, padding).
  getRange() {
    const s = this.ui.getSettings();
    const nyq = this.currentNyq();

    let fMin = isFinite(s.fMin) ? s.fMin : 0;
    let fMax = isFinite(s.fMax) ? s.fMax : 4000;

    fMin = this.clamp(fMin, 0, nyq);
    fMax = this.clamp(fMax, 1, nyq);
    if (fMax <= fMin) fMax = Math.min(nyq, fMin + 1);

    // For log scale we must avoid <= 0 to keep log() valid.
    const fMinForLog = Math.max(1, fMin);
    return { ...s, nyq, fMin, fMax, fMinForLog };
  }

  // Convert normalized X (0..1) to frequency, respecting log/linear mode.
  xNormToF(xNorm) {
    const r = this.getRange();
    const t = this.clamp(xNorm, 0, 1);
    if (!r.log) return r.fMin + t * (r.fMax - r.fMin);
    const ratio = r.fMax / r.fMinForLog;
    return r.fMinForLog * Math.pow(ratio, t);
  }

  // Convert frequency to normalized X (0..1) for plot positioning.
  fToXNorm(f) {
    const r = this.getRange();
    const ff = this.clamp(f, r.fMin, r.fMax);
    if (!r.log) return (ff - r.fMin) / (r.fMax - r.fMin);
    return Math.log(ff / r.fMinForLog) / Math.log(r.fMax / r.fMinForLog);
  }

  // Map frequency to FFT bin index.
  binForFreq(f) {
    const nyq = this.currentNyq();
    const bins = this.freqData.length;
    return this.clamp(Math.floor((f / nyq) * bins), 0, bins - 1);
  }

  // Waterfall color map for 0..255 intensity.
  colorMap(v) {
    const x = v / 255;
    const r = this.clamp(255 * Math.pow(x, 0.9), 0, 255);
    const g = this.clamp(255 * Math.pow(x, 2.0), 0, 255);
    const b = this.clamp(255 * (1.2 - Math.pow(x, 0.55)), 0, 255);
    return [r|0, g|0, b|0];
  }

  // Convert analyser byte (0..255) to linear amplitude (0..1), normalized to maxDecibels.
  byteToAmp(vByte) {
    const minDb = this.analyser ? this.analyser.minDecibels : -100;
    const maxDb = this.analyser ? this.analyser.maxDecibels : -30;
    const db = minDb + (vByte / 255) * (maxDb - minDb);
    return Math.pow(10, (db - maxDb) / 20);
  }

  setMarkerHz(hz) {
    this.markerHz = Number.isFinite(hz) ? hz : null;
  }

  setMarkerFanHz(hz) {
    this.markerFanHz = Number.isFinite(hz) ? hz : null;
  }

  setMarkerOptions(opts) {
    if (opts?.color) this.markerColor = opts.color;
    if (opts?.fanColor) this.markerFanColor = opts.fanColor;
    if (typeof opts?.harmonics === "boolean") this.markerHarmonics = opts.harmonics;
  }

  hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return [246, 178, 26];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  markerFreqs(r, baseHz) {
    if (baseHz === null || !Number.isFinite(baseHz)) return [];
    const freqs = [baseHz];
    if (this.markerHarmonics) {
      for (let i = 2; i <= this.markerHarmonicsMax; i++) {
        const f = baseHz * i;
        if (f > r.fMax) break;
        freqs.push(f);
      }
    }
    return freqs;
  }

  updateAvgLine(line) {
    if (!this.avgLine || this.avgLine.length !== line.length) {
      this.avgLine = new Float32Array(line.length);
      for (let i = 0; i < line.length; i++) this.avgLine[i] = line[i];
      return;
    }
    const alpha = 0.02;
    for (let i = 0; i < line.length; i++) {
      this.avgLine[i] = this.avgLine[i] + (line[i] - this.avgLine[i]) * alpha;
    }
  }

  findTopPeaks(plotW, r) {
    if (!this.avgLine) return [];
    const peaks = [];
    const minSep = 12;
    const minAmp = 18;
    for (let i = 2; i < this.avgLine.length - 2; i++) {
      const v = this.avgLine[i];
      if (v < minAmp) continue;
      if (v > this.avgLine[i - 1] && v >= this.avgLine[i + 1]) {
        peaks.push({ i, v });
      }
    }
    peaks.sort((a, b) => b.v - a.v);
    const selected = [];
    for (let i = 0; i < peaks.length && selected.length < 5; i++) {
      const p = peaks[i];
      if (selected.every((s) => Math.abs(s.i - p.i) >= minSep)) selected.push(p);
    }
    selected.sort((a, b) => a.i - b.i);
    return selected.map((p) => {
      const f = this.xNormToF(p.i / plotW);
      return { i: p.i, f };
    });
  }

  async start() {
    if (this.running) return;
    if (this.mode === "file") return;
    this.ui.setStatus("init");

    // AudioContext must be resumed from a user gesture in browsers.
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await this.audioCtx.resume();
    this.ui.setSampleRate(this.audioCtx.sampleRate);

    // Load the expander worklet before creating the node.
    await this.audioCtx.audioWorklet.addModule("./gate-worklet.js");

    // Core analyser node (FFT).
    this.analyser = this.audioCtx.createAnalyser();
    const s = this.ui.getSettings();
    this.analyser.fftSize = s.fftSize;
    this.analyser.smoothingTimeConstant = s.smoothing;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

    // Optional audio output (muted by default).
    this.outGain = this.audioCtx.createGain();
    this.outGain.gain.value = 1.0;
    this.outGain.connect(this.audioCtx.destination);

    // Signaling to go2rtc over WebSocket.
    this.ui.setStatus("ws open");
    this.ws = new WebSocket(this.wsUrl());

    this.ws.onopen = async () => {
      this.ui.setStatus("webrtc");
      this.pc = new RTCPeerConnection(); // LAN

      this.pc.onicecandidate = (e) => {
        if (e.candidate) this.ws.send(JSON.stringify({ type:"webrtc/candidate", value: e.candidate.candidate }));
        else this.ws.send(JSON.stringify({ type:"webrtc/candidate", value:"" }));
      };

      this.pc.ontrack = (e) => this.onTrack(e);

      this.pc.addTransceiver("audio", { direction: "recvonly" });
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.ws.send(JSON.stringify({ type:"webrtc/offer", value: offer.sdp }));
    };

    this.ws.onmessage = async (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === "webrtc/answer") {
        await this.pc.setRemoteDescription({ type:"answer", sdp: data.value });
        this.ui.setStatus("answer set");
      } else if (data.type === "webrtc/candidate" && data.value) {
        try { await this.pc.addIceCandidate({ candidate: data.value }); } catch {}
      }
    };

    this.ws.onerror = () => this.ui.setStatus("ws error");
    this.ws.onclose = () => { if (!this.running) this.ui.setStatus("ws closed"); };
  }

  onTrack(e) {
    const stream = e.streams[0];

    // Chain: source -> HP -> LP -> Expander -> Analyser -> (optional out)
    this.sourceNode = this.audioCtx.createMediaStreamSource(stream);

    this.hpNode = this.audioCtx.createBiquadFilter();
    this.hpNode.type = "highpass";
    this.hpNode.Q.value = 0.707;

    this.lpNode = this.audioCtx.createBiquadFilter();
    this.lpNode.type = "lowpass";
    this.lpNode.Q.value = 0.707;

    this.expNode = new AudioWorkletNode(this.audioCtx, "soft-expander");

    this.sourceNode.connect(this.hpNode);
    this.hpNode.connect(this.lpNode);
    this.lpNode.connect(this.expNode);
    this.expNode.connect(this.analyser);

    // Optional audio out
    const s = this.ui.getSettings();
    this.setAudioOut(s.audioOut);

    // Reset display state for a clean start.
    this.noiseFloor = null;
    this.renderGain = 1.0;
    this.lastWfTime = 0;

    this.running = true;
    this.ui.setRunning(true);

    this.applySettings();
    this.raf = requestAnimationFrame((ts) => this.tick(ts));
  }

  stop() {
    // Stop render loop first to avoid touching freed nodes.
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stopPreviewAudio();

    try { this.ws && this.ws.close(); } catch {}
    try { this.pc && this.pc.close(); } catch {}
    try { this.audioCtx && this.audioCtx.close(); } catch {}

    this.ws = this.pc = this.audioCtx = null;
    this.sourceNode = this.hpNode = this.lpNode = this.expNode = this.analyser = this.outGain = null;
    this.freqData = null;
    this.noiseFloor = null;

    this.ui.setRunning(false);
    this.ui.setSampleRate(0);
  }

  applySettings() {
    const s = this.ui.getSettings();
    const sampleRate = this.audioCtx ? this.audioCtx.sampleRate : this.fileSampleRate;
    this.updateAnalysisConfig(s, sampleRate);
    if (this.mode === "file") {
      if (this.analysisMode === "fixed") this.ensureOfflineFft(s.fftSize);
      return;
    }
    if (!this.audioCtx || !this.analyser) return;
    const targetFft = this.analysisMode === "fixed" ? s.fftSize : this.analysisTimeSize;
    if (this.analyser.fftSize !== targetFft) this.analyser.fftSize = targetFft;
    this.analyser.smoothingTimeConstant = s.smoothing;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.ensureTimeData(this.analyser.fftSize);

    const nyq = this.currentNyq();

    if (this.hpNode) this.hpNode.frequency.value = this.clamp(s.hpHz || 0, 0, nyq);
    if (this.lpNode) this.lpNode.frequency.value = this.clamp(s.lpHz || nyq, 10, nyq);

    // Update expander parameters via AudioParam for smooth changes.
    if (this.expNode) {
      const p = this.expNode.parameters;
      p.get("enabled").setValueAtTime(s.expOn ? 1 : 0, this.audioCtx.currentTime);
      p.get("thresholdDb").setValueAtTime(s.expThreshDb ?? -45, this.audioCtx.currentTime);
      p.get("ratio").setValueAtTime(this.clamp(s.expRatio ?? 3.0, 1.0, 20.0), this.audioCtx.currentTime);
      p.get("attackMs").setValueAtTime(this.clamp(s.expAttackMs ?? 10, 0.1, 2000), this.audioCtx.currentTime);
      p.get("releaseMs").setValueAtTime(this.clamp(s.expReleaseMs ?? 200, 1, 5000), this.audioCtx.currentTime);
    }

    this.setAudioOut(s.audioOut);
  }

  // Connect or disconnect audio output without affecting the analyser.
  setAudioOut(enabled) {
    if (!this.analyser || !this.outGain) return;
    try { this.analyser.disconnect(); } catch {}
    if (enabled) this.analyser.connect(this.outGain);
  }

  buildLine() {
    const r = this.getRange();
    const plotW = this.spec.width - r.pad.left - r.pad.right;

    if (this.useNoiseFloor) {
      // Noise floor init.
      if (!this.noiseFloor || this.noiseFloor.length !== this.freqData.length) {
        this.noiseFloor = new Float32Array(this.freqData.length);
        for (let i=0;i<this.noiseFloor.length;i++) this.noiseFloor[i] = this.freqData[i];
      }

      // Update noise floor with a very slow follower.
      for (let i=0;i<this.freqData.length;i++) {
        const v = this.freqData[i];
        const nf = this.noiseFloor[i];
        this.noiseFloor[i] = v < nf ? (nf + (v - nf) * 0.05) : (nf + (v - nf) * 0.001);
      }
    }

    const line = new Uint8Array(plotW);
    let peak = 1;

    // Build one spectrum line in screen pixels.
    for (let px=0; px<plotW; px++) {
      const f = this.xNormToF(px / plotW);
      const i = this.binForFreq(f);

      const raw = this.freqData[i];
      const sub = this.useNoiseFloor ? Math.max(0, raw - this.noiseFloor[i]) : raw;
      const amp = this.byteToAmp(sub);

      let v = Math.min(255, amp * 255 * r.gain);
      line[px] = v;
      if (v > peak) peak = v;
    }

    // Auto gain (display only).
    if (r.autoGain) {
      const target = peak > 0 ? (this.AUTO_TARGET / peak) : 1.0;
      this.renderGain = this.renderGain + (target - this.renderGain) * this.AUTO_SMOOTH;
    } else {
      this.renderGain = 1.0;
    }
    if (!this.isProcessingFile) this.ui.setAutoGainValue(this.renderGain);

    if (this.renderGain !== 1.0) {
      for (let px=0; px<line.length; px++) line[px] = this.clamp(line[px] * this.renderGain, 0, 255);
    }

    return line;
  }

  drawSpectrum(line) {
    const r = this.getRange();
    const w = this.spec.width, h = this.spec.height;
    const g = this.specG;

    const plotW = w - r.pad.left - r.pad.right;
    const plotH = h - r.pad.top - r.pad.bottom;

    // Background
    g.fillStyle = "#0b0f14";
    g.fillRect(0,0,w,h);

    // Grid and labels
    g.strokeStyle = "#1d2633";
    g.fillStyle = "#b9c7dd";
    g.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";

    const ticks = r.log
      ? [10,20,50,100,200,500,1000,2000,3000,4000,6000,8000,12000,16000,20000]
      : (() => { const a=[]; for (let i=0;i<=6;i++) a.push(r.fMin + (i/6)*(r.fMax-r.fMin)); return a; })();

    for (const f0 of ticks) {
      const f = Math.round(f0);
      if (f < r.fMin || f > r.fMax) continue;
      const x = r.pad.left + this.fToXNorm(f) * plotW;
      g.beginPath();
      g.moveTo(x, r.pad.top);
      g.lineTo(x, r.pad.top + plotH);
      g.stroke();
      const label = (f >= 1000) ? (f/1000).toFixed(f % 1000 === 0 ? 0 : 1) + "k" : String(f);
      g.fillText(label, x - 10, h - 8);
    }

    // Y ticks (linear amplitude)
    for (let t=0; t<=6; t++) {
      const y = r.pad.top + (t/6)*plotH;
      g.beginPath();
      g.moveTo(r.pad.left, y);
      g.lineTo(r.pad.left + plotW, y);
      g.stroke();
      const amp = (1 - (t/6)).toFixed(2);
      g.fillText(amp, 8, y + 4);
    }

    g.strokeStyle = "#2b3a52";
    g.strokeRect(r.pad.left, r.pad.top, plotW, plotH);

    // Visualize HP/LP filters in the spectrum plot.
    const hpHz = Number.isFinite(r.hpHz) ? this.clamp(r.hpHz, r.fMin, r.fMax) : r.fMin;
    const lpHz = Number.isFinite(r.lpHz) ? this.clamp(r.lpHz, r.fMin, r.fMax) : r.fMax;
    const hpX = r.pad.left + this.fToXNorm(hpHz) * plotW;
    const lpX = r.pad.left + this.fToXNorm(lpHz) * plotW;
    g.save();
    g.fillStyle = "rgba(7, 10, 16, 0.55)";
    if (hpHz > r.fMin) g.fillRect(r.pad.left, r.pad.top, Math.max(0, hpX - r.pad.left), plotH);
    if (lpHz < r.fMax) g.fillRect(lpX, r.pad.top, Math.max(0, r.pad.left + plotW - lpX), plotH);
    g.strokeStyle = "rgba(185, 199, 221, 0.25)";
    g.setLineDash([4, 4]);
    if (hpHz > r.fMin) {
      g.beginPath();
      g.moveTo(hpX, r.pad.top);
      g.lineTo(hpX, r.pad.top + plotH);
      g.stroke();
    }
    if (lpHz < r.fMax) {
      g.beginPath();
      g.moveTo(lpX, r.pad.top);
      g.lineTo(lpX, r.pad.top + plotH);
      g.stroke();
    }
    g.restore();

    // Marker line (e.g. compressor speed) + optional harmonics.
    const drawMarker = (freqs, color) => {
      if (!freqs.length) return;
      g.save();
      g.strokeStyle = color;
      for (let i = 0; i < freqs.length; i++) {
        const f = freqs[i];
        if (f < r.fMin || f > r.fMax) continue;
        g.globalAlpha = i === 0 ? 0.9 : 0.35;
        const mx = r.pad.left + this.fToXNorm(f) * plotW;
        g.beginPath();
        g.moveTo(mx, r.pad.top);
        g.lineTo(mx, r.pad.top + plotH);
        g.stroke();
      }
      g.restore();
    };
    drawMarker(this.markerFreqs(r, this.markerHz), this.markerColor);
    drawMarker(this.markerFreqs(r, this.markerFanHz), this.markerFanColor);

    // Spectrum line
    g.strokeStyle = "#e8eef7";
    g.beginPath();
    for (let px=0; px<plotW; px++) {
      const v = line[px];
      const amp = this.clamp(v / 255, 0, 1);
      const y = r.pad.top + (1 - amp) * plotH;
      const x = r.pad.left + px;
      if (px===0) g.moveTo(x,y); else g.lineTo(x,y);
    }
    g.stroke();

    // Stable peak labels (EMA over time).
    this.updateAvgLine(line);
    const peaks = this.findTopPeaks(plotW, r);
    g.fillStyle = "#c8d4ea";
    for (let p = 0; p < peaks.length; p++) {
      const { i, f } = peaks[p];
      const x = r.pad.left + i;
      const y = r.pad.top + 12 + p * 12;
      const label = f >= 1000 ? `${(f/1000).toFixed(2)}k` : `${f.toFixed(1)}`;
      g.fillText(label, x + 4, y);
    }

    // Cursor overlay inside plot
    if (this.cursorX !== null) {
      const px = this.clamp(this.cursorX - r.pad.left, 0, plotW);
      const f = this.xNormToF(px / plotW);

      const txt = `${f.toFixed(0)} Hz (${(f/1000).toFixed(2)} kHz)`;
      const tw = g.measureText(txt).width;
      g.fillStyle = "rgba(185,199,221,0.95)";
      g.fillText(txt, r.pad.left + plotW - tw - 8, r.pad.top + 16);
    }
  }

  drawWaterfallRow(line) {
    const r = this.getRange();
    const w = this.wf.width, h = this.wf.height;
    const g = this.wfG;

    const plotX = r.pad.left;
    const plotW = w - r.pad.left - r.pad.right;
    const wrap = this.ui.el.wfWrap;
    const stickToTop = wrap ? wrap.scrollTop <= 2 : false;

    // Side areas (pad)
    g.fillStyle = "#0b0f14";
    g.fillRect(0,0,r.pad.left,h);
    g.fillRect(w-r.pad.right,0,r.pad.right,h);

    // Scroll only plot area by one pixel row.
    const img = g.getImageData(plotX, 0, plotW, h-1);
    g.putImageData(img, plotX, 1);

    // Write new row at the top.
    const row = g.createImageData(plotW, 1);
    for (let px=0; px<plotW; px++) {
      const v = line[px] | 0;
      const [rr,gg,bb] = this.colorMap(v);
      const o = px*4;
      row.data[o]=rr; row.data[o+1]=gg; row.data[o+2]=bb; row.data[o+3]=255;
    }

    // Overlay marker pixel at the current row (with harmonics if enabled).
    const drawMarkerRow = (freqs, color) => {
      if (!freqs.length) return;
      const [mr, mg, mb] = this.hexToRgb(color);
      for (let i = 0; i < freqs.length; i++) {
        const f = freqs[i];
        if (f < r.fMin || f > r.fMax) continue;
        const mx = Math.round(this.fToXNorm(f) * (plotW - 1));
        const o = mx * 4;
        const scale = i === 0 ? 1 : 0.6;
        row.data[o] = Math.round(mr * scale);
        row.data[o+1] = Math.round(mg * scale);
        row.data[o+2] = Math.round(mb * scale);
        row.data[o+3] = 255;
      }
    };
    drawMarkerRow(this.markerFreqs(r, this.markerHz), this.markerColor);
    drawMarkerRow(this.markerFreqs(r, this.markerFanHz), this.markerFanColor);
    g.putImageData(row, plotX, 0);
    if (stickToTop && wrap) wrap.scrollTop = 0;
  }

  resetDisplayState() {
    this.noiseFloor = null;
    this.renderGain = 1.0;
    this.lastWfTime = 0;
    this.avgLine = null;
    this.lineSmooth = null;
    this.logBinSmooth = null;
  }

  ensureOfflineFft(fftSize) {
    const size = Number(fftSize);
    if (!size || (size & (size - 1)) !== 0) return;
    if (this.offlineFftSize === size) return;
    this.offlineFftSize = size;
    this.offlineWindow = this.buildWindow(size);
    this.offlineRe = new Float32Array(size);
    this.offlineIm = new Float32Array(size);
    this.freqData = new Uint8Array(size / 2);
  }

  buildWindow(size) {
    const win = new Float32Array(size);
    const n1 = size - 1;
    for (let i = 0; i < size; i++) {
      win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n1));
    }
    return win;
  }

  fftRadix2(re, im) {
    const n = re.length;
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wLenCos = Math.cos(ang);
      const wLenSin = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wCos = 1;
        let wSin = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k];
          const uIm = im[i + k];
          const vRe = re[i + k + len / 2] * wCos - im[i + k + len / 2] * wSin;
          const vIm = re[i + k + len / 2] * wSin + im[i + k + len / 2] * wCos;
          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe;
          im[i + k + len / 2] = uIm - vIm;
          const nextCos = wCos * wLenCos - wSin * wLenSin;
          const nextSin = wCos * wLenSin + wSin * wLenCos;
          wCos = nextCos;
          wSin = nextSin;
        }
      }
    }
  }

  computeFreqDataAtTime(timeSec) {
    if (!this.fileMono || !this.fileSampleRate) return null;
    const t = this.clamp(timeSec, 0, this.fileDuration || 0);
    const fftSize = this.offlineFftSize || this.ui.getSettings().fftSize;
    this.ensureOfflineFft(fftSize);

    const re = this.offlineRe;
    const im = this.offlineIm;
    const win = this.offlineWindow;
    const center = Math.floor(t * this.fileSampleRate);
    const start = center - Math.floor(fftSize / 2);
    const data = this.fileMono;

    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      const sample = idx >= 0 && idx < data.length ? data[idx] : 0;
      re[i] = sample * win[i];
      im[i] = 0;
    }

    this.fftRadix2(re, im);
    const minDb = this.offlineMinDb;
    const maxDb = this.offlineMaxDb;
    const scale = 255 / (maxDb - minDb);
    const half = fftSize / 2;

    for (let i = 0; i < half; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / half;
      let db = 20 * Math.log10(mag);
      if (!Number.isFinite(db)) db = minDb;
      let v = Math.round((db - minDb) * scale);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      this.freqData[i] = v;
    }

    const s = this.ui.getSettings();
    const nyq = this.currentNyq();
    const hp = Number.isFinite(s.hpHz) ? this.clamp(s.hpHz, 0, nyq) : 0;
    const lp = Number.isFinite(s.lpHz) ? this.clamp(s.lpHz, 0, nyq) : nyq;
    const hpBin = Math.floor((hp / nyq) * this.freqData.length);
    const lpBin = Math.ceil((lp / nyq) * this.freqData.length);
    for (let i = 0; i < hpBin; i++) this.freqData[i] = 0;
    for (let i = Math.min(lpBin, this.freqData.length); i < this.freqData.length; i++) {
      this.freqData[i] = 0;
    }

    return this.freqData;
  }

  getFileTimeData(timeSec, size) {
    if (!this.fileMono || !this.fileSampleRate) return null;
    const len = Math.max(1, size);
    let buf = this.timeCache.get(len);
    if (!buf) {
      buf = new Float32Array(len);
      this.timeCache.set(len, buf);
    }
    const t = this.clamp(timeSec, 0, this.fileDuration || 0);
    const center = Math.floor(t * this.fileSampleRate);
    const start = center - Math.floor(len / 2);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      buf[i] = idx >= 0 && idx < this.fileMono.length ? this.fileMono[idx] : 0;
    }
    return buf;
  }

  renderSpectrumAtTime(timeSec) {
    if (this.mode !== "file" || !this.fileBuffer) return;
    const t = this.clamp(timeSec, 0, this.fileDuration || 0);
    this.fileCursorTime = t;
    let line = null;
    if (this.analysisMode === "fixed") {
      this.computeFreqDataAtTime(t);
      line = this.buildLine();
    } else {
      const timeData = this.getFileTimeData(t, this.analysisTimeSize || this.cqtMaxSize);
      line = timeData ? this.computeLineFromTimeData(timeData, this.fileSampleRate) : null;
      if (!line) {
        this.computeFreqDataAtTime(t);
        line = this.buildLine();
      }
    }
    this.drawSpectrum(line);
    this.drawFileCursor(t);
  }

  async renderWaterfallForFile(startSec, endSec, progressCb) {
    if (this.mode !== "file" || !this.fileBuffer || !this.fileMono) return;
    const viewH = Math.max(1, this.ui.getWaterfallViewHeight());
    const r = this.getRange();
    const w = this.wf.width;
    const plotW = w - r.pad.left - r.pad.right;
    if (plotW <= 0) return;

    const minT = 0;
    const maxT = this.fileDuration || 0;
    let start = this.clamp(startSec, minT, maxT);
    let end = this.clamp(endSec, minT, maxT);
    if (end <= start) end = Math.min(maxT, start + 0.01);

    if (this.wf.height !== viewH) this.wf.height = viewH;
    if (this.wfCursor && this.wfCursor.height !== viewH) this.wfCursor.height = viewH;

    const g = this.wfG;
    g.fillStyle = "#0b0f14";
    g.fillRect(0, 0, w, viewH);

    const img = g.createImageData(plotW, viewH);
    const rows = viewH;
    const span = Math.max(0.0001, end - start);
    const denom = Math.max(1, rows - 1);
    const onProgress = typeof progressCb === "function" ? progressCb : null;

    this.resetDisplayState();
    this.isProcessingFile = true;
    try {
      for (let row = 0; row < rows; row++) {
        const t = start + (row / denom) * span;
        let line = null;
        if (this.analysisMode === "fixed") {
          this.computeFreqDataAtTime(t);
          line = this.buildLine();
        } else {
          const timeData = this.getFileTimeData(t, this.analysisTimeSize || this.cqtMaxSize);
          line = timeData ? this.computeLineFromTimeData(timeData, this.fileSampleRate) : null;
          if (!line) {
            this.computeFreqDataAtTime(t);
            line = this.buildLine();
          }
        }
        const lineLen = Math.min(plotW, line.length);
        for (let px = 0; px < lineLen; px++) {
          const v = line[px] | 0;
          const [rr, gg, bb] = this.colorMap(v);
          const o = (row * plotW + px) * 4;
          img.data[o] = rr;
          img.data[o + 1] = gg;
          img.data[o + 2] = bb;
          img.data[o + 3] = 255;
        }
        if (onProgress && (row === 0 || row === rows - 1 || row % 8 === 0)) {
          onProgress({ row, rows, timeSec: t });
        }
        if (row % 20 === 0) await this.yieldToUi();
      }
    } finally {
      this.isProcessingFile = false;
    }

    g.putImageData(img, r.pad.left, 0);
    g.fillStyle = "#0b0f14";
    g.fillRect(0, 0, r.pad.left, viewH);
    g.fillRect(w - r.pad.right, 0, r.pad.right, viewH);

    this.fileWaterfall = { startSec: start, endSec: end, height: viewH };
    this.drawFileCursor(this.fileCursorTime || start);
    if (onProgress) onProgress({ row: rows, rows, timeSec: end });
  }

  drawFileCursor(timeSec) {
    if (!this.fileWaterfall || !this.wfCursorG || !this.wfCursor) return;
    const { startSec, endSec, height } = this.fileWaterfall;
    const span = Math.max(0.0001, endSec - startSec);
    const t = this.clamp(timeSec, startSec, endSec);
    const y = ((t - startSec) / span) * (height - 1);
    const g = this.wfCursorG;
    g.clearRect(0, 0, this.wfCursor.width, this.wfCursor.height);
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(this.wfCursor.width, y + 0.5);
    g.stroke();
  }

  clearFileCursor() {
    if (!this.wfCursorG || !this.wfCursor) return;
    this.wfCursorG.clearRect(0, 0, this.wfCursor.width, this.wfCursor.height);
  }

  clearFileWaterfall() {
    this.fileWaterfall = null;
    this.clearFileCursor();
    if (!this.wfG) return;
    this.wfG.fillStyle = "#0b0f14";
    this.wfG.fillRect(0, 0, this.wf.width, this.wf.height);
  }

  ensurePreviewContext() {
    if (this.previewCtx) return;
    this.previewCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.previewGain = this.previewCtx.createGain();
    this.previewGain.gain.value = 0.8;
    this.previewGain.connect(this.previewCtx.destination);
  }

  stopPreviewAudio() {
    if (!this.previewNode) return;
    try { this.previewNode.stop(); } catch {}
    try { this.previewNode.disconnect(); } catch {}
    this.previewNode = null;
  }

  previewFileAudio(timeSec) {
    if (!this.fileBuffer || !this.fileDuration) return;
    this.ensurePreviewContext();
    if (!this.previewCtx || !this.previewGain) return;
    if (this.previewCtx.state === "suspended") {
      this.previewCtx.resume().catch(() => {});
    }
    const start = this.clamp(timeSec, 0, this.fileDuration);
    const remaining = this.fileDuration - start;
    if (remaining <= 0) return;
    const duration = Math.min(this.previewDuration, remaining);

    this.stopPreviewAudio();
    const src = this.previewCtx.createBufferSource();
    src.buffer = this.fileBuffer;
    src.connect(this.previewGain);

    const now = this.previewCtx.currentTime;
    const g = this.previewGain.gain;
    const fade = Math.min(this.previewFadeSec, duration / 2);
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(1, now + fade);
    g.linearRampToValueAtTime(0, now + duration);
    try {
      src.start(now, start, duration);
    } catch {
      return;
    }
    this.previewNode = src;
  }

  async loadFile(file) {
    this.stopPreviewAudio();
    if (!file) {
      this.fileBuffer = null;
      this.fileMono = null;
      this.fileSampleRate = 0;
      this.fileDuration = 0;
      this.fileName = "";
      this.clearFileWaterfall();
      return null;
    }

    this.ui.setStatus("loading file");
    this.fileName = file.name || "";
    const buf = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded = null;
    try {
      decoded = await ctx.decodeAudioData(buf);
    } finally {
      await ctx.close();
    }
    if (!decoded) return null;

    this.fileBuffer = decoded;
    this.fileSampleRate = decoded.sampleRate;
    this.fileDuration = decoded.duration;
    this.fileMono = this.buildMonoBuffer(decoded);
    this.fileCursorTime = 0;
    this.updateAnalysisConfig(this.ui.getSettings(), this.fileSampleRate);
    this.resetDisplayState();
    this.ensureOfflineFft(this.ui.getSettings().fftSize);
    this.clearFileWaterfall();
    this.ui.setSampleRate(this.fileSampleRate);
    this.ui.setStatus("file ready");
    return { duration: this.fileDuration, sampleRate: this.fileSampleRate };
  }

  buildMonoBuffer(buffer) {
    const channels = buffer.numberOfChannels;
    if (channels === 1) return buffer.getChannelData(0);
    const len = buffer.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i];
    }
    const inv = 1 / channels;
    for (let i = 0; i < len; i++) mono[i] *= inv;
    return mono;
  }

  yieldToUi() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  tick(ts) {
    if (!this.running) return;

    let line = null;
    if (this.analysisMode === "fixed") {
      // Pull current FFT data into freqData.
      this.analyser.getByteFrequencyData(this.freqData);
      line = this.buildLine();
    } else {
      this.ensureTimeData(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(this.timeData);
      line = this.computeLineFromTimeData(this.timeData, this.audioCtx.sampleRate);
      if (!line) {
        this.analyser.getByteFrequencyData(this.freqData);
        line = this.buildLine();
      }
    }
    this.drawSpectrum(line);

    // Waterfall updates at a fixed rate based on target seconds.
    const r = this.getRange();
    const wfSeconds = Math.max(5, r.wfSeconds || 60);
    const viewH = this.ui.getWaterfallViewHeight();
    const intervalMs = (wfSeconds * 1000) / viewH;

    if (!this.lastWfTime) this.lastWfTime = ts;
    if ((ts - this.lastWfTime) >= intervalMs) {
      this.drawWaterfallRow(line);
      this.lastWfTime = ts;
    }

    this.raf = requestAnimationFrame((t) => this.tick(t));
  }
}
