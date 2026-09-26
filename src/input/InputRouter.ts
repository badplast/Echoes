import { bus, type NoteSource, type PadGesture, type RawMidi } from '../core/events';
import { MACROS, MACRO_INFO, type MacroKey, type ParameterStore } from '../core/ParameterStore';
import { ScaleLock } from '../core/scales';
import { load, save } from '../core/storage';
import { MINILAB3, MidiLearn, relativeDelta } from './MidiLearn';

/** Physical key positions (event.code), so any layout (EN, RU, ...) plays the same notes. */
const KEY_TO_SEMITONE: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17, BracketRight: 18,
};

const PAD_GESTURES: PadGesture[] = ['swell', 'shimmer', 'bloom', 'wave'];
/** General MIDI convention: channel 10 is percussion, which is where MiniLab 3 pads live by default. */
const PAD_CHANNEL = 10;

/**
 * The one input system. MIDI, computer keyboard and pointer all become the same normalized
 * events on the bus: scale-locked notes, macro changes, expression. Nothing downstream knows
 * (or cares) which device produced them.
 */
export class InputRouter {
  readonly scale: ScaleLock;
  readonly learn = new MidiLearn();
  octave = load('octave', 4);
  private active = new Map<string, number>(); // note id -> heard note
  private held = new Set<string>(); // physical keys down
  private expr = { bend: 0, mod: 0, pressure: 0 };
  private polyPressure = new Map<number, number>();
  private focusMacro: MacroKey = 'world';
  /** Last value per channel:cc, for endless encoders that send absolute counters. */
  private lastCC = new Map<string, number>();
  private sustainKey = false;
  private sustainPedal = false;
  /** Latching hold (MiniLab main encoder push / Enter): everything rings until released. */
  hold = false;

  constructor(private params: ParameterStore) {
    this.scale = new ScaleLock(load('scale', 'minor-pentatonic'), load('root', 2));
  }

  // ---------------------------------------------------------------- notes

  noteOn(id: string, rawNote: number, velocity: number, source: NoteSource, position?: { x: number; z: number }): void {
    if (this.active.has(id)) this.noteOff(id);
    const note = this.scale.quantize(Math.max(12, Math.min(108, rawNote)));
    this.active.set(id, note);
    bus.emit('note:on', { id, note, rawNote, velocity: Math.max(0.02, Math.min(1, velocity)), source, position });
  }

  noteOff(id: string): void {
    const note = this.active.get(id);
    if (note === undefined) return;
    this.active.delete(id);
    bus.emit('note:off', { id, note });
  }

  releaseAll(): void {
    for (const id of [...this.active.keys()]) this.noteOff(id);
    this.held.clear();
  }

  setScale(id: string): void {
    this.scale.setScale(id);
    save('scale', id);
  }

  setRoot(root: number): void {
    this.scale.root = root;
    save('root', root);
  }

  // ---------------------------------------------------------------- MIDI

  handleMidi(msg: RawMidi): void {
    bus.emit('midi:raw', msg);
    const { channel, data1, data2 } = msg;
    switch (msg.kind) {
      case 'noteon':
        if (channel === PAD_CHANNEL) {
          const index = (((data1 - 36) % 8) + 8) % 8;
          // MiniLab 3 pads report low velocities (a firm hit measured ~35/127): lift them.
          bus.emit('pad', { index, gesture: PAD_GESTURES[index % 4], velocity: Math.min(1, Math.sqrt(data2 / 127) * 1.25) });
        } else {
          // Real playing on MiniLab 3 tops out around 100-105, so ~118 already counts as full.
          this.noteOn(`m${channel}:${data1}`, data1, Math.min(1, Math.pow(data2 / 118, 0.85)), 'midi');
        }
        break;
      case 'noteoff':
        if (channel !== PAD_CHANNEL) this.noteOff(`m${channel}:${data1}`);
        break;
      case 'cc':
        this.handleCC(msg.device, channel, data1, data2);
        break;
      case 'pitchbend': {
        const v = ((data2 << 7) | data1) - 8192;
        this.expr.bend = v / (v < 0 ? 8192 : 8191);
        this.emitExpr();
        break;
      }
      case 'pressure':
        this.expr.pressure = data1 / 127;
        this.emitExpr();
        break;
      case 'polypressure': {
        // Pad pressure (MiniLab 3 pads jump to 127 almost instantly) must not brighten the whole world.
        if (channel === PAD_CHANNEL) break;
        this.polyPressure.set(data1, data2 / 127);
        if (data2 === 0) this.polyPressure.delete(data1);
        this.expr.pressure = Math.max(0, ...this.polyPressure.values());
        this.emitExpr();
        break;
      }
    }
  }

