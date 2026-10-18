/**
 * Implementation of <RangeExplorer />. Loaded lazily by RangeExplorer.astro.
 *
 * Gamma-encoded R′G′B′ → 8-bit Y′CbCr with the encoder's range and matrix,
 * → R′G′B′ with the decoder's, clipped to [0, 255] as a display would.
 * The image is the real Sigma fp photo (downscaled to 240 × 160) or the
 * shared test scene, with a black → white ramp underneath either.
 */
import { renderMatrix, scheduler, svg } from '../camera/camera-math';
import { COLOR_CHECKER, type Img, drawImg, loadPhoto, makeImg, radioValue, renderScene, srgbEncode } from './imaging';
import { dequantize, quantize, rgbToYcc, yccMatrix, yccToRgb, type YuvMatrix, type YuvRange } from './yuv';

const W = 240;
const SCENE_H = 160;
const H = 184;

interface Codec {
  encRange: YuvRange;
  encMatrix: YuvMatrix;
  decRange: YuvRange;
  decMatrix: YuvMatrix;
}

/** Round-trip one R′G′B′ ∈ [0, 1] color; returns the displayed 8-bit codes. */
function roundTrip(r: number, g: number, b: number, c: Codec): [number, number, number] {
  const codes = quantize(...rgbToYcc(r, g, b, c.encMatrix), c.encRange);
  const rgb = yccToRgb(...dequantize(...codes, c.decRange), c.decMatrix);
  return rgb.map((v) => Math.round(255 * Math.min(1, Math.max(0, v)))) as [number, number, number];
}

const code = (lin: number) => Math.round(255 * srgbEncode(lin));

/** Halve a linear image by 2 × 2 box averaging (480 × 320 photo → 240 × 160). */
function halve(img: Img): Img {
  const w = img.w >> 1, h = img.h >> 1;
  const out = makeImg(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++) {
        const at = (dx: number, dy: number) => img.data[3 * ((2 * y + dy) * img.w + 2 * x + dx) + k];
        out.data[3 * (y * w + x) + k] = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4;
      }
    }
  }
  return out;
}

/** A linear W × SCENE_H scene, sRGB-encoded, with a black → white ramp underneath. */
function withRamp(scene: Img): Img {
  const src = makeImg(W, H);
  for (let p = 0; p < W * SCENE_H * 3; p++) src.data[p] = srgbEncode(scene.data[p]);
  for (let y = SCENE_H; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.round((x / (W - 1)) * 255) / 255;
      src.data.fill(v, 3 * (y * W + x), 3 * (y * W + x) + 3);
    }
  }
  return src;
}

