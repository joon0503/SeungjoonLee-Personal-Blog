/**
 * Implementation of <DemosaicCompare />. Loaded lazily by DemosaicCompare.astro.
 *
 * Two sources: a real RGGB capture (a native-resolution crop of a Sigma fp
 * 8-bit raw file, see imaging.ts) and the synthetic test scene, whose rendering is
 * the ground truth. The mosaic is demosaiced with the algorithm and Bayer
 * pattern the reader picks; real raw data is then white balanced and
 * converted to sRGB with the camera's own gains and matrix. A magnifier shows
 * a 48 × 32-pixel region.
 */
import { scheduler } from '../camera/camera-math';
import {
  type BayerPattern,
  type Img,
  type RawSample,
  bayerChannel,
  cameraToSrgb,
  demosaicBilinear,
  drawImg,
  drawZoom,
  encode8,
  loadRawSample,
  makeImg,
  mirror,
  mosaic,
  radioValue,
  renderScene,
} from './imaging';

const ZW = 48; // magnified region, in image pixels
const ZH = 32;
const SENSOR: BayerPattern = 'RGGB';
/** Exposure multiplier for the real raw crop (linear, after white balance and the color matrix). */
const RAW_EXPOSURE = 2.2;

/** The raw image shown in color: each pixel keeps only the channel its filter passes. */
function rawView(raw: Float32Array, W: number, H: number, p: BayerPattern): Img {
  const img = makeImg(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.data[3 * (y * W + x) + bayerChannel(p, x, y)] = raw[y * W + x];
  return img;
}

/** Pixel replication: every pixel takes each channel from the site that measured it in its 2 × 2 tile (same row first). */
function demosaicNearest(raw: Float32Array, W: number, H: number, p: BayerPattern): Img {
  const img = makeImg(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bx = x & ~1;
      const by = y & ~1;
      const rows = y === by ? [by, by + 1] : [by + 1, by];
      for (let c = 0; c < 3; c++) {
        let v = 0;
        search: for (const yy of rows) {
          for (const xx of [bx, bx + 1]) {
            if (bayerChannel(p, xx, yy) === c) {
              v = raw[Math.min(yy, H - 1) * W + Math.min(xx, W - 1)];
              break search;
            }
          }
        }
        img.data[3 * (y * W + x) + c] = v;
      }
    }
  }
  return img;
}

/**
 * Malvar–He–Cutler (ICASSP 2004): bilinear interpolation corrected by the
 * Laplacian of the channel measured at the pixel, as fixed 5 × 5 kernels.
 */
function demosaicMalvar(raw: Float32Array, W: number, H: number, p: BayerPattern): Img {
  const img = makeImg(W, H);
  const d = img.data;
  const at = (x: number, y: number) => raw[mirror(y, H) * W + mirror(x, W)];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = 3 * (y * W + x);
      const c = bayerChannel(p, x, y);
      const v = at(x, y);
      const L = at(x - 1, y), R = at(x + 1, y), U = at(x, y - 1), D = at(x, y + 1);
      const LL = at(x - 2, y), RR = at(x + 2, y), UU = at(x, y - 2), DD = at(x, y + 2);
      const diag = at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1);
      if (c === 1) {
        // Green site: one of R/B lies left and right (horizontal kernel), the other above and below (its transpose)
        const hk = (5 * v + 4 * (L + R) - (LL + RR) - diag + 0.5 * (UU + DD)) / 8;
        const vk = (5 * v + 4 * (U + D) - (UU + DD) - diag + 0.5 * (LL + RR)) / 8;
        const rowHasR = bayerChannel(p, x + 1, y) === 0;
        d[i] = rowHasR ? hk : vk;
        d[i + 1] = v;
        d[i + 2] = rowHasR ? vk : hk;
      } else {
        // Red or blue site: green from the cross, the other color from the diagonals
        const g = (4 * v + 2 * (L + R + U + D) - (LL + RR + UU + DD)) / 8;
        const o = (6 * v + 2 * diag - 1.5 * (LL + RR + UU + DD)) / 8;
        d[i + c] = v;
        d[i + 1] = g;
        d[i + (2 - c)] = o;
      }
    }
  }
  return img;
}

