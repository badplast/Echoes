import { bus, type RawMidi } from '../core/events';
import { FADERS, MACROS, MACRO_INFO, type ParamKey, type ParameterStore } from '../core/ParameterStore';
import { NOTE_NAMES, SCALES, noteName } from '../core/scales';
import { load, save } from '../core/storage';
import type { AudioEngine } from '../audio/AudioEngine';
import type { InputRouter } from '../input/InputRouter';
import { ALL_INPUTS, type MidiManager } from '../input/MidiManager';
import { paletteName } from '../worlds/tide/palettes';
import { h } from './dom';

export interface UIHost {
  params: ParameterStore;
  router: InputRouter;
  midi: MidiManager;
  audio: AudioEngine;
  enter(withMidi: boolean): Promise<void>;
  connectMidi(): Promise<void>;
  toggleFullscreen(): void;
  worldTitle: string;
}

const IDLE_MS = 3200;

/**
 * Art-installation UI: an intro card, a nearly invisible HUD, a compact control panel and a
 * developer MIDI monitor. Everything reads/writes the same ParameterStore and InputRouter.
 */
export class UI {
  private root = h('div.ui');
  private intro!: HTMLElement;
  private hud!: HTMLElement;
  private panel!: HTMLElement;
  private debug!: HTMLElement;
  private toastEl = h('div.toast');
  private readout = h('div.readout');
  private audioNotice = h('button.audio-notice', { type: 'button' });
  private statusEl = h('span.status');
  private holdEl = h('span.hold', {}, 'hold');
  private volInput: HTMLInputElement | null = null;
  private hintEl = h('div.hint');
  private sliders = new Map<ParamKey, { input: HTMLInputElement; value: HTMLElement; learn: HTMLButtonElement; row: HTMLElement }>();
  private deviceSelect = h('select.select', { 'aria-label': 'MIDI device' });
  private midiNote = h('p.panel-note');
  private connectBtn!: HTMLButtonElement;
  private debugLast = h('div.debug-last');
  private debugLog = h('ol.debug-log');
  private debugLines: string[] = [];
  private muteBtn!: HTMLButtonElement;
  private debugBtn!: HTMLButtonElement;
  private entered = false;
  private idleTimer = 0;
  private toastTimer = 0;
  private readoutTimer = 0;
  private debugOn = load('debug', false);
  private panelOpen = false;

  constructor(private host: UIHost) {
    document.body.append(this.root);
    this.buildIntro();
    this.buildHud();
    this.buildPanel();
    this.buildDebug();
    this.root.append(this.toastEl, this.readout, this.audioNotice);
    this.audioNotice.addEventListener('click', () => void this.host.audio.resume().then(() => this.refreshAudio()));

    bus.on('toast', (e) => this.toast(e.text));
    bus.on('hold', (e) => this.holdEl.classList.toggle('on', e.on));
    bus.on('param:touched', (e) => this.showReadout(e.key as ParamKey, e.value));
    bus.on('learn:changed', () => this.refreshLearn());
    bus.on('midi:devices', () => this.refreshDevices());
    bus.on('midi:raw', (m) => this.logMidi(m));
    host.params.onChange((k, v) => this.syncSlider(k, v));

    window.addEventListener('pointermove', () => this.wake(), { passive: true });
    window.addEventListener('pointerdown', () => this.wake(), { passive: true });
    document.addEventListener('fullscreenchange', () => this.wake());
    this.setDebug(this.debugOn);
  }

  // ------------------------------------------------------------------ intro

  private buildIntro(): void {
    const midiBtn = h('button.btn', { type: 'button' }, 'Connect MIDI');
    const keysBtn = h('button.btn.ghost', { type: 'button' }, 'Enter without MIDI');
    const go = async (withMidi: boolean) => {
      midiBtn.disabled = keysBtn.disabled = true;
      await this.host.enter(withMidi);
    };
    midiBtn.addEventListener('click', () => void go(true));
    keysBtn.addEventListener('click', () => void go(false));
    this.intro = h(
      'section.intro',
      {},
      h('h1.title', {}, 'ECHOES'),
      h('p.subtitle', {}, 'an audiovisual world you can play'),
      h('p.world-name', {}, this.host.worldTitle),
      h('div.intro-actions', {}, midiBtn, keysBtn),
      h('p.intro-foot', {}, 'Headphones recommended · sound starts when you enter'),
    );
    this.root.append(this.intro);
  }

