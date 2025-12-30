export class UI {
  constructor(config) {
    this.config = config;
    this.cookieKey = "webrtc_fft_wf_settings_v3";
    this.handlers = {
      start: () => {},
      stop: () => {},
      change: () => {},
    };

    // Padding used by DSP to layout axes and labels.
    this.PAD = { top:24, bottom:26, left:56, right:10 };
    this.WF_HISTORY_MULT = 5;

    // Bind DOM elements by ID.
    const $ = (id) => document.getElementById(id);

    this.el = {
      hostLabel: $("hostLabel"),
      srcLabel: $("srcLabel"),
      fsLabel: $("fsLabel"),
      nyqLabel: $("nyqLabel"),
      status: $("status"),
      btnStart: $("btnStart"),
      btnStop: $("btnStop"),
      btnSave: $("btnSave"),
      btnReset: $("btnReset"),
      btnToggleControls: $("btnToggleControls"),

      fftSize: $("fftSize"),
      smooth: $("smooth"),
      smoothVal: $("smoothVal"),
      gain: $("gain"),
      gainVal: $("gainVal"),
      autoGain: $("autoGain"),
      autoGainVal: $("autoGainVal"),

      fMin: $("fMin"),
      fMax: $("fMax"),
      logScale: $("logScale"),
      wfSeconds: $("wfSeconds"),

      hpHz: $("hpHz"),
      lpHz: $("lpHz"),

      expOn: $("expOn"),
      expThresh: $("expThresh"),
      expRatio: $("expRatio"),
      expAtk: $("expAtk"),
      expRel: $("expRel"),

      audioOut: $("audioOut"),

      spec: $("spec"),
      wfWrap: $("wfWrap"),
      wf: $("wf"),
    };

    // Show config in the header.
    this.el.hostLabel.textContent = config.go2rtcHost;
    this.el.srcLabel.textContent = config.src;

    // Cursor tracking (used for spectrum overlay).
    this.cursorHz = null;
    this.el.spec.addEventListener("mousemove", (e) => {
      const rect = this.el.spec.getBoundingClientRect();
      this.cursorX = e.clientX - rect.left;
    });
    this.el.spec.addEventListener("mouseleave", () => { this.cursorX = null; });

    // Resize canvases when window size changes.
    window.addEventListener("resize", () => this.resizeCanvases());
  }

  init() {
    this.loadFromCookie();
    this.updateValueTexts();
    this.resizeCanvases();

    // Wire up main buttons.
    this.el.btnStart.addEventListener("click", this.handlers.start);
    this.el.btnStop.addEventListener("click", this.handlers.stop);
    this.el.btnToggleControls.addEventListener("click", () => this.toggleControls());

    // Any input change updates labels and triggers DSP settings update.
    const onChange = () => {
      this.updateValueTexts();
      this.handlers.change();
    };

    [
      this.el.fftSize, this.el.smooth, this.el.gain, this.el.autoGain,
      this.el.fMin, this.el.fMax, this.el.logScale, this.el.wfSeconds,
      this.el.hpHz, this.el.lpHz,
      this.el.expOn, this.el.expThresh, this.el.expRatio, this.el.expAtk, this.el.expRel,
      this.el.audioOut
    ].forEach((x) => x.addEventListener("input", onChange));

    // Save settings to cookie.
    this.el.btnSave.addEventListener("click", () => {
      this.saveToCookie();
      this.setStatus("saved");
      setTimeout(() => this.setStatus("idle"), 600);
    });

    // Reset to defaults and persist.
    this.el.btnReset.addEventListener("click", () => {
      this.resetDefaults();
      this.saveToCookie();
      this.handlers.change();
      this.setStatus("reset");
      setTimeout(() => this.setStatus("idle"), 600);
    });
  }

  onStart(fn) { this.handlers.start = fn; }
  onStop(fn) { this.handlers.stop = fn; }
  onAnySettingChange(fn) { this.handlers.change = fn; }

  setStatus(s) { this.el.status.textContent = "Status: " + s; }
  setRunning(running) {
    this.el.btnStart.disabled = running;
    this.el.btnStop.disabled = !running;
    this.setStatus(running ? "running" : "idle");
  }

  setSampleRate(fs) {
    this.el.fsLabel.textContent = String(Math.round(fs));
    this.el.nyqLabel.textContent = String(Math.round(fs/2));
  }

  updateValueTexts() {
    // Keep small labels in sync with slider values.
    this.el.smoothVal.textContent = Number(this.el.smooth.value).toFixed(2);
    this.el.gainVal.textContent = Number(this.el.gain.value).toFixed(2);
  }

  setAutoGainValue(v) {
    if (!this.el.autoGainVal) return;
    this.el.autoGainVal.textContent = Number(v).toFixed(2);
  }

  getWaterfallViewHeight() {
    return this.wfViewHeight || this.el.wf.height;
  }

  toggleControls() {
    document.body.classList.toggle("controls-collapsed");
    const isCollapsed = document.body.classList.contains("controls-collapsed");
    this.el.btnToggleControls.textContent = isCollapsed ? "Expand v" : "Collapse ^";
  }

  resizeCanvases() {
    // Maintain a usable minimum size and adjust with viewport.
    const w = Math.max(900, Math.floor(window.innerWidth - 20));
    this.el.spec.width = w;
    this.el.wf.width = w;
    this.el.spec.height = 260;
    this.wfViewHeight = Math.max(360, Math.floor((window.innerHeight - 420)));
    const historyH = Math.min(this.wfViewHeight * this.WF_HISTORY_MULT, 5000);
    if (this.el.wfWrap) this.el.wfWrap.style.height = `${this.wfViewHeight}px`;
    this.el.wf.height = historyH;
  }

  getSettings() {
    // Read current values from the DOM and normalize to numbers/booleans.
    return {
      pad: this.PAD,
      fftSize: parseInt(this.el.fftSize.value, 10),
      smoothing: parseFloat(this.el.smooth.value),
      gain: parseFloat(this.el.gain.value),
      autoGain: !!this.el.autoGain.checked,

      fMin: parseFloat(this.el.fMin.value),
      fMax: parseFloat(this.el.fMax.value),
      log: !!this.el.logScale.checked,
      wfSeconds: parseFloat(this.el.wfSeconds.value),

      hpHz: parseFloat(this.el.hpHz.value),
      lpHz: parseFloat(this.el.lpHz.value),

      expOn: !!this.el.expOn.checked,
      expThreshDb: parseFloat(this.el.expThresh.value),
      expRatio: parseFloat(this.el.expRatio.value),
      expAttackMs: parseFloat(this.el.expAtk.value),
      expReleaseMs: parseFloat(this.el.expRel.value),

      audioOut: !!this.el.audioOut.checked,
    };
  }

  // Cookie helpers
  setCookie(name, value, days=365) {
    const d = new Date();
    d.setTime(d.getTime() + days*24*60*60*1000);
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
  }
  getCookie(name) {
    const parts = document.cookie.split(";").map(s=>s.trim());
    for (const p of parts) if (p.startsWith(name + "=")) return decodeURIComponent(p.substring(name.length+1));
    return null;
  }
  deleteCookie(name) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
  }

  saveToCookie() {
    this.setCookie(this.cookieKey, JSON.stringify(this.getSettings()));
  }

  loadFromCookie() {
    try {
      const saved = this.getCookie(this.cookieKey);
      if (!saved) return;
      const s = JSON.parse(saved);

      // Small helper to apply optional values.
      const set = (el, v, type="value") => {
        if (v === undefined || v === null) return;
        if (type === "checked") el.checked = !!v;
        else el.value = String(v);
      };

      set(this.el.fftSize, s.fftSize);
      set(this.el.smooth, s.smoothing);
      set(this.el.gain, s.gain);
      set(this.el.autoGain, s.autoGain, "checked");

      set(this.el.fMin, s.fMin);
      set(this.el.fMax, s.fMax);
      set(this.el.logScale, s.log, "checked");
      set(this.el.wfSeconds, s.wfSeconds);

      set(this.el.hpHz, s.hpHz);
      set(this.el.lpHz, s.lpHz);

      set(this.el.expOn, s.expOn, "checked");
      set(this.el.expThresh, s.expThreshDb);
      set(this.el.expRatio, s.expRatio);
      set(this.el.expAtk, s.expAttackMs);
      set(this.el.expRel, s.expReleaseMs);

      set(this.el.audioOut, s.audioOut, "checked");
    } catch {}
  }

  resetDefaults() {
    // Defaults match the HTML initial values.
    this.el.fftSize.value = "2048";
    this.el.smooth.value = "0.65";
    this.el.gain.value = "1";
    this.el.autoGain.checked = true;

    this.el.fMin.value = "10";
    this.el.fMax.value = "4000";
    this.el.logScale.checked = true;
    this.el.wfSeconds.value = "60";

    this.el.hpHz.value = "80";
    this.el.lpHz.value = "4000";

    this.el.expOn.checked = true;
    this.el.expThresh.value = "-45";
    this.el.expRatio.value = "3.0";
    this.el.expAtk.value = "10";
    this.el.expRel.value = "200";

    this.el.audioOut.checked = false;

    this.updateValueTexts();
  }
}
