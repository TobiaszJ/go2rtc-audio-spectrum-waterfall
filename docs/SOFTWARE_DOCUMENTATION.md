# Software Documentation (Full)

This document describes the complete software stack of the go2rtc audio spectrum + waterfall application: file structure, program flow, DSP logic, UI behavior, and all public functions.

## 1. Purpose and Scope
The application is a browser-only tool to visualize audio spectra and waterfalls from either a live WebRTC stream (go2rtc) or a local audio/video file. It supports multiple analysis modes (fixed FFT, multi FFT, CQT, wavelet), visual overlays for HP/LP filters and MQTT marker frequencies, and an offline file workflow for scrubbing and full-file waterfall rendering.

## 2. Repository Layout
Root:
- README.md: Project overview, features, quick start, usage.
- paper.tex: Academic-style description of the system and signal processing.
- LICENSE: License file.
- docs/SOFTWARE_DOCUMENTATION.md: This detailed software documentation.
- src/: Application source files.

Source files:
- src/index.html: UI layout and controls.
- src/styles.css: UI styling, layout, and visuals.
- src/app.js: Application wiring, config, MQTT, and UI <-> DSP coordination.
- src/ui.js: UI controller, settings management, layout persistence, and DOM helpers.
- src/dsp.js: DSP core, WebRTC audio pipeline, FFT/CQT/wavelet logic, spectrum + waterfall rendering.
- src/gate-worklet.js: AudioWorklet soft expander for dynamic range control.

## 3. Runtime Architecture
Modules and responsibilities:
- UI (ui.js): Reads/writes DOM, persists settings to cookie, persists layout to localStorage, handles drag + collapse of groups, and exposes getters/setters.
- DSP (dsp.js): Owns AudioContext and WebRTC pipeline in live mode. Owns file decoding and offline analysis in file mode. Renders spectrum and waterfall to canvases.
- App (app.js): Creates UI + DSP instances, binds events, manages file mode states, MQTT connection, and orchestrates live/file workflows.

Data flow in live mode:
1) UI Start -> app.js -> dsp.start()
2) dsp.start() creates AudioContext, loads worklet, opens WebSocket to go2rtc, negotiates WebRTC.
3) onTrack() builds the audio graph (HP/LP/expander/analyser).
4) tick() loop pulls FFT or time-domain data and renders spectrum + waterfall.

Data flow in file mode:
1) UI File select -> app.js -> dsp.loadFile()
2) File is decoded to AudioBuffer, converted to mono, settings updated.
3) Scrub slider -> dsp.renderSpectrumAtTime() (plus audio preview) and optional video seek.
4) Execute -> dsp.renderWaterfallForFile() renders full-file waterfall (scrub shows progress).

## 4. UI and User Interaction
Global controls:
- Controls collapse (header bar): icon-only collapse/expand button to free vertical space.
- Group drag + collapse: each group (Source/Analysis/Range/Expander/Output/MQTT) can be dragged by the handle and collapsed via the chevron.
- Layout persistence: order + collapsed state are stored in localStorage.

File mode (File Source card):
- File picker (audio/video)
- Start/End range with Range + Duration display
- Execute button for offline waterfall rendering
- Scrub slider with time indicator
- Optional video preview (toggleable)
- Scrub audio preview (short, faded playback snippet)

Spectrum and Waterfall panels:
- Spectrum uses HP/LP shading to show filtered-out regions.
- Waterfall shows intensity over time; file mode compresses to screen height with a cursor overlay.

## 5. DSP and Analysis Modes
Fixed FFT:
- Uses AnalyserNode frequency data for live, and a local FFT for file mode.
- FFT size is user-selectable (1024-8192).

Multi FFT:
- Splits frequency bands into multiple FFT sizes for better low-frequency resolution.
- Bands are blended with overlap to avoid hard edges.

CQT (Constant-Q Transform):
- Builds log-spaced bins between Fmin and Fmax.
- Uses a constant-Q kernel with Hann window.
- Precision (Low/Medium/High) changes bins per octave and max window size.

Wavelet:
- Similar log-spaced binning, but uses a Gaussian window and a scaled Q factor.
- Precision controls bins per octave and max window size.

Smoothing and AutoGain:
- Smoothing applies an exponential moving average for live mode lines.
- AutoGain is display-only and normalizes the line to a target peak.

