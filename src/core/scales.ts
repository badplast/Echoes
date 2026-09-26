export interface ScaleDef {
  id: string;
  label: string;
  steps: number[];
}

export const SCALES: ScaleDef[] = [
  { id: 'minor-pentatonic', label: 'Minor Pentatonic', steps: [0, 3, 5, 7, 10] },
  { id: 'suspended', label: 'Suspended', steps: [0, 2, 5, 7, 10] },
  { id: 'major-pentatonic', label: 'Major Pentatonic', steps: [0, 2, 4, 7, 9] },
  { id: 'dorian', label: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'aeolian', label: 'Aeolian', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'chromatic', label: 'Chromatic (off)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function scaleById(id: string): ScaleDef {
  return SCALES.find((s) => s.id === id) ?? SCALES[0];
}

export function noteName(midi: number): string {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

/**
 * 12-entry lookup: chromatic offset from root -> semitone offset of the nearest scale tone.
 * Nearest-tone mapping keeps every key close to where it was pressed (keyboard range is kept)
 * and spreads keys evenly: in a pentatonic scale each tone receives only 2-3 neighbouring keys.
 * Ties alternate up/down so a chromatic run doesn't bunch onto the same pitch.
 */
function buildTable(steps: number[]): number[] {
  const candidates = [...steps, steps[0] + 12];
  const table: number[] = [];
  let tieUp = true;
  for (let d = 0; d < 12; d++) {
    let best = 0;
    let bestDist = 99;
    let tie = false;
    for (const s of candidates) {
      const dist = Math.abs(s - d);
      if (dist < bestDist) {
        bestDist = dist;
        best = s;
        tie = false;
      } else if (dist === bestDist) {
        tie = true;
        if (tieUp) best = s;
      }
    }
    if (tie) tieUp = !tieUp;
    table.push(best);
  }
  return table;
}

export class ScaleLock {
  private table: number[] = [];
  private _scale: ScaleDef = SCALES[0];
  root: number;

  constructor(scaleId: string, root: number) {
    this.setScale(scaleId);
    this.root = root;
  }

  get scale(): ScaleDef {
    return this._scale;
  }

  setScale(id: string): void {
    this._scale = scaleById(id);
    this.table = buildTable(this._scale.steps);
  }

  quantize(note: number): number {
    const rel = note - this.root;
    const oct = Math.floor(rel / 12);
    const deg = rel - oct * 12;
    return this.root + oct * 12 + this.table[deg];
  }

  /** Move `steps` scale degrees away from a note (used by generative echoes). */
  step(note: number, steps: number): number {
    const s = this._scale.steps;
    const q = this.quantize(note);
    const rel = q - this.root;
    const oct = Math.floor(rel / 12);
    const deg = rel - oct * 12;
    let idx = s.indexOf(deg);
    if (idx < 0) idx = 0;
    const total = oct * s.length + idx + steps;
    const o = Math.floor(total / s.length);
    const i = total - o * s.length;
    return this.root + o * 12 + s[i];
  }
}
