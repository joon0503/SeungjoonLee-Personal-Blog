/**
 * Implementation of <ExposureSimulator />. Loaded lazily by ExposureSimulator.astro.
 *
 * Sensor model, per pixel and channel, in electrons:
 *   N  = min(L · illum · t · K_E, FULL_WELL)          collected photoelectrons
 *   N' = N + √N · z₁ + READ_NOISE · z₂                 shot noise + read noise
 *   A  = clamp(round(N' · gain · 4095 / FULL_WELL + ADC_NOISE · z₃), 0, 4095)   analog gain, ADC
 *   DN = min(round(A · dgain), 4095)                    digital gain on the quantized value
 * The z's are fixed standard-normal fields, so the noise pattern is stable
 * while the sliders move and only its amplitude changes.
 */
import { fmt, scheduler, svg } from '../camera/camera-math';
import { COLOR_CHECKER, type Img, drawImg, gaussian, makeImg, radioValue, renderScene, rng } from './imaging';

const W = 300;
const H = 200;
const FULL_WELL = 10000; // e⁻
const READ_NOISE = 3; // e⁻, before the gain
const ADC_NOISE = 0.8; // DN, after the gain
const DN_MAX = 4095; // 12-bit
const K_E = 600; // e⁻ per (unit radiance · ms): L = 1 at 10 ms gives 6000 e⁻
const MAX_FPS = 120; // readout limit of the sensor
const MID_GRAY = COLOR_CHECKER[21][1]; // "neutral 5" patch

/* Log-scaled sliders: position 0–1000 ↔ physical value (defaults: 667 → ×1, 697 → 10 ms). */
const T_MIN = 0.05, T_MAX = 100; // ms
const I_MIN = 0.01, I_MAX = 10;
const fromLog = (pos: number, lo: number, hi: number) => lo * Math.pow(hi / lo, pos / 1000);

/* The moving disk: center, radius (px) and reflectance. */
const DISK = { x: 0.47 * W, y: 0.81 * H, r: 14, color: [0.75, 0.3, 0.06] };

