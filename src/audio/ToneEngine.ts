import * as Tone from 'tone';
import { bus, type NoteOn, type PadGesture } from '../core/events';
import type { Macros } from '../core/ParameterStore';
import { echoFeedback, echoTime, fogLevel, lerp, pitchNorm, rainLevel, smooth, warmth } from '../core/derive';
import { load, save } from '../core/storage';

const VOICES = 12;
const mtof = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

/**
 * One pad voice: detuned saw stack + triangle body + sine "air" an octave up
 * -> 24 dB lowpass -> amp -> pan. WORLD sets the balance of the three, so night and day are
 * two different instruments rather than one filter position.
 */
class Voice {
  readonly saw: Tone.FatOscillator;
  readonly sawGain: Tone.Gain;
  readonly body: Tone.Oscillator;
  readonly bodyGain: Tone.Gain;
  readonly air: Tone.Oscillator;
  readonly airGain: Tone.Gain;
  readonly filter: Tone.Filter;
  readonly amp: Tone.Gain;
  readonly pan: Tone.Panner;
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
    this.saw = new Tone.FatOscillator({ type: 'sawtooth', count: 3, spread: 22, frequency: 220 });
    this.sawGain = new Tone.Gain(0.5);
    this.body = new Tone.Oscillator({ type: 'triangle', frequency: 110 });
    this.bodyGain = new Tone.Gain(0.5);
    this.air = new Tone.Oscillator({ type: 'sine', frequency: 440 });
    this.airGain = new Tone.Gain(0);
    this.filter = new Tone.Filter({ type: 'lowpass', rolloff: -24, Q: 0.6, frequency: 400 });
    this.amp = new Tone.Gain(0);
    this.pan = new Tone.Panner(0);
    this.saw.chain(this.sawGain, this.filter);
    this.body.chain(this.bodyGain, this.filter);
    // the air layer bypasses the lowpass: it is the "daylight" shimmer on top
    this.air.chain(this.airGain, this.amp);
    this.filter.connect(this.amp);
    this.amp.connect(this.pan);
    this.pan.connect(out);
    detune.connect(this.saw.detune);
    detune.connect(this.body.detune);
    detune.connect(this.air.detune);
    this.saw.start();
    this.body.start();
    this.air.start();
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
  private bell!: Tone.PolySynth<Tone.FMSynth>;
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

    // Shared pitch LFO = pitch bend + vibrato (mod strip) for every voice.
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
    this.bellVol = new Tone.Volume(0);
    this.bell.chain(this.bellVol, this.chorus);

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
    const w = m.world;

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
    v.air.frequency.setValueAtTime(f * 2, t0);

    // WORLD = the character of the instrument.
    //   night: dark, round, narrow — triangle body, little saw, slow bloom
    //   day:   bright, airy, wide  — open saw with a touch of resonance, octave shimmer, quicker
    v.saw.spread = lerp(8, 34, w) + m.texture * 10 + chaos * 8;
    v.sawGain.gain.setValueAtTime(lerp(0.2, 0.58, w), t0);
    v.bodyGain.gain.setValueAtTime(lerp(0.85, 0.22, w) * lerp(1, 0.5, pn), t0);
    v.airBase = smooth(0.35, 1, w) * 0.16 * lerp(1, 0.5, pn);
    v.airGain.gain.cancelAndHoldAtTime(t0);
    v.airGain.gain.linearRampToValueAtTime(v.airBase + this.mod * 0.12, t0 + 0.4);
    v.filter.Q.setValueAtTime(lerp(0.5, 1.6, w), t0);
    const spread = lerp(0.25, 1.0, w);
    v.pan.pan.setValueAtTime(((pn - 0.5) * 0.6 + (Math.random() - 0.5) * (0.2 + chaos * 0.7)) * spread, t0);

