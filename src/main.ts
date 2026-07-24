// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Voxwell — bootstraps the app, owns the state machine, wires events.
 * All heavy lifting lives in audio.ts / graph.ts / dsp/*.
 */

import './styles/main.css';

import {
  MicrophoneError,
  audioSupported,
  decodeAudioFile,
  ensureWorklet,
  joinChunks,
  peakLevel,
  renderOffline,
  startMicrophone,
  stopStream,
  streamFullyStopped,
} from './audio';
import { buildChain, type VoiceChain } from './graph';
import { RECORDER_PROCESSOR } from './dsp/constants';
import { dominantFrequency, makeTone } from './dsp/analysis';
import { categoryLogger, emit, mountEventDrawer } from './eventlog';
import {
  buildFilename,
  extForFormat,
  formatBytes,
  formatClock,
  formatSemitones,
  mimeForFormat,
} from './format';
import { initGlossary } from './glossary';
import { isTypingTarget } from './keyboard';
import { DEFAULT_PARAMS, PRESETS, findPreset, matchPreset } from './presets';
import { Scope } from './scope';
import { closeModal, initModals, isModalOpen, openModal, toast } from './ui';
import type { EncodeRequest, EncodeResponse, OutputFormat, SourceKind, VoiceParams } from './types';

const log = {
  system: categoryLogger('system'),
  mic: categoryLogger('mic'),
  engine: categoryLogger('engine'),
  render: categoryLogger('render'),
  record: categoryLogger('record'),
  export: categoryLogger('export'),
};

const MAX_RECORD_SECONDS = 600;
const STORAGE_KEY = 'voxwell.settings.v1';

// ───────────────────────────────────────────────────────────── controls

type Panel = 'voice' | 'character' | 'space' | 'output';

interface RangeCtl {
  kind: 'range';
  key: keyof VoiceParams;
  panel: Panel;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  hint?: string;
}

interface ToggleCtl {
  kind: 'toggle';
  key: keyof VoiceParams;
  panel: Panel;
  label: string;
  hint: string;
}

type Ctl = RangeCtl | ToggleCtl;

const pct = (v: number) => `${Math.round(v)}%`;

const CONTROLS: Ctl[] = [
  {
    kind: 'range',
    key: 'pitch',
    panel: 'voice',
    label: 'Pitch',
    min: -18,
    max: 18,
    step: 1,
    format: formatSemitones,
  },
  {
    kind: 'range',
    key: 'formant',
    panel: 'voice',
    label: 'Formant',
    min: -12,
    max: 12,
    step: 1,
    format: formatSemitones,
  },
  {
    kind: 'toggle',
    key: 'linkFormants',
    panel: 'voice',
    label: 'Formants follow pitch',
    hint: 'On = chipmunk. Off = the same person, higher or lower.',
  },
  {
    kind: 'range',
    key: 'ring',
    panel: 'character',
    label: 'Ring mod',
    min: 0,
    max: 400,
    step: 5,
    format: (v) => (v === 0 ? 'off' : `${v} Hz`),
  },
  {
    kind: 'range',
    key: 'drive',
    panel: 'character',
    label: 'Drive',
    min: 0,
    max: 100,
    step: 1,
    format: pct,
  },
  {
    kind: 'toggle',
    key: 'radio',
    panel: 'character',
    label: 'Radio band',
    hint: 'Squeeze the voice into a 380–3200 Hz handset.',
  },
  {
    kind: 'range',
    key: 'wobbleRate',
    panel: 'character',
    label: 'Wobble rate',
    min: 0,
    max: 10,
    step: 0.5,
    format: (v) => (v === 0 ? 'off' : `${v.toFixed(1)} Hz`),
  },
  {
    kind: 'range',
    key: 'wobbleDepth',
    panel: 'character',
    label: 'Wobble depth',
    min: 0,
    max: 100,
    step: 1,
    format: pct,
  },
  {
    kind: 'range',
    key: 'echoMix',
    panel: 'space',
    label: 'Echo',
    min: 0,
    max: 100,
    step: 1,
    format: (v) => (v === 0 ? 'off' : pct(v)),
  },
  {
    kind: 'range',
    key: 'echoTime',
    panel: 'space',
    label: 'Echo time',
    min: 60,
    max: 800,
    step: 10,
    format: (v) => `${v} ms`,
  },
  {
    kind: 'range',
    key: 'mix',
    panel: 'output',
    label: 'Wet mix',
    min: 0,
    max: 100,
    step: 1,
    format: pct,
  },
  {
    kind: 'range',
    key: 'output',
    panel: 'output',
    label: 'Level',
    min: 0,
    max: 200,
    step: 5,
    format: pct,
  },
];

const PANEL_TITLES: Record<Panel, string> = {
  voice: 'Voice',
  character: 'Character',
  space: 'Space',
  output: 'Output',
};

// ───────────────────────────────────────────────────────────── state

interface LiveSession {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  chain: VoiceChain;
  analyser: AnalyserNode;
  recorder: AudioWorkletNode;
  monitor: GainNode;
  chunks: Float32Array[];
}

