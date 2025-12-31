import { UI } from "./ui.js";
import { DSP } from "./dsp.js";

// Connection settings for the go2rtc WebRTC audio source.
const CONFIG = {
  go2rtcHost: "http://192.168.1.10:1984",
  src: "wp",
  mqtt: {
    url: "ws://192.168.1.10:1884",
    username: "test",
    password: "test1234",
    topic: "ebusd/hmu/RunDataCompressorSpeed",
    requestTopic: "ebusd/hmu/RunDataCompressorSpeed/get",
    fanTopic: "ebusd/hmu/RunDataFan1Speed",
    fanRequestTopic: "ebusd/hmu/RunDataFan1Speed/get",
  },
};

// MQTT settings for compressor speed marker.
const MQTT_CONFIG = {
  url: CONFIG.mqtt.url,
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  topic: CONFIG.mqtt.topic,
  requestTopic: CONFIG.mqtt.requestTopic,
  fanTopic: CONFIG.mqtt.fanTopic,
  fanRequestTopic: CONFIG.mqtt.fanRequestTopic,
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

let mqttClient = null;
let mqttTimer = 0;
let mqttConnected = false;
let mqttTopics = { topic: "", fanTopic: "" };

const clearMqttTimer = () => {
  if (mqttTimer) window.clearInterval(mqttTimer);
  mqttTimer = 0;
};

const disconnectMqtt = () => {
  clearMqttTimer();
  if (mqttClient) {
    try { mqttClient.end(true); } catch {}
  }
  mqttClient = null;
  mqttConnected = false;
};

const startMqttPolling = () => {
  if (!mqttConnected || !mqttClient) return;
  clearMqttTimer();
  mqttTimer = window.setInterval(() => {
    if (MQTT_CONFIG.requestTopic) mqttClient.publish(MQTT_CONFIG.requestTopic, "1");
    if (MQTT_CONFIG.fanRequestTopic) mqttClient.publish(MQTT_CONFIG.fanRequestTopic, "1");
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
    else clearMqttTimer();
  }
};

const updateMqttSubscriptions = (force=false) => {
  if (!mqttClient || !mqttConnected) return;
  const nextTopic = MQTT_CONFIG.topic || "";
  const nextFanTopic = MQTT_CONFIG.fanTopic || "";
  if (force || mqttTopics.topic !== nextTopic) {
    if (mqttTopics.topic) mqttClient.unsubscribe(mqttTopics.topic);
    if (nextTopic) mqttClient.subscribe(nextTopic);
    mqttTopics.topic = nextTopic;
  }
  if (force || mqttTopics.fanTopic !== nextFanTopic) {
    if (mqttTopics.fanTopic) mqttClient.unsubscribe(mqttTopics.fanTopic);
    if (nextFanTopic) mqttClient.subscribe(nextFanTopic);
    mqttTopics.fanTopic = nextFanTopic;
  }
  ui.setMqttTopic(nextTopic || "-");
  ui.setMqttFanTopic(nextFanTopic || "-");
};

const connectMqtt = () => {
  disconnectMqtt();
  if (!window.mqtt || !MQTT_CONFIG.url) {
    ui.setMqttStatus("disabled");
    ui.setMqttTopic(MQTT_CONFIG.topic || "-");
    ui.setMqttFanTopic(MQTT_CONFIG.fanTopic || "-");
    return;
  }
  mqttClient = window.mqtt.connect(MQTT_CONFIG.url, {
    username: MQTT_CONFIG.username,
    password: MQTT_CONFIG.password,
  });
  mqttTopics = { topic: "", fanTopic: "" };

  mqttClient.on("connect", () => {
    mqttConnected = true;
    ui.setMqttStatus("connected");
    updateMqttSubscriptions(true);
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
    clearMqttTimer();
  });
};

const syncSourceConfigFromUi = () => {
  const s = ui.getSettings();
  const nextHost = s.go2rtcHost || CONFIG.go2rtcHost;
  const nextSrc = s.go2rtcSrc || CONFIG.src;
  const changed = nextHost !== CONFIG.go2rtcHost || nextSrc !== CONFIG.src;
  CONFIG.go2rtcHost = nextHost;
  CONFIG.src = nextSrc;
  return changed;
};

const syncMqttConfigFromUi = ({ forceConnect = false } = {}) => {
  const s = ui.getSettings();
  const next = {
    url: s.mqttUrl || "",
    username: s.mqttUsername || "",
    password: s.mqttPassword || "",
    topic: s.mqttTopic || "",
    requestTopic: s.mqttRequestTopic || "",
    fanTopic: s.mqttFanTopic || "",
    fanRequestTopic: s.mqttFanRequestTopic || "",
  };
  const reconnect = next.url !== MQTT_CONFIG.url
    || next.username !== MQTT_CONFIG.username
    || next.password !== MQTT_CONFIG.password;
  const topicChanged = next.topic !== MQTT_CONFIG.topic || next.fanTopic !== MQTT_CONFIG.fanTopic;
  Object.assign(MQTT_CONFIG, next);
  ui.setMqttTopic(MQTT_CONFIG.topic || "-");
  ui.setMqttFanTopic(MQTT_CONFIG.fanTopic || "-");
  if (reconnect || forceConnect) connectMqtt();
  else if (topicChanged) updateMqttSubscriptions();
};

// Wire UI events to DSP lifecycle.
ui.onStart(async () => {
  syncSourceConfigFromUi();
  await dsp.start();
});

ui.onStop(() => {
  dsp.stop();
});

const handleSettingsChange = async () => {
  const sourceChanged = syncSourceConfigFromUi();
  syncMqttConfigFromUi();
  dsp.applySettings();
  applyMqttSettings();
  if (currentMode === "live" && sourceChanged && dsp.running) {
    dsp.stop();
    await dsp.start();
  }
  if (currentMode === "file" && fileReady) {
    dsp.renderSpectrumAtTime(ui.getScrubTime());
  }
};

// Apply settings live when any control changes.
ui.onAnySettingChange(() => {
  void handleSettingsChange();
});

ui.onSourceModeChange((mode) => {
  setMode(mode);
});

ui.onFileSelected(async (file) => {
  if (!file) {
    ui.setFileName("-");
    return;
  }
  ui.setFileName(file.name || "-");
  setMode("file");
  fileReady = false;
  ui.setFileControlsEnabled(false);
  ui.setFileInputEnabled(false);
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
    ui.setFileInputEnabled(true);
    dsp.renderSpectrumAtTime(start);
    seekVideo(start);
  } catch {
    ui.setStatus("file error");
    ui.setFileInputEnabled(true);
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
  ui.setFileInputEnabled(false);
  ui.setScrubTime(range.start);
  try {
    await dsp.renderWaterfallForFile(range.start, range.end, ({ timeSec }) => {
      ui.setScrubTime(timeSec);
    });
    ui.setStatus("file ready");
  } finally {
    ui.setFileControlsEnabled(true);
    ui.setFileInputEnabled(true);
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
syncSourceConfigFromUi();
syncMqttConfigFromUi({ forceConnect: true });
applyMqttSettings();
ui.setFileControlsEnabled(false);
ui.setFileInputEnabled(true);
ui.setFileName("-");
setMode(ui.getSourceMode());
