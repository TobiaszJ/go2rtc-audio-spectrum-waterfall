import { UI } from "./ui.js";
import { DSP } from "./dsp.js";

// Connection settings for the go2rtc WebRTC audio source.
const CONFIG = {
  go2rtcHost: "http://192.168.1.10:1984",
  src: "wp",
};

// UI handles DOM and settings; DSP handles WebRTC + audio processing + rendering.
const ui = new UI(CONFIG);
const dsp = new DSP(CONFIG, ui);

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
});

// Bootstrap UI (loads settings and binds event handlers).
ui.init();