  /** Called by the app once audio is running and the world has started to reveal. */
  onEntered(): void {
    this.entered = true;
    this.intro.classList.add('gone');
    window.setTimeout(() => this.intro.remove(), 2200);
    this.root.classList.add('entered');
    this.refreshStatus();
    this.refreshAudio();
    this.host.audio.onStateChange(() => this.refreshAudio());
    this.hintEl.textContent = 'play  A S D F G H J K L   ·   Z X octave   ·   space sustain   ·   1–8 + ↑↓ shape   ·   click the water';
    this.hintEl.classList.add('show');
    window.setTimeout(() => this.hintEl.classList.remove('show'), 9000);
    this.wake();
  }

  // ------------------------------------------------------------------ hud

  private buildHud(): void {
    const fsBtn = h('button.link', { type: 'button', onclick: () => this.host.toggleFullscreen() }, 'Fullscreen');
    const ctlBtn = h('button.link', { type: 'button', onclick: () => this.togglePanel() }, 'Controls');
    this.hud = h(
      'div.hud',
      {},
      h('div.hud-mark', {}, h('span.mark-title', {}, 'ECHOES'), h('span.mark-world', {}, 'TIDE')),
      h('div.hud-status', {}, this.statusEl, this.holdEl),
      h('div.hud-actions', {}, fsBtn, ctlBtn),
      this.hintEl,
    );
    this.root.append(this.hud);
  }

  private refreshStatus(): void {
    const s = this.host.midi.status;
    let text = 'keyboard';
    if (s === 'ready') text = this.host.midi.activeLabel() || 'no MIDI device';
    else if (s === 'denied') text = 'MIDI blocked · keyboard';
    else if (s === 'unsupported') text = 'no Web MIDI in this browser · keyboard';
    else if (s === 'pending') text = 'waiting for MIDI permission…';
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('live', s === 'ready' && this.host.midi.inputNames().length > 0);
  }

  private refreshAudio(): void {
    if (!this.entered) return;
    const st = this.host.audio.state;
    const muted = this.host.audio.muted;
    let msg = '';
    if (st === 'suspended' || st === 'interrupted') msg = 'Sound is paused by the browser — click here to resume';
    else if (st === 'closed') msg = 'Audio stopped — reload the page';
    else if (muted) msg = 'Muted — click to unmute';
    this.audioNotice.textContent = msg;
    this.audioNotice.classList.toggle('show', msg !== '');
    this.audioNotice.onclick = muted && st === 'running' ? () => this.setMuted(false) : null;
    if (this.muteBtn) this.muteBtn.textContent = muted ? 'Unmute' : 'Mute';
  }

  /** The HUD dissolves when the mouse rests; fullscreen hides the cursor too. */
  private wake(): void {
    this.root.classList.remove('idle');
    document.body.classList.remove('hide-cursor');
    clearTimeout(this.idleTimer);
    if (!this.entered) return;
    this.idleTimer = window.setTimeout(() => {
      if (this.panelOpen || this.host.router.learn.armed) return;
      this.root.classList.add('idle');
      if (document.fullscreenElement) document.body.classList.add('hide-cursor');
    }, document.fullscreenElement ? IDLE_MS : IDLE_MS * 1.6);
  }

  // ------------------------------------------------------------------ panel