## 6. Visualization
Spectrum:
- Grid and frequency labels (linear or log scale).
- Marker lines from MQTT (with harmonics).
- HP/LP shading + dashed boundaries.
- Stable peak labels (EMA-based top peaks).

Waterfall:
- Color map encodes intensity.
- Live mode scrolls with configurable time scale.
- File mode pre-renders a full waterfall compressed to screen height.
- Cursor line shows the current scrub time.

## 7. Settings and Persistence
- UI values are saved in a cookie (webrtc_fft_wf_settings_v3).
- Layout order and collapsed state are stored in localStorage (webrtc_fft_wf_layout_v1).

## 8. Performance and Limits
Key resource drivers:
- Large FFT sizes and long time windows increase CPU usage.
- CQT and wavelet modes are heavier than fixed FFT, especially in file mode.
- Long files increase offline rendering time for waterfall generation.

Recommendations:
- Use Multi FFT for a balanced view of low + high frequencies.
- Use CQT/Wavelet with Medium precision for most cases.
- Limit file ranges when rendering long files.

## 9. Function Reference (by file)

### src/app.js
Configuration:
- CONFIG: go2rtc host + source name.
- MQTT_CONFIG: MQTT connection and polling settings.

Helper functions:
- cleanupFileUrl(): Revokes the current file object URL.
- clamp(v, min, max): Numeric clamp used for ranges.
- seekVideo(time): Seeks video preview to a given time.
- setMode(mode): Switches between live and file modes, updates UI/DSP state.
- startMqttPolling(): Starts request polling at the configured interval.
- applyMqttSettings(): Applies UI settings to MQTT + marker appearance.

Event wiring:
- ui.onStart(): Starts live DSP pipeline.
- ui.onStop(): Stops live DSP pipeline.
- ui.onAnySettingChange(): Re-applies DSP + MQTT settings and refreshes file spectrum if needed.
- ui.onSourceModeChange(): Switches between live and file mode.
- ui.onFileSelected(): Loads file, prepares UI, enables scrubbing, and handles video preview.
- ui.onVideoToggle(): Shows or hides video preview.
- ui.onFileRangeChange(): Clamps range, updates scrub range, and redraws spectrum.
- ui.onFileScrub(): Renders spectrum at time, previews audio, and seeks video.
- ui.onFileProcess(): Renders full waterfall with progress via scrub slider.
- ui.onLayoutChange(): Re-renders file waterfall after resize/layout changes.

### src/ui.js
Class UI methods:
- constructor(config): Binds DOM, initializes handlers, defines padding constants.
- init(): Loads settings, wires events, initializes layout, resizes canvases.

Event registration:
- onStart(), onStop(), onAnySettingChange(), onSourceModeChange(), onFileSelected(), onFileScrub(), onFileRangeChange(), onFileProcess(), onLayoutChange(), onVideoToggle().

Status + labels:
- setStatus(), setMqttStatus(), setMqttValue(), setMqttTopic(), setMqttFanValue(), setMqttFanTopic().
- setRunning(), setSampleRate(), updateValueTexts(), setAutoGainValue().

Mode + layout:
- getWaterfallViewHeight(), getSourceMode(), setSourceMode().
- setLiveControlsEnabled(), setFileControlsEnabled().
- setFileDuration(), setFileRangeLabel(), getFileRange(), setFileRange().
- setScrubRange(), getScrubTime(), setScrubTime().
- showVideoPreview(), isVideoPreviewEnabled().
- updateAnalysisControls() (FFT vs Precision visibility).
- toggleControls() (global collapse).

Group layout (drag + collapse):
- initGroupLayout(), onGroupDragStart(), onGroupDragEnd(), onGroupDragOver(), onGroupDragLeave(), onGroupDrop().
- toggleGroup(), setGroupCollapsed().
- getGroupById(), getGroupOrder(), getGroupCollapsedState().
- applyGroupOrder(), applyGroupCollapsed().
- saveLayout(), loadLayout().

Canvas + settings:
- resizeCanvases(): Updates spectrum and waterfall canvas sizes.
- getSettings(): Returns normalized UI settings.
- setCookie(), getCookie(), deleteCookie(), saveToCookie(), loadFromCookie().
- resetDefaults(): Restores default UI values.

