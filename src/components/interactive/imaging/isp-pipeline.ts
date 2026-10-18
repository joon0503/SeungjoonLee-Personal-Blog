/**
 * Implementation of <IspPipeline />. Loaded lazily by IspPipeline.astro.
 *
 * Sensor model: scene reflectance × illuminant → camera RGB through a
 * "sensor response" matrix with crosstalk (the color filters overlap and
 * green is the most sensitive) → lens vignetting → RGGB mosaic → black
 * level, noise and 10-bit quantization.
 *
 * The ISP then undoes this step by step: black level subtraction, lens
 * shading correction, white balance (on the mosaic, as real ISPs do),
 * bilinear demosaicing, a color correction matrix and the sRGB gamma.
 *
 * The real-raw mode runs the same stages on a Sigma fp capture (480 × 320
 * binned RGGB mosaic, see imaging.ts) with one extra stage in front:
 * linearizing the stored 8-bit codes through the DNG's linearization table
 * (to 12 bits, black level 256). The file has no lens shading data, so that
 * stage is skipped; white balance and the color matrix are the camera's own.
 */
import { type Mat3, type Vec3, matMul, matVec, renderMatrix, scheduler } from '../camera/camera-math';
import {
  type Img,
  type RawSample,
  bayerChannel,
  loadRawSample,
  demosaicBilinear,
  drawImg,
  gaussian,
  makeImg,
  radioValue,
  renderScene,
  rng,
  srgbDecode,
} from './imaging';

const W = 300;
const H = 200;
const BITS_MAX = 1023;
const BLACK = 64;
const PATTERN = 'RGGB';
/** Exposure: a 90 % white patch fills ~75 % of the green channel's range. */
const EXPOSURE = 0.76;
/** Exposure multiplier for the real raw capture, applied to the linearized values. */
const RAW_EXPOSURE = 2.4;

/** Camera RGB = SENSOR · (linear sRGB radiance). Rows overlap; green is most sensitive. */
const SENSOR: Mat3 = [
  [0.7, 0.25, 0.05],
  [0.12, 0.8, 0.18],
  [0.03, 0.22, 0.6],
];

function inverse3(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

const diag = (v: Vec3): Mat3 => [
  [v[0], 0, 0],
  [0, v[1], 0],
  [0, 0, v[2]],
];

/** White balance gains (G = 1) that make a neutral surface under `light` neutral. */
function presetGains(light: Vec3): Vec3 {
  const white = matVec(SENSOR, light);
  return [white[1] / white[0], 1, white[1] / white[2]];
}

/**
 * Color correction matrix: undo the sensor's channel mixing after white
 * balance under the reference (6500 K) light, with rows scaled to sum to 1
 * so that white stays white under any light once it is white balanced.
 */
const CCM: Mat3 = (() => {
  const M = inverse3(matMul(diag(presetGains([1, 1, 1])), SENSOR));
  return M.map((row) => {
    const s = row[0] + row[1] + row[2];
    return row.map((v) => v / s);
  }) as Mat3;
})();

/**
 * Approximate black-body color at `kelvin` (Tanner Helland's curve fit),
 * linearized and normalized so that 6500 K is (1, 1, 1). Good enough to
 * tint the scene; not a colorimetric model.
 */
function lightColor(kelvin: number): Vec3 {
  const raw = (k: number): Vec3 => {
    const t = k / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [r, g, b].map((v) => srgbDecode(Math.min(255, Math.max(0, v)) / 255)) as Vec3;
  };
  const c = raw(kelvin);
  const ref = raw(6500);
  return [c[0] / ref[0], c[1] / ref[1], c[2] / ref[2]];
}

/** Relative illumination of the lens: cos⁴ falloff, 50 % in the corners. */
const VIGNETTE = (() => {
  const v = new Float32Array(W * H);
  const k = 0.644; // tan θ at the corner, where cos⁴ θ = 0.5
  const halfDiag = Math.hypot(W / 2, H / 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) / halfDiag;
      v[y * W + x] = Math.pow(Math.cos(Math.atan(r * k)), 4);
    }
  }
  return v;
})();