interface Clip {
  samples: Float32Array;
  sampleRate: number;
  name: string;
}

interface State {
  stage: 'choose' | 'studio';
  sourceKind: SourceKind | null;
  sourceName: string;
  params: VoiceParams;
  format: OutputFormat;
  bitrate: number;
  monitoring: boolean;
  recording: boolean;
  playing: boolean;
  rendering: boolean;
}

const state: State = {
  stage: 'choose',
  sourceKind: null,
  sourceName: '',
  params: { ...DEFAULT_PARAMS },
  format: 'wav',
  bitrate: 160,
  monitoring: false,
  recording: false,
  playing: false,
  rendering: false,
};

let live: LiveSession | null = null;
let sourceAudio: { samples: Float32Array; sampleRate: number } | null = null;
let clip: Clip | null = null;
let scope: Scope | null = null;
let previewCtx: AudioContext | null = null;
let previewNode: AudioBufferSourceNode | null = null;
let previewStartedAt = 0;
let uiTimer: number | null = null;
let renderTimer: number | null = null;
let renderToken = 0;
let lastBlobUrl: string | null = null;
let lastExport: { blob: Blob; name: string } | null = null;
let disposeDrawer: (() => void) | null = null;

// ───────────────────────────────────────────────────────────── markup

const ICON_MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg>`;
const ICON_FILE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V7l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`;

function controlMarkup(ctl: Ctl): string {
  if (ctl.kind === 'toggle') {
    return `
      <div class="opt-row">
        <span>
          <span class="opt-name">${ctl.label}</span>
          <span class="opt-desc">${ctl.hint}</span>
        </span>
        <input type="checkbox" id="ctl-${ctl.key}" data-key="${ctl.key}" aria-label="${ctl.label}">
      </div>`;
  }
  return `
    <div class="ctl" data-ctl="${ctl.key}">
      <label for="ctl-${ctl.key}">${ctl.label}</label>
      <input type="range" id="ctl-${ctl.key}" data-key="${ctl.key}"
             min="${ctl.min}" max="${ctl.max}" step="${ctl.step}">
      <output class="ctl-val" id="val-${ctl.key}" for="ctl-${ctl.key}"></output>
    </div>`;
}

function panelMarkup(panel: Panel): string {
  const rows = CONTROLS.filter((c) => c.panel === panel).map(controlMarkup).join('');
  return `<div class="panel"><div class="panel-title">${PANEL_TITLES[panel]}</div>${rows}</div>`;
}