### src/dsp.js
Class DSP methods:
- constructor(config, ui): Initializes DSP state and caches.
- clamp(v, a, b): Numeric clamp helper.
- setMode(mode): Switches between live and file modes and clears cursor/preview.
- nextPow2(v): Next power-of-two for FFT sizes.
- getWindow(type, size): Window generator (Hann or Gaussian).
- getFftBuffers(size): Cached FFT buffers per size.
- ensureTimeData(size): Ensures time-domain buffer.
- updateAnalysisConfig(settings, sampleRate): Updates analysis mode + config and log bins.
- buildLogBins(mode, sampleRate, range, bufferSize): Build CQT/Wavelet bin definitions.
- sampleFftAmp(), sampleLogAmp(): Sample helper functions for spectrum values.
- computeFftAmps(): FFT magnitudes -> linear amplitudes.
- computeLogBinAmps(): Goertzel-style per-bin amplitude (CQT/Wavelet).
- smoothLineValues(): EMA smoothing for lines.
- applyAutoGainToLine(): Applies display-only auto gain.
- buildLineFromSampler(): Generates a spectrum line using a sampling function.
- computeLineMultiFft(): Multi-FFT with band blending.
- computeLineLogBins(): CQT/Wavelet rendering.
- computeLineFromTimeData(): Dispatches to selected analysis mode.
- wsUrl(): Builds go2rtc WebSocket URL.
- currentNyq(): Returns current Nyquist frequency.
- getRange(): Normalizes frequency range and log scale constraints.
- xNormToF(), fToXNorm(): Frequency <-> x coordinate conversion.
- binForFreq(): FFT bin index for a frequency.
- colorMap(): Waterfall color mapping.
- byteToAmp(): Convert analyser byte to linear amplitude.
- setMarkerHz(), setMarkerFanHz(), setMarkerOptions(): Marker configuration.
- hexToRgb(): Color parsing for markers.
- markerFreqs(): Harmonic frequency list.
- updateAvgLine(): EMA for stable peak detection.
- findTopPeaks(): Extract dominant peaks for labeling.
- start(): Initializes WebRTC + audio graph.
- onTrack(): Builds audio graph nodes and starts rendering.
- stop(): Stops WebRTC, AudioContext, and preview audio.
- applySettings(): Applies UI settings to DSP nodes and analysis config.
- setAudioOut(): Toggle audio output path.
- buildLine(): Fixed FFT line rendering.
- drawSpectrum(): Spectrum grid, lines, filter shading, markers, and labels.
- drawWaterfallRow(): Live waterfall scrolling row.
- resetDisplayState(): Clears smoothing and noise floor state.
- ensureOfflineFft(): Initializes offline FFT buffers.
- buildWindow(): Hann window for offline FFT.
- fftRadix2(): Radix-2 FFT implementation.
- computeFreqDataAtTime(): Offline FFT for file mode.
- getFileTimeData(): Time-domain slice for file mode analysis.
- renderSpectrumAtTime(): File mode spectrum rendering.
- renderWaterfallForFile(): Full-file waterfall rendering (offline).
- drawFileCursor(): Cursor line for file mode waterfall.
- clearFileCursor(), clearFileWaterfall(): Clears file visual state.
- ensurePreviewContext(): Creates preview AudioContext.
- stopPreviewAudio(): Stops current preview playback.
- previewFileAudio(): Plays a short scrub preview snippet with fade-in/out.
- loadFile(): Decodes and prepares file audio data.
- buildMonoBuffer(): Mixes file channels to mono.
- yieldToUi(): Yields to the UI thread during long renders.
- tick(): Live rendering loop.

### src/gate-worklet.js
Worklet class:
- SoftExpanderProcessor.parameterDescriptors: Exposes AudioParam controls.
- constructor(): Initializes smoothed gain.
- dbToLin(), linToDb(): dB and linear conversions.
- process(): Applies downward expander to incoming audio.

## 10. Operational Notes
- AudioContext autoplay restrictions may require a user gesture.
- File mode spectrum updates stay interactive after waterfall generation.
- Video preview is optional and hidden by default when disabled.
- MQTT markers require MQTT over WebSocket.

## 11. Troubleshooting
- No audio in live mode: verify go2rtc host, source name, and WebRTC availability.
- Spectrum is flat: check HP/LP range and audio input path.
- Slow file rendering: reduce analysis precision or shorten the range.