/** Simulated 10-bit raw mosaic of the scene under `light`. */
function capture(scene: Img, light: Vec3): Uint16Array {
  const raw = new Uint16Array(W * H);
  const noise = gaussian(rng(7));
  const d = scene.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = bayerChannel(PATTERN, x, y);
      const row = SENSOR[c];
      const e = row[0] * d[3 * i] * light[0] + row[1] * d[3 * i + 1] * light[1] + row[2] * d[3 * i + 2] * light[2];
      const signal = e * EXPOSURE * VIGNETTE[i] * (BITS_MAX - BLACK);
      const dn = BLACK + signal + noise() * Math.sqrt(1.5 + 0.08 * signal);
      raw[i] = Math.max(0, Math.min(BITS_MAX, Math.round(dn)));
    }
  }
  return raw;
}

/**
 * Gray-world white balance: the mean of each channel should be equal.
 * 2 × 2 cells with a clipped pixel are ignored, since clipping is not neutral.
 */
function grayWorldGains(raw: Uint16Array): Vec3 {
  const sum = [0, 0, 0];
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const cell = [y * W + x, y * W + x + 1, (y + 1) * W + x, (y + 1) * W + x + 1];
      if (cell.some((i) => raw[i] >= BITS_MAX - 8)) continue;
      cell.forEach((i, k) => (sum[bayerChannel(PATTERN, x + (k & 1), y + (k >> 1))] += (raw[i] - BLACK) / VIGNETTE[i]));
    }
  }
  // Twice as many green pixels as red or blue
  return [sum[1] / 2 / sum[0], 1, sum[1] / 2 / sum[2]];
}

/** Gray-world gains on a real raw mosaic (values in [0, 1]), skipping 2 × 2 cells with a clipped pixel. */
function grayWorldGainsRaw(s: RawSample): Vec3 {
  const sum = [0, 0, 0];
  for (let y = 0; y + 1 < s.h; y += 2) {
    for (let x = 0; x + 1 < s.w; x += 2) {
      const cell = [y * s.w + x, y * s.w + x + 1, (y + 1) * s.w + x, (y + 1) * s.w + x + 1];
      if (cell.some((i) => s.raw[i] >= 0.98)) continue;
      cell.forEach((i, k) => (sum[bayerChannel(s.pattern, x + (k & 1), y + (k >> 1))] += s.raw[i]));
    }
  }
  return [sum[1] / 2 / sum[0], 1, sum[1] / 2 / sum[2]];
}

