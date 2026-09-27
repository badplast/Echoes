import * as Tone from 'tone';
import './automationFlushFix';
import { bus, type NoteOn, type PadGesture, type WorldId } from '../core/events';
import type { Macros } from '../core/ParameterStore';
import { echoFeedback, echoTime, fogLevel, lerp, pitchNorm, rainLevel, smooth, warmth } from '../core/derive';
import { load, save } from '../core/storage';

type Ctx = ReturnType<typeof Tone.getContext>['rawContext'];
const VOICES = 12;
const mtof = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/**
 * One pad voice: detuned saw stack + triangle body + sine "air" an octave up
 * -> 24 dB lowpass -> amp -> pan. WORLD sets the balance of the three, so night and day are
 * two different instruments rather than one filter position.
 */
/** The minimal AudioParam surface the voices automate (native and standardized-audio-context params). */
interface Param {
  value: number;
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
  exponentialRampToValueAtTime(v: number, t: number): unknown;
  setTargetAtTime(v: number, t: number, c: number): unknown;
  cancelAndHoldAtTime(t: number): unknown;
}

/**
 * A native param that remembers when (and at what value) its latest scheduled event ends.
 *
 * Web Audio's cancelAndHoldAtTime() only inserts a hold point when something is still changing at
 * that moment (a ramp in progress or a setTarget). When the param is at rest — a voice never played
 * yet, or its last ramp finished long ago — no hold is inserted, and the next linear/exponential
 * ramp starts from the time of that old event: by now it is almost complete, so the param jumps to
 * its target at once. On the voices' gain and filter that jump was the audible click at note-on.
 * Here a param at rest is anchored at its exact resting value first.
 */
class TrackedParam implements Param {
  private end = 0;
  private endValue: number;

  constructor(private readonly p: Param) {
    this.endValue = p.value;
  }
  get value(): number {
    return this.p.value;
  }
  set value(v: number) {
    this.p.value = v;
    this.end = Tone.immediate();
    this.endValue = v;
  }
  setValueAtTime(v: number, t: number): this {
    this.p.setValueAtTime(v, t);
    this.end = t;
    this.endValue = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.p.linearRampToValueAtTime(v, t);
    this.end = t;
    this.endValue = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.p.exponentialRampToValueAtTime(v, t);
    this.end = t;
    this.endValue = v;
    return this;
  }
  setTargetAtTime(v: number, t: number, c: number): this {
    this.p.setTargetAtTime(v, t, c);
    this.end = Infinity; // a setTarget never ends: a later cancelAndHold always gets a hold point
    this.endValue = NaN;
    return this;
  }
  cancelAndHoldAtTime(t: number): this {
    this.p.cancelAndHoldAtTime(t);
    if (this.end <= t) this.p.setValueAtTime(Number.isFinite(this.endValue) ? this.endValue : this.p.value, t);
    else this.endValue = NaN; // held mid-change: the exact value is known only to the audio thread
    this.end = t;
    return this;
  }
}

/** Several params driven as one: the two stages of the voice filter, the three saws of the fat oscillator. */
class ParamGroup implements Param {
  constructor(private readonly ps: Param[]) {}
  get value(): number {
    return this.ps[0].value;
  }
  set value(v: number) {
    for (const p of this.ps) p.value = v;
  }
  setValueAtTime(v: number, t: number): this {
    for (const p of this.ps) p.setValueAtTime(v, t);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    for (const p of this.ps) p.linearRampToValueAtTime(v, t);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    for (const p of this.ps) p.exponentialRampToValueAtTime(v, t);
    return this;
  }
  setTargetAtTime(v: number, t: number, c: number): this {
    for (const p of this.ps) p.setTargetAtTime(v, t, c);
    return this;
  }
  cancelAndHoldAtTime(t: number): this {
    for (const p of this.ps) p.cancelAndHoldAtTime(t);
    return this;
  }
}

/**
 * Move a voice param to a new value over 25 ms. A voice is often re-struck while its previous note
 * still rings (fast repeats of one key): an instant setValueAtTime on pan, Q or a layer level of a
 * sounding voice is a step in the waveform — an audible click.
 */
function glide(p: Param, v: number, t: number): void {
  p.cancelAndHoldAtTime(t);
  p.linearRampToValueAtTime(v, t + 0.025);
}

/** Ramp a param from wherever it is now (the native equivalent of Tone's rampTo). */
function rampParam(p: Param, v: number, time: number): void {
  const t = Tone.immediate();
  p.cancelAndHoldAtTime(t);
  p.linearRampToValueAtTime(v, t + time);
}

/**
 * One pad voice, built from plain Web Audio nodes (about 12 per voice).
 *
 * It used to be Tone objects — FatOscillator, two Oscillators, a −24 dB Filter — which expand to
 * ~80 native nodes per voice (a ConstantSource + Gains for every parameter). Twelve voices made
 * ~960 nodes that the render thread walks every 128 samples, whether a voice sounds or not. With
 * everything else the audio thread used ~65–70 % of its budget, and ordinary system hiccups
 * tipped it over: output underruns, heard as crackle. Same sound, a fraction of the cost.
 */
class Voice {
  private readonly saws: ReturnType<Ctx['createOscillator']>[];
  readonly sawFreq: ParamGroup;
  readonly sawGain: ReturnType<Ctx['createGain']>;
  readonly body: ReturnType<Ctx['createOscillator']>;
  readonly bodyGain: ReturnType<Ctx['createGain']>;
  readonly air: ReturnType<Ctx['createOscillator']>;
  readonly airGain: ReturnType<Ctx['createGain']>;
  readonly filterFreq: ParamGroup;
  readonly filterQ: ParamGroup;
  readonly amp: ReturnType<Ctx['createGain']>;
  readonly pan: ReturnType<Ctx['createStereoPanner']>;
  // every automated param goes through a TrackedParam (see there: ramps from rest must not jump)
  readonly ampGain: TrackedParam;
  readonly sawLevel: TrackedParam;
  readonly bodyLevel: TrackedParam;
  readonly airLevel: TrackedParam;
  readonly panPos: TrackedParam;
  readonly bodyFreq: TrackedParam;
  readonly airFreq: TrackedParam;
  id = '';
  note = -1;
  startedAt = -1;
  releasedAt = Infinity;
  /** when the attack reaches its peak; a release never cuts an attack short */
  attackEnd = 0;
  /** true while held (or sustained by the pedal / hold) */
  down = false;
  sustained = false;
  /** per-voice air level chosen at note-on (WORLD); mod adds to it live */
  airBase = 0;