const APP_HTML = `
  <header class="topbar">
    <a class="brand" href="/" aria-label="Voxwell home">
      <svg class="brand-mark" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 16h2.5" /><path d="M10 9v14" /><path d="M15.5 4v24" /><path d="M21 11v10" /><path d="M26.5 14v4" />
      </svg>
      <span class="brand-name">Vox<span class="accent">well</span></span>
    </a>
    <nav class="topnav" aria-label="Main">
      <button type="button" data-modal="how">How it works</button>
      <button type="button" data-modal="threat">Privacy</button>
      <button type="button" data-modal="about">About</button>
      <button type="button" class="drawer-toggle" id="drawer-toggle" aria-expanded="false">Event log</button>
    </nav>
  </header>

  <button type="button" class="trust-banner" id="trust-banner">
    <span class="lock" aria-hidden="true">&#128274;</span>
    Runs entirely in your browser. Nothing is recorded until you press record, and nothing is ever uploaded.
  </button>

  <main class="main-content">
    <div class="workspace">
      <section class="chooser" id="chooser">
        <h1 class="hero-title">Change your voice.</h1>
        <p class="hero-sub">
          Pitch and formants moved independently, live, by a phase vocoder running in this tab.
          Export a WAV or MP3. Nothing is uploaded — ever.
        </p>
        <div class="input-cards">
          <button type="button" class="input-card card-mic" id="mic-card">
            <span class="card-icon">${ICON_MIC}</span>
            <span class="card-title">Use microphone</span>
            <span class="card-sub">Speak and hear yourself change in real time</span>
          </button>
          <div class="input-card dropzone" id="dropzone" role="button" tabindex="0"
               aria-label="Drop an audio file, or press Enter to choose one">
            <span class="card-icon">${ICON_FILE}</span>
            <span class="card-title">Drop an audio file</span>
            <span class="card-sub">…or tap to choose one</span>
            <span class="card-formats">mp3 · m4a · wav · ogg · flac · mp4</span>
          </div>
        </div>
        <p class="input-note" id="input-note" role="status" aria-live="polite" hidden></p>
        <input type="file" id="file-input" accept="audio/*,video/*,.mp3,.m4a,.wav,.ogg,.flac,.aac" hidden>
      </section>

      <section class="studio" id="studio" hidden>
        <div class="source-bar">
          <div class="source-meta">
            <span class="sm-name" id="src-name"></span>
            <span class="sm-detail" id="src-detail"></span>
          </div>
          <div class="source-actions">
            <label class="switch" id="monitor-wrap" hidden>
              <input type="checkbox" id="monitor">
              <span>Hear myself</span>
            </label>
            <button type="button" class="btn btn-ghost btn-sm" id="change-source">Change source</button>
          </div>
        </div>

        <div class="scope-wrap">
          <canvas class="scope" id="scope" aria-label="Audio waveform"></canvas>
          <span class="scope-badge" id="scope-badge"></span>
        </div>

        <div class="presets" id="presets" role="group" aria-label="Voice presets"></div>

        <div class="panels">
          ${panelMarkup('voice')}
          ${panelMarkup('character')}
          ${panelMarkup('space')}
          ${panelMarkup('output')}
        </div>

        <div class="transport">
          <button type="button" class="btn btn-record" id="record-btn" hidden>
            <span class="rec-dot"></span><span id="record-label">Record</span>
          </button>
          <button type="button" class="btn btn-ghost" id="play-btn" disabled>
            <span class="play-ico" id="play-ico"></span><span id="play-label">Play</span>
          </button>
          <div class="transport-times">
            <span class="t-now" id="t-now">0:00.0</span>
            <span class="t-sep">/</span>
            <span class="t-len" id="t-len">0:00.0</span>
          </div>
          <div class="meter" id="meter" hidden><span id="meter-fill"></span></div>
        </div>

        <div class="export-area">
          <div class="export-opts">
            <label for="format-select" class="sr-only">Format</label>
            <select id="format-select">
              <option value="wav">WAV · lossless</option>
              <option value="mp3">MP3 · small</option>
            </select>
            <label for="bitrate-select" class="sr-only">MP3 bitrate</label>
            <select id="bitrate-select" hidden>
              <option value="96">96 kbps</option>
              <option value="128">128 kbps</option>
              <option value="160">160 kbps</option>
              <option value="192">192 kbps</option>
            </select>
          </div>
          <button type="button" class="btn btn-primary btn-export" id="export-btn" disabled>Save clip</button>
          <div class="progress" id="progress" hidden>
            <div class="progress-bar"><span id="progress-fill"></span></div>
            <span class="progress-pct" id="progress-pct">0%</span>
          </div>
          <div class="result" id="result" hidden>
            <span class="result-meta" id="result-meta"></span>
            <div class="result-actions">
              <button type="button" class="btn btn-ghost btn-sm" id="download-btn">Download</button>
              <button type="button" class="btn btn-ghost btn-sm" id="share-btn" hidden>Share</button>
            </div>
          </div>
          <div class="error-box" id="error-box" hidden>
            <p id="error-text"></p>
            <button type="button" class="btn btn-ghost btn-sm" id="error-dismiss">Dismiss</button>
          </div>
          <span class="kbd-hint"><kbd>Space</kbd> record/play · <kbd>Enter</kbd> save · <kbd>1</kbd>–<kbd>9</kbd> presets</span>
        </div>
      </section>
    </div>
  </main>

  <aside class="drawer" id="drawer" hidden aria-label="Event log"></aside>

  <footer class="site-footer">
    <div class="footer-inner">
      Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a>
      · <a href="https://lab.benrichardson.dev" target="_blank" rel="noopener">more tools &amp; sites</a>
    </div>
  </footer>
`;

// ───────────────────────────────────────────────────────────── helpers

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

function showError(message: string): void {
  const box = el<HTMLElement>('error-box');
  el<HTMLElement>('error-text').textContent = message;
  show(box, true);
}

function clearError(): void {
  show(el<HTMLElement>('error-box'), false);
}

function setProgress(value: number | null): void {
  const wrap = el<HTMLElement>('progress');
  if (value === null) {
    show(wrap, false);
    return;
  }
  show(wrap, true);
  const clamped = Math.max(0, Math.min(1, value));
  el<HTMLElement>('progress-fill').style.width = `${clamped * 100}%`;
  el<HTMLElement>('progress-pct').textContent = `${Math.round(clamped * 100)}%`;
}

function saveSettings(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ params: state.params, format: state.format, bitrate: state.bitrate }),
    );
  } catch {
    /* storage disabled — settings simply won't persist */
  }
}

function loadSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<{
      params: Partial<VoiceParams>;
      format: OutputFormat;
      bitrate: number;
    }>;
    if (saved.params) state.params = { ...DEFAULT_PARAMS, ...saved.params };
    if (saved.format === 'wav' || saved.format === 'mp3') state.format = saved.format;
    if (typeof saved.bitrate === 'number') state.bitrate = saved.bitrate;
  } catch {
    /* corrupt or unavailable — fall back to defaults */
  }
}

// ───────────────────────────────────────────────────────────── boot