export function mountIspPipeline(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-canvas]')!;
  const inputs = new Map<string, HTMLInputElement>();
  root.querySelectorAll<HTMLInputElement>('input[data-in]').forEach((el) => inputs.set(el.dataset.in!, el));
  const on = (key: string) => inputs.get(key)!.checked;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const initial = new Map([...root.querySelectorAll<HTMLInputElement>('input')].map((el) => [el, el.type === 'range' ? el.value : el.checked]));

  const scene = renderScene(W, H, 2);
  let cct = NaN;
  let light: Vec3 = [1, 1, 1];
  let raw: Uint16Array = new Uint16Array(0);
  let autoGains: Vec3 = [1, 1, 1];
  let lastGains: Vec3 = [1, 1, 1];
  let lastMode = radioValue(root, 'isp-wb');
  let sample: RawSample | null = null;
  let sampleGray: Vec3 = [1, 1, 1];
  let loading = true;
  let shownMode = '';
  const radio = (name: string, value: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;

  const draw = () => {
    const real = radioValue(root, 'isp-scene') === 'raw';
    // Controls that only make sense for one of the two sources
    root.querySelectorAll<HTMLElement>('[data-raw-only]').forEach((el) => (el.hidden = !real));
    inputs.get('lsc')!.disabled = real;
    inputs.get('cct')!.disabled = real;
    out('presetLabel').textContent = real ? 'As shot (camera)' : 'Preset for this light';
    if (real !== (shownMode === 'raw')) {
      shownMode = real ? 'raw' : 'sim';
      renderMatrix(out('ccm'), real && sample ? sample.camToSrgb : CCM, 2);
    }
    if (real) {
      if (!sample) {
        out('status').textContent = loading ? 'Loading the raw file…' : '';
        return;
      }
      drawRaw(sample);
      return;
    }

    const k = Number(inputs.get('cct')!.value);
    if (k !== cct) {
      cct = k;
      light = lightColor(k);
      raw = capture(scene, light);
      autoGains = grayWorldGains(raw);
    }
    out('cct').textContent = `${k} K`;

    // White balance gains for the selected mode
    const mode = radioValue(root, 'isp-wb');
    const gr = inputs.get('gr')!;
    const gb = inputs.get('gb')!;
    if (mode === 'manual' && lastMode !== 'manual') {
      // Start manual adjustment from the gains that were just applied
      gr.value = String(lastGains[0]);
      gb.value = String(lastGains[2]);
    }
    lastMode = mode;
    gr.disabled = gb.disabled = mode !== 'manual';
    const gains: Vec3 =
      mode === 'preset' ? presetGains(light) : mode === 'auto' ? autoGains : [Number(gr.value), 1, Number(gb.value)];
    lastGains = gains;
    out('gr').textContent = gains[0].toFixed(2);
    out('gb').textContent = gains[2].toFixed(2);

    // Stages 1–3 work on the mosaic, one value per pixel
    const blc = on('blc'), lsc = on('lsc'), wb = on('wb'), dem = on('demosaic'), ccm = on('ccm'), gamma = on('gamma');
    const mos = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let v = raw[i] / BITS_MAX;
        if (blc) v = (raw[i] - BLACK) / (BITS_MAX - BLACK);
        if (lsc) v /= VIGNETTE[i];
        if (wb) v *= gains[bayerChannel(PATTERN, x, y)];
        mos[i] = v;
      }
    }

    // Stage 4: demosaic, or show the mosaic itself
    let img: Img;
    if (dem) {
      img = demosaicBilinear(mos, W, H, PATTERN);
    } else {
      img = makeImg(W, H);
      const cfa = radioValue(root, 'isp-raw') === 'cfa';
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const c = bayerChannel(PATTERN, x, y);
          if (cfa) img.data[3 * i + c] = mos[i];
          else img.data[3 * i] = img.data[3 * i + 1] = img.data[3 * i + 2] = mos[i];
        }
      }
    }

    // Stage 5: color correction (needs all three channels at every pixel)
    if (dem && ccm) {
      const d = img.data;
      for (let i = 0; i < d.length; i += 3) {
        const [r, g, b] = matVec(CCM, [d[i], d[i + 1], d[i + 2]]);
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
      }
    }

    // Stage 6: sRGB gamma, or linear values written straight to the display
    if (!gamma) {
      const d = img.data;
      for (let i = 0; i < d.length; i++) d[i] = Math.min(1, Math.max(0, d[i]));
    }
    drawImg(canvas, img, { encoded: !gamma });

    out('title').textContent = dem ? 'Output image' : 'Raw mosaic (one color per pixel)';
    out('size').textContent = `${W} × ${H} px`;
    out('illum').textContent = light.map((v) => v.toFixed(2)).join(', ');
    out('gains').textContent = wb ? gains.map((v) => v.toFixed(2)).join(', ') : 'off';

    const notes: string[] = [];
    if (!blc) notes.push('No black level subtraction: blacks are lifted to gray and colors look washed out.');
    if (!lsc) notes.push('No lens shading correction: the corners are darker than the center.');
    if (!wb) notes.push('No white balance: neutral patches take on the color of the light and the green bias of the sensor.');
    else if (mode === 'auto') notes.push('Gray world assumes the scene averages to gray; close here, but not exact.');
    if (!dem) notes.push('No demosaicing: each pixel has only one color, so the color matrix is skipped.');
    else if (!ccm) notes.push('No color matrix: colors are muted, because the sensor’s color filters overlap.');
    if (!gamma) notes.push('No gamma: linear values look dark, with the shadows crushed.');
    out('status').textContent = notes.length ? notes.join(' ') : 'All stages on: the gray patches are neutral and the colors match the chart.';
  };

  /** The same pipeline on the real raw capture. */
  const drawRaw = (s: RawSample) => {
    const { w, h, pattern } = s;
    const mode = radioValue(root, 'isp-wb');
    const gr = inputs.get('gr')!;
    const gb = inputs.get('gb')!;
    if (mode === 'manual' && lastMode !== 'manual') {
      gr.value = String(lastGains[0]);
      gb.value = String(lastGains[2]);
    }
    lastMode = mode;
    gr.disabled = gb.disabled = mode !== 'manual';
    const gains: Vec3 = mode === 'preset' ? s.wb : mode === 'auto' ? sampleGray : [Number(gr.value), 1, Number(gb.value)];
    lastGains = gains;
    out('gr').textContent = gains[0].toFixed(2);
    out('gb').textContent = gains[2].toFixed(2);

    const lin = on('lin'), blc = on('blc'), wb = on('wb'), dem = on('demosaic'), ccm = on('ccm'), gamma = on('gamma');
    // Stage 0: decode the companded codes through the table; off, the codes are taken as linear values.
    // Stage 1 subtracts the black level in whichever domain stage 0 left the values.
    const black = lin ? s.black : s.blackCode / 255;
    const mos = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = lin ? s.lut[s.codes[i]] : s.codes[i] / 255;
        if (blc) v = Math.max(0, (v - black) / (1 - black));
        if (lin) v *= RAW_EXPOSURE;
        if (wb) v *= gains[bayerChannel(pattern, x, y)];
        mos[i] = v;
      }
    }

    let img: Img;
    if (dem) {
      img = demosaicBilinear(mos, w, h, pattern);
    } else {
      img = makeImg(w, h);
      const cfa = radioValue(root, 'isp-raw') === 'cfa';
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (cfa) img.data[3 * i + bayerChannel(pattern, x, y)] = mos[i];
          else img.data[3 * i] = img.data[3 * i + 1] = img.data[3 * i + 2] = mos[i];
        }
      }
    }
    if (dem && ccm) {
      const M = s.camToSrgb;
      const d = img.data;
      for (let i = 0; i < d.length; i += 3) {
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
        d[i] = M[0][0] * r + M[0][1] * g + M[0][2] * b;
        d[i + 1] = M[1][0] * r + M[1][1] * g + M[1][2] * b;
        d[i + 2] = M[2][0] * r + M[2][1] * g + M[2][2] * b;
      }
    }
    if (!gamma) {
      const d = img.data;
      for (let i = 0; i < d.length; i++) d[i] = Math.min(1, Math.max(0, d[i]));
    }
    drawImg(canvas, img, { encoded: !gamma });

    out('title').textContent = dem ? 'Output image' : 'Raw mosaic (one color per pixel)';
    out('size').textContent = `${w} × ${h} px`;
    out('illum').textContent = 'unknown (as shot)';
    out('gains').textContent = wb ? gains.map((v) => v.toFixed(2)).join(', ') : 'off';

    const notes: string[] = ['Lens shading is skipped: this DNG has no shading data.'];
    if (!lin) notes.push('No linearization: the 8-bit codes are companded (fine steps in the shadows, coarse in the highlights); used as if linear, the tones are flat and the colors wrong.');
    if (!blc) notes.push('No black level subtraction: the sensor’s offset of 256 (of 4095) lifts the blacks to a tinted gray.');
    if (!wb) notes.push('No white balance: the sensor’s green bias tints the whole image.');
    else if (mode === 'auto') notes.push('Gray world assumes the scene averages to gray; the red-lit wall breaks that, so it turns the whole image cyan.');
    if (!dem) notes.push('No demosaicing: each pixel has only one color, so the color matrix is skipped.');
    else if (!ccm) notes.push('No color matrix: colors are muted, because the sensor’s color filters overlap.');
    if (!gamma) notes.push('No gamma: linear values look dark, with the shadows crushed.');
    out('status').textContent =
      notes.length > 1 ? notes.slice(1).join(' ') : 'All stages on: the camera’s white balance and color matrix. ' + notes[0];
  };

  renderMatrix(out('ccm'), CCM, 2);
  const redraw = scheduler(draw);
  root.querySelectorAll('input').forEach((el) => el.addEventListener('input', redraw));
  root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    for (const [el, v] of initial) {
      if (typeof v === 'boolean') el.checked = v;
      else el.value = v;
    }
    redraw();
  });

  loadRawSample('scene')
    .then((s) => {
      sample = s;
      sampleGray = grayWorldGainsRaw(s);
      shownMode = '';
    })
    .catch(() => {
      // No raw file: fall back to the simulated capture
      radio('isp-scene', 'sim').checked = true;
      radio('isp-scene', 'raw').disabled = true;
    })
    .finally(() => {
      loading = false;
      redraw();
    });

  draw();
}
