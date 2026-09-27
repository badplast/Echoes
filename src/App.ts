import { Color, WebGLRenderer } from 'three';
import { bus, type WorldId } from './core/events';
import { ParameterStore } from './core/ParameterStore';
import { Generator } from './core/Generator';
import { AudioEngine } from './audio/AudioEngine';
import { InputRouter } from './input/InputRouter';
import { MidiManager } from './input/MidiManager';
import type { World } from './worlds/World';
import { WORLDS, worldEntry } from './worlds/registry';
import { load, save } from './core/storage';
import { UI, type UIHost } from './ui/UI';
import { IntroScene } from './intro/IntroScene';

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
  private world: World | null = null;
  private worldId: WorldId = worldEntry(load<WorldId>('world', 'tide')).id;
  /** 0..1 fade used while one world hands over to the next */
  private worldFade = 1;
  private worldFadeTarget = 1;
  private switching = false;
  /** The cover animation; lives until the first world has faded in. */
  private intro: IntroScene | null = new IntroScene();
  private renderer: WebGLRenderer;
  private ui: UI;
  private entered = false;
  private reveal = 0;
  private clearTmp = new Color();
  private last = performance.now();
  private raf = 0;

  // adaptive resolution
  private pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  private maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  private frameAcc = 0;
  private frameCount = 0;
  private settle = 0;

  get worldTitle(): string {
    return worldEntry(this.worldId).title;
  }

  get currentWorld(): WorldId {
    return this.worldId;
  }

  readonly worlds = WORLDS.map((w) => ({ id: w.id, title: w.title }));

  constructor(private container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.domElement.className = 'stage';
    container.append(this.renderer.domElement);

    this.audio.setRoot(this.router.scale.root);
    this.ui = new UI(this);
    this.resize();
    void this.loadWorld(this.worldId);

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

  /** Fade the current world out, swap, fade the next one in. Audio crossfades with it. */
  async switchWorld(id: WorldId): Promise<void> {
    if (this.switching || (id === this.worldId && this.world)) return;
    this.switching = true;
    this.worldFadeTarget = 0;
    this.audio.setWorld(id);
    this.router.releaseAll();
    await new Promise((r) => setTimeout(r, 900));
    await this.loadWorld(id);
    this.switching = false;
  }

  private async loadWorld(id: WorldId): Promise<void> {
    const entry = worldEntry(id);
    const next = await entry.create();
    this.world?.dispose();
    this.world = next;
    this.worldId = entry.id;
    next.mount(this.renderer);
    this.resize();
    this.router.padGestures = next.pads;
    this.generator.mode = entry.id;
    this.audio.setWorld(entry.id);
    this.ui.setWorld(next);
    save('world', entry.id);
    this.worldFade = 0;
    this.worldFadeTarget = 1;
    bus.emit('world:changed', { id: entry.id });
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
    // a world may still be compiling its shaders: keep the cover up and start revealing when ready
    const worldReady = !!this.world && this.world.ready !== false;
    if (this.entered) {
      if (worldReady) this.reveal = Math.min(1, this.reveal + dt / 3.5);
      this.generator.update(dt, m);
    }
    this.worldFade += (this.worldFadeTarget - this.worldFade) * (1 - Math.exp(-dt / (this.worldFadeTarget > 0.5 ? 0.9 : 0.25)));
    this.audio.update(m, dt);
    // The world is only drawn once you enter; until then the cover has the screen to itself.
    const drawWorld = this.entered && worldReady;
    if (drawWorld) {
      const r = this.reveal * this.reveal * (3 - 2 * this.reveal);
      this.world!.setReveal(r * this.worldFade);
      this.world!.frame(dt, m);
    }
    if (this.intro) {
      if (drawWorld) this.intro.fade = Math.max(0, this.intro.fade - dt / 1.8);
      this.intro.render(this.renderer, dt, !drawWorld);
      if (this.intro.fade <= 0) {
        this.intro.dispose();
        this.intro = null;
      }
    } else if (!drawWorld) {
      // between worlds (the next one still preparing): a clean black frame, never a stale one
      const alpha = this.renderer.getClearAlpha();
      this.renderer.getClearColor(this.clearTmp);
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear();
      this.renderer.setClearColor(this.clearTmp, alpha);
    }
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
    this.world?.resize(w, h, this.pixelRatio);
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
      const hit = this.world?.pick(x * 2 - 1, -(y * 2 - 1));
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
    this.world?.dispose();
    this.renderer.dispose();
  }
}