function boot(): void {
  const app = el<HTMLElement>('app');
  app.innerHTML = APP_HTML;

  loadSettings();
  initModals();
  initGlossary();

  scope = new Scope(el<HTMLCanvasElement>('scope'));

  buildPresetTiles();
  syncControls();
  wireChrome();
  wireInputs();
  wireStudio();

  log.system('Voxwell ready — no network calls beyond loading this page.', 'ok');

  if (!audioSupported()) {
    showChooserNote(
      'This browser is missing AudioWorklet, which Voxwell needs. Try a current Chrome, Edge, Firefox or Safari.',
      'err',
    );
    el<HTMLButtonElement>('mic-card').disabled = true;
    log.system('AudioWorklet unavailable — the tool cannot run here.', 'err');
  }

  registerServiceWorker();
  installTestHook();
}

function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(
      () => log.system('Service worker registered — the tool now works offline.', 'ok'),
      () => log.system('Service worker registration failed; the tool still works online.', 'warn'),
    );
  });
}

// ───────────────────────────────────────────────────────────── chrome

function wireChrome(): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-modal]'))) {
    btn.addEventListener('click', () => openModal(btn.dataset.modal as string));
  }
  el<HTMLButtonElement>('trust-banner').addEventListener('click', () => openModal('threat'));

  const drawer = el<HTMLElement>('drawer');
  const toggle = el<HTMLButtonElement>('drawer-toggle');
  const closeDrawer = () => {
    show(drawer, false);
    toggle.classList.remove('on');
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    const opening = drawer.hidden;
    show(drawer, opening);
    toggle.classList.toggle('on', opening);
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening && !disposeDrawer) disposeDrawer = mountEventDrawer(drawer, closeDrawer);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isModalOpen()) {
        closeModal();
        return;
      }
      if (!drawer.hidden) closeDrawer();
      return;
    }
    if (isModalOpen()) return;
    const typing = isTypingTarget(e.target);

    if (e.key === ' ' && !typing) {
      e.preventDefault();
      if (state.sourceKind === 'mic') toggleRecording();
      else togglePlayback();
      return;
    }
    if (e.key === 'Enter' && !typing && state.stage === 'studio') {
      e.preventDefault();
      void exportClip();
      return;
    }
    if (/^[1-9]$/.test(e.key) && state.stage === 'studio' && !typing) {
      const preset = PRESETS[Number(e.key) - 1];
      if (preset) applyPreset(preset.id);
    }
  });

  // Leaving or hiding the page must release the microphone, or the OS
  // indicator stays lit after the user has moved on.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && live && !state.recording) teardownLive('tab hidden');
  });
  window.addEventListener('pagehide', () => teardownLive('page closed'));
}

function showChooserNote(message: string, kind: 'info' | 'err' = 'info'): void {
  const note = el<HTMLElement>('input-note');
  note.textContent = message;
  note.dataset.kind = kind;
  show(note, true);
}

// ───────────────────────────────────────────────────────────── input

function wireInputs(): void {
  const dropzone = el<HTMLElement>('dropzone');
  const fileInput = el<HTMLInputElement>('file-input');

  el<HTMLButtonElement>('mic-card').addEventListener('click', () => void beginMic());

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void ingestFile(file);
    fileInput.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    dropzone.addEventListener(type, () => dropzone.classList.remove('drag'));
  }
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void ingestFile(file);
  });

  // Whole-window drop, so a near-miss on the zone still works.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (state.stage !== 'choose') return;
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void ingestFile(file);
  });
}

async function ingestFile(file: File): Promise<void> {
  clearError();
  showChooserNote(`Reading “${file.name}” — locally, in this tab…`);
  log.render(`Decoding ${file.name} (${formatBytes(file.size)})`);
  try {
    const decoded = await decodeAudioFile(file);
    if (decoded.samples.length === 0) throw new Error('That file contains no audio.');
    sourceAudio = { samples: decoded.samples, sampleRate: decoded.sampleRate };
    state.sourceKind = 'file';
    state.sourceName = file.name;
    log.render(
      `Decoded ${formatClock(decoded.duration)} at ${decoded.sampleRate} Hz — nothing left the device.`,
      'ok',
    );
    enterStudio();
    scheduleRender(true);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'That file could not be read.';
    showChooserNote(message, 'err');
    log.render(message, 'err');
  }
}

async function beginMic(): Promise<void> {
  clearError();
  showChooserNote('Asking for microphone access…');
  try {
    const stream = await startMicrophone();
    log.mic('Microphone opened — the stream is processed here and discarded.', 'ok');
    await openLiveSession(stream);
    state.sourceKind = 'mic';
    state.sourceName = 'Live microphone';
    enterStudio();
  } catch (err) {
    const message =
      err instanceof MicrophoneError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'The microphone could not be opened.';
    showChooserNote(`${message}`, 'err');
    log.mic(message, 'err');
  }
}