    // Soft, velocity-shaped envelopes. Attack stays ambient even when played hard.
    const attack = lerp(1.25, 0.28, Math.pow(vel, 0.8)) * lerp(1.25, 0.85, m.energy) * lerp(1.35, 0.6, w);
    const pitchComp = pn > 0.62 ? lerp(1, 0.55, (pn - 0.62) / 0.38) : pn < 0.2 ? 0.8 : 1;
    // the world's own echoes belong to the atmosphere (fader 1); pads and played notes do not
    const src = e.source === 'generative' ? 0.8 * Math.min(1.4, m.atmos / 0.7) : e.source === 'pad' ? 0.85 : 1;
    const peak = 0.62 * Math.pow(vel, 1.3) * pitchComp * src;
    const g = v.amp.gain;
    g.cancelAndHoldAtTime(t);
    if (dip) g.linearRampToValueAtTime(0, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.setTargetAtTime(peak * lerp(0.72, 0.55, w), t0 + attack, 1.8);

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
    // Night: a soft, almost sine "kalimba" low in the mix. Day: a clear glass bell.
    const bellNote = e.note < 60 ? e.note + 12 : e.note;
    const bellVel = Math.pow(vel, 1.6) * lerp(0.35, 1, pn) * lerp(0.45, 1.2, w) * (1 + this.mod * 0.5) * (e.source === 'generative' ? 0.7 : 1);
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
    const rel = m ? lerp(3.2, 7.5, m.space) * lerp(1.1, 0.8, m.energy) * lerp(1.25, 0.85, m.world) : 5;
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
    // gentle vibrato: expression, not wobble
    const depth = this.mod * 9 + (this.m ? this.m.chaos * 3 : 0);
    this.detune.min = bendCents - depth;
    this.detune.max = bendCents + depth;
  }

  private drip(note: number, velocity: number): void {
    if (!this.ready || !this.m) return;
    const s = this.drips[this.dripIdx++ % this.drips.length];
    const t = Tone.immediate() + 0.005;
    const f = mtof(note);
    const loud = rainLevel(this.m) * velocity;
    s.volume.setValueAtTime(-38 + loud * 12 + this.m.texture * 3, t);
    s.triggerAttackRelease(f, 0.03, t, 0.7);
    s.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.07);
    this.dripPans[(this.dripIdx - 1) % this.dripPans.length].pan.setValueAtTime((Math.random() - 0.5) * 1.4, t);
  }

  private pad(gesture: PadGesture, velocity: number): void {
    if (!this.ready || gesture !== 'wave') return;
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

  /** Called every frame; audio parameters are refreshed ~30x per second. */
  update(m: Macros, dt: number): void {
    this.m = m;
    if (!this.ready) return;
    this.gust = Math.max(0, this.gust - dt * 0.3);
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
    this.chorus.spread = lerp(90, 180, w);
    // held notes follow the mod strip live: air/shimmer on top of whatever WORLD chose
    for (const v of this.voices) if (v.down || v.sustained) v.airGain.gain.rampTo(v.airBase + mod * 0.12, R);

    // TEXTURE: chorus movement and grain.
    this.chorus.depth = Math.min(1, lerp(0.25, 0.85, m.texture) + mod * 0.25);
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
    const h = w < 0.33 ? 1 : w < 0.66 ? 2 : 3;
    const mi = Math.round((lerp(0.6, 3.4, w) + m.texture * 1.2 + mod * 2) * 10) / 10;
    if (h !== this.lastBell.h || Math.abs(mi - this.lastBell.mi) > 0.25) {
      this.bell.set({ harmonicity: h, modulationIndex: mi });
      this.lastBell = { h, mi };
    }
    this.bellVol.volume.rampTo(lerp(-6, 0, w) + mod * 3, R);

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
    this.droneLfo.min = lerp(110, 260, w);
    this.droneLfo.max = lerp(380, 1500, w) * lerp(1, 1.6, e);
    this.droneA.spread = lerp(8, 34, m.chaos * 0.5 + m.texture * 0.5);
    this.droneGain.gain.rampTo(lerp(0.075, 0.05, w) * lerp(0.8, 1.1, m.space) * droneLvl, 1);
    this.droneAirGain.gain.rampTo(smooth(0.35, 1, w) * 0.35 + m.drone * 0.15, 1);

    // Atmosphere (fader 1) + WEATHER + ENERGY + rain (fader 2): the sound of the place.
    this.atmosBus.gain.rampTo(Math.pow(m.atmos / 0.7, 2), R);
    const wx = m.weather;
    const rain = rainLevel(m);
    this.wind.frequency.rampTo(lerp(0.03, 0.3, m.motion * 0.5 + wx * 0.3 + e * 0.4), R);
    this.wind.baseFrequency = lerp(180, 460, Math.max(wx, e * 0.8));
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