  constructor(out: Tone.InputNode, detune: Tone.LFO) {
    const c = Tone.getContext().rawContext as Ctx;
    const osc = (type: OscillatorType, f: number) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      return o;
    };
    const gain = (v: number) => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    // the fat saw: three detuned saws, each at -6 - 3·1.1 dB like Tone's FatOscillator(count 3)
    this.saws = [0, 1, 2].map(() => osc('sawtooth', 220));
    const sawMix = gain(Math.pow(10, (-6 - 3 * 1.1) / 20));
    this.sawGain = gain(0.5);
    this.body = osc('triangle', 110);
    this.bodyGain = gain(0.5);
    this.air = osc('sine', 440);
    this.airGain = gain(0);
    // -24 dB lowpass = two 12 dB stages sharing frequency and Q
    const f1 = c.createBiquadFilter();
    const f2 = c.createBiquadFilter();
    for (const f of [f1, f2]) {
      f.type = 'lowpass';
      f.frequency.value = 400;
      f.Q.value = 0.6;
    }
    this.amp = gain(0);
    this.pan = c.createStereoPanner();
    // like Tone.Panner: mono in, equal-power pan (-3 dB at centre) — keeps the old voice level
    this.pan.channelCount = 1;
    this.pan.channelCountMode = 'explicit';
    for (const s of this.saws) s.connect(sawMix);
    sawMix.connect(this.sawGain);
    this.sawGain.connect(f1);
    this.body.connect(this.bodyGain);
    this.bodyGain.connect(f1);
    f1.connect(f2);
    f2.connect(this.amp);
    // the air layer bypasses the lowpass: it is the "daylight" shimmer on top
    this.air.connect(this.airGain);
    this.airGain.connect(this.amp);
    this.amp.connect(this.pan);
    Tone.connect(this.pan, out);
    for (const o of [...this.saws, this.body, this.air]) {
      detune.connect(o.detune as unknown as Tone.InputNode);
      o.start();
    }
    const tr = (p: Param) => new TrackedParam(p);
    this.sawFreq = new ParamGroup(this.saws.map((s) => tr(s.frequency)));
    this.filterFreq = new ParamGroup([tr(f1.frequency), tr(f2.frequency)]);
    this.filterQ = new ParamGroup([tr(f1.Q), tr(f2.Q)]);
    this.ampGain = tr(this.amp.gain);
    this.sawLevel = tr(this.sawGain.gain);
    this.bodyLevel = tr(this.bodyGain.gain);
    this.airLevel = tr(this.airGain.gain);
    this.panPos = tr(this.pan.pan);
    this.bodyFreq = tr(this.body.frequency);
    this.airFreq = tr(this.air.frequency);
    this.spread = 22;
  }

  /** detune spread of the three saws, in cents (as FatOscillator.spread) */
  set spread(cents: number) {
    this.saws.forEach((s, i) => (s.detune.value = -cents / 2 + (cents / 2) * i));
  }
}

interface Env {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}
interface LightPolyOptions {
  /** two-operator FM (Tone.FMSynth) or a plain oscillator (Tone.Synth) */
  fm: boolean;
  harmonicity: number;
  modulationIndex: number;
  envelope: Env;
  modulationEnvelope: Env;
  volume: number;
  maxPolyphony: number;
}

/**
 * Tone's envelope, reproduced on a native AudioParam: linear attack, then Tone's "exponential"
 * approach (time constant ln(t+1)/ln(200), finished by a short linear ramp at 90 %) for the decay
 * and the release. The release may begin before the attack or the decay has finished.
 */
function scheduleEnvelope(p: Param, e: Env, t: number, peak: number, releaseAt: number): number {
  const tc = (x: number) => Math.log(x + 1) / Math.log(200);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + e.attack);
  if (e.decay > 0 && e.sustain < 1) {
    const dv = peak * e.sustain;
    const ds = t + e.attack;
    p.setTargetAtTime(dv, ds, tc(e.decay));
    p.cancelAndHoldAtTime(ds + e.decay * 0.9);
    p.linearRampToValueAtTime(dv, ds + e.decay);
  }
  p.cancelAndHoldAtTime(releaseAt);
  p.setTargetAtTime(0, releaseAt, tc(e.release));
  p.cancelAndHoldAtTime(releaseAt + e.release * 0.9);
  p.linearRampToValueAtTime(0, releaseAt + e.release);
  return releaseAt + e.release;
}

/**
 * A light polyphonic synth with the same sound as Tone.PolySynth(FMSynth / Synth) for our patches.
 * Tone builds 54 native nodes per FM voice (19 per Synth voice) and keeps idle ones alive; the
 * bells, music box and halo held ~900 nodes in FIBA while playing. Here each note is 2–5 plain
 * nodes, created for the note and released to the garbage collector when it has finished.
 */
class LightPoly {
  readonly output: ReturnType<Ctx['createGain']>;
  maxPolyphony: number;
  private o: LightPolyOptions;
  private ends: number[] = [];

  constructor(opts: LightPolyOptions) {
    this.o = { ...opts, envelope: { ...opts.envelope }, modulationEnvelope: { ...opts.modulationEnvelope } };
    this.maxPolyphony = opts.maxPolyphony;
    const c = Tone.getContext().rawContext as Ctx;
    this.output = c.createGain();
    this.output.gain.value = Math.pow(10, opts.volume / 20);
  }

  /** notes still sounding (including their release tails) */
  get activeVoices(): number {
    const now = Tone.immediate();
    this.ends = this.ends.filter((e) => e > now);
    return this.ends.length;
  }

  set(o: { harmonicity?: number; modulationIndex?: number; envelope?: Partial<Env> }): void {
    if (o.harmonicity !== undefined) this.o.harmonicity = o.harmonicity;
    if (o.modulationIndex !== undefined) this.o.modulationIndex = o.modulationIndex;
    if (o.envelope) Object.assign(this.o.envelope, o.envelope);
  }