async function openLiveSession(stream: MediaStream): Promise<void> {
  const ctx = new AudioContext();
  await ctx.resume();
  await ensureWorklet(ctx);

  const source = ctx.createMediaStreamSource(stream);
  const chain = buildChain(ctx, state.params);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.1;

  const recorder = new AudioWorkletNode(ctx, RECORDER_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  const monitor = ctx.createGain();
  monitor.gain.value = state.monitoring ? 1 : 0;

  // A silent sink keeps the analyser and recorder inside the graph that is
  // being pulled towards the destination, without making a sound.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  source.connect(chain.input);
  chain.output.connect(analyser).connect(sink);
  chain.output.connect(recorder).connect(sink);
  chain.output.connect(monitor).connect(ctx.destination);

  const chunks: Float32Array[] = [];
  recorder.port.onmessage = (event: MessageEvent<{ type: string; chunk?: Float32Array }>) => {
    const data = event.data;
    if (data?.type === 'chunk' && data.chunk) chunks.push(data.chunk);
    else if (data?.type === 'done') finishRecording();
  };

  live = { ctx, stream, source, chain, analyser, recorder, monitor, chunks };
  scope?.attachAnalyser(analyser);
  log.engine(`Voice engine running at ${ctx.sampleRate} Hz on the audio thread.`, 'ok');
}

function teardownLive(reason: string): void {
  if (!live) return;
  const session = live;
  live = null;
  state.recording = false;
  state.monitoring = false;
  scope?.attachAnalyser(null);
  try {
    session.recorder.port.onmessage = null;
    session.chain.dispose();
    session.source.disconnect();
    session.recorder.disconnect();
    session.monitor.disconnect();
  } catch {
    /* nodes already detached */
  }
  stopStream(session.stream);
  void session.ctx.close().catch(() => undefined);
  log.mic(`Microphone released (${reason}). The recording indicator is off.`, 'ok');
  stopUiTimer();
  syncTransport();
}

// ───────────────────────────────────────────────────────────── studio

function enterStudio(): void {
  state.stage = 'studio';
  clip = null;
  lastExport = null;
  show(el<HTMLElement>('chooser'), false);
  show(el<HTMLElement>('studio'), true);
  show(el<HTMLElement>('input-note'), false);
  show(el<HTMLElement>('result'), false);
  setProgress(null);

  el<HTMLElement>('src-name').textContent = state.sourceName;
  show(el<HTMLElement>('monitor-wrap'), state.sourceKind === 'mic');
  show(el<HTMLButtonElement>('record-btn'), state.sourceKind === 'mic');
  show(el<HTMLElement>('meter'), state.sourceKind === 'mic');

  if (state.sourceKind === 'mic') {
    el<HTMLElement>('src-detail').textContent =
      'Live · nothing is kept until you press record · use headphones to monitor';
    el<HTMLElement>('scope-badge').textContent = 'live';
    startUiTimer();
  } else if (sourceAudio) {
    const seconds = sourceAudio.samples.length / sourceAudio.sampleRate;
    el<HTMLElement>('src-detail').textContent = `${formatClock(seconds)} · ${sourceAudio.sampleRate} Hz · mono`;
    el<HTMLElement>('scope-badge').textContent = 'preview';
  }

  syncControls();
  syncTransport();
}

function leaveStudio(): void {
  teardownLive('source changed');
  stopPlayback();
  sourceAudio = null;
  clip = null;
  lastExport = null;
  state.stage = 'choose';
  state.sourceKind = null;
  scope?.showClip(null);
  show(el<HTMLElement>('studio'), false);
  show(el<HTMLElement>('chooser'), true);
  show(el<HTMLElement>('input-note'), false);
  clearError();
}

function buildPresetTiles(): void {
  const host = el<HTMLElement>('presets');
  host.innerHTML = '';
  PRESETS.forEach((preset, index) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'preset';
    tile.dataset.preset = preset.id;
    tile.setAttribute('aria-pressed', 'false');
    tile.innerHTML = `<span class="preset-key">${index + 1}</span><span class="preset-name">${preset.name}</span><span class="preset-hint">${preset.hint}</span>`;
    tile.addEventListener('click', () => applyPreset(preset.id));
    host.appendChild(tile);
  });
}

function applyPreset(id: string): void {
  const preset = findPreset(id);
  if (!preset) return;
  state.params = { ...preset.params };
  log.engine(`Preset “${preset.name}” applied.`);
  syncControls();
  pushParams();
}

function wireStudio(): void {
  for (const ctl of CONTROLS) {
    const input = el<HTMLInputElement>(`ctl-${ctl.key}`);
    if (ctl.kind === 'toggle') {
      input.addEventListener('change', () => {
        (state.params[ctl.key] as boolean) = input.checked;
        syncControls();
        pushParams();
      });
    } else {
      input.addEventListener('input', () => {
        (state.params[ctl.key] as number) = Number(input.value);
        syncControls();
        pushParams();
      });
    }
  }

  el<HTMLButtonElement>('change-source').addEventListener('click', leaveStudio);

  el<HTMLInputElement>('monitor').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    state.monitoring = on;
    if (live) live.monitor.gain.value = on ? 1 : 0;
    log.mic(on ? 'Monitoring on — wear headphones or it will feed back.' : 'Monitoring off.');
  });

  el<HTMLButtonElement>('record-btn').addEventListener('click', toggleRecording);
  el<HTMLButtonElement>('play-btn').addEventListener('click', togglePlayback);
  el<HTMLButtonElement>('export-btn').addEventListener('click', () => void exportClip());
  el<HTMLButtonElement>('download-btn').addEventListener('click', downloadExport);
  el<HTMLButtonElement>('share-btn').addEventListener('click', () => void shareExport());
  el<HTMLButtonElement>('error-dismiss').addEventListener('click', clearError);

  const formatSelect = el<HTMLSelectElement>('format-select');
  formatSelect.value = state.format;
  formatSelect.addEventListener('change', () => {
    state.format = formatSelect.value === 'mp3' ? 'mp3' : 'wav';
    show(el<HTMLElement>('bitrate-select'), state.format === 'mp3');
    saveSettings();
  });

  const bitrateSelect = el<HTMLSelectElement>('bitrate-select');
  bitrateSelect.value = String(state.bitrate);
  show(bitrateSelect, state.format === 'mp3');
  bitrateSelect.addEventListener('change', () => {
    state.bitrate = Number(bitrateSelect.value) || 160;
    saveSettings();
  });
}

