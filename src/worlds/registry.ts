import type { WorldId } from '../core/events';
import type { WorldEntry } from './World';

/** Every world of ECHOES. Each one is its own chunk, loaded when first visited. */
export const WORLDS: WorldEntry[] = [
  { id: 'tide', title: 'World 01 — TIDE', create: async () => new (await import('./tide/TideWorld')).TideWorld() },
  { id: 'fiba', title: 'World 02 — FIBA', create: async () => new (await import('./fiba/FibaWorld')).FibaWorld() },
];

export function worldEntry(id: WorldId): WorldEntry {
  return WORLDS.find((w) => w.id === id) ?? WORLDS[0];
}
