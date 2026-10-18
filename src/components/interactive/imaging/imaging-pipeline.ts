/**
 * Implementation of <ImagingPipeline />. Loaded lazily by ImagingPipeline.astro.
 *
 * Hovering over or clicking a stage highlights it and shows the real raw
 * sample (480 × 320 RGGB mosaic, see imaging.ts) as it looks after that
 * stage. Until the gamma stage, values are linear and are written to the
 * display as they are, which is why those previews look dark.
 */
import {
  type Img,
  type RawSample,
  bayerChannel,
  demosaicBilinear,
  drawImg,
  loadPhoto,
  loadRawSample,
  makeImg,
  srgbEncode,
} from './imaging';
import { quantize, rgbToYcc, yccToRgb } from './yuv';

/** Exposure applied by the analog gain stage (and kept from then on). */
const GAIN = 2.4;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** One value per pixel, shown as gray or in the color of its filter. */
function mosaicImg(s: RawSample, value: (i: number) => number, colored: boolean): Img {
  const img = makeImg(s.w, s.h);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      const v = clamp01(value(i));
      if (colored) img.data[3 * i + bayerChannel(s.pattern, x, y)] = v;
      else img.data[3 * i] = img.data[3 * i + 1] = img.data[3 * i + 2] = v;
    }
  }
  return img;
}

/** White-balanced, exposed linear mosaic (black level removed). */
function balanced(s: RawSample): Float32Array {
  const m = new Float32Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = y * s.w + x;
      m[i] = s.raw[i] * GAIN * s.wb[bayerChannel(s.pattern, x, y)];
    }
  }
  return m;
}

function applyMatrix(img: Img, M: [number, number, number][]): Img {
  const d = img.data;
  for (let i = 0; i < d.length; i += 3) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = M[0][0] * r + M[0][1] * g + M[0][2] * b;
    d[i + 1] = M[1][0] * r + M[1][1] * g + M[1][2] * b;
    d[i + 2] = M[2][0] * r + M[2][1] * g + M[2][2] * b;
  }
  return img;
}

const clampImg = (img: Img): Img => {
  for (let i = 0; i < img.data.length; i++) img.data[i] = clamp01(img.data[i]);
  return img;
};

/** 8-bit Y′, Cb, Cr planes (BT.709, full range) of a linear image. */
function toYcc(img: Img): [Uint8Array, Uint8Array, Uint8Array] {
  const n = img.w * img.h;
  const Y = new Uint8Array(n), Cb = new Uint8Array(n), Cr = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = [0, 1, 2].map((k) => srgbEncode(clamp01(img.data[3 * i + k])));
    [Y[i], Cb[i], Cr[i]] = quantize(...rgbToYcc(r, g, b, '709'), 'full');
  }
  return [Y, Cb, Cr];
}

/** Y′CbCr planes → displayable R′G′B′ image (values already gamma encoded). */
function fromYcc(w: number, h: number, Y: Uint8Array, Cb: Uint8Array, Cr: Uint8Array): Img {
  const img = makeImg(w, h);
  for (let i = 0; i < w * h; i++) {
    const rgb = yccToRgb(Y[i] / 255, (Cb[i] - 128) / 255, (Cr[i] - 128) / 255, '709');
    for (let k = 0; k < 3; k++) img.data[3 * i + k] = clamp01(rgb[k]);
  }
  return img;
}

/** 2 × 2-averaged chroma planes (4:2:0), at half resolution. */
function subsample420(w: number, h: number, C: Uint8Array): Uint8Array {
  const out = new Uint8Array((w / 2) * (h / 2));
  for (let y = 0; y < h / 2; y++) {
    for (let x = 0; x < w / 2; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * (w / 2) + x] = Math.round((C[i] + C[i + 1] + C[i + w] + C[i + w + 1]) / 4);
    }
  }
  return out;
}

const hex = (bytes: ArrayLike<number>, n: number) =>
  Array.from({ length: n }, (_, i) => bytes[i].toString(16).toUpperCase().padStart(2, '0')).join(' ');

interface Preview {
  img: Img;
  /** Values already display-encoded (linear stages, and anything after gamma). */
  encoded: boolean;
  bytes?: string;
}

