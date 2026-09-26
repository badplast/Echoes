import * as Tone from 'tone';
import { bus, type NoteOn, type PadGesture } from '../core/events';
import type { Macros } from '../core/ParameterStore';
import { echoFeedback, echoTime, lerp, pitchNorm, smooth, warmth } from '../core/derive';
import { load, save } from '../core/storage';

const VOICES = 12;
const mtof = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/** One pad voice: detuned saw stack + soft triangle body -> 24 dB lowpass -> amp -> pan. */
class Voice {
  readonly saw: Tone.FatOscillator;
  readonly body: Tone.Oscillator;
  readonly bodyGain: Tone.Gain;
  readonly filter: Tone.Filter;
  readonly amp: Tone.Gain;
  readonly pan: Tone.Panner;
  id = '';
  note = -1;
  startedAt = -1;
  releasedAt = Infinity;
  /** when the attack reaches its peak; a release never cuts an attack short */
  attackEnd = 0;
  /** true while held (or sustained by the pedal) */
  down = false;
  sustained = false;

  constructor(out: Tone.InputNode, detune: Tone.LFO) {
    this.saw = new Tone.FatOscillator({ type: 'sawtooth', count: 3, spread: 22, frequency: 220 });
    this.body = new Tone.Oscillator({ type: 'triangle', frequency: 110 });
    this.bodyGain = new Tone.Gain(0.5);
    this.filter = new Tone.Filter({ type: 'lowpass', rolloff: -24, Q: 0.6, frequency: 400 });
    this.amp = new Tone.Gain(0);
    this.pan = new Tone.Panner(0);
    const sawGain = new Tone.Gain(0.5);
    this.saw.chain(sawGain, this.filter);
    this.body.chain(this.bodyGain, this.filter);
    this.filter.chain(this.amp, this.pan);
    this.pan.connect(out);
    detune.connect(this.saw.detune);
    detune.connect(this.body.detune);
    this.saw.start();
    this.body.start();
  }
}

/**
 * Generative ambient engine. Three layers share one effect space:
 *   pad voices (the instrument)  +  glass bell (the articulation)  +  drone/weather (the air).
 * It reads the same macros and derived values as the world (see core/derive.ts).
 */
export class ToneEngine {
  ready = false;
  private voices: Voice[] = [];
  private bell!: Tone.PolySynth<Tone.FMSynth>;
  private drips: Tone.Synth[] = [];
  private dripPans: Tone.Panner[] = [];
  private dripIdx = 0;
  private detune!: Tone.LFO;

  private voiceBus!: Tone.Gain;
  private busFilter!: Tone.Filter;
  private chorus!: Tone.Chorus;
  private sat!: Tone.Distortion;
  private delay!: Tone.PingPongDelay;
  private delaySend!: Tone.Gain;
  private revSmall!: Tone.Reverb;
  private revLarge!: Tone.Reverb;
  private revSmallGain!: Tone.Gain;
  private revLargeGain!: Tone.Gain;
  private reverbSend!: Tone.Gain;
  private reverbTone!: Tone.Filter;
  private master!: Tone.Gain;
  private volumeNode!: Tone.Volume;
  /** Output level probe (used by the automated checks, cheap enough to keep). */
  meter!: Tone.Meter;

  private droneA!: Tone.FatOscillator;
  private droneB!: Tone.FatOscillator;
  private droneAir!: Tone.Oscillator;
  private droneAirGain!: Tone.Gain;
  private droneFilter!: Tone.Filter;
  private droneLfo!: Tone.LFO;
  private droneGain!: Tone.Gain;
  private wind!: Tone.AutoFilter;
  private windGain!: Tone.Gain;
  private rainGain!: Tone.Gain;
  private rumbleGain!: Tone.Gain;
  private noises: Tone.Noise[] = [];

  private sustain = false;
  private expr = { bend: 0, mod: 0, pressure: 0 };
  private baseCutoff = 900;
  private droneRoot = -1;
  private lastBell = { h: -1, mi: -1 };
  private lastSatAmount = -1;
  private accum = 0;
  private gust = 0;
  private unsubs: (() => void)[] = [];
  private m: Macros | null = null;

