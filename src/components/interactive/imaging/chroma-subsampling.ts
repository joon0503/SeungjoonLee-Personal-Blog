/**
 * Implementation of <ChromaSubsampling />. Loaded lazily by ChromaSubsampling.astro.
 *
 * The image (the real Sigma fp photo, or the shared test scene plus a strip
 * of saturated text and one-pixel colored stripes) is converted to 8-bit Y′CbCr from its
 * gamma-encoded R′G′B′ values. The chroma planes are box-averaged over
 * sx × sy blocks, upsampled back (nearest or bilinear, chroma sited at the
 * block centre) and converted to R′G′B′ for display.
 */
import { scheduler, svg } from '../camera/camera-math';
import { drawImg, drawZoom, loadPhoto, makeImg, radioValue, renderScene, srgbEncode } from './imaging';
import { dequantize, quantize, rgbToYcc, yccToRgb } from './yuv';

/* Test chart size. The photo is 480 × 320; both are divisible by 4 and 2 for every scheme. */
const CHART_W = 240;
const CHART_H = 200;
const SCENE_H = 160;
const ZW = 40; // zoom region in image pixels
const ZH = 25;

/** Chroma block size (horizontal, vertical) of each J:a:b scheme. */
const FACTORS: Record<string, [number, number]> = {
  '4:4:4': [1, 1],
  '4:2:2': [2, 1],
  '4:2:0': [2, 2],
  '4:1:1': [4, 1],
};

interface Source {
  w: number;
  h: number;
  /** Gamma-encoded R′G′B′ in [0, 1], interleaved. */
  rgb: Float32Array;
  /** Default top-left of the zoom region. */
  zoom: [number, number];
}

/** The test chart as gamma-encoded R′G′B′ in [0, 1], interleaved. */
function buildChart(): Source {
  const W = CHART_W, H = CHART_H;
  const sceneCanvas = document.createElement('canvas');
  drawImg(sceneCanvas, renderScene(W, SCENE_H, 2));

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(sceneCanvas, 0, 0);

  // Saturated text on colored backgrounds
  const blocks: [string, string, string][] = [
    ['#2340c8', '#ff2a2a', 'Chroma'],
    ['#000000', '#ff2a2a', '4:2:0'],
    ['#ffffff', '#1a3cff', 'YCbCr'],
  ];
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  blocks.forEach(([bg, fg, text], i) => {
    ctx.fillStyle = bg;
    ctx.fillRect(i * 80, SCENE_H, 80, 28);
    ctx.fillStyle = fg;
    ctx.fillText(text, i * 80 + 40, SCENE_H + 15);
  });

  // One-pixel stripes: vertical red/cyan on the left, horizontal green/magenta on the right
  for (let y = SCENE_H + 28; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const left = x < W / 2;
      const on = left ? x % 2 === 0 : y % 2 === 0;
      ctx.fillStyle = left ? (on ? '#ff3030' : '#20d0d0') : on ? '#30d040' : '#d030d0';
      ctx.fillRect(x, y, 1, 1);
    }
  }

  const px = ctx.getImageData(0, 0, W, H).data;
  const out = new Float32Array(W * H * 3);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    out[i] = px[j] / 255;
    out[i + 1] = px[j + 1] / 255;
    out[i + 2] = px[j + 2] / 255;
  }
  return { w: W, h: H, rgb: out, zoom: [6, 158] };
}

/** The developed Sigma fp photo, re-encoded to sRGB R′G′B′; the zoom starts on the ColorChecker. */
async function buildPhoto(): Promise<Source> {
  const img = await loadPhoto();
  const rgb = new Float32Array(img.data.length);
  for (let i = 0; i < rgb.length; i++) rgb[i] = srgbEncode(img.data[i]);
  return { w: img.w, h: img.h, rgb, zoom: [Math.round(img.w * 0.15), Math.round(img.h * 0.17)] };
}