export function mountImagingPipeline(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-canvas]')!;
  const bytesEl = root.querySelector<HTMLElement>('[data-bytes]')!;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const stageEls = [...root.querySelectorAll<SVGGElement>('.stage')];
  const links = [...root.querySelectorAll<SVGPathElement>('.link')];
  const keys = stageEls.map((el) => el.dataset.stage!);
  const labels = new Map(stageEls.map((el) => [el.dataset.stage!, el.querySelector('.stage-label')!.textContent!.trim()]));

  let sample: RawSample | null = null;
  let photo: Img | null = null;
  let failed = false;
  let current = 'lens';
  const cache = new Map<string, Preview>();

  /** Linear, white-balanced, demosaiced image in sRGB primaries (the input to the gamma stage). */
  let finalLinear: Img | null = null;
  const getFinal = (s: RawSample) => (finalLinear ??= applyMatrix(demosaicBilinear(balanced(s), s.w, s.h, s.pattern), s.camToSrgb));

  const build = (key: string, s: RawSample): Preview => {
    const enc = (img: Img): Preview => ({ img: clampImg(img), encoded: true });
    switch (key) {
      case 'lens':
        return { img: photo!, encoded: false };
      case 'cfa':
        return enc(mosaicImg(s, (i) => s.lut[s.codes[i]] * GAIN, true));
      case 'photodiode':
        return enc(mosaicImg(s, (i) => s.lut[s.codes[i]], false));
      case 'gain':
        return enc(mosaicImg(s, (i) => s.lut[s.codes[i]] * GAIN, false));
      case 'adc':
        return enc(mosaicImg(s, (i) => s.codes[i] / 255, false));
      case 'black':
      case 'lsc':
        return enc(mosaicImg(s, (i) => s.raw[i] * GAIN, false));
      case 'wb': {
        const m = balanced(s);
        return enc(mosaicImg(s, (i) => m[i], true));
      }
      case 'demosaic':
        return enc(demosaicBilinear(balanced(s), s.w, s.h, s.pattern));
      case 'ccm': {
        const f = getFinal(s);
        return enc({ ...f, data: f.data.slice() });
      }
      case 'gamma':
      case 'denoise':
        return { img: getFinal(s), encoded: false };
      case 'ycc': {
        // Quad view at half size: Y′ | Cb over Cr | image
        const f = getFinal(s);
        const [Y, Cb, Cr] = toYcc(f);
        const rgb = fromYcc(s.w, s.h, Y, Cb, Cr);
        const img = makeImg(s.w, s.h);
        const hw = s.w / 2, hh = s.h / 2;
        for (let y = 0; y < hh; y++) {
          for (let x = 0; x < hw; x++) {
            const src = 2 * y * s.w + 2 * x;
            const put = (ox: number, oy: number, v: [number, number, number]) => img.data.set(v, 3 * ((oy + y) * s.w + ox + x));
            put(0, 0, [Y[src] / 255, Y[src] / 255, Y[src] / 255]);
            put(hw, 0, [Cb[src] / 255, Cb[src] / 255, Cb[src] / 255]);
            put(hw, hh, [Cr[src] / 255, Cr[src] / 255, Cr[src] / 255]);
            put(0, hh, [rgb.data[3 * src], rgb.data[3 * src + 1], rgb.data[3 * src + 2]]);
          }
        }
        return { img, encoded: true };
      }
      case 'chroma':
      case 'pack': {
        const f = getFinal(s);
        const { w, h } = s;
        const [Y, Cb, Cr] = toYcc(f);
        const cb = subsample420(w, h, Cb), cr = subsample420(w, h, Cr);
        // Nearest-neighbor upsampling back to full size for display
        const up = (C: Uint8Array) => Uint8Array.from({ length: w * h }, (_, i) => C[((i / w) >> 1) * (w / 2) + ((i % w) >> 1)]);
        const img = fromYcc(w, h, Y, up(cb), up(cr));
        if (key === 'chroma') return { img, encoded: true };
        const uv = new Uint8Array(cb.length * 2);
        for (let i = 0; i < cb.length; i++) {
          uv[2 * i] = cb[i];
          uv[2 * i + 1] = cr[i];
        }
        const size = Y.length + uv.length;
        const bytes = [
          `NV12, ${w} × ${h}: ${size.toLocaleString('en-US')} bytes`,
          `@0        Y′ plane (1 byte per pixel)`,
          `  ${hex(Y, 12)} …`,
          `@${String(Y.length).padEnd(8)} CbCr plane (Cb Cr per 2 × 2)`,
          `  ${hex(uv, 12)} …`,
        ].join('\n');
        return { img, encoded: true, bytes };
      }
    }
    throw new Error(`unknown stage ${key}`);
  };

  const render = () => {
    out('title').textContent = `After: ${labels.get(current)}`;
    out('step').textContent = `${keys.indexOf(current) + 1} / ${keys.length}`;
    bytesEl.hidden = true;
    if (!sample || !photo) {
      if (failed) out('title').textContent = 'The sample image could not be loaded.';
      return;
    }
    let p = cache.get(current);
    if (!p) cache.set(current, (p = build(current, sample)));
    drawImg(canvas, p.img, { encoded: p.encoded });
    if (p.bytes) {
      bytesEl.textContent = p.bytes;
      bytesEl.hidden = false;
    }
  };

  const select = (key: string, focus = false) => {
    current = key;
    const k = keys.indexOf(key);
    stageEls.forEach((el, i) => {
      el.setAttribute('aria-pressed', String(i === k));
      el.classList.toggle('done', i < k);
    });
    links.forEach((el) => el.classList.toggle('done', Number(el.dataset.after) < k));
    if (focus) stageEls[k].focus();
    render();
  };
  const step = (d: number, focus = false) => select(keys[(keys.indexOf(current) + d + keys.length) % keys.length], focus);

  stageEls.forEach((el) => {
    el.addEventListener('click', () => select(el.dataset.stage!));
    el.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && el.dataset.stage !== current) select(el.dataset.stage!);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') select(el.dataset.stage!);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(1, true);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(-1, true);
      else return;
      e.preventDefault();
    });
  });

  Promise.all([loadRawSample('scene'), loadPhoto()])
    .then(([s, ph]) => {
      sample = s;
      photo = ph;
    })
    .catch(() => (failed = true))
    .finally(render);

  render();
}
