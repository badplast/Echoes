import { WebGLRenderer } from 'three';
import { bus } from './core/events';
import { ParameterStore } from './core/ParameterStore';
import { Generator } from './core/Generator';
import { AudioEngine } from './audio/AudioEngine';
import { InputRouter } from './input/InputRouter';
import { MidiManager } from './input/MidiManager';
import type { World } from './worlds/World';
import { TideWorld } from './worlds/tide/TideWorld';
import { UI, type UIHost } from './ui/UI';

/**
 * Wires the shared services together:
 *   Input (MIDI / keys / pointer) -> InputRouter -> bus -> AudioEngine + World
 *   Knobs / sliders -> ParameterStore -> AudioEngine + World
 */
export class App implements UIHost {
  readonly params = new ParameterStore();
  readonly router = new InputRouter(this.params);
  readonly midi = new MidiManager((m) => this.router.handleMidi(m));
  readonly audio = new AudioEngine();
  readonly generator = new Generator(this.router.scale);
  private world: World = new TideWorld();
  private renderer: WebGLRenderer;
  private ui: UI;
  private entered = false;
  private reveal = 0;
  private last = performance.now();
  private raf = 0;

  // adaptive resolution
  private pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  private maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  private frameAcc = 0;
  private frameCount = 0;
  private settle = 0;

  get worldTitle(): string {
    return this.world.title;
  }

  constructor(private container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.domElement.className = 'stage';
    container.append(this.renderer.domElement);

    this.world.mount(this.renderer);
    this.audio.setRoot(this.router.scale.root);
    this.ui = new UI(this);
    this.resize();

    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.bindPointer();
    bus.on('pad', (e) => this.generator.pad(e.gesture, e.index, e.velocity));
    bus.on('master:nudge', (e) => {
      const v = Math.round(Math.min(1, Math.max(0, this.audio.volume + e.delta)) * 100) / 100;
      this.audio.setVolume(v);
      this.ui.syncVolume(v);
      bus.emit('toast', { text: `VOLUME  ${Math.round(v * 100)}` });
    });
    bus.on('midi:devices', (e) => {
      if (this.router.learn.applyDeviceSuggestion(e.inputs)) {
        bus.emit('learn:changed', { key: null });
        bus.emit('toast', { text: 'MiniLab 3 found — encoders 1–8 mapped to the world' });
      }
    });

    this.raf = requestAnimationFrame(this.loop);
  }

  async enter(withMidi: boolean): Promise<void> {
    // Audio must start inside the user gesture, before anything is awaited.
    const audioStart = this.audio.start().catch((err) => console.warn('[ECHOES] audio start failed', err));
    if (withMidi) await this.midi.request();
    await audioStart;
    this.entered = true;
    this.ui.onEntered();
  }

  async connectMidi(): Promise<void> {
    await this.midi.request();
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => bus.emit('toast', { text: 'Fullscreen not allowed here' }));
  }

  // ------------------------------------------------------------------ loop

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(0.1, Math.max(0, rawDt));

    this.params.update(dt);
    const m = this.params.value;
    if (this.entered) {
      this.reveal = Math.min(1, this.reveal + dt / 3.5);
      this.generator.update(dt, m);
    } else {
      // behind the intro the world is already alive, just veiled
      this.reveal = Math.min(0.42, this.reveal + dt / 3);
    }
    this.world.setReveal(this.reveal * this.reveal * (3 - 2 * this.reveal));
    this.audio.update(m, dt);
    this.world.frame(dt, m);
    this.adaptResolution(rawDt);
  };

  /** Keeps ~60 fps: lower the render resolution when frames are slow, raise it back when there's headroom. */
  private adaptResolution(rawDt: number): void {
    if (rawDt > 0.25) return; // tab switch / hitch: ignore
    this.frameAcc += rawDt;
    this.frameCount++;
    if (this.frameAcc < 1.5) return;
    const avg = this.frameAcc / this.frameCount;
    this.frameAcc = 0;
    this.frameCount = 0;
    if (this.settle > 0) {
      this.settle--;
      return;
    }
    let next = this.pixelRatio;
    if (avg > 1 / 50) next = Math.max(0.55, this.pixelRatio - 0.12);
    else if (avg < 1 / 58 && this.pixelRatio < this.maxPixelRatio) next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.05);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.settle = 1;
      this.resize();
    }
  }

  private resize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    this.pixelRatio = Math.min(this.pixelRatio, this.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.world.resize(w, h, this.pixelRatio);
  };

  // ------------------------------------------------------------------ input

  private isFormTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && (t as HTMLInputElement).type !== 'range');
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Tab' && this.entered) {
      e.preventDefault();
      this.ui.togglePanel();
      return;
    }
    if (e.code === 'Backquote') {
      this.ui.toggleDebug();
      return;
    }
    if (e.code === 'Escape' && this.ui.isPanelOpen()) {
      this.ui.togglePanel(false);
      return;
    }
    if (!this.entered || this.isFormTarget(e)) return;
    // Range sliders keep their own arrow keys.
    if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight')) return;
    if (this.audio.state === 'suspended') void this.audio.resume();
    if (this.router.keyDown(e)) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.entered) return;
    this.router.keyUp(e);
  };

  private onBlur = () => {
    this.router.releaseAll();
    bus.emit('sustain', { on: false });
  };

  private onVisibility = () => {
    if (document.hidden) this.onBlur();
  };

  private bindPointer(): void {
    const el = this.renderer.domElement;
    let down = false;
    const locate = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const hit = this.world.pick(x * 2 - 1, -(y * 2 - 1));
      return { x, y, hit: hit ?? undefined };
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.entered || e.button !== 0) return;
      if (this.audio.state === 'suspended') void this.audio.resume();
      down = true;
      el.setPointerCapture(e.pointerId);
      const p = locate(e);
      this.router.pointerDown(p.x, p.y, p.hit);
    });
    el.addEventListener('pointermove', (e) => {
      if (!down) return;
      const p = locate(e);
      this.router.pointerMove(p.x, p.y, p.hit);
    });
    const up = () => {
      if (!down) return;
      down = false;
      this.router.pointerUp();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.midi.dispose();
    this.audio.dispose();
    this.world.dispose();
    this.renderer.dispose();
  }
}
