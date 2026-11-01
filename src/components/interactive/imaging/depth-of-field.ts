/**
 * Implementation of <DepthOfField />. Loaded lazily by DepthOfField.astro.
 *
 * Thin-lens model, all lengths in mm. A lens of focal length f and f-number N
 * (aperture diameter A = f / N), focused at distance s, images a point at
 * distance d as a disk of diameter
 *   c(d) = A · f · |d − s| / (d · (s − f))
 * on the sensor. Diffraction adds an Airy disk of diameter 2.44 λ N
 * (λ = 550 nm). The two are combined in quadrature. A point looks sharp when
 * the total stays below the acceptable blur C (a few pixels); the near and far
 * limits and the hyperfocal distance follow from c(d) = √(C² − Airy²).
 */
import { fmt, scheduler, svg, svgPoint } from '../camera/camera-math';

const LAMBDA = 550e-6; // mm
const STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];

/* Log-scaled sliders: position 0–1000 ↔ physical value. */
const F_RANGE: [number, number] = [2, 50]; // mm
const S_RANGE: [number, number] = [0.1, 50]; // m
const D_RANGE: [number, number] = [0.05, 100]; // m (also the plot's x range)
const fromLog = (pos: number, [lo, hi]: [number, number]) => lo * Math.pow(hi / lo, pos / 1000);
const toLog = (v: number, [lo, hi]: [number, number]) => (1000 * Math.log(v / lo)) / Math.log(hi / lo);

/** Distance for readouts: mm in, "42 cm" / "1.25 m" / "∞" out. */
function dist(mm: number): string {
  if (!Number.isFinite(mm) || mm > 1e7) return '∞';
  if (mm < 1000) return `${fmt(mm / 10, mm < 100 ? 1 : 0)} cm`;
  return `${fmt(mm / 1000, mm < 10000 ? 2 : 1)} m`;
}

/* Plot geometry (viewBox 360 × 220). */
const PX0 = 40, PX1 = 340, PY0 = 12, PY1 = 190;
const Y_MAX = 10; // px of blur at the top of the plot
const plotX = (m: number) => PX0 + ((PX1 - PX0) * Math.log(m / D_RANGE[0])) / Math.log(D_RANGE[1] / D_RANGE[0]);
const plotXInv = (x: number) => D_RANGE[0] * Math.pow(D_RANGE[1] / D_RANGE[0], (x - PX0) / (PX1 - PX0));
const plotY = (px: number) => PY1 - ((PY1 - PY0) * Math.min(px, Y_MAX)) / Y_MAX;

