import type { WebGLRenderer } from 'three';
import type { Macros } from '../core/ParameterStore';

/**
 * Contract every ECHOES world implements. Input, audio and parameters are shared services;
 * a world only turns bus events + macros into image. Adding MOSS = adding another World.
 */
export interface World {
  readonly id: string;
  readonly title: string;
  /** Subscribe to the bus, build the scene. */
  mount(renderer: WebGLRenderer): void;
  resize(width: number, height: number, pixelRatio: number): void;
  /** dt in seconds (clamped), macros are the smoothed shared values. */
  frame(dt: number, macros: Macros): void;
  /** Screen (NDC) -> world ground point, for pointer play. */
  pick(ndcX: number, ndcY: number): { x: number; z: number } | null;
  /** 0..1 fade-in of the image (intro -> world). */
  setReveal(v: number): void;
  dispose(): void;
}