  connect(dest: Tone.InputNode): this {
    Tone.connect(this.output, dest);
    return this;
  }

  triggerAttackRelease(freq: number, duration: number, time: number, velocity = 1): void {
    if (!Number.isFinite(freq) || freq <= 0) return;
    const c = Tone.getContext().rawContext as Ctx;
    const o = this.o;
    const carrier = c.createOscillator();
    carrier.frequency.value = freq;
    const amp = c.createGain();
    amp.gain.value = 0;
    carrier.connect(amp);
    amp.connect(this.output);
    const rel = time + duration;
    // Tone's ModulationSynth runs both its carrier and its modulator at -10 dB
    const inner = o.fm ? Math.pow(10, -10 / 20) : 1;
    let end = scheduleEnvelope(amp.gain, o.envelope, time, velocity * inner, rel);
    const nodes: { disconnect(): void }[] = [carrier, amp];
    const oscs = [carrier];
    if (o.fm) {
      // Tone.FMSynth: modulator at f·harmonicity, through its own envelope, scaled by
      // f·modulationIndex, added to the carrier frequency
      const mod = c.createOscillator();
      mod.frequency.value = freq * o.harmonicity;
      const modEnv = c.createGain();
      modEnv.gain.value = 0;
      const depth = c.createGain();
      depth.gain.value = freq * o.modulationIndex * inner;
      mod.connect(modEnv);
      modEnv.connect(depth);
      depth.connect(carrier.frequency);
      end = Math.max(end, scheduleEnvelope(modEnv.gain, o.modulationEnvelope, time, 1, rel));
      nodes.push(mod, modEnv, depth);
      oscs.push(mod);
    }
    for (const x of oscs) {
      x.start(time);
      x.stop(end + 0.05);
    }
    carrier.onended = () => {
      for (const n of nodes) n.disconnect();
    };
    this.ends.push(end);
  }
}

/**
 * Generative ambient engine. Layers share one effect space:
 *   pad voices (the instrument) + glass bell (the articulation) + drone (the air)
 *   + atmosphere of the place: wind, rain, surf on the pebble beach, distant rumble.
 * It reads the same parameters and derived values as the world (see core/derive.ts).
 */
export class ToneEngine {
  ready = false;
  private voices: Voice[] = [];
  private bell!: LightPoly;
  private bellVol!: Tone.Volume;
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

  /** Fader 1 (Atmosphere) scales everything in here. */
  private atmosBus!: Tone.Gain;
  private wind!: Tone.AutoFilter;
  private windGain!: Tone.Gain;
  private rainGain!: Tone.Gain;
  private rumbleGain!: Tone.Gain;
  private surfLfo!: Tone.LFO;
  private surfGain!: Tone.Gain;
  private surfFilter!: Tone.Filter;
  private waveFilter!: Tone.Filter;
  private waveGain!: Tone.Gain;
  private noises: Tone.Noise[] = [];

  /** FIBA: the sound of a sleeping room. */
  private fibaBus!: Tone.Gain;
  private roomGain!: Tone.Gain;
  private purrGain!: Tone.Gain;
  private purrLfo!: Tone.LFO;
  private purrFilter!: Tone.Filter;
  private rustle!: Tone.NoiseSynth;
  private rustlePan!: Tone.Panner;
  private swishFilter!: Tone.Filter;
  private swishGain!: Tone.Gain;
  private purrAccent = 0;
  /** FIBA dream layers */
  private musicBox!: LightPoly;
  private musicBoxPan!: Tone.Panner;
  /** FIBA: distant harmonic tails (octave + twelfth), replacing the granular pitch-shift shimmer */
  private halo!: LightPoly;
  private chorusLfos: Tone.LFO[] = [];
  /** last values given to setters that jump instantly (assigned only when they really change) */
  private lastSet: Record<string, number> = {};
  /** output safety shaper (public for diagnostics) */
  safety!: Tone.WaveShaper;
  private haloGain!: Tone.Gain;
  /** smoothed count of sounding voices, for density gain compensation */
  private density = 1;
  private breathGain!: Tone.Gain;
  private lastWorldBell = '';

  private sustain = false;
  private expr = { bend: 0, mod: 0, pressure: 0 };
  /** smoothed mod strip, so expression swells instead of stepping */
  private mod = 0;
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
      // A 20 ms device buffer instead of the default ~10 ms. Every ~30 s this machine's render thread
      // slows down for a moment (~2.5x per quantum for a few hundred ms, measured in a Chrome trace);
      // with the lighter graph that is a deficit of a few ms, which 20 ms absorbs and 10 ms did not.
      // Costs ~10 ms of extra output latency.
      Tone.setContext(new Tone.Context({ latencyHint: 0.02 as unknown as AudioContextLatencyCategory, lookAhead: 0.02 }));
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
    this.volumeNode = new Tone.Volume(this.volume <= 0.001 ? -80 : 20 * Math.log10(this.volume));
    // Last-resort safety: exactly linear below 0.9, then a smooth knee that can never exceed 1.0.
    // Tone.Limiter is a DynamicsCompressor without look-ahead: fast attacks slip past it, and
    // anything over 1.0 is hard-clipped by the browser (that was the crackle). This catches it.
    const safety = (this.safety = new Tone.WaveShaper((x) => {
      const a = Math.abs(x);
      if (a <= 0.9) return x;
      return Math.sign(x) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
    }, 4096));
    safety.oversample = '4x';
    this.volumeNode.chain(safety, Tone.getDestination());
    // A real peak limiter: hard knee, 2 ms attack (plus the node's own look-ahead), 120 ms release.
    // Tone.Limiter is a compressor with a 30 dB soft knee and a 10 ms release: loud chords went
    // through it to ~1.3 FS, and the fast release rippled the gain inside each low cycle — both heard
    // as grit/crackle on dense passages (the safety shaper below then had to bend the peaks).
    const limiter = new Tone.Compressor({ threshold: -2, ratio: 20, knee: 0, attack: 0.002, release: 0.12 });
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
    // Depth is driven through the LFOs' amplitude (a ramped param): with the range set once to the
    // maximum, amplitude a gives exactly delay ± delay·a, the same as depth a. Tone's depth setter
    // moves the range instantly — refreshed 30 times a second (twice, with different values, in
    // FIBA) it cut steps into everything that passes the chorus: that was the audible crackle.
    this.chorus.depth = 1;
    const lfos = this.chorus as unknown as { _lfoL: Tone.LFO; _lfoR: Tone.LFO };
    this.chorusLfos = [lfos._lfoL, lfos._lfoR];
    for (const l of this.chorusLfos) l.amplitude.value = 0.5;
    this.sat = new Tone.Distortion({ distortion: 0.08, wet: 0.08, oversample: '2x' });
    const fxOut = new Tone.Gain(1);
    this.voiceBus.chain(this.busFilter, this.chorus, this.sat, fxOut);
    const dry = new Tone.Gain(0.75);
    fxOut.connect(dry);
    dry.connect(this.master);
    fxOut.connect(this.delaySend);
    fxOut.connect(this.reverbSend);