export function mountDepthOfField(root: HTMLElement): void {
  const rays = root.querySelector<SVGSVGElement>('[data-rays]')!;
  const plot = root.querySelector<SVGSVGElement>('[data-plot]')!;
  const inputs = new Map<string, HTMLInputElement>();
  root.querySelectorAll<HTMLInputElement>('input[data-in]').forEach((el) => inputs.set(el.dataset.in!, el));
  const val = (key: string) => Number(inputs.get(key)!.value);
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const initial = new Map([...inputs].map(([k, el]) => [k, el.value]));

  const params = () => {
    const f = fromLog(val('f'), F_RANGE);
    const N = STOPS[val('n')];
    const s = Math.max(fromLog(val('s'), S_RANGE) * 1000, 1.05 * f);
    const pitch = val('pitch') / 1000; // mm
    const C = val('coc') * pitch;
    const airy = 2.44 * LAMBDA * N;
    const cDef = airy < C ? Math.sqrt(C * C - airy * airy) : 0; // defocus budget left after diffraction
    return { f, N, s, pitch, C, airy, cDef, d: fromLog(val('d'), D_RANGE) * 1000 };
  };
  type P = ReturnType<typeof params>;
  const defocus = (p: P, d: number) => ((p.f / p.N) * p.f * Math.abs(d - p.s)) / (d * (p.s - p.f));
  const total = (p: P, d: number) => Math.hypot(defocus(p, d), p.airy);

  const limits = (p: P) => {
    if (p.cDef === 0) return { near: NaN, far: NaN, hyper: NaN };
    const k = p.N * p.cDef * (p.s - p.f);
    const f2 = p.f * p.f;
    return {
      near: (p.s * f2) / (f2 + k),
      far: f2 - k > 0 ? (p.s * f2) / (f2 - k) : Infinity,
      hyper: f2 / (p.N * p.cDef) + p.f,
    };
  };

  /* --- Plot ---------------------------------------------------------------- */
  const drawPlot = (p: P, lim: ReturnType<typeof limits>) => {
    plot.replaceChildren();
    const g = (tag: 'line' | 'path' | 'rect' | 'text', attrs: Record<string, string | number>, text?: string) => {
      const el = svg(tag, attrs);
      if (text !== undefined) el.textContent = text;
      plot.append(el);
      return el;
    };
    // Sharp range
    if (Number.isFinite(lim.near)) {
      const x0 = Math.max(PX0, plotX(lim.near / 1000));
      const x1 = Number.isFinite(lim.far) ? Math.min(PX1, plotX(lim.far / 1000)) : PX1;
      if (x1 > x0) g('rect', { x: x0, y: PY0, width: x1 - x0, height: PY1 - PY0, fill: 'var(--accent)', opacity: 0.1 });
    }
    // Axes and grid
    for (const m of [0.1, 0.3, 1, 3, 10, 30, 100]) {
      const x = plotX(m);
      g('line', { x1: x, x2: x, y1: PY0, y2: PY1, stroke: 'var(--border)' });
      g('text', { x, y: PY1 + 14, 'font-size': 10, 'text-anchor': 'middle', fill: 'var(--text-muted)' }, m < 1 ? `${m * 100} cm` : `${m} m`);
    }
    for (let px = 0; px <= Y_MAX; px += 2) {
      const y = plotY(px);
      g('line', { x1: PX0, x2: PX1, y1: y, y2: y, stroke: 'var(--border)' });
      g('text', { x: PX0 - 5, y: y + 3.5, 'font-size': 10, 'text-anchor': 'end', fill: 'var(--text-muted)' }, String(px));
    }
    g('text', { x: 10, y: (PY0 + PY1) / 2, 'font-size': 10, 'text-anchor': 'middle', fill: 'var(--text-muted)', transform: `rotate(-90 10 ${(PY0 + PY1) / 2})` }, 'blur (px)');
    // Acceptable blur
    const yC = plotY(p.C / p.pitch);
    g('line', { x1: PX0, x2: PX1, y1: yC, y2: yC, stroke: 'var(--text-muted)', 'stroke-dasharray': '4 3' });
    g('text', { x: PX1 - 2, y: yC - 4, 'font-size': 10, 'text-anchor': 'end', fill: 'var(--text-muted)' }, 'acceptable');
    // Diffraction
    const yA = plotY(p.airy / p.pitch);
    g('line', { x1: PX0, x2: PX1, y1: yA, y2: yA, stroke: 'var(--hl)', 'stroke-width': 1.5, 'stroke-dasharray': '2 3' });
    g('text', { x: PX0 + 4, y: yA - 4, 'font-size': 10, fill: 'var(--hl)' }, 'diffraction');
    // Defocus and total blur
    const curve = (fn: (d: number) => number) => {
      let d = '';
      for (let x = PX0; x <= PX1; x += 1.5) d += `${d ? 'L' : 'M'}${x.toFixed(1)},${plotY(fn(plotXInv(x) * 1000) / p.pitch).toFixed(1)}`;
      return d;
    };
    g('path', { d: curve((d) => defocus(p, d)), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.25, opacity: 0.6 });
    g('path', { d: curve((d) => total(p, d)), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2 });
    // Focus distance and object marker
    const xs = plotX(p.s / 1000);
    g('line', { x1: xs, x2: xs, y1: PY0, y2: PY1, stroke: 'var(--accent)', 'stroke-width': 1 });
    g('text', { x: xs + 3, y: PY0 + 10, 'font-size': 10, fill: 'var(--accent)' }, 'focus');
    const xd = plotX(p.d / 1000);
    const yd = plotY(total(p, p.d) / p.pitch);
    g('line', { x1: xd, x2: xd, y1: yd, y2: PY1, stroke: 'var(--obj-a)', 'stroke-dasharray': '3 2' });
    const dot = svg('circle', { cx: xd, cy: yd, r: 5, fill: 'var(--obj-a)', stroke: 'var(--bg)', 'stroke-width': 1.5 });
    plot.append(dot);
  };

  /* --- Ray diagram ------------------------------------------------------------ */
  const drawRays = (p: P, blurPx: number) => {
    rays.replaceChildren();
    const add = (tag: 'line' | 'rect' | 'text' | 'ellipse' | 'circle', attrs: Record<string, string | number>, text?: string) => {
      const el = svg(tag, attrs);
      if (text !== undefined) el.textContent = text;
      rays.append(el);
      return el;
    };
    const cy = 100, lensX = 150, sensorX = 300;
    const open = 62 * (STOPS[0] / p.N) ** 0.6 + 6; // aperture half-height, compressed so f/22 stays visible
    // Optical axis
    add('line', { x1: 8, x2: 352, y1: cy, y2: cy, stroke: 'var(--border-strong)', 'stroke-dasharray': '2 3' });
    // Object point (left) and its rays to the aperture edges
    const objX = 24;
    add('line', { x1: objX, y1: cy, x2: lensX, y2: cy - open, stroke: 'var(--obj-a)', 'stroke-width': 1.25 });
    add('line', { x1: objX, y1: cy, x2: lensX, y2: cy + open, stroke: 'var(--obj-a)', 'stroke-width': 1.25 });
    add('circle', { cx: objX, cy, r: 4, fill: 'var(--obj-a)' });
    add('text', { x: objX, y: cy + 22, 'font-size': 10, 'text-anchor': 'middle', fill: 'var(--text-muted)' }, dist(p.d));
    // Lens and aperture stop
    add('ellipse', { cx: lensX, cy, rx: 7, ry: 78, fill: 'var(--bg)', stroke: 'var(--text-muted)' });
    add('rect', { x: lensX - 2.5, y: cy - 86, width: 5, height: 86 - open, fill: 'var(--text)' });
    add('rect', { x: lensX - 2.5, y: cy + open, width: 5, height: 86 - open, fill: 'var(--text)' });
    add('text', { x: lensX, y: cy + 104, 'font-size': 10.5, 'text-anchor': 'middle', fill: 'var(--text)', 'font-weight': 600 }, `f/${p.N}`);
    // Image-side cone: the blur spot b on the sensor fixes where the rays meet (exaggerated, consistent geometry)
    const b = Math.min(open * 0.9, blurPx * 2.2);
    const L = sensorX - lensX;
    const nearSide = p.d < p.s; // closer than focus: the rays meet behind the sensor
    const meet = nearSide ? (open * L) / (open - b) : (open * L) / (open + b);
    const mx = lensX + meet;
    const cone = (sign: number) => {
      const yEdge = cy + sign * open;
      if (mx <= sensorX) {
        // Meet in front of the sensor, then diverge to the blur spot
        add('line', { x1: lensX, y1: yEdge, x2: mx, y2: cy, stroke: 'var(--obj-a)', 'stroke-width': 1.25 });
        add('line', { x1: mx, y1: cy, x2: sensorX, y2: cy - sign * b, stroke: 'var(--obj-a)', 'stroke-width': 1.25 });
      } else {
        add('line', { x1: lensX, y1: yEdge, x2: sensorX, y2: cy + sign * b, stroke: 'var(--obj-a)', 'stroke-width': 1.25 });
        add('line', { x1: sensorX, y1: cy + sign * b, x2: Math.min(mx, 352), y2: cy + sign * b * (1 - (Math.min(mx, 352) - sensorX) / (mx - sensorX)), stroke: 'var(--obj-a)', 'stroke-width': 1, 'stroke-dasharray': '3 2', opacity: 0.6 });
      }
    };
    cone(-1);
    cone(1);
    // Sensor and the blur spot on it
    add('rect', { x: sensorX, y: cy - 80, width: 6, height: 160, fill: 'var(--bg-subtle)', stroke: 'var(--text-muted)' });
    add('rect', { x: sensorX - 1, y: cy - Math.max(b, 1), width: 8, height: 2 * Math.max(b, 1), fill: 'var(--obj-a)' });
    add('text', { x: sensorX + 3, y: cy + 104, 'font-size': 10.5, 'text-anchor': 'middle', fill: 'var(--text)', 'font-weight': 600 }, 'sensor');
    add('text', { x: sensorX + 3, y: cy - 88, 'font-size': 10, 'text-anchor': 'middle', fill: 'var(--obj-a)' }, `${fmt(blurPx, 1)} px`);
  };

  const draw = () => {
    const p = params();
    const lim = limits(p);
    out('f').textContent = `${fmt(p.f, p.f < 10 ? 1 : 0)} mm`;
    out('n').textContent = `f/${p.N}`;
    out('s').textContent = dist(p.s);
    out('pitch').textContent = `${fmt(p.pitch * 1000, 1)} µm`;
    out('coc').textContent = `${val('coc')} px`;
    out('d').textContent = dist(p.d);

    const blurPx = total(p, p.d) / p.pitch;
    out('near').textContent = Number.isFinite(lim.near) ? dist(lim.near) : '—';
    out('far').textContent = Number.isFinite(lim.near) ? dist(lim.far) : '—';
    out('hyper').textContent = Number.isFinite(lim.hyper) ? dist(lim.hyper) : '—';
    out('airy').textContent = `${fmt(p.airy * 1000, 1)} µm (${fmt(p.airy / p.pitch, 1)} px)`;
    out('blur').textContent = `${fmt(blurPx, 1)} px${blurPx <= p.C / p.pitch ? ', sharp' : ''}`;
    const stops = 2 * Math.log2(p.N / 2);
    out('light').textContent = Math.abs(stops) < 0.05 ? '×1' : `×${fmt(Math.pow(2, -stops), Math.abs(stops) > 3 ? 3 : 2)} (${stops > 0 ? '−' : '+'}${fmt(Math.abs(stops), 1)} stops)`;

    let status: string;
    if (!Number.isFinite(lim.near)) status = `Diffraction-limited: at f/${p.N} the diffraction spot alone is ${fmt(p.airy / p.pitch, 1)} px, more than the acceptable blur, so nothing is sharp. Open the aperture.`;
    else if (p.s >= lim.hyper) status = `Focused beyond the hyperfocal distance: everything from ${dist(lim.near)} to infinity is acceptably sharp.`;
    else status = `Acceptably sharp from ${dist(lim.near)} to ${dist(lim.far)}.`;
    out('status').textContent = status;

    drawPlot(p, lim);
    drawRays(p, blurPx);
  };

  const redraw = scheduler(draw);
  inputs.forEach((el) => el.addEventListener('input', redraw));

  // Drag on the plot to move the object point
  const moveTo = (e: PointerEvent) => {
    const [x] = svgPoint(plot, e);
    const m = plotXInv(Math.min(PX1, Math.max(PX0, x)));
    inputs.get('d')!.value = String(Math.round(toLog(m, D_RANGE)));
    redraw();
  };
  plot.addEventListener('pointerdown', (e) => {
    plot.setPointerCapture(e.pointerId);
    moveTo(e);
  });
  plot.addEventListener('pointermove', (e) => {
    if (plot.hasPointerCapture(e.pointerId)) moveTo(e);
  });

  root.querySelector('[data-action="hyper"]')!.addEventListener('click', () => {
    const lim = limits(params());
    if (Number.isFinite(lim.hyper)) inputs.get('s')!.value = String(Math.min(1000, Math.ceil(toLog(lim.hyper / 1000, S_RANGE))));
    redraw();
  });
  root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    for (const [k, v] of initial) inputs.get(k)!.value = v;
    redraw();
  });

  draw();
}