export function mountExposureSimulator(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-image]')!;
  const histSvg = root.querySelector<SVGSVGElement>('[data-hist]')!;
  const inputs = new Map<string, HTMLInputElement>();
  root.querySelectorAll<HTMLInputElement>('input[data-in]').forEach((el) => inputs.set(el.dataset.in!, el));
  const val = (key: string) => Number(inputs.get(key)!.value);
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const initial = new Map([...inputs].map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));

  // Precomputed once: the static scene and three noise fields.
  const scene = renderScene(W, H, 2);
  const n = W * H * 3;
  const z = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const normal = gaussian(rng(7));
  for (const f of z) for (let i = 0; i < n; i++) f[i] = normal();

  const radiance = makeImg(W, H);
  const output: Img = makeImg(W, H);

  /** Scene radiance with the disk smeared over a path of `blur` px (centered on DISK.x). */
  const composeRadiance = (blur: number) => {
    radiance.data.set(scene.data);
    const { x: cx, y: cy, r, color } = DISK;
    const x0 = Math.max(0, Math.floor(cx - blur / 2 - r - 1));
    const x1 = Math.min(W - 1, Math.ceil(cx + blur / 2 + r + 1));
    const SUB = 4; // vertical subsamples, to antialias the top and bottom edges
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = x0; x <= x1; x++) {
        // Fraction of the shutter interval during which the disk covers the pixel:
        // the disk covers (x, y) while its center is within ±c of x.
        let cov = 0;
        for (let s = 0; s < SUB; s++) {
          const dy = y + (s + 0.5) / SUB - 0.5 - cy;
          if (Math.abs(dy) >= r) continue;
          const c = Math.sqrt(r * r - dy * dy);
          if (blur < 1e-6) cov += Math.abs(x - cx) < c ? 1 : 0;
          else cov += Math.max(0, Math.min(x + c, cx + blur / 2) - Math.max(x - c, cx - blur / 2)) / blur;
        }
        cov /= SUB;
        const i = 3 * (y * W + x);
        for (let k = 0; k < 3; k++) radiance.data[i + k] = (1 - cov) * radiance.data[i + k] + cov * color[k];
      }
    }
  };

  let lastT = fromLog(val('t'), T_MIN, T_MAX);

  const draw = () => {
    const illum = fromLog(val('illum'), I_MIN, I_MAX);
    const t = fromLog(val('t'), T_MIN, T_MAX);
    if (inputs.get('lock')!.checked && t !== lastT) {
      // Hold t × gain: change the gain by the inverse of the exposure change.
      const db = val('gain') + 20 * Math.log10(lastT / t);
      inputs.get('gain')!.value = String(Math.min(24, Math.max(0, Math.round(db * 2) / 2)));
    }
    lastT = t;
    const gainDb = val('gain');
    const gain = Math.pow(10, gainDb / 20);
    const dgainDb = val('dgain');
    const dgain = Math.pow(10, dgainDb / 20);
    const shadows = radioValue(root, 'exp-hist') === 'shadows';
    const speed = val('speed'); // px/s
    const blur = (speed * t) / 1000;

    composeRadiance(blur);

    // Sensor: electrons → noise → gain → ADC
    const e = illum * t * K_E;
    const s = (gain * DN_MAX) / FULL_WELL;
    const R = radiance.data;
    const O = output.data;
    // Full range: 64 bins of 64 codes. Shadows: one bin per code for DN 0–255, where skipped codes show.
    const hist = new Uint32Array(shadows ? 256 : 64);
    let clipped = 0;
    for (let p = 0; p < W * H; p++) {
      let any = false;
      for (let k = 0; k < 3; k++) {
        const i = 3 * p + k;
        const N = Math.min(R[i] * e, FULL_WELL);
        const Nn = N + Math.sqrt(N) * z[0][i] + READ_NOISE * z[1][i];
        const a = Math.min(DN_MAX, Math.max(0, Math.round(Nn * s + ADC_NOISE * z[2][i])));
        const v = Math.min(DN_MAX, Math.round(a * dgain));
        O[i] = v / DN_MAX;
        if (!shadows) hist[v >> 6]++;
        else if (v < 256) hist[v]++;
        if (v === DN_MAX || N === FULL_WELL) any = true;
      }
      if (any) clipped++;
    }
    drawImg(canvas, output);
    drawHistogram(hist, shadows);

    // Readouts
    out('illum').textContent = `×${illum < 0.1 ? fmt(illum, 3) : illum < 1 ? fmt(illum, 2) : fmt(illum, 1)}`;
    out('t').textContent = t < 1 ? `${fmt(t, 2)} ms` : t < 10 ? `${fmt(t, 1)} ms` : `${fmt(t, 0)} ms`;
    out('gain').textContent = `${fmt(gainDb, 1)} dB (×${fmt(gain, gain < 10 ? 2 : 1)})`;
    out('dgain').textContent = `${fmt(dgainDb, 1)} dB (×${fmt(dgain, dgain < 10 ? 2 : 1)})`;
    out('total').textContent = `${fmt(gainDb + dgainDb, 1)} dB (×${fmt(gain * dgain, gain * dgain < 10 ? 2 : 1)})`;
    // Distinct output codes: ADC codes that still land below the clip after the digital gain
    const levels = Math.min(DN_MAX + 1, Math.floor(DN_MAX / dgain + 0.5) + 1);
    out('levels').textContent = `${levels} of 4096 (${fmt(Math.log2(levels), 1)} bits)`;
    out('histRange').textContent = shadows ? 'DN 0–255, one bar per code' : 'DN 0–4095, all channels';
    out('speed').textContent = `${speed} px/s`;
    const fps = Math.min(MAX_FPS, 1000 / t);
    out('fps').textContent = `${fmt(fps, fps < 10 ? 1 : 0)} fps${fps === MAX_FPS ? ' (sensor limit)' : ''}`;

    const Ng = MID_GRAY * e;
    if (Ng >= FULL_WELL || Ng * s * dgain >= DN_MAX) {
      out('snr').textContent = 'clipped';
    } else {
      // Variance in DN: shot + read noise amplified by the analog gain, plus ADC and quantization noise,
      // all amplified again by the digital gain, plus its own rounding. Digital gain cannot raise the SNR.
      const varAdc = (Ng + READ_NOISE ** 2) * s * s + ADC_NOISE ** 2 + 1 / 12;
      const varDn = varAdc * dgain * dgain + (dgain > 1 ? 1 / 12 : 0);
      const snr = (Ng * s * dgain) / Math.sqrt(varDn);
      out('snr').textContent = `${fmt(20 * Math.log10(Math.max(snr, 1e-3)), 1)} dB (${fmt(Ng, 0)} e⁻)`;
    }
    out('clip').textContent = `${fmt((100 * clipped) / (W * H), 1)} %`;
    out('blur').textContent = `${fmt(blur, 1)} px`;
  };

  const drawHistogram = (hist: Uint32Array, shadows: boolean) => {
    const HW = 300, top = 12, base = 178;
    const lmax = Math.log1p(Math.max(...hist));
    const bw = HW / hist.length;
    const g = svg('g');
    hist.forEach((c, b) => {
      const hgt = lmax > 0 ? ((base - top) * Math.log1p(c)) / lmax : 0;
      const last = !shadows && b === hist.length - 1;
      g.append(
        svg(
          'rect',
          // One bar per code in shadows mode: no gaps, so the empty codes are the only gaps
          shadows ? { x: b * bw, y: base - hgt, width: bw, height: hgt } : { x: b * bw + 0.5, y: base - hgt, width: bw - 1, height: hgt },
          { fill: last && c > 0 ? 'var(--ch-r)' : 'var(--accent)', fillOpacity: last ? '1' : '0.75' },
        ),
      );
    });
    const label = (x: number, text: string, anchor: string) =>
      Object.assign(svg('text', { x, y: base + 16, 'text-anchor': anchor }, { fill: 'var(--text-muted)', fontSize: '11px' }), {
        textContent: text,
      });
    histSvg.replaceChildren(
      g,
      svg('line', { x1: 0, y1: base, x2: HW, y2: base }, { stroke: 'var(--text-faint)', strokeWidth: '1' }),
      label(2, '0', 'start'),
      label(HW / 2, shadows ? '128' : '2048', 'middle'),
      label(HW - 2, shadows ? '255' : '4095', 'end'),
      Object.assign(svg('text', { x: HW - 4, y: top + 2, 'text-anchor': 'end' }, { fill: 'var(--text-faint)', fontSize: '10px' }), {
        textContent: 'log count',
      }),
    );
  };

  const redraw = scheduler(draw);
  inputs.forEach((el) => el.addEventListener('input', redraw));
  root.querySelectorAll('input[name="exp-hist"]').forEach((el) => el.addEventListener('change', redraw));
  root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    for (const [k, v] of initial) {
      const el = inputs.get(k)!;
      if (typeof v === 'boolean') el.checked = v;
      else el.value = v;
    }
    root.querySelector<HTMLInputElement>('input[name="exp-hist"][value="full"]')!.checked = true;
    lastT = fromLog(val('t'), T_MIN, T_MAX);
    redraw();
  });

  draw();
}