/** Reflect `state.params` into every control and the preset tiles. */
function syncControls(): void {
  for (const ctl of CONTROLS) {
    const input = document.getElementById(`ctl-${ctl.key}`) as HTMLInputElement | null;
    if (!input) continue;
    if (ctl.kind === 'toggle') {
      input.checked = state.params[ctl.key] as boolean;
      continue;
    }
    const value = state.params[ctl.key] as number;
    input.value = String(value);
    const out = document.getElementById(`val-${ctl.key}`);
    if (out) out.textContent = ctl.format(value);
  }

  // The formant slider is meaningless while formants are linked to pitch.
  const formantRow = document.querySelector<HTMLElement>('[data-ctl="formant"]');
  const formantInput = document.getElementById('ctl-formant') as HTMLInputElement | null;
  if (formantRow && formantInput) {
    formantRow.classList.toggle('disabled', state.params.linkFormants);
    formantInput.disabled = state.params.linkFormants;
    const out = document.getElementById('val-formant');
    if (out && state.params.linkFormants) out.textContent = 'follows';
  }

  const active = matchPreset(state.params);
  for (const tile of Array.from(document.querySelectorAll<HTMLElement>('.preset'))) {
    const on = tile.dataset.preset === active;
    tile.classList.toggle('on', on);
    tile.setAttribute('aria-pressed', String(on));
  }
}

/** Send the current params wherever they need to go, and persist them. */
function pushParams(): void {
  saveSettings();
  if (live) {
    live.chain.update(state.params);
    return;
  }
  if (state.sourceKind === 'file') scheduleRender(false);
}

// ───────────────────────────────────────────────────────────── render

function scheduleRender(immediate: boolean): void {
  if (renderTimer !== null) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => void renderFileClip(), immediate ? 0 : 320);
}

async function renderFileClip(): Promise<void> {
  if (!sourceAudio) return;
  const token = ++renderToken;
  state.rendering = true;
  el<HTMLElement>('scope-badge').textContent = 'rendering…';
  el<HTMLButtonElement>('export-btn').disabled = true;
  const started = performance.now();
  try {
    const samples = await renderOffline(sourceAudio.samples, sourceAudio.sampleRate, state.params);
    if (token !== renderToken) return;
    clip = { samples, sampleRate: sourceAudio.sampleRate, name: state.sourceName };
    lastExport = null;
    show(el<HTMLElement>('result'), false);
    scope?.showClip(samples);
    el<HTMLElement>('scope-badge').textContent = 'preview';
    log.render(
      `Rendered ${formatClock(samples.length / clip.sampleRate)} in ${Math.round(performance.now() - started)} ms — peak ${(peakLevel(samples) * 100).toFixed(0)}%.`,
      'ok',
    );
  } catch (err) {
    if (token !== renderToken) return;
    const message = err instanceof Error ? err.message : 'Rendering failed.';
    showError(`${message} Try a different preset, or reload the page.`);
    log.render(message, 'err');
    el<HTMLElement>('scope-badge').textContent = 'error';
  } finally {
    if (token === renderToken) {
      state.rendering = false;
      syncTransport();
    }
  }
}

// ───────────────────────────────────────────────────────── recording

function toggleRecording(): void {
  if (state.sourceKind !== 'mic' || !live) return;
  if (state.recording) {
    live.recorder.port.postMessage({ type: 'stop' });
    state.recording = false;
    log.record('Recording stopped.', 'ok');
    syncTransport();
    return;
  }
  // Playback and recording share the elapsed-time readout, and playing a take
  // back into an open microphone is never what anyone wants.
  if (state.playing) stopPlayback();
  live.chunks.length = 0;
  clip = null;
  lastExport = null;
  show(el<HTMLElement>('result'), false);
  clearError();
  live.recorder.port.postMessage({ type: 'start' });
  state.recording = true;
  previewStartedAt = performance.now();
  scope?.attachAnalyser(live.analyser);
  el<HTMLElement>('scope-badge').textContent = 'recording';
  log.record('Recording — the processed signal is being captured in this tab only.');
  syncTransport();
}