/** PSNR in dB between two images after sRGB encoding (values clipped to [0, 1]). */
function psnr(a: Img, b: Img): number {
  let se = 0;
  for (let i = 0; i < a.data.length; i++) {
    const e = encode8(a.data[i]) - encode8(b.data[i]);
    se += e * e;
  }
  const mse = se / a.data.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

const STATUS: Record<string, string> = {
  truth: 'What a sensor with a full RGB triple at every pixel would record.',
  raw: 'One value per pixel, shown in the color of its filter. This is all the sensor measures.',
  rawReal: 'The 8-bit codes as stored in the file (companded: fine steps in the shadows, coarse in the highlights), one per pixel, in the color of its filter.',
  nearest: 'Blocky edges and color fringes: each 2 × 2 tile is effectively one pixel.',
  bilinear: 'Look for zipper patterns along patch borders and false color in the zone plate rings.',
  bilinearReal: 'Look for zipper patterns and colored fringes along the edges of the lettering.',
  malvar: 'Sharper edges and less fringing than bilinear, at the cost of a 5 × 5 neighbourhood.',
};

interface Source {
  kind: 'raw' | 'chart';
  w: number;
  h: number;
  /** Linear mosaic values, one per pixel. */
  mosaic: Float32Array;
  /** Ground truth (test chart only). */
  truth?: Img;
  /** Stored 8-bit codes and camera color data (real raw only). */
  sample?: RawSample;
  cache: Map<string, Img>;
  /** Magnifier position, in image pixels. */
  zx: number;
  zy: number;
}

function chartSource(): Source {
  const w = 240, h = 160;
  const truth = renderScene(w, h, 3);
  // Default magnifier: the outer rings of the zone plate, where aliasing is strongest
  return { kind: 'chart', w, h, mosaic: mosaic(truth, SENSOR), truth, cache: new Map(), zx: 203 - ZW / 2, zy: 66 - ZH / 2 };
}

function rawSource(sample: RawSample): Source {
  // Default magnifier: the lettering of the logo
  return { kind: 'raw', w: sample.w, h: sample.h, mosaic: sample.raw, sample, cache: new Map(), zx: 120, zy: 60 };
}

export function mountDemosaicCompare(root: HTMLElement): void {
  const main = root.querySelector<HTMLCanvasElement>('[data-main]')!;
  const zoom = root.querySelector<HTMLCanvasElement>('[data-zoom]')!;
  const box = root.querySelector<HTMLElement>('[data-zoom-box]')!;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const radio = (name: string, value: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;
  const truthChip = radio('demosaic-alg', 'truth');

  let chart: Source | null = null;
  let real: Source | null = null;
  let loading = true;

  const current = (): Source | null => {
    if (radioValue(root, 'demosaic-scene') === 'chart') return (chart ??= chartSource());
    return real;
  };

  const image = (src: Source, alg: string, p: BayerPattern): Img => {
    if (alg === 'truth' && src.truth) return src.truth;
    const key = `${alg}:${p}`;
    let img = src.cache.get(key);
    if (!img) {
      const { mosaic: m, w, h } = src;
      if (alg === 'raw') {
        if (src.sample) {
          // Stored codes, shown as they are (roughly perceptually spaced by the companding)
          img = makeImg(w, h);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data[3 * (y * w + x) + bayerChannel(p, x, y)] = src.sample.codes[y * w + x] / 255;
          src.cache.set(key, img);
          return img;
        }
        img = rawView(m, w, h, p);
      } else {
        if (alg === 'nearest') img = demosaicNearest(m, w, h, p);
        else if (alg === 'malvar') img = demosaicMalvar(m, w, h, p);
        else img = demosaicBilinear(m, w, h, p);
        if (src.sample) cameraToSrgb(img, src.sample.wb, src.sample.camToSrgb, RAW_EXPOSURE);
      }
      src.cache.set(key, img);
    }
    return img;
  };

  const drawZoomOnly = () => {
    const src = current();
    if (!src) return;
    drawZoom(zoom, main, src.zx, src.zy, ZW, ZH);
    Object.assign(box.style, {
      display: 'block',
      left: `${(src.zx / src.w) * 100}%`,
      top: `${(src.zy / src.h) * 100}%`,
      width: `${(ZW / src.w) * 100}%`,
      height: `${(ZH / src.h) * 100}%`,
    });
  };

  const draw = () => {
    const src = current();
    const status = out('status');
    truthChip.disabled = radioValue(root, 'demosaic-scene') === 'raw';
    if (!src) {
      status.textContent = loading ? 'Loading the raw file…' : '';
      box.style.display = 'none';
      return;
    }
    if (src.kind === 'raw' && radioValue(root, 'demosaic-alg') === 'truth') radio('demosaic-alg', 'bilinear').checked = true;
    const alg = radioValue(root, 'demosaic-alg');
    const p = radioValue(root, 'demosaic-pattern') as BayerPattern;
    const img = image(src, alg, p);
    drawImg(main, img, { encoded: src.kind === 'raw' && alg === 'raw' });
    drawZoomOnly();

    out('size').textContent = `${src.w} × ${src.h} px · drag to move the magnifier`;
    out('psnr').textContent = !src.truth
      ? 'n/a (a real sensor has no ground truth)'
      : alg === 'truth'
        ? '∞'
        : alg === 'raw'
          ? '—'
          : `${psnr(img, src.truth).toFixed(1)} dB`;
    const wrong = p !== SENSOR && alg !== 'truth';
    const real = src.kind === 'raw';
    status.textContent = wrong
      ? `Pattern mismatch: the decoder reads an RGGB sensor as ${p}, so the channels land in the wrong places.`
      : (real && STATUS[`${alg}Real`]) || STATUS[alg];
    status.classList.toggle('warn', wrong);
  };

  // Drag (or tap) on the image to move the magnifier
  const move = (event: PointerEvent) => {
    const src = current();
    if (!src) return;
    const r = main.getBoundingClientRect();
    const x = ((event.clientX - r.left) / r.width) * src.w;
    const y = ((event.clientY - r.top) / r.height) * src.h;
    src.zx = Math.round(Math.min(Math.max(x - ZW / 2, 0), src.w - ZW));
    src.zy = Math.round(Math.min(Math.max(y - ZH / 2, 0), src.h - ZH));
    redrawZoom();
  };
  const redrawZoom = scheduler(drawZoomOnly);
  main.addEventListener('pointerdown', (e) => {
    main.setPointerCapture(e.pointerId);
    move(e);
  });
  main.addEventListener('pointermove', (e) => {
    if (main.hasPointerCapture(e.pointerId)) move(e);
  });

  const redraw = scheduler(draw);
  root.querySelectorAll('input[type="radio"]').forEach((el) => el.addEventListener('change', redraw));

  loadRawSample('detail')
    .then((sample) => {
      real = rawSource(sample);
    })
    .catch(() => {
      // No raw file: fall back to the test chart
      radio('demosaic-scene', 'chart').checked = true;
      radio('demosaic-scene', 'raw').disabled = true;
    })
    .finally(() => {
      loading = false;
      redraw();
    });

  draw();
}