export function mountChromaSubsampling(root: HTMLElement): void {
  const main = root.querySelector<HTMLCanvasElement>('[data-main]')!;
  const zoom = root.querySelector<HTMLCanvasElement>('[data-zoom]')!;
  const zoomBox = root.querySelector<HTMLElement>('[data-zoom-box]')!;
  const jab = root.querySelector<SVGSVGElement>('[data-jab]')!;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;

  // Full-resolution 8-bit planes (BT.709, full range) of the current source
  let W = 0, H = 0;
  let Y = new Uint8Array(0), Cb = Y, Cr = Y;
  let zx = 0; // top-left of the zoom region, image pixels
  let zy = 0;
  const setSource = (src: Source) => {
    W = src.w;
    H = src.h;
    const n = W * H;
    Y = new Uint8Array(n);
    Cb = new Uint8Array(n);
    Cr = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const [y, cb, cr] = rgbToYcc(src.rgb[3 * p], src.rgb[3 * p + 1], src.rgb[3 * p + 2], '709');
      [Y[p], Cb[p], Cr[p]] = quantize(y, cb, cr, 'full');
    }
    [zx, zy] = src.zoom;
  };

  const chart = buildChart();
  let photo: Source | null = null;
  let photoFailed = false;
  let currentScene = '';

  const draw = () => {
    const scene = radioValue(root, 'chroma-scene');
    if (scene !== currentScene) {
      if (scene === 'photo' && !photo) {
        if (photoFailed) {
          root.querySelector<HTMLInputElement>('input[name="chroma-scene"][value="chart"]')!.checked = true;
        } else {
          out('size').textContent = 'loading photo…';
          return;
        }
      }
      currentScene = radioValue(root, 'chroma-scene');
      setSource(currentScene === 'photo' ? photo! : chart);
    }
    const scheme = radioValue(root, 'chroma-scheme');
    const view = radioValue(root, 'chroma-view');
    const bilinear = radioValue(root, 'chroma-up') === 'bilinear';
    const [sx, sy] = FACTORS[scheme];
    const cw = Math.ceil(W / sx);
    const ch = Math.ceil(H / sy);

    // Subsample: box average of each sx × sy block
    const cb = new Float32Array(cw * ch);
    const cr = new Float32Array(cw * ch);
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        let a = 0, b = 0, k = 0;
        for (let y = j * sy; y < Math.min(H, (j + 1) * sy); y++) {
          for (let x = i * sx; x < Math.min(W, (i + 1) * sx); x++) {
            a += Cb[y * W + x];
            b += Cr[y * W + x];
            k++;
          }
        }
        cb[j * cw + i] = Math.round(a / k);
        cr[j * cw + i] = Math.round(b / k);
      }
    }

    // Chroma at full-resolution pixel (x, y)
    const sample = (plane: Float32Array, x: number, y: number): number => {
      if (!bilinear) return plane[Math.floor(y / sy) * cw + Math.floor(x / sx)];
      const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / sx - 0.5));
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / sy - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(ch - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const top = plane[y0 * cw + x0] * (1 - tx) + plane[y0 * cw + x1] * tx;
      const bot = plane[y1 * cw + x0] * (1 - tx) + plane[y1 * cw + x1] * tx;
      return top * (1 - ty) + bot * ty;
    };

    let canvasW = W, canvasH = H;
    const img = makeImg(W, H);
    if (view === 'result' || view === 'y') {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          const rgb =
            view === 'y'
              ? [Y[p] / 255, Y[p] / 255, Y[p] / 255]
              : yccToRgb(...dequantize(Y[p], sample(cb, x, y), sample(cr, x, y), 'full'), '709');
          img.data.set(rgb.map((v) => Math.min(1, Math.max(0, v))), 3 * p);
        }
      }
    } else {
      // A chroma plane at its stored resolution, shown on mid-gray luma
      canvasW = cw;
      canvasH = ch;
      img.w = cw;
      img.h = ch;
      img.data = new Float32Array(cw * ch * 3);
      const plane = view === 'cb' ? cb : cr;
      for (let p = 0; p < cw * ch; p++) {
        const [c1, c2] = view === 'cb' ? [plane[p], 128] : [128, plane[p]];
        const rgb = yccToRgb(...dequantize(128, c1, c2, 'full'), '709');
        img.data.set(rgb.map((v) => Math.min(1, Math.max(0, v))), 3 * p);
      }
    }
    drawImg(main, img, { encoded: true });

    // Zoom (the region is in full-resolution pixels; scale it for a chroma plane)
    const kx = canvasW / W, ky = canvasH / H;
    drawZoom(zoom, main, zx * kx, zy * ky, ZW * kx, ZH * ky);
    Object.assign(zoomBox.style, {
      left: `${(zx / W) * 100}%`,
      top: `${(zy / H) * 100}%`,
      width: `${(ZW / W) * 100}%`,
      height: `${(ZH / H) * 100}%`,
    });

    const titles: Record<string, string> = { result: 'Result', y: 'Y′ (luma) plane', cb: 'Cb plane', cr: 'Cr plane' };
    out('title').textContent = titles[view];
    out('size').textContent = `${canvasW} × ${canvasH} px`;

    // Readouts
    const chromaPerBlock = 8 / (sx * sy);
    out('samples').textContent = `8 Y′ + ${chromaPerBlock} Cb + ${chromaPerBlock} Cr`;
    const bpp = 1 + 2 / (sx * sy);
    out('bpp').textContent = `${bpp} (${bpp * 8} bits)`;
    const frame = 1920 * 1080 * bpp;
    out('frame').textContent = `${(frame / 1e6).toFixed(2)} MB`;
    out('rate').textContent = `${((frame * 30) / 1e6).toFixed(0)} MB/s (${((frame * 30 * 8) / 1e6).toFixed(0)} Mbit/s)`;

    drawJab(jab, sx, sy);
  };

  const redraw = scheduler(draw);
  root.querySelectorAll('input').forEach((el) => el.addEventListener('change', redraw));
  buildPhoto()
    .then((p) => (photo = p))
    .catch(() => (photoFailed = true))
    .finally(redraw);

  // Drag on the image to move the zoom region
  const move = (e: PointerEvent) => {
    const r = main.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    zx = Math.round(Math.min(W - ZW, Math.max(0, x - ZW / 2)));
    zy = Math.round(Math.min(H - ZH, Math.max(0, y - ZH / 2)));
    redraw();
  };
  main.addEventListener('pointerdown', (e) => {
    main.setPointerCapture(e.pointerId);
    move(e);
  });
  main.addEventListener('pointermove', (e) => {
    if (main.hasPointerCapture(e.pointerId)) move(e);
  });

  draw();
}