    // Shared pitch LFO = pitch bend + vibrato (mod strip) for every voice.
    this.detune = new Tone.LFO({ frequency: 4.6, min: 0, max: 0, type: 'sine' }).start();
    for (let i = 0; i < VOICES; i++) this.voices.push(new Voice(this.voiceBus, this.detune));
    if (this.world === 'fiba') for (const v of this.voices) v.body.type = 'sine';

    // Real playing measured 18 key strikes in 3 s (each bell voice lives ~3 s): leave headroom.
    this.bell = new LightPoly({
      fm: true,
      harmonicity: 3,
      modulationIndex: 2,
      envelope: { attack: 0.006, decay: 2.8, sustain: 0, release: 3 },
      modulationEnvelope: { attack: 0.004, decay: 0.7, sustain: 0, release: 0.6 },
      volume: -13,
      maxPolyphony: 32,
    });
    this.bellVol = new Tone.Volume(0);
    this.bell.connect(this.bellVol);
    this.bellVol.connect(this.chorus);

    // ---- atmosphere of the place (fader 1 scales all of it)
    this.atmosBus = new Tone.Gain(1);
    this.atmosBus.connect(this.master);
    const atmosVerb = new Tone.Gain(0.35);
    this.atmosBus.connect(atmosVerb);
    atmosVerb.connect(this.reverbSend);

