import { EventBus } from './EventBus';

export type NoteSource = 'midi' | 'keyboard' | 'pointer' | 'generative' | 'pad';

/** A normalized musical event. Everything downstream (audio + world) speaks only this. */
export interface NoteOn {
  id: string;
  /** Scale-locked MIDI note that is actually heard. */
  note: number;
  /** What the player pressed before scale locking. */
  rawNote: number;
  /** 0..1 */
  velocity: number;
  source: NoteSource;
  /** Optional world-space hint (pointer clicks land exactly where you clicked). */
  position?: { x: number; z: number };
}

export interface NoteOff {
  id: string;
  note: number;
}

export type PadGesture = 'swell' | 'shimmer' | 'bloom' | 'gust';

export interface RawMidi {
  device: string;
  channel: number; // 1..16
  kind: 'noteon' | 'noteoff' | 'cc' | 'pitchbend' | 'pressure' | 'polypressure' | 'program' | 'other';
  data1: number;
  data2: number;
  bytes: number[];
}

export type MidiStatus = 'unsupported' | 'idle' | 'pending' | 'ready' | 'denied';

export interface AppEvents extends Record<string, unknown> {
  'note:on': NoteOn;
  'note:off': NoteOff;
  pad: { index: number; gesture: PadGesture; velocity: number };
  /** A tiny weather grain: a water drop you hear and see. */
  drip: { note: number; velocity: number };
  /** bend -1..1, mod 0..1, pressure 0..1 */
  expression: { bend: number; mod: number; pressure: number };
  sustain: { on: boolean };
  'midi:raw': RawMidi;
  'midi:devices': { inputs: string[]; active: string; status: MidiStatus };
  /** A macro was moved by hardware/keyboard (for the transient on-screen readout). */
  'param:touched': { key: string; value: number };
  'learn:changed': { key: string | null };
  toast: { text: string };
}

export const bus = new EventBus<AppEvents>();
