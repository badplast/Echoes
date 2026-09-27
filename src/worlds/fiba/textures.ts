import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

/** Deterministic PRNG so the room is the same every night. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = false): Texture {
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Grey tweed: speckled weave, optional tufting (seat grid) or channels (back). */
export function fabric(kind: 'plain' | 'tufted' | 'channels', seed = 1): { map: Texture; bump: Texture } {
  const S = 512;
  const [c, g] = canvas(S, S);
  const [b, gb] = canvas(S, S);
  const r = rng(seed);
  const img = g.createImageData(S, S);
  const bimg = gb.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const weave = ((x + y) % 4 < 2 ? 1 : -1) * 4 + ((x - y + 1024) % 6 < 3 ? 2 : -2);
      const speck = (r() - 0.5) * 34 + (r() < 0.03 ? -30 : 0) + (r() < 0.02 ? 26 : 0);
      const v = 118 + weave + speck;
      img.data[i] = v;
      img.data[i + 1] = v + 2;
      img.data[i + 2] = v + 6;
      img.data[i + 3] = 255;
      const bv = 128 + weave * 3 + speck * 0.6;
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = bv;
      bimg.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  gb.putImageData(bimg, 0, 0);
  const seam = (ctx: CanvasRenderingContext2D, dark: string, lines: [number, number, number, number][], puff: boolean) => {
    for (const [x0, y0, x1, y1] of lines) {
      if (puff) {
        // soft puffy shading either side of the stitch
        const grad = ctx.createLinearGradient(x0 - (y1 - y0 ? 18 : 0), y0 - (x1 - x0 ? 18 : 0), x0 + (y1 - y0 ? 18 : 0), y0 + (x1 - x0 ? 18 : 0));
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.5, 'rgba(0,0,0,0.35)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 48;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
      ctx.strokeStyle = dark;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  };
  const lines: [number, number, number, number][] = [];
  if (kind === 'tufted') for (let k = 1; k < 3; k++) lines.push([(k * S) / 3, 0, (k * S) / 3, S], [0, (k * S) / 3, S, (k * S) / 3]);
  if (kind === 'channels') for (let k = 1; k < 3; k++) lines.push([(k * S) / 3, 0, (k * S) / 3, S]);
  if (kind === 'channels') for (let k = 1; k < 4; k++) lines.push([0, (k * S) / 4, S, (k * S) / 4]);
  // the stitches are subtle on the real chair: a soft dip in the padding, barely a line
  seam(g, 'rgba(62,64,68,0.4)', lines, false);
  seam(gb, 'rgba(0,0,0,0.7)', lines, true);
  return { map: tex(c), bump: tex(b, false) };
}

/** Painted wall: lighter low down, sinking into shadow toward the ceiling, faint plaster. */
export function wallPaint(): Texture {
  const [c, g] = canvas(64, 512);
  const img = g.createImageData(64, 512);
  const r = rng(13);
  for (let y = 0; y < 512; y++) {
    const up = y / 511; // 0 = top of the texture (ceiling)
    const base = 150 + up * 105;
    for (let x = 0; x < 64; x++) {
      const v = base + (r() - 0.5) * 6;
      const k = (y * 64 + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return tex(c);
}

/** Light oak planks. */
export function oakFloor(): Texture {
  const W = 1024;
  const H = 1024;
  const [c, g] = canvas(W, H);
  const r = rng(7);
  const boards = 7;
  const bw = Math.floor(W / boards);
  const img = g.createImageData(W, H);
  for (let i = 0; i < boards; i++) {
    const tone = 196 + (r() - 0.5) * 22;
    const offset = r() * H;
    const cut = Math.floor(offset % H);
    for (let y = 0; y < H; y++) {
      const wave = Math.sin((y + offset) * 0.012) * 6;
      for (let x = 0; x < bw; x++) {
        const grain = Math.sin((x * 0.21 + wave) * 1.3) * 7 + Math.sin(y * 0.05 + x * 0.6) * 2;
        let v = tone + grain;
        if (x < 2 || Math.abs(y - cut) < 1) v *= 0.55; // seams
        const k = (y * W + i * bw + x) * 4;
        img.data[k] = v;
        img.data[k + 1] = v * 0.86;
        img.data[k + 2] = v * 0.7;
        img.data[k + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
  const t = tex(c, true, true);
  t.repeat.set(2, 2);
  return t;
}

/** Two posters leaning on the wall, abstracted from the room's own. */
export function poster(kind: 'red' | 'green'): Texture {
  const [c, g] = canvas(256, 340);
  const r = rng(kind === 'red' ? 3 : 5);
  g.fillStyle = '#e9e6df';
  g.fillRect(0, 0, 256, 340);
  if (kind === 'red') {
    g.fillStyle = '#7f2e29';
    g.fillRect(16, 16, 224, 308);
    g.fillStyle = 'rgba(40,14,12,0.85)';
    for (let i = 0; i < 5; i++) {
      const x = 40 + i * 38 + r() * 8;
      g.beginPath();
      g.ellipse(x, 120, 11, 13, 0, 0, Math.PI * 2);
      g.fill();
      g.fillRect(x - 15, 132, 30, 110);
    }
    g.fillStyle = '#f1ece4';
    g.fillRect(40, 270, 176, 26);
  } else {
    g.fillStyle = '#8aa594';
    g.fillRect(16, 16, 224, 308);
    g.fillStyle = '#3e5a4c';
    g.fillRect(16, 16, 224, 60);
    g.fillStyle = '#f2f0e8';
    for (let i = 0; i < 16; i++) {
      g.beginPath();
      g.ellipse(40 + r() * 176, 110 + r() * 190, 9, 6, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  return tex(c);
}

/** A monstera leaf: heart-shaped, split from the edge toward the midrib, alpha-cut. */
export function monsteraLeaf(): Texture {
  const [c, g] = canvas(256, 256);
  // heart outline (two lobes, pointed tip up)
  g.fillStyle = '#2c4430';
  g.beginPath();
  g.moveTo(128, 18);
  g.bezierCurveTo(215, 30, 250, 150, 170, 228);
  g.bezierCurveTo(150, 246, 136, 236, 128, 214);
  g.bezierCurveTo(120, 236, 106, 246, 86, 228);
  g.bezierCurveTo(6, 150, 41, 30, 128, 18);
  g.fill();
  // lighter centre
  const grad = g.createRadialGradient(128, 120, 10, 128, 120, 120);
  grad.addColorStop(0, 'rgba(90,120,80,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fill();
  // splits from the edge in toward the midrib
  g.globalCompositeOperation = 'destination-out';
  g.lineCap = 'round';
  for (const side of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const y = 60 + k * 38;
      g.lineWidth = 7;
      g.beginPath();
      g.moveTo(128 + side * 150, y - 30);
      g.lineTo(128 + side * (34 + k * 4), y + 6);
      g.stroke();
    }
  }
  g.globalCompositeOperation = 'source-over';
  g.strokeStyle = 'rgba(120,150,110,0.6)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(128, 220);
  g.lineTo(128, 30);
  g.stroke();
  return tex(c);
}

/** The view out: a night sky behind the balcony railing (brightness driven in the shader). */
export function windowView(): Texture {
  const [c, g] = canvas(256, 320);
  const grad = g.createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.75, '#b8b8b8');
  grad.addColorStop(1, '#707070');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 320);
  // distant houses along the bottom, soft
  g.fillStyle = 'rgba(0,0,0,0.55)';
  const r = rng(11);
  for (let x = 0; x < 256; x += 24 + r() * 20) g.fillRect(x, 250 - r() * 50, 22 + r() * 14, 90);
  // balcony railing bars
  g.fillStyle = 'rgba(0,0,0,0.85)';
  g.fillRect(0, 200, 256, 6);
  for (let x = 6; x < 256; x += 17) g.fillRect(x, 200, 4, 120);
  // window frame cross
  g.fillStyle = '#000';
  g.fillRect(124, 0, 8, 320);
  g.fillRect(0, 150, 256, 8);
  return tex(c);
}
