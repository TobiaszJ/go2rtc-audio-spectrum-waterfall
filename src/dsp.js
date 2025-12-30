export class DSP {
  constructor(config, ui) {
    this.config = config;
    this.ui = ui;

    this.ws = null;
    this.pc = null;
    this.audioCtx = null;

    this.sourceNode = null;
    this.hpNode = null;
    this.lpNode = null;
    this.expNode = null;
    this.analyser = null;
    this.outGain = null;

    this.freqData = null;

    this.running = false;
    this.raf = 0;
    this.lastWfTime = 0;

    // display noise floor estimator (optional)
    this.noiseFloor = null;

    // autogain for display only
    this.renderGain = 1.0;
    this.AUTO_TARGET = 190;
    this.AUTO_SMOOTH = 0.03;

    // canvases
    this.spec = ui.el.spec;
    this.wf = ui.el.wf;
    this.specG = this.spec.getContext("2d", { alpha:false });
    this.wfG = this.wf.getContext("2d", { alpha:false });

    // cursor overlay uses ui.cursorX
    this.spec.addEventListener("mousemove", (e) => {
      const rect = this.spec.getBoundingClientRect();
      this.cursorX = e.clientX - rect.left;
    });
    this.spec.addEventListener("mouseleave", () => { this.cursorX = null; });
  }

  clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }

  wsUrl() {
    const u = new URL(this.config.go2rtcHost);
    const proto = (u.protocol === "https:") ? "wss:" : "ws:";
    return `${proto}//${u.host}/api/ws?src=${encodeURIComponent(this.config.src)}`;
  }

  currentNyq() {
    const fs = this.audioCtx ? this.audioCtx.sampleRate : 48000;
    return fs/2;
  }

  getRange() {
    const s = this.ui.getSettings();
    const nyq = this.currentNyq();

    let fMin = isFinite(s.fMin) ? s.fMin : 0;
    let fMax = isFinite(s.fMax) ? s.fMax : 4000;

    fMin = this.clamp(fMin, 0, nyq);
    fMax = this.clamp(fMax, 1, nyq);
    if (fMax <= fMin) fMax = Math.min(nyq, fMin + 1);

    const fMinForLog = Math.max(1, fMin);
    return { ...s, nyq, fMin, fMax, fMinForLog };
  }

  xNormToF(xNorm) {
    const r = this.getRange();
    const t = this.clamp(xNorm, 0, 1);
    if (!r.log) return r.fMin + t * (r.fMax - r.fMin);
    const ratio = r.fMax / r.fMinForLog;
    return r.fMinForLog * Math.pow(ratio, t);
  }

  fToXNorm(f) {
    const r = this.getRange();
    const ff = this.clamp(f, r.fMin, r.fMax);
    if (!r.log) return (ff - r.fMin) / (r.fMax - r.fMin);
    return Math.log(ff / r.fMinForLog) / Math.log(r.fMax / r.fMinForLog);
  }

  binForFreq(f) {
    const nyq = this.currentNyq();
    const bins = this.freqData.length;
    return this.clamp(Math.floor((f / nyq) * bins), 0, bins - 1);
  }

  colorMap(v) {
    const x = v / 255;
    const r = this.clamp(255 * Math.pow(x, 0.9), 0, 255);
    const g = this.clamp(255 * Math.pow(x, 2.0), 0, 255);
    const b = this.clamp(255 * (1.2 - Math.pow(x, 0.55)), 0, 255);
    return [r|0, g|0, b|0];
  }

  magToDb(vByte) {
    const x = Math.max(vByte / 255, 1e-6);
    return 20 * Math.log10(x);
  }

  async start() {
    if (this.running) return;
    this.ui.setStatus("init");

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await this.audioCtx.resume();
    this.ui.setSampleRate(this.audioCtx.sampleRate);

    // Load worklet
    await this.audioCtx.audioWorklet.addModule("./gate-worklet.js");

    // nodes
    this.analyser = this.audioCtx.createAnalyser();
    const s = this.ui.getSettings();
    this.analyser.fftSize = s.fftSize;
    this.analyser.smoothingTimeConstant = s.smoothing;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

    this.outGain = this.audioCtx.createGain();
    this.outGain.gain.value = 1.0;
    this.outGain.connect(this.audioCtx.destination);

    // signalling
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

    // chain: source -> HP -> LP -> Expander -> Analyser -> (optional out)
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

    // optional audio out
    const s = this.ui.getSettings();
    this.setAudioOut(s.audioOut);

    this.noiseFloor = null;
    this.renderGain = 1.0;
    this.lastWfTime = 0;

    this.running = true;
    this.ui.setRunning(true);

    this.applySettings();
    this.raf = requestAnimationFrame((ts) => this.tick(ts));
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);

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
    if (!this.audioCtx || !this.analyser) return;
    const s = this.ui.getSettings();
    this.analyser.fftSize = s.fftSize;
    this.analyser.smoothingTimeConstant = s.smoothing;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

    const nyq = this.currentNyq();

    if (this.hpNode) this.hpNode.frequency.value = this.clamp(s.hpHz || 0, 0, nyq);
    if (this.lpNode) this.lpNode.frequency.value = this.clamp(s.lpHz || nyq, 10, nyq);

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

  setAudioOut(enabled) {
    if (!this.analyser || !this.outGain) return;
    try { this.analyser.disconnect(); } catch {}
    if (enabled) this.analyser.connect(this.outGain);
  }

  buildLine() {
    const r = this.getRange();
    const plotW = this.spec.width - r.pad.left - r.pad.right;

    // noise floor init
    if (!this.noiseFloor || this.noiseFloor.length !== this.freqData.length) {
      this.noiseFloor = new Float32Array(this.freqData.length);
      for (let i=0;i<this.noiseFloor.length;i++) this.noiseFloor[i] = this.freqData[i];
    }

    // update noise floor (very slow follower)
    for (let i=0;i<this.freqData.length;i++) {
      const v = this.freqData[i];
      const nf = this.noiseFloor[i];
      this.noiseFloor[i] = v < nf ? (nf + (v - nf) * 0.05) : (nf + (v - nf) * 0.001);
    }

    const line = new Uint8Array(plotW);
    let peak = 1;

    for (let px=0; px<plotW; px++) {
      const f = this.xNormToF(px / plotW);
      const i = this.binForFreq(f);

      const raw = this.freqData[i];
      const sub = Math.max(0, raw - this.noiseFloor[i]); // display noise reduction

      let v = Math.min(255, sub * r.gain);
      line[px] = v;
      if (v > peak) peak = v;
    }

    // autogain (display)
    if (r.autoGain) {
      const target = peak > 0 ? (this.AUTO_TARGET / peak) : 1.0;
      this.renderGain = this.renderGain + (target - this.renderGain) * this.AUTO_SMOOTH;
    } else {
      this.renderGain = 1.0;
    }

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

    g.fillStyle = "#0b0f14";
    g.fillRect(0,0,w,h);

    // grid
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

    // y ticks
    const dbMin = -90, dbMax = 0;
    for (let t=0; t<=6; t++) {
      const y = r.pad.top + (t/6)*plotH;
      g.beginPath();
      g.moveTo(r.pad.left, y);
      g.lineTo(r.pad.left + plotW, y);
      g.stroke();
      const db = (dbMax - (t/6)*(dbMax-dbMin)).toFixed(0) + " dB";
      g.fillText(db, 8, y + 4);
    }

    g.strokeStyle = "#2b3a52";
    g.strokeRect(r.pad.left, r.pad.top, plotW, plotH);

    // line
    g.strokeStyle = "#e8eef7";
    g.beginPath();
    for (let px=0; px<plotW; px++) {
      const v = line[px];
      const db = this.clamp(this.magToDb(v), dbMin, dbMax);
      const y = r.pad.top + (1 - (db - dbMin)/(dbMax-dbMin))*plotH;
      const x = r.pad.left + px;
      if (px===0) g.moveTo(x,y); else g.lineTo(x,y);
    }
    g.stroke();

    // cursor overlay inside plot
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

    // side areas
    g.fillStyle = "#0b0f14";
    g.fillRect(0,0,r.pad.left,h);
    g.fillRect(w-r.pad.right,0,r.pad.right,h);

    // scroll only plot area
    const img = g.getImageData(plotX, 0, plotW, h-1);
    g.putImageData(img, plotX, 1);

    const row = g.createImageData(plotW, 1);
    for (let px=0; px<plotW; px++) {
      const v = line[px] | 0;
      const [rr,gg,bb] = this.colorMap(v);
      const o = px*4;
      row.data[o]=rr; row.data[o+1]=gg; row.data[o+2]=bb; row.data[o+3]=255;
    }
    g.putImageData(row, plotX, 0);
  }

  tick(ts) {
    if (!this.running) return;

    this.analyser.getByteFrequencyData(this.freqData);

    const line = this.buildLine();
    this.drawSpectrum(line);

    const r = this.getRange();
    const wfSeconds = Math.max(5, r.wfSeconds || 60);
    const intervalMs = (wfSeconds * 1000) / this.wf.height;

    if (!this.lastWfTime) this.lastWfTime = ts;
    if ((ts - this.lastWfTime) >= intervalMs) {
      this.drawWaterfallRow(line);
      this.lastWfTime = ts;
    }

    this.raf = requestAnimationFrame((t) => this.tick(t));
  }
}
