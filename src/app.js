import { UI } from "./ui.js";
import { DSP } from "./dsp.js";

// Connection settings for the go2rtc WebRTC audio source.
const CONFIG = {
  go2rtcHost: "http://192.168.1.10:1984",
  src: "wp",
};

// MQTT settings for compressor speed marker.
const MQTT_CONFIG = {
  url: "ws://192.168.1.10:1884",
  username: "test",
  password: "test1234",
  topic: "ebusd/hmu/RunDataCompressorSpeed",
  requestTopic: "ebusd/hmu/RunDataCompressorSpeed/get",
  fanTopic: "ebusd/hmu/RunDataFan1Speed",
  fanRequestTopic: "ebusd/hmu/RunDataFan1Speed/get",
  requestIntervalMs: 1000,
};

// UI handles DOM and settings; DSP handles WebRTC + audio processing + rendering.
const ui = new UI(CONFIG);
const dsp = new DSP(CONFIG, ui);

let currentMode = "live";
let fileUrl = "";
let fileReady = false;
let fileDuration = 0;
let fileIsVideo = false;

const cleanupFileUrl = () => {
  if (fileUrl) {
    URL.revokeObjectURL(fileUrl);
    fileUrl = "";
  }
};

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const seekVideo = (time) => {
  if (!fileIsVideo || !ui.el.videoPreview) return;
  try {
    ui.el.videoPreview.currentTime = time;
  } catch {}
};

const setMode = (mode) => {
  const next = mode === "file" ? "file" : "live";
  if (currentMode === next) return;
  currentMode = next;
  if (ui.getSourceMode() !== next) ui.setSourceMode(next);
  dsp.setMode(next);

  if (next === "file") {
    dsp.stop();
    ui.setLiveControlsEnabled(false);
    ui.setStatus(fileReady ? "file ready" : "file idle");
  } else {
    ui.setLiveControlsEnabled(true);
    ui.setRunning(false);
    ui.setStatus("idle");
    dsp.clearFileCursor();
  }
};

// MQTT client for compressor speed marker (Hz).
const mqttClient = window.mqtt
  ? window.mqtt.connect(MQTT_CONFIG.url, {
      username: MQTT_CONFIG.username,
      password: MQTT_CONFIG.password,
    })
  : null;

let mqttTimer = 0;
let mqttConnected = false;

const startMqttPolling = () => {
  if (!mqttConnected || !mqttClient) return;
  if (mqttTimer) window.clearInterval(mqttTimer);
  mqttTimer = window.setInterval(() => {
    mqttClient.publish(MQTT_CONFIG.requestTopic, "1");
    mqttClient.publish(MQTT_CONFIG.fanRequestTopic, "1");
  }, MQTT_CONFIG.requestIntervalMs);
};

const applyMqttSettings = () => {
  const s = ui.getSettings();
  const pollSec = clamp(Number(s.mqttPollSec || 1), 1, 60);
  const pollEnabled = !!s.mqttPollEnabled;
  MQTT_CONFIG.requestIntervalMs = pollSec * 1000;
  dsp.setMarkerOptions({
    color: s.markerColor,
    fanColor: s.markerFanColor,
    harmonics: s.markerHarmonics,
  });
  if (mqttConnected) {
    if (pollEnabled) startMqttPolling();
    else {
      if (mqttTimer) window.clearInterval(mqttTimer);
      mqttTimer = 0;
    }
  }
};

if (mqttClient) {
  mqttClient.on("connect", () => {
    mqttConnected = true;
    ui.setMqttStatus("connected");
    ui.setMqttTopic(MQTT_CONFIG.topic);
    ui.setMqttFanTopic(MQTT_CONFIG.fanTopic);
    mqttClient.subscribe(MQTT_CONFIG.topic);
    mqttClient.subscribe(MQTT_CONFIG.fanTopic);
    applyMqttSettings();
    if (ui.getSettings().mqttPollEnabled) startMqttPolling();
  });

  mqttClient.on("message", (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      const hz = Number(data?.value?.value);
      if (!Number.isFinite(hz)) return;
      if (topic === MQTT_CONFIG.topic) {
        ui.setMqttValue(hz.toFixed(2));
        dsp.setMarkerHz(hz);
      } else if (topic === MQTT_CONFIG.fanTopic) {
        ui.setMqttFanValue(hz.toFixed(2));
        dsp.setMarkerFanHz(hz);
      }
    } catch {}
  });

  mqttClient.on("error", () => {
    ui.setMqttStatus("error");
  });

  mqttClient.on("close", () => {
    mqttConnected = false;
    ui.setMqttStatus("closed");
    if (mqttTimer) window.clearInterval(mqttTimer);
    mqttTimer = 0;
  });
}

