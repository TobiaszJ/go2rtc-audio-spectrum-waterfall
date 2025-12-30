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

// MQTT client for compressor speed marker (Hz).
const mqttClient = window.mqtt
  ? window.mqtt.connect(MQTT_CONFIG.url, {
      username: MQTT_CONFIG.username,
      password: MQTT_CONFIG.password,
    })
  : null;

let mqttTimer = 0;
let mqttConnected = false;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

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
  MQTT_CONFIG.requestIntervalMs = pollSec * 1000;
  dsp.setMarkerOptions({
    color: s.markerColor,
    harmonics: s.markerHarmonics,
  });
  if (mqttConnected) startMqttPolling();
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
    startMqttPolling();
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
});

// Bootstrap UI (loads settings and binds event handlers).
ui.init();