    for (let i = 0; i < 4; i++) {
      const s = new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 0.09, sustain: 0, release: 0.06 },
        volume: -30,
      });
      const p = new Tone.Panner(0);
      s.chain(p, this.atmosBus);
      // drips still get a touch of the echo, like drops in a harbour
      p.connect(this.delaySend);
      this.drips.push(s);
      this.dripPans.push(p);
    }

    // ---- drone: root + fifth, breathing lowpass (fader 4)
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
    pink.chain(this.wind, this.windGain, this.atmosBus);

    const rainHp = new Tone.Filter({ type: 'highpass', frequency: 2600, rolloff: -12 });
    const rainLp = new Tone.Filter({ type: 'lowpass', frequency: 8500, rolloff: -12 });
    const rainTrem = new Tone.Tremolo({ frequency: 0.13, depth: 0.5, spread: 120 }).start();
    this.rainGain = new Tone.Gain(0);
    white.chain(rainHp, rainLp, rainTrem, this.rainGain, this.atmosBus);

    const rumbleLp = new Tone.Filter({ type: 'lowpass', frequency: 95, rolloff: -24 });
    const rumbleTrem = new Tone.Tremolo({ frequency: 0.045, depth: 0.85 }).start();
    this.rumbleGain = new Tone.Gain(0);
    brown.chain(rumbleLp, rumbleTrem, this.rumbleGain, this.atmosBus);

    // Surf on the pebble beach: slow sets of waves washing in (ENERGY brings them up).
    this.surfFilter = new Tone.Filter({ type: 'bandpass', frequency: 700, Q: 0.6 });
    const surfAmp = new Tone.Gain(0);
    this.surfLfo = new Tone.LFO({ frequency: 0.11, min: 0.05, max: 1, type: 'sine' }).start();
    this.surfLfo.connect(surfAmp.gain);
    this.surfGain = new Tone.Gain(0);
    const surfHiss = new Tone.Filter({ type: 'highpass', frequency: 3500, rolloff: -12 });
    const hissGain = new Tone.Gain(0.25);
    pink.connect(this.surfFilter);
    white.chain(surfHiss, hissGain);
    this.surfFilter.connect(surfAmp);
    hissGain.connect(surfAmp);
    surfAmp.chain(this.surfGain, this.atmosBus);

    // Pad 4 "wave": one big wash that rises and breaks.
    this.waveFilter = new Tone.Filter({ type: 'bandpass', frequency: 250, Q: 0.9 });
    this.waveGain = new Tone.Gain(0);
    pink.chain(this.waveFilter, this.waveGain);
    this.waveGain.connect(this.master);
    this.waveGain.connect(this.reverbSend);

    // ---- FIBA: room tone, a purring texture, grains of fabric, the chair's rustle
    this.fibaBus = new Tone.Gain(0);
    this.fibaBus.connect(this.master);
    const fibaVerb = new Tone.Gain(0.25);
    this.fibaBus.connect(fibaVerb);
    fibaVerb.connect(this.reverbSend);
    const roomLp = new Tone.Filter({ type: 'lowpass', frequency: 650, rolloff: -24 });
    this.roomGain = new Tone.Gain(0.02);
    pink.chain(roomLp, this.roomGain, this.fibaBus);
    // purr: low noise, pulsing ~24 times a second, breathing slowly in and out
    this.purrFilter = new Tone.Filter({ type: 'bandpass', frequency: 95, Q: 1.2 });
    const purrAm = new Tone.Gain(0);
    this.purrLfo = new Tone.LFO({ frequency: 24, min: 0.1, max: 1, type: 'sine' }).start();
    this.purrLfo.connect(purrAm.gain);
    this.purrGain = new Tone.Gain(0);
    const purrLp = new Tone.Filter({ type: 'lowpass', frequency: 260, rolloff: -24 });
    brown.chain(this.purrFilter, purrAm, purrLp, this.purrGain, this.fibaBus);
    // grains: tiny soft ticks of fabric and dust (instead of TIDE's water drops)
    this.rustle = new Tone.NoiseSynth({ noise: { type: 'pink' }, envelope: { attack: 0.004, decay: 0.07, sustain: 0, release: 0.05 }, volume: -34 });
    const rustleBp = new Tone.Filter({ type: 'bandpass', frequency: 2600, Q: 0.8 });
    this.rustlePan = new Tone.Panner(0);
    this.rustle.chain(rustleBp, this.rustlePan, this.fibaBus);
    // the chair's soft rustle when Fiba moves
    this.swishFilter = new Tone.Filter({ type: 'bandpass', frequency: 1200, Q: 0.7 });
    this.swishGain = new Tone.Gain(0);
    pink.chain(this.swishFilter, this.swishGain, this.fibaBus);

    // music box (FIBA fader 1 = LULLABY, pad 2 stardust): tiny glassy plucks, two octaves of shine
    this.musicBox = new LightPoly({
      fm: true,
      harmonicity: 4,
      modulationIndex: 1.1,
      envelope: { attack: 0.002, decay: 1.6, sustain: 0, release: 1.4 },
      modulationEnvelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.3 },
      volume: -5,
      maxPolyphony: 24,
    });
    this.musicBoxPan = new Tone.Panner(0);
    this.musicBox.connect(this.musicBoxPan);
    this.musicBoxPan.connect(this.chorus);
    // halo (FIBA): each note leaves soft sine partials an octave and a twelfth above, slow in,
    // long out, mostly heard through the big hall — clean "distant harmonic tails"
    this.halo = new LightPoly({
      fm: false,
      harmonicity: 1,
      modulationIndex: 0,
      envelope: { attack: 0.9, decay: 1.5, sustain: 0.35, release: 5 },
      modulationEnvelope: { attack: 0, decay: 0, sustain: 0, release: 0 },
      volume: -18,
      maxPolyphony: 12,
    });
    this.haloGain = new Tone.Gain(0);
    const haloLp = new Tone.Filter({ type: 'lowpass', frequency: 5200, rolloff: -12 });
    this.halo.connect(haloLp);
    haloLp.connect(this.haloGain);
    this.haloGain.connect(this.revLarge);
    const haloDry = new Tone.Gain(0.35);
    this.haloGain.connect(haloDry);
    haloDry.connect(this.master);
    // airy breath of the dream (MIST)
    const breathBp = new Tone.Filter({ type: 'bandpass', frequency: 1900, Q: 0.5 });
    const breathTrem = new Tone.Tremolo({ frequency: 0.09, depth: 0.6, spread: 90 }).start();
    this.breathGain = new Tone.Gain(0);
    pink.chain(breathBp, breathTrem, this.breathGain, this.fibaBus);

    this.unsubs.push(
      bus.on('lullaby', (e) => this.lullaby(e.note, e.velocity)),
      bus.on('cat:move', (e) => this.catMove(e.strength)),
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
    // defensive: a malformed event (non-numeric pitch) must never reach the audio params
    if (!Number.isFinite(mtof(e.note)) || !Number.isFinite(e.velocity)) return;
    const m = this.m;
    const t = Tone.immediate() + 0.005;
    const vel = e.velocity;
    const pn = pitchNorm(e.note);
    const w = m.world;
    // FIBA: warmer, softer, closer — the same instrument played quietly in a sleeping room
    const fiba = this.world === 'fiba';

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
    v.sawFreq.setValueAtTime(f, t0);
    v.bodyFreq.setValueAtTime(f * (e.note > 55 ? 0.5 : 1), t0);
    v.airFreq.setValueAtTime(f * 2, t0);

    // WORLD = the character of the instrument.
    //   night: dark, round, narrow — triangle body, little saw, slow bloom
    //   day:   bright, airy, wide  — open saw with a touch of resonance, octave shimmer, quicker
    v.spread = lerp(8, 34, w) + m.texture * 10 + chaos * 8;
    // FIBA: no saw at all — a soft glass-flute: triangle body plus a sine an octave up
    glide(v.sawLevel, fiba ? 0 : lerp(0.2, 0.58, w), t0);
    // FIBA: a soft sine-like tone, about as loud as a TIDE voice (the old 0.95 triangle clipped)
    glide(v.bodyLevel, fiba ? 0.42 : lerp(0.85, 0.22, w) * lerp(1, 0.5, pn), t0);
    v.airBase = fiba ? lerp(0.1, 0.2, m.texture) * lerp(1, 0.6, pn) : smooth(0.35, 1, w) * 0.16 * lerp(1, 0.5, pn);
    v.airLevel.cancelAndHoldAtTime(t0);
    v.airLevel.linearRampToValueAtTime(v.airBase + this.mod * 0.12, t0 + 0.4);
    glide(v.filterQ, fiba ? 0.45 : lerp(0.5, 1.6, w), t0);
    const spread = lerp(0.25, 1.0, w) * (fiba ? 0.6 : 1);
    glide(v.panPos, ((pn - 0.5) * 0.6 + (Math.random() - 0.5) * (0.2 + chaos * 0.7)) * spread, t0);

    // Soft, velocity-shaped envelopes. Attack stays ambient even when played hard.
    const attack = fiba ? lerp(0.9, 0.35, Math.pow(vel, 0.8)) * lerp(1.3, 0.8, m.motion) : lerp(1.25, 0.28, Math.pow(vel, 0.8)) * lerp(1.25, 0.85, m.energy) * lerp(1.35, 0.6, w);
    const pitchComp = pn > 0.62 ? lerp(1, 0.55, (pn - 0.62) / 0.38) : pn < 0.2 ? 0.8 : 1;
    // the world's own echoes belong to the atmosphere (fader 1); pads and played notes do not
    const src = e.source === 'generative' ? 0.8 * Math.min(1.4, m.atmos / 0.7) : e.source === 'pad' ? 0.85 : 1;
    const peak = 0.62 * Math.pow(vel, 1.3) * pitchComp * src;
    const g = v.ampGain;
    g.cancelAndHoldAtTime(t);
    if (dip) g.linearRampToValueAtTime(0, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.setTargetAtTime(peak * lerp(0.72, 0.55, w), t0 + attack, 1.8);

    const cut = this.baseCutoff * Math.pow(2, (e.note - 60) / 30);
    const fq = v.filterFreq;
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
    // Night: a soft, almost sine "kalimba" low in the mix. Day: a clear glass bell.
    const bellNote = e.note < 60 ? e.note + 12 : e.note;
    // FIBA: the dream bell answers every note, clearer as SPARKLE (texture) rises
    // halo: distant harmonic tails for each FIBA note
    if (fiba && e.source !== 'generative' && this.halo.activeVoices < this.halo.maxPolyphony - 2) {
      const hv = Math.min(1, 0.25 + vel * 0.5);
      this.halo.triggerAttackRelease(mtof(e.note + 12), 0.8, t + 0.02, hv);
      if (vel > 0.45) this.halo.triggerAttackRelease(mtof(e.note + 19), 0.6, t + 0.12, hv * 0.55);
    }
    const bellVel = fiba
      ? Math.pow(vel, 1.3) * lerp(0.5, 1, pn) * lerp(0.45, 0.9, m.texture) * (1 + this.mod * 0.4) * (e.source === 'generative' ? 0.7 : 1)
      : Math.pow(vel, 1.6) * lerp(0.35, 1, pn) * lerp(0.45, 1.2, w) * (1 + this.mod * 0.5) * (e.source === 'generative' ? 0.7 : 1);
    if (bellVel > 0.02 && this.bell.activeVoices < (fiba ? 16 : this.bell.maxPolyphony)) this.bell.triggerAttackRelease(mtof(bellNote) * Math.pow(2, cents / 2400), 0.05, t, Math.min(1, bellVel));
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
    const rel = (m ? lerp(3.2, 7.5, m.space) * lerp(1.1, 0.8, m.energy) * lerp(1.25, 0.85, m.world) : 5) * (this.world === 'fiba' ? 1.4 : 1);
    // A quick tap still blooms: let the attack finish, then fade.
    const from = Math.max(t, v.attackEnd + 0.002);
    v.ampGain.cancelAndHoldAtTime(from);
    v.ampGain.setTargetAtTime(0, from, rel / 4.5);
    v.filterFreq.cancelAndHoldAtTime(from);
    v.filterFreq.setTargetAtTime(Math.max(80, this.baseCutoff * 0.35), from, rel / 3);
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
    if (this.world === 'fiba') {
      // a slow drift of pitch, like an old tape: warmth, not wobble
      const wow = 3.5 + this.mod * 6 + (this.m ? this.m.chaos * 3 : 0);
      this.detune.frequency.value = 0.42;
      this.detune.min = bendCents - wow;
      this.detune.max = bendCents + wow;
      return;
    }
    // gentle vibrato: expression, not wobble
    const depth = this.mod * 9 + (this.m ? this.m.chaos * 3 : 0);
    this.detune.frequency.value = 4.6;
    this.detune.min = bendCents - depth;
    this.detune.max = bendCents + depth;
  }

  private lastRustle = 0;
  private dripLast: number[] = [];

  private drip(note: number, velocity: number): void {
    if (!this.ready || !this.m) return;
    if (this.world === 'fiba') {
      // one noise source: two rustles in the same audio block would restart it at the same
      // instant, which Tone rejects with an exception — keep them strictly apart
      const t = Math.max(Tone.immediate() + 0.005, this.lastRustle + 0.012);
      this.lastRustle = t;
      this.rustlePan.pan.setValueAtTime((Math.random() - 0.5) * 1.2, t);
      this.rustle.volume.setValueAtTime(-40 + velocity * 8 + this.m.texture * 4, t);
      this.rustle.triggerAttackRelease(0.03, t, 0.6);
      return;
    }
    const di = this.dripIdx++ % this.drips.length;
    const s = this.drips[di];
    const t = Math.max(Tone.immediate() + 0.005, (this.dripLast[di] ?? 0) + 0.012);
    this.dripLast[di] = t;
    const f = mtof(note);
    const loud = rainLevel(this.m) * velocity;
    s.volume.setValueAtTime(-38 + loud * 12 + this.m.texture * 3, t);
    s.triggerAttackRelease(f, 0.03, t, 0.7);
    s.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.07);
    this.dripPans[(this.dripIdx - 1) % this.dripPans.length].pan.setValueAtTime((Math.random() - 0.5) * 1.4, t);
  }

  private lullaby(note: number, velocity: number): void {
    if (!this.ready || !this.m) return;
    const t = Tone.immediate() + 0.005;
    this.musicBoxPan.pan.setValueAtTime((Math.random() - 0.5) * lerp(0.4, 1.2, this.m.chaos), t);
    if (this.musicBox.activeVoices < this.musicBox.maxPolyphony) this.musicBox.triggerAttackRelease(mtof(note), 0.05, t, Math.min(1, velocity));
  }

  /** Fiba shifting on the fabric: a soft, short rustle. */
  private catMove(strength: number): void {
    if (!this.ready || this.world !== 'fiba') return;
    const t = Tone.immediate() + 0.01;
    const g = this.swishGain.gain;
    g.cancelAndHoldAtTime(t);
    g.linearRampToValueAtTime(0.02 + strength * 0.035, t + 0.45);
    g.setTargetAtTime(0, t + 0.9, 0.5);
    const f = this.swishFilter.frequency;
    f.cancelAndHoldAtTime(t);
    f.exponentialRampToValueAtTime(2200, t + 0.5);
    f.exponentialRampToValueAtTime(900, t + 2);
  }

  private pad(gesture: PadGesture, velocity: number): void {
    if (!this.ready) return;
    if (gesture === 'purr') this.purrAccent = Math.min(1, this.purrAccent + 0.6 + velocity * 0.4);
    if (gesture !== 'wave') return;
    // The wash of a big wave: swells over ~1.4 s, breaks, drains away. Never a click.
    const t = Tone.immediate() + 0.01;
    const peak = 0.18 + velocity * 0.22;
    const g = this.waveGain.gain;
    g.cancelAndHoldAtTime(t);
    g.linearRampToValueAtTime(peak, t + 1.4);
    g.setTargetAtTime(0, t + 1.6, 1.3);
    const fq = this.waveFilter.frequency;
    fq.cancelAndHoldAtTime(t);
    fq.exponentialRampToValueAtTime(1500, t + 1.5);
    fq.exponentialRampToValueAtTime(320, t + 5);
    this.gust = Math.min(1.2, this.gust + 0.5 + velocity * 0.5);
  }

  // ------------------------------------------------------------------ parameters

  /** True (and remembered) when a value has moved by more than `eps` since it was last applied. */
  private changed(key: string, v: number, eps: number): boolean {
    const last = this.lastSet[key];
    if (last !== undefined && Math.abs(last - v) <= eps) return false;
    this.lastSet[key] = v;
    return true;
  }

  /** Called every frame; audio parameters are refreshed ~30x per second. */
  update(m: Macros, dt: number): void {
    this.m = m;
    if (!this.ready) return;
    this.gust = Math.max(0, this.gust - dt * 0.3);
    this.purrAccent = Math.max(0, this.purrAccent - dt * 0.1);
    this.mod += (this.expr.mod - this.mod) * (1 - Math.exp(-dt / 0.15));
    this.accum += dt;
    if (this.accum < 1 / 30) return;
    this.accum = 0;
    const R = 0.12; // ramp time: covers one refresh interval with margin, no zipper noise
    const warm = warmth(m);
    const w = m.world;
    const e = m.energy;
    const mod = this.mod;
    const fog = fogLevel(m);

    // WORLD + COLOR (+ mod): brightness of the instrument and the tail of the space.
    this.baseCutoff = lerp(320, 3200, Math.pow(w, 0.85)) * lerp(1.2, 0.8, warm) * (1 + mod * 0.8);
    const busCut = lerp(900, 8000, w) * lerp(1.15, 0.78, warm) * (1 + this.expr.pressure * 1.6 + mod * 1.2) * lerp(1, 0.75, m.weather);
    this.busFilter.frequency.rampTo(busCut, R);
    this.reverbTone.frequency.rampTo(lerp(1500, 7000, w) * lerp(1.1, 0.85, warm) * lerp(1.15, 0.7, fog), R);
    if (this.changed('chorusSpread', lerp(90, 180, w), 1)) this.chorus.spread = this.lastSet.chorusSpread;
    // held notes follow the mod strip live: air/shimmer on top of whatever WORLD chose
    for (const v of this.voices) if (v.down || v.sustained) rampParam(v.airLevel, v.airBase + mod * 0.12, R);

    // TEXTURE: chorus movement and grain.
    const chorusDepth = this.world === 'fiba' ? lerp(0.5, 0.9, m.motion) : Math.min(1, lerp(0.25, 0.85, m.texture) + mod * 0.25);
    for (const l of this.chorusLfos) l.amplitude.rampTo(chorusDepth, R);
    this.chorus.wet.rampTo(lerp(0.18, 0.55, m.texture), R);
    this.chorus.frequency.rampTo(lerp(0.08, 0.7, m.motion) * (1 + m.chaos * 0.4 + e * 0.5), R);
    const satAmt = lerp(0.05, 0.45, m.texture);
    if (Math.abs(satAmt - this.lastSatAmount) > 0.05) {
      this.sat.distortion = satAmt;
      this.lastSatAmount = satAmt;
    }
    this.sat.wet.rampTo(Math.pow(m.texture, 1.4) * 0.32, R);

    // SPACE (+ WORLD + fog): room size and echo. Night is a huge dark hall, day a clearer, closer air.
    this.revSmallGain.gain.rampTo(lerp(0.85, 0.1, m.space) * lerp(0.8, 1.2, w), R);
    this.revLargeGain.gain.rampTo(lerp(0.15, 1, m.space) * lerp(1.15, 0.8, w), R);
    this.reverbSend.gain.rampTo(lerp(0.28, 0.75, m.space) * lerp(0.9, 1.2, fog), R);
    this.delay.delayTime.rampTo(echoTime(m), 1.2);
    this.delay.feedback.rampTo(echoFeedback(m), R);
    this.delaySend.gain.rampTo(lerp(0.1, 0.3, m.space) * lerp(0.8, 1.3, e), R);

    // Bell: night = soft rounded kalimba, day = clear glass; mod brightens it.
    // In FIBA it stays a quiet music box: octave partial, a little shimmer.
    const inFiba = this.world === 'fiba';
    const h = inFiba ? 4 : w < 0.33 ? 1 : w < 0.66 ? 2 : 3;
    const mi = Math.round(((inFiba ? lerp(0.2, 0.75, m.texture) : lerp(0.6, 3.4, w) + m.texture * 1.2) + mod * (inFiba ? 0.8 : 2)) * 10) / 10;
    if (h !== this.lastBell.h || Math.abs(mi - this.lastBell.mi) > 0.25) {
      this.bell.set({ harmonicity: h, modulationIndex: mi });
      this.lastBell = { h, mi };
    }
    this.bellVol.volume.rampTo(inFiba ? -5 + mod * 2 : lerp(-6, 0, w) + mod * 3, R);

    // Drone (fader 4) follows the root and breathes with MOTION; WORLD changes its character.
    const root = this.rootMidi;
    if (root !== this.droneRoot) {
      const first = this.droneRoot < 0;
      this.droneRoot = root;
      const r = mtof(root);
      if (first) {
        this.droneA.frequency.value = r;
        this.droneB.frequency.value = r * 1.4983;
        this.droneAir.frequency.value = r * 4;
      } else {
        this.droneA.frequency.rampTo(r, 4);
        this.droneB.frequency.rampTo(r * 1.4983, 4);
        this.droneAir.frequency.rampTo(r * 4, 4);
      }
    }
    const droneLvl = Math.pow(m.drone / 0.6, 1.3); // 0.6 = the v0.1 level
    this.droneLfo.frequency.rampTo(lerp(0.015, 0.14, m.motion) * lerp(1, 2.2, e), R);
    // these setters jump instantly: give each its final value once, and only when it has moved
    if (this.changed('droneMin', lerp(110, 260, w), 2)) this.droneLfo.min = this.lastSet.droneMin;
    const droneMax = this.world === 'fiba' ? lerp(300, 800, w) : lerp(380, 1500, w) * lerp(1, 1.6, e);
    if (this.changed('droneMax', droneMax, 4)) this.droneLfo.max = this.lastSet.droneMax;
    if (this.changed('droneSpread', lerp(8, 34, m.chaos * 0.5 + m.texture * 0.5), 0.5)) this.droneA.spread = this.lastSet.droneSpread;
    this.droneGain.gain.rampTo(lerp(0.075, 0.05, w) * lerp(0.8, 1.1, m.space) * droneLvl, 1);
    this.droneAirGain.gain.rampTo(smooth(0.35, 1, w) * 0.35 + m.drone * 0.15, 1);

    // Each world has its own place: crossfade between TIDE's sea and FIBA's room.
    const fiba = this.world === 'fiba';
    const atmosLevel = Math.pow(m.atmos / 0.7, 2);
    this.atmosBus.gain.rampTo(fiba ? 0 : atmosLevel, 1.2);
    this.fibaBus.gain.rampTo(fiba ? 1 : 0, 1.2);
    this.haloGain.gain.rampTo(fiba ? lerp(0.5, 1, m.space) * lerp(0.7, 1.2, m.texture) : 0, 1.2);
    // density compensation (FIBA): sustained chords and HOLD stack many voices; keep the sum clean
    let sounding = 0;
    for (const v of this.voices) if (v.ampGain.value > 0.01) sounding++;
    this.density += (Math.max(1, sounding) - this.density) * 0.25;
    this.voiceBus.gain.rampTo(fiba ? Math.min(1, 2.2 / Math.sqrt(this.density)) : 1, 0.15);
    if (fiba) this.updateFiba(m);
    if (this.lastWorldBell !== this.world) {
      this.lastWorldBell = this.world;
      this.bell.set({ envelope: { decay: fiba ? 4.5 : 2.8, release: fiba ? 4 : 3 } });
      this.lastBell = { h: -1, mi: -1 };
    }

    // Atmosphere (fader 1) + WEATHER + ENERGY + rain (fader 2): the sound of the place.
    const wx = m.weather;
    const rain = rainLevel(m);
    this.wind.frequency.rampTo(lerp(0.03, 0.3, m.motion * 0.5 + wx * 0.3 + e * 0.4), R);
    if (this.changed('windBase', lerp(180, 460, Math.max(wx, e * 0.8)), 2)) this.wind.baseFrequency = this.lastSet.windBase;
    const windLvl = 0.012 + smooth(0.05, 0.9, wx) * 0.1 + smooth(0.25, 1, e) * 0.16 + this.gust * 0.12 + mod * 0.05;
    this.windGain.gain.rampTo(windLvl, 0.2);
    this.rainGain.gain.rampTo(rain * 0.034 * lerp(0.7, 1.2, m.texture), R);
    this.rumbleGain.gain.rampTo(Math.max(smooth(0.6, 1, wx), smooth(0.6, 1, e) * 0.7) * 0.5, 1);
    // surf: calm water barely laps; ENERGY brings in sets of waves, faster and louder
    this.surfGain.gain.rampTo(lerp(0.01, 0.26, Math.pow(e, 1.3)) * lerp(1, 1.4, wx), 0.5);
    this.surfLfo.frequency.rampTo(lerp(0.07, 0.2, e) * lerp(0.9, 1.2, m.motion), 1);
    this.surfFilter.frequency.rampTo(lerp(500, 1100, e), 1);

    this.applyDetune();
  }

  world: WorldId = 'tide';
  setWorld(id: WorldId): void {
    this.world = id;
    // FIBA voices sing with sines; TIDE keeps its triangle body
    if (this.ready) for (const v of this.voices) v.body.type = id === 'fiba' ? 'sine' : 'triangle';
    this.applyDetune();
  }

  /** FIBA's instrument space and its room, refreshed with the other parameters. */
  private updateFiba(m: Macros): void {
    const R = 0.12;
    const w = m.world;
    // the lamp-lit night is darker and closer than the sea; SPACE opens it into a dream-room
    this.busFilter.frequency.rampTo(lerp(1800, 5200, w) * (1 + this.mod * 1.2), R);
    this.baseCutoff = lerp(1400, 2600, w) * (1 + this.mod * 0.8);
    this.reverbTone.frequency.rampTo(lerp(3200, 6500, w), R);
    this.revSmallGain.gain.rampTo(lerp(0.9, 0.35, m.space), R);
    this.revLargeGain.gain.rampTo(lerp(0.05, 0.7, m.space), R);
    this.delaySend.gain.rampTo(lerp(0.08, 0.2, m.space), R);
    this.chorus.wet.rampTo(lerp(0.35, 0.6, m.texture), R);
    this.sat.wet.rampTo(0, R);
    this.reverbSend.gain.rampTo(lerp(0.45, 0.85, m.space), R);
    // room tone stays a whisper; MIST breathes an airy veil into the dream
    this.roomGain.gain.rampTo(0.006, 0.5);
    this.breathGain.gain.rampTo(Math.pow(m.weather, 1.3) * 0.05, 0.5);
    // purr: under the drone (fader 4), deeper when she is content (pad), breathing slowly
    const breath = 0.6 + 0.4 * Math.sin(performance.now() / 1000 * Math.PI * 2 * lerp(0.2, 0.3, m.energy));
    this.purrGain.gain.rampTo((Math.pow(m.drone, 1.5) * 0.22 + this.purrAccent * 0.35) * breath, 0.15);
    this.purrLfo.frequency.rampTo(lerp(22, 27, m.energy) + m.chaos * 2, 1);
    this.purrFilter.frequency.rampTo(lerp(80, 120, w), 1);
    // the drone itself is softer here and sits lower
    this.droneGain.gain.rampTo(lerp(0.06, 0.045, w) * Math.pow(m.drone / 0.6, 1.3) * 0.7, 1);
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
