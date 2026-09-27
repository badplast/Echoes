import type { WebGLRenderer } from 'three';
import type { PadGesture, WorldId } from '../core/events';
import type { Macros, ParamKey } from '../core/ParameterStore';

export type ParamLabels = Partial<Record<ParamKey, { label: string; lo: string; hi: string }>>;

/**
 * Contract every ECHOES world implements. Input, audio and parameters are shared services;
 * a world turns bus events + parameters into image, and says how the shared controls
 * should read inside it (pad gestures, parameter names).
 */
export interface World {
  readonly id: WorldId;
  /** "World 01 — TIDE" */
  readonly title: string;
  /** What pads 1-8 do in this world. */
  readonly pads: PadGesture[];
  /** World-specific names for the shared parameters (falls back to the defaults). */
  readonly labels: ParamLabels;
  /** Display name of the COLOR state (optional). */
  paletteName?(color: number): string;
  /** Subscribe to the bus, build the scene. */
  mount(renderer: WebGLRenderer): void;
  /** False while the world is still preparing (e.g. compiling shaders); the app keeps the cover up. */
  readonly ready?: boolean;
  resize(width: number, height: number, pixelRatio: number): void;
  /** dt in seconds (clamped), macros are the smoothed shared values. */
  frame(dt: number, macros: Macros): void;
  /** Screen (NDC) -> world ground point, for pointer play. */
  pick(ndcX: number, ndcY: number): { x: number; z: number } | null;
  /** 0..1 fade-in of the image (intro -> world, world -> world). */
  setReveal(v: number): void;
  dispose(): void;
}

export interface WorldEntry {
  id: WorldId;
  title: string;
  create: () => Promise<World>;
}
