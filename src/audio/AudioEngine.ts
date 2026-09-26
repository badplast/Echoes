import type { WorldId } from '../core/events';
import type { Macros } from '../core/ParameterStore';
import { load } from '../core/storage';
import type { ToneEngine } from './ToneEngine';

/**
 * Facade over the Tone.js engine. Tone creates an AudioContext as soon as it is imported, which
 * browsers refuse to start before a user gesture, so the engine module is loaded lazily from
 * the Enter click. Until then this facade just keeps settings.
 */
export class AudioEngine {
  private engine: ToneEngine | null = null;
  private loading: Promise<ToneEngine> | null = null;
  private root = 2;
  private world: WorldId = 'tide';
  volume = load('volume', 0.8);
  muted = load('muted', false);

  /** Call from a user gesture. */
  async start(): Promise<void> {
    if (!this.loading) {
      this.loading = import('./ToneEngine').then(async ({ ToneEngine }) => {
        const e = new ToneEngine();
        e.setRoot(this.root);
        e.setWorld(this.world);
        await e.start();
        e.setVolume(this.volume);
        e.setMuted(this.muted);
        this.engine = e;
        return e;
      });
    }
    await (await this.loading).resume();
  }

  /** Current output level 0..1 (peak of the last block), for diagnostics. */
  level(): number {
    const v = this.engine?.meter.getValue();
    return typeof v === 'number' ? v : Array.isArray(v) ? Math.max(...v) : 0;
  }

  get state(): AudioContextState | 'interrupted' | 'off' {
    return this.engine ? this.engine.state : 'off';
  }

  onStateChange(fn: () => void): void {
    this.engine?.onStateChange(fn);
  }

  async resume(): Promise<void> {
    await this.engine?.resume();
  }

  setVolume(v: number): void {
    this.volume = v;
    this.engine?.setVolume(v);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.engine?.setMuted(m);
  }

  /** Crossfade the sound of the place (and the instrument's character) to another world. */
  setWorld(id: WorldId): void {
    this.world = id;
    this.engine?.setWorld(id);
  }

  setRoot(pc: number): void {
    this.root = pc;
    this.engine?.setRoot(pc);
  }

  update(m: Macros, dt: number): void {
    this.engine?.update(m, dt);
  }

  dispose(): void {
    this.engine?.dispose();
    this.engine = null;
  }
}
