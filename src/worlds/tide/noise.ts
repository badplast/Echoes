import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, UnsignedByteType } from 'three';

/** Deterministic PRNG so the world looks the same every visit. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable fbm value noise sampled on an N x N grid, values roughly 0..1. */
function tileableFbm(size: number, basePeriod: number, octaves: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const lattices: Float32Array[] = [];
  for (let o = 0; o < octaves; o++) {
    const p = basePeriod << o;
    const l = new Float32Array(p * p);
    for (let i = 0; i < l.length; i++) l[i] = rand();
    lattices.push(l);
  }
  const out = new Float32Array(size * size);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.5;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        const p = basePeriod << o;
        const l = lattices[o];
        const fx = (x / size) * p;
        const fy = (y / size) * p;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fade(fx - x0);
        const ty = fade(fy - y0);
        const x1 = (x0 + 1) % p;
        const y1 = (y0 + 1) % p;
        const a = l[y0 * p + x0];
        const b = l[y0 * p + x1];
        const c = l[y1 * p + x0];
        const d = l[y1 * p + x1];
        v += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
        norm += amp;
        amp *= 0.5;
      }
      out[y * size + x] = v / norm;
    }
  }
  return out;
}

function toTexture(data: Uint8Array, size: number): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Contrast-stretch a field to 0..1 so thresholds in shaders behave predictably. */
function normalize(f: Float32Array): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of f) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const s = 1 / (hi - lo || 1);
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * s;
  return f;
}

/**
 * Cloud / mist noise: four independent tileable fbm fields in RGBA at different scales.
 */
export function createCloudNoise(size = 256): DataTexture {
  const layers = [
    normalize(tileableFbm(size, 4, 5, 11)),
    normalize(tileableFbm(size, 8, 5, 23)),
    normalize(tileableFbm(size, 16, 4, 37)),
    normalize(tileableFbm(size, 6, 5, 51)),
  ];
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(layers[c][i] * 255);
  }
  return toTexture(data, size);
}

/**
 * Water micro-detail stored as precomputed GRADIENTS (RG = layer 1, BA = layer 2).
 * Interpolating gradients gives smooth normals, unlike differentiating a bilinear height texture.
 */
export function createWaterDetail(size = 256): DataTexture {
  const h1 = tileableFbm(size, 8, 4, 71);
  const h2 = tileableFbm(size, 16, 3, 89);
  const data = new Uint8Array(size * size * 4);
  const grad = (h: Float32Array, x: number, y: number, dx: number, dy: number) => {
    const xa = (x + dx + size) % size;
    const ya = (y + dy + size) % size;
    const xb = (x - dx + size) % size;
    const yb = (y - dy + size) % size;
    return dx ? h[y * size + xa] - h[y * size + xb] : h[ya * size + x] - h[yb * size + x];
  };
  // Gradients are in "height per texel*2"; scale into byte range with a fixed gain.
  const G1 = size * 0.06;
  const G2 = size * 0.035;
  const enc = (v: number) => Math.max(0, Math.min(255, Math.round(128 + v * 127)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = enc(grad(h1, x, y, 1, 0) * G1);
      data[i + 1] = enc(grad(h1, x, y, 0, 1) * G1);
      data[i + 2] = enc(grad(h2, x, y, 1, 0) * G2);
      data[i + 3] = enc(grad(h2, x, y, 0, 1) * G2);
    }
  }
  return toTexture(data, size);
}
