import { bus } from '../core/events';
import { MACROS, type MacroKey } from '../core/ParameterStore';
import { load, save } from '../core/storage';

/**
 * abs:   0..127 pot or fader — the physical position is the value.
 * delta: endless encoder that transmits an absolute 0..127 counter (MiniLab 3). Only the change
 *        is used, and a repeated 0/127 at the end stop keeps moving, so nothing ever jumps.
 * rel64: relative encoder, 64 = no move (63/65).
 * rel2c: relative encoder, two's complement (1 / 127).
 */
export type CCMode = 'abs' | 'delta' | 'rel64' | 'rel2c';

export interface CCMapping {
  /** 1..16, or 0 = any channel */
  channel: number;
  cc: number;
  mode: CCMode;
  /** Mapping came from the built-in device profile rather than the user. */
  suggested?: boolean;
}

export type MappingTable = Partial<Record<MacroKey, CCMapping>>;

/**
 * Arturia MiniLab 3, measured on a real unit (factory "User" preset, see docs/MINILAB3.md).
 * Encoders 1-8 send absolute CC counters on channel 1 with built-in acceleration (step 1 -> 2)
 * and repeat 0/127 at the end stops.
 */
export const MINILAB3 = {
  match: (name: string) => /mini\s*lab\s*3|minilab3/i.test(name),
  encoders: [74, 71, 76, 77, 93, 18, 19, 16],
  /** Second encoder layer seen on the same unit (not mapped by default). */
  altEncoders: [86, 87, 89],
};

const MINILAB3_DEFAULT: [MacroKey, number][] = MACROS.map((k, i) => [k, MINILAB3.encoders[i]]);

const isMiniLabEncoder = (device: string, cc: number) =>
  MINILAB3.match(device) && (MINILAB3.encoders.includes(cc) || MINILAB3.altEncoders.includes(cc));

/**
 * MIDI Learn: arm a macro, move a control, done. The first CC that arrives is bound immediately;
 * the next ~1.2 s of values from that control are then inspected to detect the encoder type.
 */
export class MidiLearn {
  mappings: MappingTable = load<MappingTable>('midiMappings', {});
  armed: MacroKey | null = null;
  private probe: { key: MacroKey; channel: number; cc: number; values: number[]; timer: number } | null = null;

  hasUserMappings(): boolean {
    return MACROS.some((k) => this.mappings[k] && !this.mappings[k]!.suggested);
  }

  /** Installs (or refreshes) the MiniLab 3 profile unless the user has learned their own layout. */
  applyDeviceSuggestion(deviceNames: string[]): boolean {
    if (this.hasUserMappings()) return false;
    if (!deviceNames.some(MINILAB3.match)) return false;
    const upToDate = MINILAB3_DEFAULT.every(([k, cc]) => {
      const m = this.mappings[k];
      return m && m.cc === cc && m.mode === 'delta';
    });
    if (upToDate) return false;
    for (const [key, cc] of MINILAB3_DEFAULT) this.mappings[key] = { channel: 0, cc, mode: 'delta', suggested: true };
    this.persist();
    return true;
  }

  arm(key: MacroKey | null): void {
    this.armed = this.armed === key ? null : key;
    bus.emit('learn:changed', { key: this.armed });
  }

  clear(key: MacroKey): void {
    delete this.mappings[key];
    this.persist();
    bus.emit('learn:changed', { key: this.armed });
  }

  clearAll(): void {
    this.mappings = {};
    this.persist();
    bus.emit('learn:changed', { key: this.armed });
  }

  /** Returns true if the CC was consumed by the learn process. */
  handleLearn(device: string, channel: number, cc: number, value: number): boolean {
    if (this.probe && this.probe.channel === channel && this.probe.cc === cc) {
      this.probe.values.push(value);
      return true;
    }
    if (!this.armed) return false;
    // Never learn the sustain pedal or mod wheel: they have fixed musical roles.
    if (cc === 64 || cc === 1) return false;
    const key = this.armed;
    for (const k of MACROS) {
      const m = this.mappings[k];
      if (m && m.cc === cc && (m.channel === channel || m.channel === 0)) delete this.mappings[k];
    }
    this.mappings[key] = { channel, cc, mode: isMiniLabEncoder(device, cc) ? 'delta' : 'abs' };
    this.armed = null;
    this.persist();
    bus.emit('learn:changed', { key: null });
    bus.emit('toast', { text: `${key.toUpperCase()}  ←  CC ${cc} · ch ${channel}` });
    if (this.probe) clearTimeout(this.probe.timer);
    this.probe = { key, channel, cc, values: [value], timer: window.setTimeout(() => this.finishProbe(), 1200) };
    return true;
  }

  find(channel: number, cc: number): { key: MacroKey; mapping: CCMapping } | null {
    for (const k of MACROS) {
      const m = this.mappings[k];
      if (m && m.cc === cc && (m.channel === channel || m.channel === 0)) return { key: k, mapping: m };
    }
    return null;
  }

  label(key: MacroKey): string {
    const m = this.mappings[key];
    if (!m) return '';
    return `CC${m.cc}${m.mode === 'rel64' || m.mode === 'rel2c' ? ' rel' : ''}`;
  }

  private finishProbe(): void {
    const p = this.probe;
    this.probe = null;
    if (!p) return;
    const m = this.mappings[p.key];
    const mode = detectMode(p.values, m?.mode ?? 'abs');
    if (!m || mode === m.mode) return;
    m.mode = mode;
    this.persist();
    bus.emit('learn:changed', { key: this.armed });
  }

  private persist(): void {
    save('midiMappings', this.mappings);
  }
}

/**
 * Classify a burst of values from one control.
 * - Pots/faders only transmit on change: never a back-to-back repeat.
 * - Endless "absolute counter" encoders repeat only at the end stops (0,0,0 / 127,127,127).
 * - Relative encoders repeat their step value mid-turn (65,65,65 or 1,1,1 / 127,127).
 */
export function detectMode(v: number[], fallback: CCMode): CCMode {
  if (v.length < 4) return fallback;
  // Relative encoders that return to 64 after every tick (MiniLab 3 main encoder: 64,65,64,65…).
  const centred = v.filter((x) => x === 64).length;
  if (v.every((x) => x >= 57 && x <= 71) && centred >= v.length * 0.3 && centred < v.length) return 'rel64';
  const repeated = new Set<number>();
  v.forEach((x, i) => i > 0 && x === v[i - 1] && repeated.add(x));
  if (repeated.size === 0) return fallback;
  if ([...repeated].every((x) => x === 0 || x === 127) && v.some((x) => x > 8 && x < 120)) return 'delta';
  if (v.every((x) => x >= 57 && x <= 71 && x !== 64)) return 'rel64';
  const small = v.some((x) => x >= 1 && x <= 8);
  if (small && v.every((x) => (x >= 1 && x <= 8) || x >= 120)) return 'rel2c';
  // Only the end-stop value repeating: an absolute counter pinned at its limit.
  if ([...repeated].every((x) => x === 0 || x === 127)) return 'delta';
  return fallback;
}

/** Decode a relative encoder value into a signed step count. */
export function relativeDelta(mode: CCMode, value: number): number {
  if (mode === 'rel64') return value - 64;
  return value < 64 ? value : value - 128;
}
