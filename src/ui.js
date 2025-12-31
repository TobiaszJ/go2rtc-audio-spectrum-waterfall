export class UI {
  constructor(config) {
    this.config = config;
    this.cookieKey = "webrtc_fft_wf_settings_v3";
    this.layoutKey = "webrtc_fft_wf_layout_v1";
    this.dragGroupId = null;
    this.handlers = {
      start: () => {},
      stop: () => {},
      change: () => {},
      sourceMode: () => {},
      fileSelect: () => {},
      fileScrub: () => {},
      fileRange: () => {},
      fileProcess: () => {},
      layout: () => {},
      videoToggle: () => {},
    };

    // Padding used by DSP to layout axes and labels.
    this.PAD = { top:24, bottom:26, left:56, right:10 };
    this.WF_HISTORY_MULT = 5;
    this.sourceMode = "live";

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
      sourceMode: $("sourceMode"),
      analysisMode: $("analysisMode"),
      fftControl: $("fftControl"),
      fftLabel: $("fftLabel"),
      analysisDetailControl: $("analysisDetailControl"),
      analysisDetailLabel: $("analysisDetailLabel"),
      analysisDetail: $("analysisDetail"),

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
      mqttStatus: $("mqttStatus"),
      mqttValue: $("mqttValue"),
      mqttFanValue: $("mqttFanValue"),
      mqttTopic: $("mqttTopic"),
      mqttFanTopic: $("mqttFanTopic"),
      mqttPollEnabled: $("mqttPollEnabled"),
      mqttPoll: $("mqttPoll"),
      mqttColor: $("mqttColor"),
      mqttFanColor: $("mqttFanColor"),
      mqttHarmonics: $("mqttHarmonics"),

      spec: $("spec"),
      wfWrap: $("wfWrap"),
      wf: $("wf"),
      wfCursor: $("wfCursor"),

      fileCard: $("fileCard"),
      fileInput: $("fileInput"),
      fileStart: $("fileStart"),
      fileEnd: $("fileEnd"),
      fileScrub: $("fileScrub"),
      fileTime: $("fileTime"),
      fileDuration: $("fileDuration"),
      fileRangeLabel: $("fileRangeLabel"),
      btnProcess: $("btnProcess"),
      videoToggle: $("videoToggle"),
      videoPreview: $("videoPreview"),
    };

    this.groupContainer = document.querySelector("header");
    this.groups = Array.from(document.querySelectorAll(".group[data-group]"));

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
    this.setSourceMode(this.el.sourceMode?.value || "live");
    this.updateAnalysisControls();
    this.initGroupLayout();
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
      this.el.analysisMode, this.el.fftSize, this.el.analysisDetail, this.el.smooth, this.el.gain, this.el.autoGain,
      this.el.fMin, this.el.fMax, this.el.logScale, this.el.wfSeconds,
      this.el.hpHz, this.el.lpHz,
      this.el.expOn, this.el.expThresh, this.el.expRatio, this.el.expAtk, this.el.expRel,
      this.el.audioOut,
      this.el.mqttPollEnabled, this.el.mqttPoll, this.el.mqttColor, this.el.mqttFanColor, this.el.mqttHarmonics,
      this.el.videoToggle
    ].forEach((x) => x.addEventListener("input", onChange));

    if (this.el.sourceMode) {
      this.el.sourceMode.addEventListener("change", () => {
        const mode = this.getSourceMode();
        this.setSourceMode(mode);
        this.handlers.sourceMode(mode);
      });
    }

    if (this.el.analysisMode) {
      this.el.analysisMode.addEventListener("change", () => this.updateAnalysisControls());
    }

    if (this.el.fileInput) {
      this.el.fileInput.addEventListener("change", () => {
        const file = this.el.fileInput.files?.[0] || null;
        this.handlers.fileSelect(file);
      });
    }

    if (this.el.fileScrub) {
      this.el.fileScrub.addEventListener("input", () => {
        const time = this.getScrubTime();
        this.setScrubTime(time);
        this.handlers.fileScrub(time);
      });
    }

    if (this.el.videoToggle) {
      this.el.videoToggle.addEventListener("input", () => {
        this.handlers.videoToggle(this.isVideoPreviewEnabled());
      });
    }

    [this.el.fileStart, this.el.fileEnd].forEach((el) => {
      if (!el) return;
      el.addEventListener("input", () => this.handlers.fileRange(this.getFileRange()));
    });

    if (this.el.btnProcess) {
      this.el.btnProcess.addEventListener("click", () => this.handlers.fileProcess());
    }

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
  onSourceModeChange(fn) { this.handlers.sourceMode = fn; }
  onFileSelected(fn) { this.handlers.fileSelect = fn; }
  onFileScrub(fn) { this.handlers.fileScrub = fn; }
  onFileRangeChange(fn) { this.handlers.fileRange = fn; }
  onFileProcess(fn) { this.handlers.fileProcess = fn; }
  onLayoutChange(fn) { this.handlers.layout = fn; }
  onVideoToggle(fn) { this.handlers.videoToggle = fn; }

  setStatus(s) { this.el.status.textContent = "Status: " + s; }
  setMqttStatus(s) { if (this.el.mqttStatus) this.el.mqttStatus.textContent = s; }
  setMqttValue(v) { if (this.el.mqttValue) this.el.mqttValue.textContent = v; }
  setMqttTopic(t) { if (this.el.mqttTopic) this.el.mqttTopic.textContent = t; }
  setMqttFanValue(v) { if (this.el.mqttFanValue) this.el.mqttFanValue.textContent = v; }
  setMqttFanTopic(t) { if (this.el.mqttFanTopic) this.el.mqttFanTopic.textContent = t; }
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

  getSourceMode() {
    return this.el.sourceMode?.value || "live";
  }

  setSourceMode(mode) {
    this.sourceMode = mode === "file" ? "file" : "live";
    if (this.el.sourceMode) this.el.sourceMode.value = this.sourceMode;
    document.body.classList.toggle("mode-file", this.sourceMode === "file");
    document.body.classList.toggle("mode-live", this.sourceMode !== "file");
    this.resizeCanvases();
  }

  setLiveControlsEnabled(enabled) {
    this.el.btnStart.disabled = !enabled;
    this.el.btnStop.disabled = true;
  }

  setFileControlsEnabled(enabled) {
    if (this.el.fileStart) this.el.fileStart.disabled = !enabled;
    if (this.el.fileEnd) this.el.fileEnd.disabled = !enabled;
    if (this.el.fileScrub) this.el.fileScrub.disabled = !enabled;
    if (this.el.btnProcess) this.el.btnProcess.disabled = !enabled;
    if (this.el.videoToggle) this.el.videoToggle.disabled = !enabled;
  }

  setFileDuration(seconds) {
    if (!this.el.fileDuration) return;
    if (!Number.isFinite(seconds)) this.el.fileDuration.textContent = "-";
    else this.el.fileDuration.textContent = seconds.toFixed(2) + " s";
  }

  setFileRangeLabel(startSec, endSec) {
    if (!this.el.fileRangeLabel) return;
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      this.el.fileRangeLabel.textContent = "-";
      return;
    }
    this.el.fileRangeLabel.textContent = `${startSec.toFixed(2)} - ${endSec.toFixed(2)} s`;
  }

  getFileRange() {
    const start = parseFloat(this.el.fileStart?.value || "0");
    const end = parseFloat(this.el.fileEnd?.value || "0");
    return { start, end };
  }

  setFileRange(start, end) {
    if (this.el.fileStart) this.el.fileStart.value = String(start.toFixed(2));
    if (this.el.fileEnd) this.el.fileEnd.value = String(end.toFixed(2));
    this.setFileRangeLabel(start, end);
  }

  setScrubRange(min, max) {
    if (!this.el.fileScrub) return;
    this.el.fileScrub.min = String(min);
    this.el.fileScrub.max = String(max);
  }

  getScrubTime() {
    return parseFloat(this.el.fileScrub?.value || "0");
  }

  setScrubTime(seconds) {
    if (this.el.fileTime) this.el.fileTime.textContent = Number(seconds).toFixed(2);
    if (this.el.fileScrub) this.el.fileScrub.value = String(seconds);
  }

  showVideoPreview(show) {
    if (!this.el.videoPreview) return;
    this.el.videoPreview.classList.toggle("is-visible", !!show);
  }

  isVideoPreviewEnabled() {
    return !!this.el.videoToggle?.checked;
  }

  updateAnalysisControls() {
    const mode = this.el.analysisMode?.value || "fixed";
    const fftControl = this.el.fftControl;
    const detailControl = this.el.analysisDetailControl;
    if (!fftControl || !detailControl) return;
    if (mode === "fixed") {
      fftControl.classList.remove("is-hidden");
      detailControl.classList.add("is-hidden");
    } else if (mode === "multi") {
      fftControl.classList.add("is-hidden");
      detailControl.classList.add("is-hidden");
    } else {
      fftControl.classList.add("is-hidden");
      detailControl.classList.remove("is-hidden");
      if (this.el.analysisDetailLabel) {
        this.el.analysisDetailLabel.textContent = "Precision";
      }
    }
  }

  toggleControls() {
    document.body.classList.toggle("controls-collapsed");
    const isCollapsed = document.body.classList.contains("controls-collapsed");
    if (this.el.btnToggleControls) {
      this.el.btnToggleControls.setAttribute("aria-label", isCollapsed ? "Expand controls" : "Collapse controls");
      this.el.btnToggleControls.setAttribute("title", isCollapsed ? "Expand controls" : "Collapse controls");
    }
    this.resizeCanvases();
  }

  initGroupLayout() {
    this.groups = Array.from(document.querySelectorAll(".group[data-group]"));
    if (!this.groupContainer || !this.groups.length) return;
    this.groups.forEach((group) => {
      const id = group.dataset.group;
      const toggleBtn = group.querySelector(".group-toggle");
      if (toggleBtn) {
        toggleBtn.addEventListener("click", () => this.toggleGroup(id));
      }
      const dragBtn = group.querySelector(".group-drag");
      if (dragBtn) {
        dragBtn.addEventListener("dragstart", (e) => this.onGroupDragStart(e, id));
        dragBtn.addEventListener("dragend", () => this.onGroupDragEnd(id));
      }
      group.addEventListener("dragover", (e) => this.onGroupDragOver(e, id));
      group.addEventListener("dragleave", (e) => this.onGroupDragLeave(e, id));
      group.addEventListener("drop", (e) => this.onGroupDrop(e, id));
    });
    this.loadLayout();
  }

  onGroupDragStart(e, id) {
    this.dragGroupId = id;
    const group = this.getGroupById(id);
    if (group) group.classList.add("is-dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    }
  }

  onGroupDragEnd(id) {
    const group = this.getGroupById(id);
    if (group) group.classList.remove("is-dragging");
    this.groups.forEach((g) => {
      g.classList.remove("is-drop-target");
      delete g.dataset.dropAfter;
    });
    this.dragGroupId = null;
  }

  onGroupDragOver(e, id) {
    if (!this.dragGroupId || this.dragGroupId === id) return;
    e.preventDefault();
    const group = this.getGroupById(id);
    if (!group) return;
    const rect = group.getBoundingClientRect();
    const dropAfter = e.clientY > rect.top + rect.height / 2;
    group.dataset.dropAfter = dropAfter ? "1" : "0";
    group.classList.add("is-drop-target");
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  onGroupDragLeave(e, id) {
    const group = this.getGroupById(id);
    if (!group) return;
    if (e?.relatedTarget && group.contains(e.relatedTarget)) return;
    group.classList.remove("is-drop-target");
    delete group.dataset.dropAfter;
  }

  onGroupDrop(e, id) {
    if (!this.groupContainer) return;
    e.preventDefault();
    const dragId = this.dragGroupId || e.dataTransfer?.getData("text/plain");
    if (!dragId || dragId === id) return;
    const dragEl = this.getGroupById(dragId);
    const target = this.getGroupById(id);
    if (!dragEl || !target) return;
    const dropAfter = target.dataset.dropAfter === "1";
    if (dropAfter) target.after(dragEl);
    else target.before(dragEl);
    target.classList.remove("is-drop-target");
    delete target.dataset.dropAfter;
    this.saveLayout();
  }

  toggleGroup(id) {
    const group = this.getGroupById(id);
    if (!group) return;
    const next = !group.classList.contains("is-collapsed");
    this.setGroupCollapsed(group, next);
    this.saveLayout();
    this.resizeCanvases();
  }

  setGroupCollapsed(group, collapsed) {
    group.classList.toggle("is-collapsed", collapsed);
    const toggle = group.querySelector(".group-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      toggle.setAttribute("aria-label", collapsed ? "Expand group" : "Collapse group");
      toggle.setAttribute("title", collapsed ? "Expand group" : "Collapse group");
    }
  }

  getGroupById(id) {
    return document.querySelector(`.group[data-group="${id}"]`);
  }

  getGroupOrder() {
    return Array.from(document.querySelectorAll(".group[data-group]")).map((g) => g.dataset.group);
  }

  getGroupCollapsedState() {
    const state = {};
    document.querySelectorAll(".group[data-group]").forEach((g) => {
      state[g.dataset.group] = g.classList.contains("is-collapsed");
    });
    return state;
  }

  applyGroupOrder(order) {
    if (!this.groupContainer || !order || !order.length) return;
    const groups = new Map(this.groups.map((g) => [g.dataset.group, g]));
    const used = new Set();
    order.forEach((id) => {
      const el = groups.get(id);
      if (el) {
        this.groupContainer.appendChild(el);
        used.add(id);
      }
    });
    for (const [id, el] of groups.entries()) {
      if (!used.has(id)) this.groupContainer.appendChild(el);
    }
  }

  applyGroupCollapsed(state) {
    if (!state) return;
    this.groups.forEach((group) => {
      const id = group.dataset.group;
      this.setGroupCollapsed(group, !!state[id]);
    });
  }

  saveLayout() {
    if (!window.localStorage) return;
    const layout = {
      order: this.getGroupOrder(),
      collapsed: this.getGroupCollapsedState(),
    };
    try {
      window.localStorage.setItem(this.layoutKey, JSON.stringify(layout));
    } catch {}
  }

  loadLayout() {
    if (!window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(this.layoutKey);
      if (!raw) return;
      const layout = JSON.parse(raw);
      this.applyGroupOrder(layout.order);
      this.groups = Array.from(document.querySelectorAll(".group[data-group]"));
      this.applyGroupCollapsed(layout.collapsed);
    } catch {}
  }

  resizeCanvases() {
    // Maintain a usable minimum size and adjust with viewport.
    const w = Math.max(900, Math.floor(window.innerWidth - 20));
    this.el.spec.width = w;
    this.el.wf.width = w;
    if (this.el.wfCursor) this.el.wfCursor.width = w;
    this.el.spec.height = 260;
    const wrapH = this.el.wfWrap ? this.el.wfWrap.clientHeight : 0;
    this.wfViewHeight = Math.max(260, wrapH || Math.floor(window.innerHeight - 420));
    const historyMult = this.sourceMode === "file" ? 1 : this.WF_HISTORY_MULT;
    const historyH = Math.min(this.wfViewHeight * historyMult, 5000);
    this.el.wf.height = historyH;
    if (this.el.wfCursor) this.el.wfCursor.height = this.wfViewHeight;
    this.handlers.layout();
  }

  getSettings() {
    // Read current values from the DOM and normalize to numbers/booleans.
    return {
      pad: this.PAD,
      analysisMode: this.el.analysisMode?.value || "fixed",
      analysisDetail: this.el.analysisDetail?.value || "med",
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
      mqttPollEnabled: !!this.el.mqttPollEnabled?.checked,
      mqttPollSec: parseInt(this.el.mqttPoll?.value || "1", 10),
      markerColor: this.el.mqttColor?.value || "#f6b21a",
      markerFanColor: this.el.mqttFanColor?.value || "#3bd4ff",
      markerHarmonics: !!this.el.mqttHarmonics?.checked,
      videoPreviewEnabled: this.isVideoPreviewEnabled(),
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
      set(this.el.analysisMode, s.analysisMode);
      set(this.el.analysisDetail, s.analysisDetail);

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
      set(this.el.mqttPollEnabled, s.mqttPollEnabled, "checked");
      set(this.el.mqttPoll, s.mqttPollSec);
      set(this.el.mqttColor, s.markerColor);
      set(this.el.mqttFanColor, s.markerFanColor);
      set(this.el.mqttHarmonics, s.markerHarmonics, "checked");
      set(this.el.videoToggle, s.videoPreviewEnabled, "checked");
    } catch {}
  }

  resetDefaults() {
    // Defaults match the HTML initial values.
    if (this.el.analysisMode) this.el.analysisMode.value = "fixed";
    if (this.el.analysisDetail) this.el.analysisDetail.value = "med";
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
    this.el.mqttPollEnabled.checked = true;
    this.el.mqttPoll.value = "1";
    this.el.mqttColor.value = "#f6b21a";
    this.el.mqttFanColor.value = "#3bd4ff";
    this.el.mqttHarmonics.checked = true;
    if (this.el.videoToggle) this.el.videoToggle.checked = true;

    this.updateValueTexts();
    this.updateAnalysisControls();
  }
}