// Wire UI events to DSP lifecycle.
ui.onStart(async () => {
  await dsp.start();
});

ui.onStop(() => {
  dsp.stop();
});

// Apply settings live when any control changes.
ui.onAnySettingChange(() => {
  dsp.applySettings();
  applyMqttSettings();
  if (currentMode === "file" && fileReady) {
    dsp.renderSpectrumAtTime(ui.getScrubTime());
  }
});

ui.onSourceModeChange((mode) => {
  setMode(mode);
});

ui.onFileSelected(async (file) => {
  if (!file) return;
  setMode("file");
  fileReady = false;
  ui.setFileControlsEnabled(false);
  ui.setStatus("loading file");
  dsp.clearFileWaterfall();

  cleanupFileUrl();
  fileUrl = URL.createObjectURL(file);
  fileIsVideo = file.type.startsWith("video/");
  ui.showVideoPreview(fileIsVideo && ui.isVideoPreviewEnabled());
  if (ui.el.videoPreview) {
    if (fileIsVideo) {
      ui.el.videoPreview.src = fileUrl;
      ui.el.videoPreview.onloadedmetadata = () => {
        seekVideo(ui.getScrubTime());
      };
      ui.el.videoPreview.load();
    } else {
      ui.el.videoPreview.removeAttribute("src");
      ui.el.videoPreview.load();
    }
  }

  try {
    const meta = await dsp.loadFile(file);
    if (!meta) return;
    fileDuration = meta.duration || 0;
    fileReady = true;
    const start = 0;
    const end = fileDuration;
    ui.setFileDuration(fileDuration);
    ui.setFileRange(start, end);
    ui.setScrubRange(start, end);
    ui.setScrubTime(start);
    ui.setFileControlsEnabled(true);
    dsp.renderSpectrumAtTime(start);
    seekVideo(start);
  } catch {
    ui.setStatus("file error");
  }
});

ui.onVideoToggle(() => {
  ui.showVideoPreview(fileIsVideo && ui.isVideoPreviewEnabled());
});

ui.onFileRangeChange(({ start, end }) => {
  if (!fileReady) return;
  let s = clamp(start, 0, fileDuration);
  let e = clamp(end, 0, fileDuration);
  if (e <= s) e = clamp(s + 0.01, 0, fileDuration);
  ui.setFileRange(s, e);
  ui.setScrubRange(s, e);
  const t = clamp(ui.getScrubTime(), s, e);
  ui.setScrubTime(t);
  dsp.renderSpectrumAtTime(t);
  seekVideo(t);
});

ui.onFileScrub((time) => {
  if (!fileReady) return;
  const range = ui.getFileRange();
  const t = clamp(time, range.start, range.end);
  if (t !== time) ui.setScrubTime(t);
  dsp.renderSpectrumAtTime(t);
  dsp.previewFileAudio(t);
  seekVideo(t);
});

ui.onFileProcess(async () => {
  if (!fileReady) return;
  const range = ui.getFileRange();
  const prevTime = ui.getScrubTime();
  ui.setStatus("processing");
  ui.setFileControlsEnabled(false);
  ui.setScrubTime(range.start);
  try {
    await dsp.renderWaterfallForFile(range.start, range.end, ({ timeSec }) => {
      ui.setScrubTime(timeSec);
    });
    ui.setStatus("file ready");
  } finally {
    ui.setFileControlsEnabled(true);
    const t = clamp(prevTime, range.start, range.end);
    ui.setScrubTime(t);
    dsp.renderSpectrumAtTime(t);
    seekVideo(t);
  }
});

ui.onLayoutChange(() => {
  if (currentMode !== "file" || !fileReady || dsp.isProcessingFile) return;
  const wf = dsp.fileWaterfall;
  if (!wf) return;
  dsp.renderWaterfallForFile(wf.startSec, wf.endSec);
});

// Bootstrap UI (loads settings and binds event handlers).
ui.init();
ui.setFileControlsEnabled(false);
setMode(ui.getSourceMode());