  private handleCC(device: string, channel: number, cc: number, value: number): void {
    const id = `${channel}:${cc}`;
    const prev = this.lastCC.get(id);
    this.lastCC.set(id, value);
    if (this.learn.handleLearn(device, channel, cc, value)) return;
    const hit = this.learn.find(channel, cc);
    if (hit) {
      const { key, mapping } = hit;
      const cur = this.params.target[key];
      let v = cur;
      if (mapping.mode === 'abs') v = value / 127;
      else if (mapping.mode === 'delta') {
        // Counter change; at an end stop the device repeats 0/127, which means "keep going".
        let d = prev === undefined ? 0 : value - prev;
        if (d === 0 && value === 127) d = 2;
        if (d === 0 && value === 0) d = -2;
        v = cur + d / 127;
      } else v = cur + relativeDelta(mapping.mode, value) / 127;
      this.params.set(key, v);
      bus.emit('param:touched', { key, value: this.params.target[key] });
      return;
    }
    // MiniLab 3 main encoder: push = HOLD, turn = master volume (unless the user learned it).
    if (MINILAB3.match(device)) {
      if (cc === MINILAB3.mainPush) {
        if (value >= 64) this.toggleHold();
        return;
      }
      if (cc === MINILAB3.mainTurn) {
        if (value !== 64) bus.emit('master:nudge', { delta: relativeDelta('rel64', value) * 0.025 });
        return;
      }
    }
    if (cc === 64) {
      this.sustainPedal = value >= 64;
      this.emitSustain();
    } else if (cc === 1) {
      this.expr.mod = value / 127;
      this.emitExpr();
    } else if (cc === 123 || cc === 120) {
      this.releaseAll();
    }
  }

  private emitExpr(): void {
    bus.emit('expression', { ...this.expr });
  }

  private emitSustain(): void {
    bus.emit('sustain', { on: this.sustainKey || this.sustainPedal || this.hold });
  }

  toggleHold(): void {
    this.hold = !this.hold;
    this.emitSustain();
    bus.emit('hold', { on: this.hold });
    bus.emit('toast', { text: this.hold ? 'HOLD — everything rings' : 'HOLD released' });
  }

  // ---------------------------------------------------------------- computer keyboard

  /** Returns true when the key was used, so the caller can preventDefault. */
  keyDown(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const code = e.code;
    const semi = KEY_TO_SEMITONE[code];
    if (semi !== undefined) {
      if (!e.repeat && !this.held.has(code)) {
        this.held.add(code);
        const chaos = this.params.value.chaos;
        const base = e.shiftKey ? 0.95 : 0.62;
        const vel = base + (Math.random() - 0.5) * (0.08 + chaos * 0.2);
        this.noteOn(`k:${code}`, 12 * (this.octave + 1) + semi, vel, 'keyboard');
      }
      return true;
    }
    if (e.repeat && code !== 'ArrowUp' && code !== 'ArrowDown') return code === 'Space';
    switch (code) {
      case 'KeyZ':
        this.shiftOctave(-1);
        return true;
      case 'KeyX':
        this.shiftOctave(1);
        return true;
      case 'Space':
        this.sustainKey = true;
        this.emitSustain();
        return true;
      case 'Enter':
        this.toggleHold();
        return true;
      case 'ArrowUp':
      case 'ArrowDown': {
        const step = (e.shiftKey ? 0.01 : 0.04) * (code === 'ArrowUp' ? 1 : -1);
        this.params.set(this.focusMacro, this.params.target[this.focusMacro] + step);
        bus.emit('param:touched', { key: this.focusMacro, value: this.params.target[this.focusMacro] });
        return true;
      }
    }
    if (/^Digit[1-8]$/.test(code)) {
      this.focusMacro = MACROS[Number(code.slice(5)) - 1];
      bus.emit('param:touched', { key: this.focusMacro, value: this.params.target[this.focusMacro] });
      bus.emit('toast', { text: `${MACRO_INFO[this.focusMacro].label.toUpperCase()} — ↑ ↓ to shape` });
      return true;
    }
    return false;
  }

  keyUp(e: KeyboardEvent): void {
    const code = e.code;
    if (code === 'Space') {
      this.sustainKey = false;
      this.emitSustain();
      return;
    }
    if (this.held.delete(code)) this.noteOff(`k:${code}`);
  }

  private shiftOctave(d: number): void {
    this.octave = Math.max(1, Math.min(7, this.octave + d));
    save('octave', this.octave);
    bus.emit('toast', { text: `OCTAVE ${this.octave}` });
  }

  // ---------------------------------------------------------------- pointer

  private pointerId = 0;
  private pointerNote = -1;

  /** xNorm 0..1 across the screen picks pitch over three octaves; yNorm picks velocity. */
  pointerDown(xNorm: number, yNorm: number, position?: { x: number; z: number }): void {
    this.pointerNote = -1;
    this.pointerMove(xNorm, yNorm, position);
  }

  pointerMove(xNorm: number, yNorm: number, position?: { x: number; z: number }): void {
    const raw = 12 * this.octave + Math.round(xNorm * 36);
    const q = this.scale.quantize(raw);
    if (q === this.pointerNote) return;
    this.pointerUp();
    this.pointerNote = q;
    this.noteOn(`p:${++this.pointerId}`, raw, 0.3 + yNorm * 0.6, 'pointer', position);
  }

  pointerUp(): void {
    if (this.pointerId) this.noteOff(`p:${this.pointerId}`);
  }
}