function finishRecording(): void {
  if (!live) return;
  const samples = joinChunks(live.chunks);
  live.chunks.length = 0;
  if (samples.length === 0) {
    showError('Nothing was captured. Check that the right microphone is selected and try again.');
    log.record('Recording produced no samples.', 'warn');
    syncTransport();
    return;
  }
  clip = { samples, sampleRate: live.ctx.sampleRate, name: 'voice' };
  scope?.attachAnalyser(null);
  scope?.showClip(samples);
  el<HTMLElement>('scope-badge').textContent = 'take';
  log.record(
    `Captured ${formatClock(samples.length / clip.sampleRate)} — peak ${(peakLevel(samples) * 100).toFixed(0)}%.`,
    'ok',
  );
  syncTransport();
}

function startUiTimer(): void {
  if (uiTimer !== null) return;
  uiTimer = window.setInterval(() => {
    if (state.recording) {
      const seconds = (performance.now() - previewStartedAt) / 1000;
      el<HTMLElement>('t-now').textContent = formatClock(seconds);
      el<HTMLElement>('t-len').textContent = formatClock(MAX_RECORD_SECONDS);
      if (seconds >= MAX_RECORD_SECONDS) {
        toast('Ten-minute limit reached — recording stopped.', 'info');
        toggleRecording();
      }
    }
    if (live) {
      const data = new Float32Array(live.analyser.fftSize);
      live.analyser.getFloatTimeDomainData(data);
      const level = Math.min(1, peakLevel(data));
      el<HTMLElement>('meter-fill').style.width = `${level * 100}%`;
      el<HTMLElement>('meter').dataset.hot = String(level > 0.96);
    }
    if (state.playing && previewCtx) {
      const elapsed = previewCtx.currentTime - previewStartedAt;
      const total = clip ? clip.samples.length / clip.sampleRate : 0;
      el<HTMLElement>('t-now').textContent = formatClock(elapsed);
      if (total > 0) scope?.setPlayhead(Math.min(1, elapsed / total));
    }
  }, 100);
}

function stopUiTimer(): void {
  if (uiTimer === null) return;
  window.clearInterval(uiTimer);
  uiTimer = null;
}

// ───────────────────────────────────────────────────────── playback

function togglePlayback(): void {
  if (state.playing) {
    stopPlayback();
    return;
  }
  if (!clip) return;
  try {
    if (!previewCtx) previewCtx = new AudioContext();
    void previewCtx.resume();
    const buffer = previewCtx.createBuffer(1, clip.samples.length, clip.sampleRate);
    buffer.copyToChannel(clip.samples as Float32Array<ArrayBuffer>, 0);
    const node = previewCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(previewCtx.destination);
    node.onended = () => {
      if (previewNode === node) stopPlayback();
    };
    node.start();
    previewNode = node;
    previewStartedAt = previewCtx.currentTime;
    state.playing = true;
    startUiTimer();
    syncTransport();
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Playback failed.');
  }
}

function stopPlayback(): void {
  if (previewNode) {
    try {
      previewNode.onended = null;
      previewNode.stop();
    } catch {
      /* already finished */
    }
    previewNode = null;
  }
  state.playing = false;
  scope?.setPlayhead(-1);
  if (!live) stopUiTimer();
  syncTransport();
}

function syncTransport(): void {
  const recordBtn = el<HTMLButtonElement>('record-btn');
  const playBtn = el<HTMLButtonElement>('play-btn');
  const exportBtn = el<HTMLButtonElement>('export-btn');

  recordBtn.classList.toggle('on', state.recording);
  el<HTMLElement>('record-label').textContent = state.recording ? 'Stop' : 'Record';

  playBtn.disabled = !clip || state.rendering;
  el<HTMLElement>('play-label').textContent = state.playing ? 'Stop' : 'Play';
  el<HTMLElement>('play-ico').classList.toggle('is-playing', state.playing);

  exportBtn.disabled = !clip || state.rendering;

  const total = clip ? clip.samples.length / clip.sampleRate : 0;
  if (!state.recording) {
    el<HTMLElement>('t-len').textContent = formatClock(total);
    if (!state.playing) el<HTMLElement>('t-now').textContent = formatClock(0);
  }
}

// ─────────────────────────────────────────────────────────── export

