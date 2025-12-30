# go2rtc Audio Spectrum + Waterfall

Web UI zum Anzeigen eines Live-Audio-Spektrums und eines Waterfalls fuer einen go2rtc WebRTC-Audio-Stream.
Die Anzeige laeuft komplett im Browser und nutzt WebAudio + AudioWorklet.

## Features
- Live-Spectrum (linear oder log)
- Waterfall mit frei waehlbarer Zeitachse
- Anzeige-Autogain (nur Darstellung)
- Highpass/Lowpass Filter
- Soft Expander (AudioWorklet)
- Settings speichern (Cookie)
- Optionaler Audio-Output

## Voraussetzungen
- go2rtc mit WebRTC-Audio-Source
- Browser mit AudioWorklet-Unterstuetzung (aktuelle Chromium/Firefox)
- Statisches Hosting (lokaler Webserver reicht)

## Quick Start
1) go2rtc Host und Source in `src/app.js` anpassen:
```js
const CONFIG = {
  go2rtcHost: "http://192.168.1.10:1984",
  src: "wp",
};
```
2) Projekt statisch serven (AudioWorklet benoetigt HTTP/HTTPS):
```bash
# Beispiel (Node)
npx serve .
```
3) `src/index.html` im Browser oeffnen (z.B. `http://localhost:3000/src/index.html`).
4) `Start` klicken.

## Bedienung
- FFT: Groesse der FFT
- Smoothing: Glaettung der FFT-Frames
- Gain/AutoGain: Darstellungsskalierung (kein Einfluss aufs Audio)
- Fmin/Fmax + Log: Frequenzbereich fuer Spectrum und Waterfall
- Waterfall (s): Zeitdauer, die in der Hoehe des Waterfalls sichtbar ist
- HP/LP: Biquad Highpass/Lowpass
- Expander: Soft Expander (Threshold, Ratio, Attack/Release)
- Audio out: Ausgabe des Streams auf die lokalen Lautsprecher

## Hinweise
- WebSocket-Verbindung: `ws(s)://<go2rtc-host>/api/ws?src=<name>`
- Bei Problemen mit AudioContext: Seite einmal anklicken (Browser-Autoplay-Policy).
- Waterfall und Spectrum verwenden denselben Frequenzbereich.

## Struktur
- `src/index.html`: UI
- `src/app.js`: Config + Wiring
- `src/dsp.js`: WebRTC/Audio/DSP + Rendering
- `src/gate-worklet.js`: Soft Expander (AudioWorklet)
- `src/ui.js`: UI-Logik und Settings

## Lizenz
Siehe `LICENSE`.