  volume = load('volume', 0.8);
  muted = load('muted', false);

  /** Must be called from a user gesture (click / key). */
  async start(): Promise<void> {
    if (!this.ready) {
      // This module is loaded lazily from the user gesture, so Tone's context is born allowed to run.
      Tone.getContext().lookAhead = 0.02;
      await Tone.start();
      this.build();
      this.ready = true;
    }
    await Tone.start();
  }

  get state(): AudioContextState | 'off' {
    return this.ready ? (Tone.getContext().state as AudioContextState) : 'off';
  }

  onStateChange(fn: () => void): void {
    if (this.ready) Tone.getContext().on('statechange', fn);
  }

  async resume(): Promise<void> {
    if (this.ready) await Tone.start();
  }

  setVolume(v: number): void {
    this.volume = v;
    save('volume', v);
    if (this.ready) this.volumeNode.volume.rampTo(v <= 0.001 ? -80 : 20 * Math.log10(v), 0.1);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    save('muted', m);
    if (this.ready) this.master.gain.rampTo(m ? 0 : 1, 0.25);
  }

  private build(): void {
    // ---- master chain
    this.volumeNode = new Tone.Volume(this.volume <= 0.001 ? -80 : 20 * Math.log10(this.volume)).toDestination();
    const limiter = new Tone.Limiter(-1.5);
    const comp = new Tone.Compressor({ threshold: -20, ratio: 2.2, attack: 0.08, release: 0.6 });
    this.master = new Tone.Gain(0);
    const makeup = new Tone.Gain(1.45);
    this.master.chain(comp, makeup, limiter, this.volumeNode);
    this.meter = new Tone.Meter({ normalRange: true, smoothing: 0 });
    this.volumeNode.connect(this.meter);
    this.master.gain.rampTo(this.muted ? 0 : 1, 2.5);

    // ---- shared space: reverbs + delay
    this.revSmall = new Tone.Reverb({ decay: 2.6, preDelay: 0.01, wet: 1 });
    this.revLarge = new Tone.Reverb({ decay: 11, preDelay: 0.045, wet: 1 });
    this.revSmallGain = new Tone.Gain(0.4);
    this.revLargeGain = new Tone.Gain(0.6);
    this.reverbTone = new Tone.Filter({ type: 'lowpass', frequency: 4000, rolloff: -12 });
    this.reverbSend = new Tone.Gain(0.5);
    this.reverbSend.fan(this.revSmall, this.revLarge);
    this.revSmall.chain(this.revSmallGain, this.reverbTone);
    this.revLarge.chain(this.revLargeGain, this.reverbTone);
    this.reverbTone.connect(this.master);

    this.delay = new Tone.PingPongDelay({ delayTime: 0.6, feedback: 0.35, wet: 1, maxDelay: 2 });
    const delayTone = new Tone.Filter({ type: 'lowpass', frequency: 3200, rolloff: -12 });
    this.delaySend = new Tone.Gain(0.22);
    this.delaySend.chain(this.delay, delayTone);
    delayTone.connect(this.master);
    delayTone.connect(this.reverbSend);

    // ---- instrument bus: tone -> chorus -> gentle saturation -> dry + sends
    this.voiceBus = new Tone.Gain(1);
    this.busFilter = new Tone.Filter({ type: 'lowpass', frequency: 2400, rolloff: -12, Q: 0.4 });
    this.chorus = new Tone.Chorus({ frequency: 0.25, delayTime: 4, depth: 0.5, wet: 0.3, spread: 160 }).start();
    this.sat = new Tone.Distortion({ distortion: 0.08, wet: 0.08, oversample: '2x' });
    const fxOut = new Tone.Gain(1);
    this.voiceBus.chain(this.busFilter, this.chorus, this.sat, fxOut);
    const dry = new Tone.Gain(0.75);
    fxOut.connect(dry);
    dry.connect(this.master);
    fxOut.connect(this.delaySend);
    fxOut.connect(this.reverbSend);

    // Shared pitch LFO = pitch bend + vibrato (mod wheel) for every voice.
    this.detune = new Tone.LFO({ frequency: 4.6, min: 0, max: 0, type: 'sine' }).start();
    for (let i = 0; i < VOICES; i++) this.voices.push(new Voice(this.voiceBus, this.detune));

    this.bell = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3,
      modulationIndex: 2,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.006, decay: 2.8, sustain: 0, release: 3 },
      modulationEnvelope: { attack: 0.004, decay: 0.7, sustain: 0, release: 0.6 },
      volume: -13,
    });
    // Real playing measured 18 key strikes in 3 s (each bell voice lives ~3 s): leave headroom.
    this.bell.maxPolyphony = 32;
    this.bell.connect(this.chorus);

    for (let i = 0; i < 4; i++) {
      const s = new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 0.09, sustain: 0, release: 0.06 },
        volume: -30,
      });
      const p = new Tone.Panner(0);
      s.chain(p, fxOut);
      this.drips.push(s);
      this.dripPans.push(p);
    }

    // ---- drone: the air of the space, root + fifth, breathing lowpass
    this.droneA = new Tone.FatOscillator({ type: 'triangle', count: 3, spread: 18, frequency: 73 }).start();
    this.droneB = new Tone.FatOscillator({ type: 'sine', count: 2, spread: 10, frequency: 110 }).start();
    this.droneAir = new Tone.Oscillator({ type: 'sine', frequency: 293 }).start();
    this.droneAirGain = new Tone.Gain(0);
    const airTrem = new Tone.LFO({ frequency: 0.07, min: 0, max: 1 }).start();
    const airAmp = new Tone.Gain(0);
    airTrem.connect(airAmp.gain);
    this.droneFilter = new Tone.Filter({ type: 'lowpass', frequency: 400, rolloff: -24, Q: 0.8 });
    this.droneLfo = new Tone.LFO({ frequency: 0.04, min: 180, max: 700 }).start();
    this.droneLfo.connect(this.droneFilter.frequency);
    this.droneGain = new Tone.Gain(0);
    const bGain = new Tone.Gain(0.55);
    this.droneA.connect(this.droneFilter);
    this.droneB.chain(bGain, this.droneFilter);
    this.droneAir.chain(airAmp, this.droneAirGain, this.droneGain);
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.master);
    this.droneGain.connect(this.reverbSend);
    this.droneGain.gain.rampTo(0.06, 6);

    // ---- weather: wind, rain hiss, distant rumble
    const pink = new Tone.Noise('pink').start();
    const white = new Tone.Noise('white').start();
    const brown = new Tone.Noise('brown').start();
    this.noises = [pink, white, brown];
    this.wind = new Tone.AutoFilter({
      frequency: 0.06,
      baseFrequency: 260,
      octaves: 3.2,
      filter: { type: 'bandpass', Q: 1.4, rolloff: -12 },
    }).start();
    this.windGain = new Tone.Gain(0);
    pink.chain(this.wind, this.windGain);
    this.windGain.connect(this.master);
    this.windGain.connect(this.reverbSend);

    const rainHp = new Tone.Filter({ type: 'highpass', frequency: 2600, rolloff: -12 });
    const rainLp = new Tone.Filter({ type: 'lowpass', frequency: 8500, rolloff: -12 });
    const rainTrem = new Tone.Tremolo({ frequency: 0.13, depth: 0.5, spread: 120 }).start();
    this.rainGain = new Tone.Gain(0);
    white.chain(rainHp, rainLp, rainTrem, this.rainGain, this.master);

    const rumbleLp = new Tone.Filter({ type: 'lowpass', frequency: 95, rolloff: -24 });
    const rumbleTrem = new Tone.Tremolo({ frequency: 0.045, depth: 0.85 }).start();
    this.rumbleGain = new Tone.Gain(0);
    brown.chain(rumbleLp, rumbleTrem, this.rumbleGain);
    this.rumbleGain.connect(this.master);
    this.rumbleGain.connect(this.reverbSend);

    this.unsubs.push(
      bus.on('note:on', (e) => this.noteOn(e)),
      bus.on('note:off', (e) => this.noteOff(e.id)),
      bus.on('sustain', (e) => this.setSustain(e.on)),
      bus.on('expression', (e) => {
        this.expr = e;
        this.applyDetune();
      }),
      bus.on('drip', (e) => this.drip(e.note, e.velocity)),
      bus.on('pad', (e) => this.pad(e.gesture, e.velocity)),
    );
  }

  // ------------------------------------------------------------------ notes

  private noteOn(e: NoteOn): void {
    if (!this.ready || !this.m) return;
    const m = this.m;
    const t = Tone.immediate() + 0.005;
    const vel = e.velocity;
    const pn = pitchNorm(e.note);

    // Retrigger an identical pitch instead of stacking a second voice on it.
    let v = this.voices.find((x) => x.note === e.note && x.releasedAt !== Infinity);
    if (!v) v = this.voices.find((x) => x.startedAt < 0 || t - x.releasedAt > 12);
    if (!v) v = this.pickSteal();
    // A voice that is still audible on another pitch dips out first, so the pitch change is silent.
    const dip = v.startedAt >= 0 && v.note !== e.note && (v.releasedAt === Infinity || t - v.releasedAt < 12);
    const t0 = dip ? t + 0.04 : t;

    const chaos = m.chaos;
    const freq = mtof(e.note);
    const cents = (Math.random() - 0.5) * chaos * 14;
    const f = freq * Math.pow(2, cents / 1200);
    v.saw.frequency.setValueAtTime(f, t0);
    v.body.frequency.setValueAtTime(f * (e.note > 55 ? 0.5 : 1), t0);
    v.saw.spread = lerp(14, 38, m.texture) + chaos * 10;
    v.bodyGain.gain.setValueAtTime(lerp(0.55, 0.25, pn), t0);
    v.pan.pan.setValueAtTime((pn - 0.5) * 0.5 + (Math.random() - 0.5) * chaos * 0.9, t0);

    // Soft, velocity-shaped envelopes. Attack stays ambient even when played hard.
    const attack = lerp(1.25, 0.28, Math.pow(vel, 0.8)) * lerp(1.25, 0.85, m.energy);
    const pitchComp = pn > 0.62 ? lerp(1, 0.55, (pn - 0.62) / 0.38) : pn < 0.2 ? 0.8 : 1;
    const src = e.source === 'generative' ? 0.8 : 1;
    const peak = 0.62 * Math.pow(vel, 1.3) * pitchComp * src;
    const g = v.amp.gain;
    g.cancelAndHoldAtTime(t);
    if (dip) g.linearRampToValueAtTime(0, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.setTargetAtTime(peak * 0.62, t0 + attack, 1.8);

    const cut = this.baseCutoff * Math.pow(2, (e.note - 60) / 30);
    const fq = v.filter.frequency;
    fq.cancelAndHoldAtTime(t);
    fq.exponentialRampToValueAtTime(Math.max(80, cut * 0.45), t0 + 0.02);
    fq.exponentialRampToValueAtTime(Math.min(12000, cut * lerp(1.3, 4, vel)), t0 + attack * 1.1 + 0.05);
    fq.setTargetAtTime(Math.min(9000, cut * lerp(0.9, 1.7, vel)), t0 + attack * 1.1 + 0.05, 2.2);

    v.id = e.id;
    v.note = e.note;
    v.attackEnd = t0 + attack;
    v.startedAt = t;
    v.releasedAt = Infinity;
    v.down = true;
    v.sustained = false;

    // The bell: the drop-into-water articulation you hear the instant you press.
    const bellNote = e.note < 60 ? e.note + 12 : e.note;
    const bellVel = Math.pow(vel, 1.6) * lerp(0.35, 1, pn) * lerp(0.7, 1.15, m.world) * (e.source === 'generative' ? 0.7 : 1);
    if (bellVel > 0.02 && this.bell.activeVoices < this.bell.maxPolyphony) this.bell.triggerAttackRelease(mtof(bellNote) * Math.pow(2, cents / 2400), 0.05, t, Math.min(1, bellVel));
  }

  private noteOff(id: string): void {
    if (!this.ready) return;
    const v = this.voices.find((x) => x.id === id && x.down);
    if (!v) return;
    v.down = false;
    if (this.sustain) {
      v.sustained = true;
      return;
    }
    this.release(v);
  }

  private release(v: Voice): void {
    const m = this.m;
    const t = Tone.immediate() + 0.005;
    const rel = m ? lerp(3.2, 7.5, m.space) * lerp(1.1, 0.8, m.energy) : 5;
    // A quick tap still blooms: let the attack finish, then fade.
    const from = Math.max(t, v.attackEnd + 0.002);
    v.amp.gain.cancelAndHoldAtTime(from);
    v.amp.gain.setTargetAtTime(0, from, rel / 4.5);
    v.filter.frequency.cancelAndHoldAtTime(from);
    v.filter.frequency.setTargetAtTime(Math.max(80, this.baseCutoff * 0.35), from, rel / 3);
    v.releasedAt = t;
    v.sustained = false;
    v.id = '';
  }

  private pickSteal(): Voice {
    let best = this.voices[0];
    let bestScore = -Infinity;
    const now = Tone.immediate();
    for (const v of this.voices) {
      // Prefer the longest-released voice, then the oldest held one.
      const score = v.releasedAt !== Infinity ? 1000 + (now - v.releasedAt) : now - v.startedAt;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  private setSustain(on: boolean): void {
    this.sustain = on;
    if (!on) for (const v of this.voices) if (v.sustained) this.release(v);
  }

  private applyDetune(): void {
    if (!this.ready) return;
    const bendCents = this.expr.bend * 200;
    const depth = this.expr.mod * 28 + (this.m ? this.m.chaos * 3 : 0);
    this.detune.min = bendCents - depth;
    this.detune.max = bendCents + depth;
  }

  private drip(note: number, velocity: number): void {
    if (!this.ready || !this.m) return;
    const s = this.drips[this.dripIdx++ % this.drips.length];
    const t = Tone.immediate() + 0.005;
    const f = mtof(note);
    const loud = smooth(0.1, 0.9, this.m.weather) * velocity;
    s.volume.setValueAtTime(-38 + loud * 12 + this.m.texture * 3, t);
    s.triggerAttackRelease(f, 0.03, t, 0.7);
    s.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.07);
    this.dripPans[(this.dripIdx - 1) % this.dripPans.length].pan.setValueAtTime((Math.random() - 0.5) * 1.4, t);
  }

  private pad(gesture: PadGesture, velocity: number): void {
    if (!this.ready || gesture !== 'gust') return;
    this.gust = Math.min(1.5, this.gust + 0.6 + velocity * 0.8);
  }

  // ------------------------------------------------------------------ macros

  /** Called every frame; audio parameters are refreshed ~30x per second. */
  update(m: Macros, dt: number): void {
    this.m = m;
    if (!this.ready) return;
    this.gust = Math.max(0, this.gust - dt * 0.35);
    this.accum += dt;
    if (this.accum < 1 / 30) return;
    this.accum = 0;
    const R = 0.12; // ramp time: covers one refresh interval with margin, no zipper noise
    const warm = warmth(m);

    // WORLD + COLOR: brightness of the instrument and the tail of the space.
    this.baseCutoff = lerp(420, 2600, Math.pow(m.world, 0.9)) * lerp(1.2, 0.8, warm);
    const busCut = lerp(1100, 6800, m.world) * lerp(1.15, 0.78, warm) * (1 + this.expr.pressure * 1.6) * lerp(1, 0.75, m.weather);
    this.busFilter.frequency.rampTo(busCut, R);
    this.reverbTone.frequency.rampTo(lerp(1800, 6500, m.world) * lerp(1.1, 0.85, warm), R);

    // TEXTURE: chorus movement and grain.
    this.chorus.depth = lerp(0.25, 0.85, m.texture);
    this.chorus.wet.rampTo(lerp(0.18, 0.55, m.texture), R);
    this.chorus.frequency.rampTo(lerp(0.08, 0.7, m.motion) * (1 + m.chaos * 0.4), R);
    const satAmt = lerp(0.05, 0.45, m.texture);
    if (Math.abs(satAmt - this.lastSatAmount) > 0.03) {
      this.sat.distortion = satAmt;
      this.lastSatAmount = satAmt;
    }
    this.sat.wet.rampTo(Math.pow(m.texture, 1.4) * 0.32, R);

    // SPACE: room size, echo.
    this.revSmallGain.gain.rampTo(lerp(0.85, 0.1, m.space), R);
    this.revLargeGain.gain.rampTo(lerp(0.15, 1, m.space), R);
    this.reverbSend.gain.rampTo(lerp(0.28, 0.75, m.space), R);
    this.delay.delayTime.rampTo(echoTime(m), 1.2);
    this.delay.feedback.rampTo(echoFeedback(m), R);
    this.delaySend.gain.rampTo(lerp(0.1, 0.3, m.space) * lerp(0.8, 1.2, m.energy), R);

    // Bell timbre: glassy in cold palettes, rounder in warm ones.
    const h = warm > 0.5 ? 2 : 3;
    const mi = Math.round(lerp(1.4, 4.2, m.texture) * 10) / 10;
    if (h !== this.lastBell.h || Math.abs(mi - this.lastBell.mi) > 0.25) {
      this.bell.set({ harmonicity: h, modulationIndex: mi });
      this.lastBell = { h, mi };
    }

    // Drone follows the root and breathes with MOTION; WORLD changes its character.
    const root = this.rootMidi;
    if (root !== this.droneRoot) {
      const first = this.droneRoot < 0;
      this.droneRoot = root;
      const ramp = first ? 0 : 4;
      const r = mtof(root);
      if (first) {
        this.droneA.frequency.value = r;
        this.droneB.frequency.value = r * 1.4983;
        this.droneAir.frequency.value = r * 4;
      } else {
        this.droneA.frequency.rampTo(r, ramp);
        this.droneB.frequency.rampTo(r * 1.4983, ramp);
        this.droneAir.frequency.rampTo(r * 4, ramp);
      }
    }
    this.droneLfo.frequency.rampTo(lerp(0.015, 0.14, m.motion), R);
    this.droneLfo.min = lerp(110, 260, m.world);
    this.droneLfo.max = lerp(380, 1500, m.world) * lerp(1, 1.6, m.energy);
    this.droneA.spread = lerp(8, 34, m.chaos * 0.5 + m.texture * 0.5);
    this.droneGain.gain.rampTo(lerp(0.075, 0.05, m.world) * lerp(0.8, 1.1, m.space), 1);
    this.droneAirGain.gain.rampTo(smooth(0.35, 1, m.world) * 0.35, 1);

    // WEATHER: wind, rain, rumble. Gusts from pads push the wind for a moment.
    const w = m.weather;
    this.wind.frequency.rampTo(lerp(0.03, 0.3, m.motion * 0.6 + w * 0.4), R);
    this.wind.baseFrequency = lerp(180, 420, w);
    this.windGain.gain.rampTo(0.008 + smooth(0.05, 0.9, w) * 0.1 + this.gust * 0.12, 0.2);
    this.rainGain.gain.rampTo(smooth(0.35, 0.85, w) * 0.028 * lerp(0.7, 1.2, m.texture), R);
    this.rumbleGain.gain.rampTo(smooth(0.6, 1, w) * 0.5, 1);

    this.applyDetune();
  }

  /** Root pitch class drives the drone; 36 + pc keeps it low but audible. */
  private rootMidi = 38;
  setRoot(pc: number): void {
    this.rootMidi = 36 + pc;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (!this.ready) return;
    for (const n of this.noises) n.stop();
    Tone.getContext().dispose();
    this.ready = false;
  }
}