async function exportClip(): Promise<void> {
  if (!clip || state.rendering) return;
  clearError();
  const current = clip;
  const worker = new Worker(new URL('./encoder-worker.ts', import.meta.url), { type: 'module' });
  const presetName = findPreset(matchPreset(state.params) ?? '')?.name ?? 'voxwell';
  const name = buildFilename(current.name, presetName, state.format);

  el<HTMLButtonElement>('export-btn').disabled = true;
  setProgress(0);
  log.export(`Encoding ${state.format.toUpperCase()} locally…`);

  const done = new Promise<void>((resolve) => {
    worker.onmessage = (event: MessageEvent<EncodeResponse>) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        setProgress(msg.value);
        return;
      }
      if (msg.type === 'done') {
        const blob = new Blob([msg.buffer], { type: msg.mime });
        lastExport = { blob, name };
        setProgress(null);
        showResult(blob, name);
        log.export(`${name} ready — ${formatBytes(blob.size)}. It never left this device.`, 'ok');
      } else {
        setProgress(null);
        showError(msg.message);
        log.export(msg.message, 'err');
      }
      worker.terminate();
      el<HTMLButtonElement>('export-btn').disabled = false;
      resolve();
    };
    worker.onerror = () => {
      setProgress(null);
      showError('The encoder crashed. Try WAV, or reload the page.');
      log.export('Encoder worker error.', 'err');
      worker.terminate();
      el<HTMLButtonElement>('export-btn').disabled = false;
      resolve();
    };
  });

  const samples = current.samples.slice();
  const request: EncodeRequest = {
    format: state.format,
    samples,
    sampleRate: current.sampleRate,
    bitrate: state.bitrate,
  };
  worker.postMessage(request, [samples.buffer]);
  await done;
}

function showResult(blob: Blob, name: string): void {
  const result = el<HTMLElement>('result');
  el<HTMLElement>('result-meta').textContent = `${name} · ${formatBytes(blob.size)}`;
  show(result, true);
  const shareBtn = el<HTMLButtonElement>('share-btn');
  const file = new File([blob], name, { type: blob.type });
  show(shareBtn, typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }));
}

function downloadExport(): void {
  if (!lastExport) return;
  if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
  lastBlobUrl = URL.createObjectURL(lastExport.blob);
  const a = document.createElement('a');
  a.href = lastBlobUrl;
  a.download = lastExport.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  log.export(`Saved ${lastExport.name}.`, 'ok');
}

async function shareExport(): Promise<void> {
  if (!lastExport) return;
  const file = new File([lastExport.blob], lastExport.name, { type: lastExport.blob.type });
  try {
    await navigator.share({ files: [file], title: 'Voxwell clip' });
    log.export('Handed to the system share sheet.', 'ok');
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return;
    toast('Sharing was not possible here — use Download instead.', 'err');
  }
}

// ─────────────────────────────────────────────────── in-page test hook

/**
 * A deterministic driver for the automated dry-run. The automation cannot speak
 * into a microphone, so the sensor path is exercised with synthetic samples
 * through exactly the same engine, graph and export code the live path uses.
 */
function installTestHook(): void {
  (window as unknown as Record<string, unknown>).__voxwell = {
    version: 1,
    state: () => ({ ...state, hasClip: !!clip, hasExport: !!lastExport }),
    dominantHz: (samples: Float32Array, rate: number) => dominantFrequency(samples, rate),

    /** Feed a synthetic tone in as if it were a dropped file. */
    async loadTone(frequency = 440, seconds = 1.5, rate = 48000) {
      sourceAudio = { samples: makeTone(frequency, seconds, rate), sampleRate: rate };
      state.sourceKind = 'file';
      state.sourceName = `tone-${frequency}hz.wav`;
      enterStudio();
      await renderFileClip();
      return { inHz: dominantFrequency(sourceAudio.samples, rate) };
    },

    async setParams(patch: Partial<VoiceParams>) {
      state.params = { ...state.params, ...patch };
      syncControls();
      saveSettings();
      if (state.sourceKind === 'file') await renderFileClip();
      else if (live) live.chain.update(state.params, true);
    },

    clip: () =>
      clip
        ? {
            length: clip.samples.length,
            sampleRate: clip.sampleRate,
            seconds: clip.samples.length / clip.sampleRate,
            peak: peakLevel(clip.samples),
            dominantHz: dominantFrequency(clip.samples, clip.sampleRate),
          }
        : null,

    async exportAs(format: OutputFormat) {
      state.format = format;
      el<HTMLSelectElement>('format-select').value = format;
      await exportClip();
      if (!lastExport) return null;
      const bytes = new Uint8Array(await lastExport.blob.arrayBuffer());
      return {
        name: lastExport.name,
        size: bytes.length,
        mime: lastExport.blob.type,
        head: Array.from(bytes.slice(0, 12)),
        expectedMime: mimeForFormat(format),
        expectedExt: extForFormat(format),
      };
    },

    /** Drive the permission-denied path without touching the real device. */
    simulateMicFailure(reason: 'denied' | 'missing' | 'insecure' = 'denied') {
      const err = new MicrophoneError(
        reason,
        reason === 'denied'
          ? 'Microphone access was blocked. You can still drop in an audio file — that path does everything the live one does.'
          : 'No microphone was found. Drop in an audio file instead.',
      );
      showChooserNote(err.message, 'err');
      log.mic(err.message, 'err');
      return { note: el<HTMLElement>('input-note').textContent, dropzoneUsable: !el<HTMLElement>('dropzone').hidden };
    },

    micTracksStopped: () => streamFullyStopped(live?.stream ?? null),
    releaseMic: () => teardownLive('test hook'),
    emit,
  };
}

boot();
