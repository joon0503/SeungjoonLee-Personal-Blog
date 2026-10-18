/**
 * Shared helpers for the imaging-pipeline figures (exposure, ISP, Bayer,
 * demosaicing, YUV). Plain typed arrays, no dependencies.
 *
 * Images are linear-light RGB in a Float32Array, interleaved (r, g, b per
 * pixel), with 1.0 = a perfect white reflector under the reference light.
 * Values above 1 are allowed (light sources, specular highlights).
 */

export type RGB = [number, number, number];

export interface Img {
  w: number;
  h: number;
  /** Interleaved linear RGB, length 3·w·h. */
  data: Float32Array;
}

export const makeImg = (w: number, h: number): Img => ({ w, h, data: new Float32Array(w * h * 3) });

/* --- Transfer functions ---------------------------------------------------- */

/** sRGB transfer function: linear [0, 1] → encoded [0, 1]. */
export function srgbEncode(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** Inverse sRGB transfer function: encoded [0, 1] → linear [0, 1]. */
export function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 4096-entry lookup table for linear [0, 1] → sRGB 8-bit, for fast canvas output. */
const ENCODE_LUT = (() => {
  const lut = new Uint8ClampedArray(4097);
  for (let i = 0; i <= 4096; i++) lut[i] = Math.round(srgbEncode(i / 4096) * 255);
  return lut;
})();

export const encode8 = (x: number): number => ENCODE_LUT[x <= 0 ? 0 : x >= 1 ? 4096 : (x * 4096) | 0];

/* --- Canvas output --------------------------------------------------------- */

/** Draw a linear image to a canvas, sRGB-encoding it (or not, with `encoded`). */
export function drawImg(canvas: HTMLCanvasElement, img: Img, { encoded = false } = {}): void {
  if (canvas.width !== img.w) canvas.width = img.w;
  if (canvas.height !== img.h) canvas.height = img.h;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(img.w, img.h);
  const d = img.data;
  const o = out.data;
  for (let i = 0, j = 0; i < d.length; i += 3, j += 4) {
    if (encoded) {
      o[j] = d[i] * 255;
      o[j + 1] = d[i + 1] * 255;
      o[j + 2] = d[i + 2] * 255;
    } else {
      o[j] = encode8(d[i]);
      o[j + 1] = encode8(d[i + 1]);
      o[j + 2] = encode8(d[i + 2]);
    }
    o[j + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

/**
 * Copy the region (sx, sy, sw, sh) of `src` into `dst`, magnified with
 * nearest-neighbour sampling so the individual pixels stay visible.
 */
export function drawZoom(dst: HTMLCanvasElement, src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number): void {
  const ctx = dst.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, dst.width, dst.height);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dst.width, dst.height);
}

/* --- Random numbers -------------------------------------------------------- */

/** Small seeded PRNG (mulberry32), so noise patterns are repeatable between redraws. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal samples (Box–Muller) from a uniform generator. */
export function gaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u = Math.max(rand(), 1e-12);
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * rand();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

/* --- Test scene ------------------------------------------------------------ */

/** sRGB 8-bit values of the 24 ColorChecker patches, row by row. */
const COLOR_CHECKER_8: RGB[] = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
  [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
  [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
];

/** Linear reflectances of the ColorChecker patches. */
export const COLOR_CHECKER: RGB[] = COLOR_CHECKER_8.map((c) => c.map((v) => srgbDecode(v / 255)) as RGB);

/** Aspect ratio (width / height) of the test scene. */
export const SCENE_ASPECT = 1.5;

const ZP = { u: 1.17, v: 0.31, r: 0.26 };
const LAMP = { u: 1.17, v: 0.8, r: 0.07 };

/**
 * The test scene at scene coordinates (u, v) ∈ [0, 1.5] × [0, 1], top-left
 * origin: a ColorChecker, a zone plate (concentric rings whose frequency
 * grows with radius, for aliasing), a 12-step gray wedge, and a bright lamp
 * that clips under most exposures.
 *
 * `zoneK` sets the zone plate's chirp rate: the ring frequency at radius r is
 * zoneK·r/π cycles per scene unit.
 */
export function sceneAt(u: number, v: number, zoneK = 680): RGB {
  // Lamp with a soft glow (radiance well above 1)
  const dl = Math.hypot(u - LAMP.u, v - LAMP.v);
  if (dl < LAMP.r) return [8, 7.2, 5.6];
  let glow = 0;
  if (dl < 0.2) glow = 0.35 * Math.pow(1 - (dl - LAMP.r) / (0.2 - LAMP.r), 2);

  // Zone plate
  const dz = Math.hypot(u - ZP.u, v - ZP.v);
  if (dz < ZP.r) {
    const s = 0.5 + 0.5 * Math.cos(zoneK * dz * dz);
    const g = 0.03 + 0.8 * s;
    return [g, g, g];
  }

  // ColorChecker: 6 × 4 patches
  const x0 = 0.05, y0 = 0.06, pw = 0.135, ph = 0.135, gap = 0.012;
  const cu = (u - x0) / (pw + gap);
  const cv = (v - y0) / (ph + gap);
  if (cu >= 0 && cu < 6 && cv >= 0 && cv < 4) {
    const i = Math.floor(cu), j = Math.floor(cv);
    if (cu - i < pw / (pw + gap) && cv - j < ph / (ph + gap)) return COLOR_CHECKER[j * 6 + i];
  }

  // Gray wedge: 12 steps, about half a stop apart
  if (v > 0.7 && v < 0.92 && u > 0.05 && u < 0.92) {
    const k = Math.min(11, Math.floor(((u - 0.05) / 0.87) * 12));
    const g = 0.9 * Math.pow(2, -(11 - k) * 0.6);
    return [g + glow, g + glow, g + glow];
  }

  // Background: dark neutral surround
  const b = 0.045 + glow;
  return [b, b, b];
}

/** Render the scene at w × h pixels with ss × ss supersampling (box filter). */
export function renderScene(w: number, h: number, ss = 2, zoneK?: number): Img {
  const img = makeImg(w, h);
  const scale = 1 / h; // scene units per pixel (scene height is 1)
  const d = img.data;
  const n = ss * ss;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sceneAt((x + (sx + 0.5) / ss) * scale, (y + (sy + 0.5) / ss) * scale, zoneK);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = 3 * (y * w + x);
      d[i] = r / n;
      d[i + 1] = g / n;
      d[i + 2] = b / n;
    }
  }
  return img;
}

/* --- Bayer color filter array --------------------------------------------- */

export type BayerPattern = 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';
export const BAYER_PATTERNS: BayerPattern[] = ['RGGB', 'BGGR', 'GRBG', 'GBRG'];

const CH: Record<string, 0 | 1 | 2> = { R: 0, G: 1, B: 2 };

/** Channel (0 = R, 1 = G, 2 = B) that the filter at pixel (x, y) passes. The pattern names the top-left 2 × 2 tile, row by row. */
export const bayerChannel = (p: BayerPattern, x: number, y: number): 0 | 1 | 2 => CH[p[((y & 1) << 1) | (x & 1)]];

/** Sample an RGB image through a Bayer filter: one value per pixel. */
export function mosaic(img: Img, p: BayerPattern): Float32Array {
  const { w, h, data } = img;
  const raw = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = data[3 * (y * w + x) + bayerChannel(p, x, y)];
  return raw;
}

/**
 * Bilinear demosaicing: each missing channel is the mean of the nearest
 * pixels that measured it (2 or 4 neighbours). Borders are mirrored.
 */
export function demosaicBilinear(raw: Float32Array, w: number, h: number, p: BayerPattern): Img {
  const img = makeImg(w, h);
  const d = img.data;
  const at = (x: number, y: number) => raw[mirror(y, h) * w + mirror(x, w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = bayerChannel(p, x, y);
      const i = 3 * (y * w + x);
      const here = at(x, y);
      const cross = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
      const diag = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
      const horiz = (at(x - 1, y) + at(x + 1, y)) / 2;
      const vert = (at(x, y - 1) + at(x, y + 1)) / 2;
      if (c === 1) {
        // Green pixel: R and B are either left/right or above/below
        const rowHasR = bayerChannel(p, x + 1, y) === 0;
        d[i + 1] = here;
        d[i] = rowHasR ? horiz : vert;
        d[i + 2] = rowHasR ? vert : horiz;
      } else {
        // Red or blue pixel: green on the cross, the other color on the diagonals
        d[i + c] = here;
        d[i + 1] = cross;
        d[i + (2 - c)] = diag;
      }
    }
  }
  return img;
}

/** Reflect an index into [0, n), so x = −1 → 1 and x = n → n − 2. Keeps the Bayer phase. */
export function mirror(i: number, n: number): number {
  if (i < 0) return -i;
  if (i >= n) return 2 * n - 2 - i;
  return i;
}

/* --- Small DOM helpers ----------------------------------------------------- */

/** Selected value of a radio group inside `root`. */
export const radioValue = (root: ParentNode, name: string): string =>
  root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;

/* --- Real raw sample (Sigma fp, raw.pixls.us, CC0) ------------------------- */

/**
 * A real Bayer capture prepared by scripts/prepare-raw-sample.py: the Sigma fp
 * stores one 8-bit code per photosite, and the DNG's linearization table maps
 * each code to a 12-bit linear value with black level 256.
 */
export interface RawSample {
  w: number;
  h: number;
  pattern: BayerPattern;
  /** The stored 8-bit codes, one per photosite. */
  codes: Uint8Array;
  /** Linearization table: code → linear value, normalized to the white level (black not subtracted). */
  lut: Float32Array;
  /** Black level, normalized to the white level, and the code that maps to it. */
  black: number;
  blackCode: number;
  /** Linear values with the black level subtracted, normalized to [0, 1]. */
  raw: Float32Array;
  /** As-shot white balance gains (R, G, B), G = 1. */
  wb: RGB;
  /** White-balanced camera RGB → linear sRGB, row-major. */
  camToSrgb: [RGB, RGB, RGB];
}

const SAMPLE_DIR = '/figures/photons-to-pixels/';

interface SampleMeta {
  pattern: BayerPattern;
  lut: number[];
  black: number;
  blackCode: number;
  white: number;
  wb: RGB;
  camToSrgb: [RGB, RGB, RGB];
  scene: { file: string };
  detail: { file: string };
  photo: { file: string };
}

let metaPromise: Promise<SampleMeta> | null = null;
const loadMeta = () => (metaPromise ??= fetch(`${SAMPLE_DIR}raw-sample.json`).then((r) => r.json() as Promise<SampleMeta>));

/** Decode an image file to RGBA pixels (PNGs without a color profile come back unchanged). */
async function loadPixels(file: string): Promise<ImageData> {
  const img = new Image();
  img.src = SAMPLE_DIR + file;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

const sampleCache = new Map<string, Promise<RawSample>>();

/**
 * Load a raw mosaic: 'scene' is a 2880 × 1920 crop of the frame downscaled to
 * 480 × 320, 'detail' a native-resolution 360 × 240 crop (the logo on the stem).
 */
export function loadRawSample(which: 'scene' | 'detail'): Promise<RawSample> {
  if (!sampleCache.has(which)) {
    sampleCache.set(
      which,
      (async () => {
        const meta = await loadMeta();
        const px = await loadPixels(meta[which].file);
        const lut = Float32Array.from(meta.lut, (v) => v / meta.white);
        const black = meta.black / meta.white;
        const n = px.width * px.height;
        const codes = new Uint8Array(n);
        const raw = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const c = px.data[4 * i];
          codes[i] = c;
          raw[i] = Math.max(0, (lut[c] - black) / (1 - black));
        }
        const { pattern, wb, camToSrgb, blackCode } = meta;
        return { w: px.width, h: px.height, pattern, codes, lut, black, blackCode, raw, wb, camToSrgb };
      })(),
    );
  }
  return sampleCache.get(which)!;
}

let photoPromise: Promise<Img> | null = null;

/** The same scene crop developed by LibRaw (AHD demosaic, camera WB, sRGB), as a linear image. 480 × 320. */
export function loadPhoto(): Promise<Img> {
  return (photoPromise ??= (async () => {
    const meta = await loadMeta();
    const px = await loadPixels(meta.photo.file);
    const img = makeImg(px.width, px.height);
    const lut = new Float32Array(256).map((_, v) => srgbDecode(v / 255));
    for (let i = 0, j = 0; i < img.data.length; i += 3, j += 4) {
      img.data[i] = lut[px.data[j]];
      img.data[i + 1] = lut[px.data[j + 1]];
      img.data[i + 2] = lut[px.data[j + 2]];
    }
    return img;
  })());
}

/**
 * Turn demosaiced camera RGB into linear sRGB in place: white balance, the
 * camera → sRGB matrix, then an exposure multiplier.
 */
export function cameraToSrgb(img: Img, wb: RGB, M: [RGB, RGB, RGB], exposure = 1): Img {
  const d = img.data;
  for (let i = 0; i < d.length; i += 3) {
    const r = d[i] * wb[0], g = d[i + 1] * wb[1], b = d[i + 2] * wb[2];
    d[i] = exposure * (M[0][0] * r + M[0][1] * g + M[0][2] * b);
    d[i + 1] = exposure * (M[1][0] * r + M[1][1] * g + M[1][2] * b);
    d[i + 2] = exposure * (M[2][0] * r + M[2][1] * g + M[2][2] * b);
  }
  return img;
}