export function mountRangeExplorer(root: HTMLElement): void {
  const original = root.querySelector<HTMLCanvasElement>('[data-original]')!;
  const decoded = root.querySelector<HTMLCanvasElement>('[data-decoded]')!;
  const plot = root.querySelector<SVGSVGElement>('[data-plot]')!;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;

  // Sources: the photo (once loaded) or the test chart, each with the gray ramp underneath
  const chart = withRamp(renderScene(W, SCENE_H, 2));
  let photo: Img | null = null;
  let photoFailed = false;
  loadPhoto()
    .then((img) => (photo = withRamp(halve(img))))
    .catch(() => (photoFailed = true))
    .finally(() => redraw());

  const red = COLOR_CHECKER[14].map(code) as [number, number, number];
  const green = COLOR_CHECKER[13].map(code) as [number, number, number];

  const draw = () => {
    if (radioValue(root, 'range-scene') === 'photo' && !photo) {
      if (!photoFailed) {
        out('status').textContent = 'Loading photo…';
        return;
      }
      root.querySelector<HTMLInputElement>('input[name="range-scene"][value="chart"]')!.checked = true;
    }
    const src = radioValue(root, 'range-scene') === 'photo' ? photo! : chart;
    drawImg(original, src, { encoded: true });

    const c: Codec = {
      encRange: radioValue(root, 'range-enc-range') as YuvRange,
      encMatrix: radioValue(root, 'range-enc-matrix') as YuvMatrix,
      decRange: radioValue(root, 'range-dec-range') as YuvRange,
      decMatrix: radioValue(root, 'range-dec-matrix') as YuvMatrix,
    };

    const dst = makeImg(W, H);
    const s = src.data;
    for (let i = 0; i < s.length; i += 3) {
      const rgb = roundTrip(s[i], s[i + 1], s[i + 2], c);
      dst.data[i] = rgb[0] / 255;
      dst.data[i + 1] = rgb[1] / 255;
      dst.data[i + 2] = rgb[2] / 255;
    }
    drawImg(decoded, dst, { encoded: true });

    // Transfer curve of the gray ramp
    const curve: [number, number][] = [];
    for (let v = 0; v <= 255; v++) curve.push([v, roundTrip(v / 255, v / 255, v / 255, c)[0]]);
    drawPlot(plot, curve);

    // Readouts
    const limited = c.encRange === 'limited';
    out('stored').textContent = limited ? 'Y′ = 16 / 235' : 'Y′ = 0 / 255';
    out('chroma').textContent = limited ? '16 – 240 (128 = neutral)' : '0 – 255 (128 = neutral)';
    out('shown').textContent = `${curve[0][1]} / ${curve[255][1]}`;
    const fmtRgb = (v: number[]) => `(${v.join(', ')})`;
    out('red').textContent = `${fmtRgb(red)} → ${fmtRgb(roundTrip(red[0] / 255, red[1] / 255, red[2] / 255, c))}`;
    out('green').textContent = `${fmtRgb(green)} → ${fmtRgb(roundTrip(green[0] / 255, green[1] / 255, green[2] / 255, c))}`;
    renderMatrix(out('matrix'), yccMatrix(c.encMatrix), 3);

    const msgs: string[] = [];
    if (c.encRange === 'limited' && c.decRange === 'full') msgs.push('Washed out: black is shown as 16/255 gray and white as 235/255, and colors lose saturation.');
    if (c.encRange === 'full' && c.decRange === 'limited') msgs.push('Crushed: codes below 16 and above 235 clip, so shadow and highlight detail is lost and contrast is exaggerated.');
    if (c.encMatrix !== c.decMatrix) msgs.push(`Hue shift from the BT.${c.encMatrix}/${c.decMatrix} mismatch: grays are untouched, but look at the red and green patches.`);
    const status = out('status');
    status.textContent = msgs.length ? msgs.join(' ') : 'Match: the decoder inverts the encoder (up to 8-bit rounding).';
    status.classList.toggle('warn', msgs.length > 0);
  };

  const redraw = scheduler(draw);
  root.querySelectorAll('input').forEach((el) => el.addEventListener('change', redraw));
  draw();
}

/** Plot displayed code against input code on [0, 255]², with the identity dashed and the 16/235 levels marked. */
function drawPlot(el: SVGSVGElement, curve: [number, number][]): void {
  const L = 48, T = 10, S = 200 / 255; // plot origin and scale (200 px for 255 codes)
  const X = (v: number) => L + v * S;
  const Y = (v: number) => T + 200 - v * S;
  const label = (x: number, y: number, text: string, anchor = 'middle') =>
    Object.assign(svg('text', { x, y, 'text-anchor': anchor }, { fill: 'var(--text-muted)', fontSize: '11px' }), { textContent: text });

  const g: SVGElement[] = [
    svg('rect', { x: X(0), y: Y(255), width: 200, height: 200 }, { fill: 'none', stroke: 'var(--border-strong)' }),
  ];
  for (const v of [16, 235]) {
    g.push(
      svg('line', { x1: X(v), y1: Y(0), x2: X(v), y2: Y(255) }, { stroke: 'var(--border-strong)', strokeDasharray: '2 3' }),
      svg('line', { x1: X(0), y1: Y(v), x2: X(255), y2: Y(v) }, { stroke: 'var(--border-strong)', strokeDasharray: '2 3' }),
    );
  }
  for (const v of [0, 128, 255]) {
    g.push(label(X(v), Y(0) + 14, String(v)), label(X(0) - 5, Y(v) + 4, String(v), 'end'));
  }
  g.push(
    label(X(16) + 3, Y(255) + 12, '16', 'start'),
    label(X(235) - 3, Y(255) + 12, '235', 'end'),
    svg('line', { x1: X(0), y1: Y(0), x2: X(255), y2: Y(255) }, { stroke: 'var(--text-faint)', strokeDasharray: '5 4', strokeWidth: '1.2' }),
    svg('polyline', { points: curve.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ') }, { fill: 'none', stroke: 'var(--accent)', strokeWidth: '2.2' }),
    label(X(127.5), Y(0) + 30, 'input gray code'),
  );
  const yLabel = label(0, 0, 'displayed gray code');
  yLabel.setAttribute('transform', `translate(${L - 30}, ${Y(127.5)}) rotate(-90)`);
  g.push(yLabel);
  el.replaceChildren(...g);
}