  private buildPanel(): void {
    const { params, router, audio } = this.host;

    const makeRow = (key: ParamKey, index: string) => {
      const info = MACRO_INFO[key];
      const input = h('input.slider', { type: 'range', min: 0, max: 1, step: 0.001, value: params.target[key], 'aria-label': info.label });
      const value = h('span.macro-value');
      const learn = h('button.learn', { type: 'button', title: 'MIDI Learn: click, then move a knob' });
      input.addEventListener('input', () => params.set(key, Number(input.value)));
      learn.addEventListener('click', () => this.host.router.learn.arm(key));
      learn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.host.router.learn.clear(key);
      });
      const row = h(
        'div.macro',
        {},
        h('div.macro-head', {}, h('span.macro-index', {}, index), h('span.macro-label', {}, info.label), value, learn),
        input,
        h('div.macro-range', {}, h('span', {}, info.lo), h('span', {}, info.hi)),
      );
      this.sliders.set(key, { input, value, learn, row });
      this.syncSlider(key, params.target[key]);
      return row;
    };
    const rows = MACROS.map((key, i) => makeRow(key, String(i + 1)));
    const faderRows = FADERS.map((key, i) => makeRow(key, `F${i + 1}`));

    const scaleSel = h('select.select', { 'aria-label': 'Scale' }, ...SCALES.map((s) => h('option', { value: s.id }, s.label)));
    scaleSel.value = router.scale.scale.id;
    scaleSel.addEventListener('change', () => router.setScale(scaleSel.value));
    const rootSel = h('select.select', { 'aria-label': 'Root note' }, ...NOTE_NAMES.map((n, i) => h('option', { value: i }, n)));
    rootSel.value = String(router.scale.root);
    rootSel.addEventListener('change', () => {
      router.setRoot(Number(rootSel.value));
      audio.setRoot(Number(rootSel.value));
    });

    const vol = h('input.slider', { type: 'range', min: 0, max: 1, step: 0.01, value: audio.volume, 'aria-label': 'Master volume' });
    vol.addEventListener('input', () => audio.setVolume(Number(vol.value)));
    this.volInput = vol;
    this.muteBtn = h('button.chip', { type: 'button', onclick: () => this.setMuted(!this.host.audio.muted) }, audio.muted ? 'Unmute' : 'Mute');
    this.debugBtn = h('button.chip', { type: 'button', onclick: () => this.setDebug(!this.debugOn) }, 'MIDI monitor');
    this.connectBtn = h('button.chip', { type: 'button', onclick: () => void this.host.connectMidi() }, 'Connect MIDI');
    this.deviceSelect.addEventListener('change', () => this.host.midi.select(this.deviceSelect.value));

    this.panel = h(
      'aside.panel',
      { 'aria-label': 'Controls' },
      h('header.panel-head', {}, h('span', {}, 'Controls'), h('button.close', { type: 'button', 'aria-label': 'Close', onclick: () => this.togglePanel(false) }, '×')),
      h('section.panel-sec', {}, h('h3', {}, 'Input'), h('div.row', {}, this.deviceSelect, this.connectBtn), this.midiNote),
      h('section.panel-sec.macros', {}, h('h3', {}, 'World'), ...rows),
      h('section.panel-sec.macros', {}, h('h3', {}, 'Mix'), ...faderRows),
      h(
        'section.panel-sec',
        {},
        h('h3', {}, 'Harmony'),
        h('div.row', {}, h('label.field', {}, h('span', {}, 'Scale'), scaleSel), h('label.field.narrow', {}, h('span', {}, 'Root'), rootSel)),
      ),
      h('section.panel-sec', {}, h('h3', {}, 'Output'), h('label.field.wide', {}, h('span', {}, 'Volume'), vol), h('div.row', {}, this.muteBtn)),
      h(
        'section.panel-sec',
        {},
        h('h3', {}, 'System'),
        h(
          'div.row.wrap',
          {},
          h('button.chip', { type: 'button', onclick: () => this.host.toggleFullscreen() }, 'Fullscreen'),
          this.debugBtn,
          h('button.chip', { type: 'button', onclick: () => { this.host.router.learn.clearAll(); this.toast('MIDI mappings cleared'); } }, 'Clear mappings'),
          h('button.chip', { type: 'button', onclick: () => this.host.params.reset() }, 'Reset world'),
        ),
        h('p.panel-note', {}, 'Learn: press LEARN, then move a knob or fader. Right-click LEARN to unmap. Enter (or the MiniLab main encoder push) toggles HOLD. Tab toggles this panel, ` the MIDI monitor.'),
      ),
    );
    this.root.append(this.panel);
    this.refreshDevices();
    this.refreshLearn();
  }

  togglePanel(force?: boolean): void {
    this.panelOpen = force ?? !this.panelOpen;
    this.panel.classList.toggle('open', this.panelOpen);
    if (!this.panelOpen && this.host.router.learn.armed) this.host.router.learn.arm(null);
    this.wake();
  }

  private setMuted(m: boolean): void {
    this.host.audio.setMuted(m);
    this.refreshAudio();
  }

  private syncSlider(key: ParamKey, v: number): void {
    const s = this.sliders.get(key);
    if (!s) return;
    if (document.activeElement !== s.input) s.input.value = String(v);
    s.value.textContent = key === 'color' ? paletteName(v) : v.toFixed(2);
    s.input.style.setProperty('--fill', `${v * 100}%`);
  }

  private refreshLearn(): void {
    const learn = this.host.router.learn;
    for (const [key, s] of this.sliders) {
      const armed = learn.armed === key;
      const label = learn.label(key);
      const m = learn.mappings[key];
      s.learn.textContent = armed ? 'move a knob…' : label || 'learn';
      s.learn.classList.toggle('armed', armed);
      s.learn.classList.toggle('mapped', !!label && !armed);
      s.learn.title = m?.suggested ? 'Suggested MiniLab 3 mapping — click to re-learn, right-click to unmap' : 'MIDI Learn: click, then move a knob';
      s.row.classList.toggle('armed', armed);
    }
    if (learn.armed) this.wake();
  }

  private refreshDevices(): void {
    const midi = this.host.midi;
    const names = midi.inputNames();
    this.deviceSelect.replaceChildren(h('option', { value: ALL_INPUTS }, names.length ? 'All MIDI inputs' : 'No MIDI device'), ...names.map((n) => h('option', { value: n }, n)));
    this.deviceSelect.value = names.includes(midi.preferred) ? midi.preferred : ALL_INPUTS;
    this.deviceSelect.disabled = midi.status !== 'ready';
    this.connectBtn.style.display = midi.status === 'ready' ? 'none' : '';
    const notes: Record<string, string> = {
      unsupported: 'This browser has no Web MIDI. Use Chrome or Edge — the computer keyboard works everywhere.',
      denied: 'MIDI permission was refused. Allow MIDI for this site in the address bar, then Connect again.',
      idle: 'Not connected. The computer keyboard is always active.',
      pending: 'Waiting for the browser permission prompt…',
      ready: names.length ? 'Listening. Open the MIDI monitor to see what each control sends.' : 'MIDI is on, but no device is plugged in. Plug it in — it will appear here.',
    };
    this.midiNote.textContent = notes[midi.status];
    this.refreshStatus();
  }

  // ------------------------------------------------------------------ debug

  private buildDebug(): void {
    this.debug = h(
      'div.debug',
      {},
      h('div.debug-head', {}, h('span', {}, 'MIDI monitor'), h('button.close', { type: 'button', 'aria-label': 'Close', onclick: () => this.setDebug(false) }, '×')),
      this.debugLast,
      this.debugLog,
    );
    this.debugLast.textContent = 'Touch any key, pad or knob.';
    this.root.append(this.debug);
  }

  setDebug(on: boolean): void {
    this.debugOn = on;
    save('debug', on);
    this.debug.classList.toggle('open', on);
    this.debugBtn?.classList.toggle('on', on);
  }

  toggleDebug(): void {
    this.setDebug(!this.debugOn);
  }

  private logMidi(m: RawMidi): void {
    if (!this.debugOn) return;
    let title = '';
    let lines: string[] = [];
    switch (m.kind) {
      case 'noteon':
      case 'noteoff': {
        title = m.kind === 'noteon' ? 'Note On' : 'Note Off';
        const q = this.host.router.scale.quantize(m.data1);
        lines = [`Note: ${m.data1} (${noteName(m.data1)})${m.channel === 10 ? '  · pad' : `  → ${noteName(q)}`}`, `Velocity: ${m.data2}`];
        break;
      }
      case 'cc': {
        title = `CC ${m.data1}`;
        const hit = this.host.router.learn.find(m.channel, m.data1);
        lines = [`Value: ${m.data2}`, hit ? `→ ${MACRO_INFO[hit.key].label}` : m.data1 === 64 ? '→ sustain' : m.data1 === 1 ? '→ mod / vibrato' : 'unmapped'];
        break;
      }
      case 'pitchbend':
        title = 'Pitch Bend';
        lines = [`Value: ${((m.data2 << 7) | m.data1) - 8192}`];
        break;
      case 'pressure':
        title = 'Aftertouch (channel)';
        lines = [`Value: ${m.data1}`];
        break;
      case 'polypressure':
        title = 'Aftertouch (poly)';
        lines = [`Note: ${m.data1}`, `Value: ${m.data2}`];
        break;
      case 'program':
        title = 'Program Change';
        lines = [`Program: ${m.data1}`];
        break;
      default:
        title = 'Other';
        lines = [m.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')];
    }
    this.debugLast.replaceChildren(
      h('div.dl-device', {}, m.device),
      h('div.dl-channel', {}, `Channel: ${m.channel}`),
      h('div.dl-title', {}, title),
      ...lines.map((l) => h('div.dl-line', {}, l)),
    );
    this.debugLines.unshift(`ch${String(m.channel).padStart(2, ' ')}  ${title.padEnd(12, ' ')} ${m.data1.toString().padStart(3, ' ')} ${m.data2.toString().padStart(3, ' ')}`);
    if (this.debugLines.length > 14) this.debugLines.length = 14;
    this.debugLog.replaceChildren(...this.debugLines.map((l) => h('li', {}, l)));
  }

  // ------------------------------------------------------------------ transient feedback

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }

  private showReadout(key: ParamKey, v: number): void {
    if (this.panelOpen) return;
    const info = MACRO_INFO[key];
    const val = key === 'color' ? paletteName(v) : v.toFixed(2);
    this.readout.replaceChildren(
      h('span.ro-label', {}, info.label),
      h('span.ro-bar', { style: `--fill:${v * 100}%` }),
      h('span.ro-value', {}, val),
    );
    this.readout.classList.add('show');
    clearTimeout(this.readoutTimer);
    this.readoutTimer = window.setTimeout(() => this.readout.classList.remove('show'), 1400);
  }

  /** Keep the volume slider in step with hardware changes (MiniLab main encoder). */
  syncVolume(v: number): void {
    if (this.volInput && document.activeElement !== this.volInput) this.volInput.value = String(v);
  }

  isPanelOpen(): boolean {
    return this.panelOpen;
  }
}
