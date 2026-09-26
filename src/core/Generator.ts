import { bus, type NoteSource, type PadGesture } from './events';
import type { Macros } from './ParameterStore';
import type { ScaleLock } from './scales';
import { eventInterval, lerp, rainLevel, smooth } from './derive';

interface Scheduled {
  at: number;
  fn: () => void;
}

/**
 * The world's own small musical life. It listens to what you play and occasionally answers:
 * soft "echoes" of your recent notes (displaced by an octave or a scale step), drips when the
 * weather turns, and the phrases behind the pads. Everything it plays goes through the same bus
 * as your notes, so the world reacts to its echoes exactly like it reacts to you.
 */
export class Generator {
  private memory: number[] = [];
  private queue: Scheduled[] = [];
  private nextEcho = 6;
  private nextDrip = 0;
  private counter = 0;
  private lastUserAt = -99;
  private now = 0;

  constructor(private scale: ScaleLock) {
    bus.on('note:on', (e) => {
      if (e.source === 'generative') return;
      this.memory.push(e.note);
      if (this.memory.length > 12) this.memory.shift();
      this.lastUserAt = this.now;
    });
  }

  update(dt: number, m: Macros): void {
    this.now += dt;
    const now = this.now;

    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].at <= now) {
        const job = this.queue[i];
        this.queue.splice(i, 1);
        job.fn();
      }
    }

    if (now >= this.nextEcho) {
      this.echo(m);
      const spread = lerp(0.35, 1, m.chaos);
      const interval = eventInterval(m) * (1 + (Math.random() * 2 - 1) * spread * 0.7);
      // Leave room right after the player has played; answer, don't interrupt.
      const quiet = now - this.lastUserAt < 1.5 ? 2 : 0;
      this.nextEcho = now + Math.max(0.8, interval) + quiet;
    }

    const dripRate = rainLevel(m) * 8 + smooth(0.15, 0.5, m.weather) * 1.5 + m.texture * m.weather * 2;
    if (dripRate > 0.05 && now >= this.nextDrip) {
      this.drip();
      this.nextDrip = now + (-Math.log(1 - Math.random()) / dripRate);
    } else if (dripRate <= 0.05) {
      this.nextDrip = now + 0.5;
    }
  }

  pad(gesture: PadGesture, index: number, velocity: number): void {
    const root = this.scale.root;
    const lift = index >= 4 ? 12 : 0;
    const v = 0.35 + velocity * 0.55;
    switch (gesture) {
      case 'swell': {
        const base = root + 36 + lift;
        [0, 7, 12, 19].forEach((iv, i) => this.play(this.scale.quantize(base + iv), v * (1 - i * 0.12), 5.5, i * 0.09, 'pad'));
        break;
      }
      case 'shimmer': {
        let n = this.scale.quantize(root + 72 + lift);
        for (let i = 0; i < 7; i++) {
          this.play(n, v * 0.55 * (1 - i * 0.08), 1.6, i * 0.13 + Math.random() * 0.03, 'pad');
          n = this.scale.step(n, Math.random() < 0.8 ? 1 : 2);
        }
        break;
      }
      case 'bloom': {
        let n = this.scale.quantize(root + 48 + lift);
        for (let i = 0; i < 5; i++) {
          this.play(n, v * 0.7, 4.5, i * 0.035, 'pad');
          n = this.scale.step(n, 2);
        }
        break;
      }
      case 'wave': {
        // A big wave rolling in: a deep root with a distant fifth above; audio adds the wash of
        // the wave, TIDE the long swell and the gust of wind that comes with it.
        const deep = this.scale.quantize(root + 24 + lift);
        this.play(deep, v * 0.9, 4.5, 0, 'pad');
        this.play(this.scale.quantize(deep + 7), v * 0.45, 3.5, 0.35, 'pad');
        this.play(this.scale.quantize(deep + 24), v * 0.3, 2.5, 0.9, 'pad');
        break;
      }
    }
  }

  private echo(m: Macros): void {
    const recent = this.memory.length > 0 && Math.random() < 0.85;
    let note: number;
    if (recent) {
      const src = this.memory[Math.floor(Math.random() * Math.min(this.memory.length, 6)) + Math.max(0, this.memory.length - 6)];
      const r = Math.random();
      const chaos = m.chaos;
      if (r < 0.45) note = src + 12;
      else if (r < 0.6 + chaos * 0.1) note = this.scale.step(src, Math.random() < 0.5 ? 1 : -1);
      else if (r < 0.85) note = this.scale.step(src + 12, Math.random() < 0.5 ? 2 : -2);
      else note = src - 12;
    } else {
      const chord = [0, 7, 12, 14, 19];
      note = this.scale.quantize(this.scale.root + 60 + chord[Math.floor(Math.random() * chord.length)]);
    }
    note = Math.max(40, Math.min(96, note));
    const vel = lerp(0.12, 0.34, m.energy) * (0.7 + Math.random() * 0.5);
    this.play(note, vel, lerp(3.5, 1.4, m.energy), 0);
    // At higher energy the world sometimes answers with a short phrase.
    if (Math.random() < m.energy * 0.45) {
      const n2 = this.scale.step(note, Math.random() < 0.5 ? 1 : 2);
      this.play(n2, vel * 0.8, 1.8, lerp(0.9, 0.35, m.motion));
      if (Math.random() < m.energy * 0.5) this.play(this.scale.step(n2, -1), vel * 0.65, 2.2, lerp(1.8, 0.7, m.motion));
    }
  }

  private drip(): void {
    const n = this.scale.quantize(this.scale.root + 84 + Math.floor(Math.random() * 14));
    bus.emit('drip', { note: n, velocity: 0.2 + Math.random() * 0.6 });
  }

  private play(note: number, velocity: number, duration: number, delay: number, source: NoteSource = 'generative'): void {
    const id = `g${++this.counter}`;
    const start = () => {
      bus.emit('note:on', { id, note, rawNote: note, velocity, source });
      this.queue.push({ at: this.now + duration, fn: () => bus.emit('note:off', { id, note }) });
    };
    if (delay <= 0) start();
    else this.queue.push({ at: this.now + delay, fn: start });
  }
}
