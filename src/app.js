import { UI } from "./ui.js";
import { DSP } from "./dsp.js";

const CONFIG = {
  go2rtcHost: "http://192.168.1.10:1984",
  src: "wp",
};

const ui = new UI(CONFIG);
const dsp = new DSP(CONFIG, ui);

ui.onStart(async () => {
  await dsp.start();
});

ui.onStop(() => {
  dsp.stop();
});

ui.onAnySettingChange(() => {
  dsp.applySettings();
});

ui.init();