/** A 4 × 2 grid of luma samples with one tinted region and dot per stored chroma sample. */
function drawJab(el: SVGSVGElement, sx: number, sy: number): void {
  const S = 40, X0 = 4, Y0 = 4;
  const g: SVGElement[] = [];
  for (let j = 0; j < 2 / sy; j++) {
    for (let i = 0; i < 4 / sx; i++) {
      const x = X0 + i * sx * S, y = Y0 + j * sy * S;
      g.push(
        svg('rect', { x: x + 3, y: y + 3, width: sx * S - 6, height: sy * S - 6, rx: 4 }, { fill: 'var(--accent)', fillOpacity: '0.14', stroke: 'var(--accent)', strokeWidth: '1.5' }),
        svg('circle', { cx: x + (sx * S) / 2, cy: y + (sy * S) / 2, r: 6 }, { fill: 'var(--ch-r)', stroke: 'var(--bg)', strokeWidth: '1.5' }),
      );
    }
  }
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 4; i++) {
      g.push(
        svg('rect', { x: X0 + i * S, y: Y0 + j * S, width: S, height: S }, { fill: 'none', stroke: 'var(--border-strong)', strokeWidth: '1' }),
        svg('circle', { cx: X0 + i * S + 8, cy: Y0 + j * S + 8, r: 2.5 }, { fill: 'var(--text-muted)' }),
      );
    }
  }
  el.replaceChildren(...g);
}
