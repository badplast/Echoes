import { bus, type MidiStatus, type RawMidi } from '../core/events';
import { load, save } from '../core/storage';

export const ALL_INPUTS = '__all__';

/**
 * Control-surface ports (Mackie/HUI, Arturia ALV) carry DAW-mode traffic such as transport buttons
 * sent as notes. "All inputs" skips them; they can still be picked explicitly.
 */
const isAuxPort = (name: string) => /\b(MCU|HUI|ALV|DAW)\b/i.test(name);

/**
 * Web MIDI access, device list, hot-plug and selection. It only parses bytes into RawMidi;
 * musical meaning is decided by InputRouter.
 */
export class MidiManager {
  status: MidiStatus = typeof navigator.requestMIDIAccess === 'function' ? 'idle' : 'unsupported';
  private access: MIDIAccess | null = null;
  private attached = new Map<MIDIInput, (e: MIDIMessageEvent) => void>();
  /** Device name (ids are not stable across sessions) or ALL_INPUTS. */
  preferred: string = load('midiDevice', ALL_INPUTS);

  constructor(private onMessage: (msg: RawMidi) => void) {}

  async request(): Promise<boolean> {
    if (this.status === 'unsupported') {
      this.announce();
      return false;
    }
    if (this.access) return true;
    this.status = 'pending';
    this.announce();
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.status = 'ready';
      this.access.addEventListener('statechange', this.onStateChange);
      this.reattach();
      return true;
    } catch (err) {
      console.info('[ECHOES] MIDI access not granted:', err);
      this.status = 'denied';
      this.announce();
      return false;
    }
  }

  inputNames(): string[] {
    if (!this.access) return [];
    const names: string[] = [];
    this.access.inputs.forEach((input) => {
      if (input.state === 'connected') names.push(input.name ?? 'MIDI Input');
    });
    return names;
  }

  select(name: string): void {
    this.preferred = name;
    save('midiDevice', name);
    this.reattach();
  }

  /** Name shown in the HUD: the one device we listen to, or a summary. */
  activeLabel(): string {
    const names = this.inputNames();
    if (this.status !== 'ready') return '';
    if (names.length === 0) return 'no MIDI device';
    if (this.preferred !== ALL_INPUTS && names.includes(this.preferred)) return this.preferred;
    // Name the playable port, not the control-surface / thru ports that come with it.
    const musical = names.filter((n) => !isAuxPort(n) && !/\bTHRU\b/i.test(n));
    if (musical.length === 1) return musical[0];
    return names.length === 1 ? names[0] : `${musical.length || names.length} MIDI inputs`;
  }

  dispose(): void {
    for (const [input, fn] of this.attached) input.removeEventListener('midimessage', fn as EventListener);
    this.attached.clear();
    this.access?.removeEventListener('statechange', this.onStateChange);
  }

  private onStateChange = () => this.reattach();

  private reattach(): void {
    if (!this.access) return;
    const names = this.inputNames();
    // If the preferred device is unplugged, fall back to all inputs until it returns.
    const listenAll = this.preferred === ALL_INPUTS || !names.includes(this.preferred);
    const wanted = new Set<MIDIInput>();
    this.access.inputs.forEach((input) => {
      if (input.state !== 'connected') return;
      const name = input.name ?? '';
      if (listenAll ? !isAuxPort(name) : name === this.preferred) wanted.add(input);
    });
    for (const [input, fn] of this.attached) {
      if (!wanted.has(input)) {
        input.removeEventListener('midimessage', fn as EventListener);
        this.attached.delete(input);
      }
    }
    for (const input of wanted) {
      if (this.attached.has(input)) continue;
      const fn = (e: MIDIMessageEvent) => this.parse(input.name ?? 'MIDI', e.data);
      input.addEventListener('midimessage', fn as EventListener);
      this.attached.set(input, fn);
    }
    this.announce();
  }

  private announce(): void {
    bus.emit('midi:devices', { inputs: this.inputNames(), active: this.activeLabel(), status: this.status });
  }

  private parse(device: string, data: Uint8Array | null): void {
    if (!data || data.length === 0) return;
    const status = data[0];
    if (status >= 0xf0) return; // clock, active sensing, sysex: not musical input here
    const type = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;
    let kind: RawMidi['kind'] = 'other';
    switch (type) {
      case 0x90:
        kind = d2 > 0 ? 'noteon' : 'noteoff';
        break;
      case 0x80:
        kind = 'noteoff';
        break;
      case 0xb0:
        kind = 'cc';
        break;
      case 0xe0:
        kind = 'pitchbend';
        break;
      case 0xd0:
        kind = 'pressure';
        break;
      case 0xa0:
        kind = 'polypressure';
        break;
      case 0xc0:
        kind = 'program';
        break;
    }
    this.onMessage({ device, channel, kind, data1: d1, data2: d2, bytes: Array.from(data) });
  }
}
