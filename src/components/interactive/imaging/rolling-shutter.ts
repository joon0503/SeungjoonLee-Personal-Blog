/**
 * Implementation of <RollingShutter />. Loaded lazily by RollingShutter.astro.
 *
 * Each pixel integrates the scene over its row's exposure window, sampled at
 * K instants. With a global shutter every row uses the same window; with a
 * rolling shutter row y starts y / H · readout later than row 0. Scenes are
 * analytic functions of position (px) and time (ms), so motion blur and
 * rolling-shutter distortion both come out of the same integral.
 */
import { fmt, scheduler, svg } from '../camera/camera-math';
import { radioValue } from './imaging';

const W = 240;
const H = 160;
const K = 10; // time samples per exposure
const SLOW_MOTION = 50;
const SENSOR_ROWS = 1080; // for the line-time readout

/* Exposure slider: position 0–1000 ↔ 0.05–20 ms, log scale. */
const E_MIN = 0.05, E_MAX = 20;
const exposureMs = (pos: number) => E_MIN * Math.pow(E_MAX / E_MIN, pos / 1000);
const exposurePos = (ms: number) => (1000 * Math.log(ms / E_MIN)) / Math.log(E_MAX / E_MIN);
/** Snap the exposure to a whole number of flicker cycles within this many slider steps. */
const SNAP = 10;

/** A lamp on AC mains brightens on both half-cycles: its light ripples at twice the mains frequency. */
const lightHz = (mains: number) => 2 * mains;

type RGB = [number, number, number];
type Scene = (x: number, y: number, t: number) => RGB;

const SKY: RGB = [0.78, 0.84, 0.9];

/** Two-bladed propeller spinning about the center at `rpm`. */
function propeller(rpm: number): Scene {
  const w = (rpm / 60000) * 2 * Math.PI; // rad per ms
  const cx = W / 2, cy = H / 2, R = 72;
  return (x, y, t) => {
    const dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy);
    if (r < 9) return [0.42, 0.42, 0.45];
    if (r < R) {
      let d = Math.atan2(dy, dx) - w * t;
      d -= Math.PI * Math.round(d / Math.PI); // two blades: period π
      if (Math.abs(r * Math.sin(d)) < 4 + 5 * Math.sin((Math.PI * r) / R)) return [0.16, 0.16, 0.18];
    }
    const g = 1 - 0.12 * (y / H);
    return [SKY[0] * g, SKY[1] * g, SKY[2] * g];
  };
}

/** Light output (0–1) at time `t` ms of a lamp rippling at `hz`. */
const lightAt = (hz: number, t: number) => 0.6 + 0.4 * Math.cos((2 * Math.PI * hz * t) / 1000);

/** Mean light output over [start, start + exposure]: what a row collects, divided by the exposure. */
function meanLight(hz: number, start: number, exposure: number): number {
  const w = (2 * Math.PI * hz) / 1000;
  if (w * exposure < 1e-6) return lightAt(hz, start);
  return 0.6 + (0.4 * (Math.sin(w * (start + exposure)) - Math.sin(w * start))) / (w * exposure);
}

/** A textured wall lit by a light whose output ripples at `hz` (the light frequency, not the mains). */
function flicker(hz: number): Scene {
  return (x, y, t) => {
    const light = lightAt(hz, t);
    const tile = ((Math.floor(x / 40) + Math.floor(y / 40)) & 1) === 0 ? 1 : 0.9;
    const v = light * tile * (0.95 - 0.1 * (x / W));
    return [v * 0.95, v * 0.9, v * 0.82];
  };
}

/** Capture the scene into `img`; row y is exposed over [t0 + delay(y), + exposure]. */
function capture(img: ImageData, scene: Scene, t0: number, exposure: number, delay: (y: number) => number) {
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const start = t0 + delay(y);
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < K; k++) {
        const c = scene(x + 0.5, y + 0.5, start + (exposure * (k + 0.5)) / K);
        r += c[0];
        g += c[1];
        b += c[2];
      }
      const j = 4 * (y * W + x);
      d[j] = (255 * r) / K;
      d[j + 1] = (255 * g) / K;
      d[j + 2] = (255 * b) / K;
      d[j + 3] = 255;
    }
  }
}

export function mountRollingShutter(root: HTMLElement): void {
  const globalCanvas = root.querySelector<HTMLCanvasElement>('[data-global]')!;
  const rollingCanvas = root.querySelector<HTMLCanvasElement>('[data-rolling]')!;
  const timing = root.querySelector<SVGSVGElement>('[data-timing]')!;
  const inputs = new Map<string, HTMLInputElement>();
  root.querySelectorAll<HTMLInputElement>('input[data-in]').forEach((el) => inputs.set(el.dataset.in!, el));
  const val = (key: string) => Number(inputs.get(key)!.value);
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  // The exposure is remembered per scene; the flicker scene starts at one light cycle (8.33 ms at 60 Hz mains)
  const exposureDefaults: Record<string, number> = { prop: 500, flicker: exposurePos(1000 / lightHz(60)) };
  const exposureByScene = { ...exposureDefaults };
  let shownScene = radioValue(root, 'rs-scene');
  const initial = new Map([...root.querySelectorAll<HTMLInputElement>('input')].map((el) => [el, el.type === 'range' ? el.value : el.checked]));

  const gctx = globalCanvas.getContext('2d')!;
  const rctx = rollingCanvas.getContext('2d')!;
  const gImg = gctx.createImageData(W, H);
  const rImg = rctx.createImageData(W, H);

  let t0 = 0; // scene time of the current frame, ms
  // Propeller scene: the frame starts at t0 and the scan line is at row scan / 100 · H, read at t0 + scan / 100 · readout
  const scanFraction = () => Math.min(0.999, val('scan') / 100);
  let lastNow = 0;
  let visible = false;
  // Starts paused; the Play button toggles the slow-motion animation
  let playing = false;
  const playBtn = root.querySelector<HTMLButtonElement>('[data-action="play"]')!;
  const setPlaying = (on: boolean) => {
    playing = on;
    playBtn.setAttribute('aria-pressed', String(on));
    out('playLabel').textContent = on ? 'Pause' : 'Play';
    playBtn.querySelector('[data-icon]')!.setAttribute('d', on ? 'M2.5 1.5h2.5v9h-2.5zM7 1.5h2.5v9h-2.5z' : 'M3 1.5v9l7.5-4.5z');
  };
  playBtn.addEventListener('click', () => setPlaying(!playing));

  const drawTiming = (readout: number, exposure: number, scene: string, hz: number, scan: number | null) => {
    timing.replaceChildren();
    const flick = scene === 'flicker';
    // The flicker scene adds three light-output strips above the rows and a per-row brightness plot on the right
    const X0 = 70, X1 = flick ? 590 : 705;
    const Y0 = flick ? 172 : 14, Y1 = flick ? 250 : 112;
    const LEGEND = Y1 + 38;
    timing.setAttribute('viewBox', `0 0 720 ${LEGEND + 18}`);
    const T = (readout + exposure) * 1.08;
    const tx = (t: number) => X0 + ((X1 - X0) * t) / T;
    const add = (tag: 'line' | 'path' | 'rect' | 'text' | 'polygon' | 'circle', attrs: Record<string, string | number>, text?: string) => {
      const el = svg(tag, attrs);
      if (text !== undefined) el.textContent = text;
      timing.append(el);
    };
    const label = (x: number, y: number, text: string, fill = 'var(--text-muted)', anchor = 'end') =>
      add('text', { x, y, 'font-size': 10.5, 'text-anchor': anchor, fill }, text);

    // Rolling: a slanted band; global: one rectangle (centered on the same instant)
    add('polygon', {
      points: `${tx(0)},${Y0} ${tx(exposure)},${Y0} ${tx(readout + exposure)},${Y1} ${tx(readout)},${Y1}`,
      fill: 'var(--accent)',
      'fill-opacity': 0.22,
      stroke: 'var(--accent)',
      'stroke-width': 1.25,
    });
    const globalStart = scan === null ? readout / 2 : scan * readout;
    add('rect', { x: tx(globalStart), y: Y0, width: Math.max(1, tx(exposure) - X0), height: Y1 - Y0, fill: 'none', stroke: 'var(--text-muted)', 'stroke-dasharray': '4 3' });
    if (scan !== null) {
      // The row under the scan line, exposed over the same window as the global snapshot
      const ry = Y0 + (Y1 - Y0) * scan;
      add('line', { x1: tx(globalStart), x2: tx(globalStart + exposure), y1: ry, y2: ry, stroke: 'var(--accent)', 'stroke-width': 3, 'stroke-linecap': 'round' });
      label(Math.min(tx(globalStart + exposure) + 6, X1 - 50), ry + 4, 'scan line', 'var(--accent)', 'start');
    }
    label(X0 - 8, Y0 + 8, 'first row');
    label(X0 - 8, Y1, 'last row');

    if (flick) {
      // Mean light collected by each image row (row y starts y / H · readout after row 0)
      const means = Array.from({ length: H }, (_, y) => meanLight(hz, t0 + (y / H) * readout, exposure));
      const lo = Math.min(...means), hi = Math.max(...means);
      // Show the brightest and darkest rows; when every row is the same, two fixed rows
      const flat = hi - lo < 0.005;
      const rows = flat ? [H / 4, (3 * H) / 4] : [means.indexOf(hi), means.indexOf(lo)];
      const names = flat ? ['', ''] : ['brightest', 'darkest'];
      // Light strips: rows A and B of the rolling shutter, then the one window every global-shutter row shares
      const globalMean = meanLight(hz, t0 + readout / 2, exposure);
      const strips = [
        ...rows.map((y, i) => ({ a: (y / H) * readout, mean: means[y], color: ['var(--accent)', 'var(--obj-a)'][i], title: `row ${'AB'[i]}`, sub: names[i], row: y })),
        { a: readout / 2, mean: globalMean, color: 'var(--text-muted)', title: 'global', sub: 'every row', row: -1 },
      ];
      strips.forEach((st, i) => {
        const S0 = 16 + 50 * i, S1 = S0 + 40; // strip: light 0 at S1, 1 at S0
        const ly = (v: number) => S1 - (S1 - S0) * v;
        const a = st.a, b = a + exposure;
        add('line', { x1: X0, x2: X1, y1: S1, y2: S1, stroke: 'var(--border-strong)' });
        // Area under the light curve during this exposure window
        let area = `M${tx(a).toFixed(1)},${S1}`;
        for (let k = 0; k <= 60; k++) {
          const t = a + (exposure * k) / 60;
          area += `L${tx(t).toFixed(1)},${ly(lightAt(hz, t0 + t)).toFixed(1)}`;
        }
        add('path', { d: `${area}L${tx(b).toFixed(1)},${S1}Z`, fill: st.color, 'fill-opacity': 0.3 });
        let curve = '';
        for (let x = X0; x <= X1; x += 2) curve += `${curve ? 'L' : 'M'}${x},${ly(lightAt(hz, t0 + ((x - X0) / (X1 - X0)) * T)).toFixed(1)}`;
        add('path', { d: curve, fill: 'none', stroke: 'var(--hl)', 'stroke-width': 1.25 });
        // Mean level over the window
        add('line', { x1: tx(a), x2: tx(b), y1: ly(st.mean), y2: ly(st.mean), stroke: st.color, 'stroke-width': 1.5, 'stroke-dasharray': '4 2' });
        label(X0 - 8, S0 + 16, st.title, st.color);
        label(X0 - 8, S0 + 29, st.sub);
        label(X1 + 25, S0 + 16, 'mean', 'var(--text-muted)', 'start');
        label(X1 + 25, S0 + 29, fmt(st.mean, 2), st.color, 'start');
        // Link the window to its row in the rolling band, or to the global rectangle
        const ry = st.row < 0 ? Y0 : Y0 + (Y1 - Y0) * (st.row / H);
        if (st.row >= 0) add('line', { x1: tx(a), x2: tx(b), y1: ry, y2: ry, stroke: st.color, 'stroke-width': 2.5 });
        for (const t of [a, b]) add('line', { x1: tx(t), x2: tx(t), y1: S1, y2: ry, stroke: st.color, 'stroke-width': 0.75, 'stroke-dasharray': '2 3', opacity: 0.8 });
      });
      label(X1, 12, 'light output', 'var(--hl)');

      // Per-row brightness: a gray bar (what the image shows) and the mean light as a curve
      const BX = 604, PX0 = 625, PX1 = 705;
      const px = (v: number) => PX0 + (PX1 - PX0) * v;
      label(PX1, LEGEND + 8, 'brightness per row', 'var(--text-muted)');
      const SEG = 40;
      for (let k = 0; k < SEG; k++) {
        const g = Math.round(255 * 0.85 * means[Math.floor(((k + 0.5) / SEG) * H)]);
        add('rect', { x: BX, y: Y0 + ((Y1 - Y0) * k) / SEG, width: 12, height: (Y1 - Y0) / SEG + 0.5, fill: `rgb(${g},${g},${g})` });
      }
      // Global shutter: every row gets the same mean
      add('line', { x1: px(globalMean), x2: px(globalMean), y1: Y0, y2: Y1, stroke: 'var(--text-muted)', 'stroke-width': 1.25, 'stroke-dasharray': '4 3' });
      label(px(globalMean), Y0 - 6, 'global', 'var(--text-muted)', 'middle');
      let d = '';
      means.forEach((v, y) => (d += `${d ? 'L' : 'M'}${px(v).toFixed(1)},${(Y0 + ((Y1 - Y0) * y) / (H - 1)).toFixed(1)}`));
      add('path', { d, fill: 'none', stroke: 'var(--text)', 'stroke-width': 1.5 });
      strips.forEach((st) => st.row >= 0 && add('circle', { cx: px(st.mean), cy: Y0 + ((Y1 - Y0) * st.row) / (H - 1), r: 3.5, fill: st.color }));
      add('line', { x1: PX0, x2: PX1, y1: Y1 + 8, y2: Y1 + 8, stroke: 'var(--border-strong)' });
      for (const v of [0, 1]) {
        add('line', { x1: px(v), x2: px(v), y1: Y1 + 8, y2: Y1 + 12, stroke: 'var(--border-strong)' });
        label(px(v), Y1 + 24, String(v), 'var(--text-muted)', 'middle');
      }
    }

    // Time axis
    add('line', { x1: X0, x2: X1, y1: Y1 + 8, y2: Y1 + 8, stroke: 'var(--border-strong)' });
    const step = [0.5, 1, 2, 5, 10, 20][[0.5, 1, 2, 5, 10, 20].findIndex((s) => T / s <= (flick ? 8 : 10))] ?? 10;
    for (let t = 0; t <= T; t += step) {
      add('line', { x1: tx(t), x2: tx(t), y1: Y1 + 8, y2: Y1 + 12, stroke: 'var(--border-strong)' });
      label(tx(t), Y1 + 24, `${fmt(t, step < 1 ? 1 : 0)} ms`, 'var(--text-muted)', 'middle');
    }
    // Legend
    add('rect', { x: X0, y: LEGEND, width: 14, height: 9, fill: 'var(--accent)', 'fill-opacity': 0.22, stroke: 'var(--accent)' });
    label(X0 + 20, LEGEND + 8, 'rolling shutter', 'var(--text)', 'start');
    add('rect', { x: X0 + 130, y: LEGEND, width: 14, height: 9, fill: 'none', stroke: 'var(--text-muted)', 'stroke-dasharray': '3 2' });
    label(X0 + 150, LEGEND + 8, 'global shutter', 'var(--text)', 'start');
    if (flick) {
      add('rect', { x: X0 + 260, y: LEGEND, width: 14, height: 9, fill: 'var(--accent)', 'fill-opacity': 0.3 });
      label(X0 + 280, LEGEND + 8, 'light collected (area = integral)', 'var(--text)', 'start');
    }
  };

  const draw = () => {
    const scene = radioValue(root, 'rs-scene');
    root.querySelectorAll<HTMLElement>('[data-scene]').forEach((el) => (el.hidden = el.dataset.scene !== scene));
    const scanView = scene === 'prop' && radioValue(root, 'rs-view') === 'scan';
    inputs.get('scan')!.closest('label')!.hidden = !scanView;
    const rpm = val('rpm'), mains = val('hz');
    const hz = lightHz(mains);
    const readout = val('readout');
    const exposure = exposureMs(val('exposure'));
    out('rpm').textContent = `${rpm} rpm`;
    out('hz').textContent = `${mains} Hz`;
    out('readout').textContent = `${readout} ms`;
    out('exposure').textContent = `${fmt(exposure, exposure < 1 ? 2 : 1)} ms`;

    const fn = scene === 'prop' ? propeller(rpm) : flicker(hz);
    // In the scan-line view the global image is a snapshot taken as the scan line is read
    const scan = scanView ? scanFraction() : null;
    out('scan').textContent = `row ${Math.round((scan ?? 0) * SENSOR_ROWS)}`;
    capture(gImg, fn, t0, exposure, () => (scan === null ? readout / 2 : scan * readout));
    // Rows below the scan line still hold the previous frame
    const line = scan === null ? H : Math.floor(scan * H) + 1;
    capture(rImg, fn, t0, exposure, (y) => (y / H) * readout - (y < line ? 0 : readout));
    gctx.putImageData(gImg, 0, 0);
    rctx.putImageData(rImg, 0, 0);
    if (scan !== null) {
      const style = getComputedStyle(root);
      const y = Math.floor(scan * H) + 0.5;
      // Dim the previous frame below the line
      rctx.globalAlpha = 0.6;
      rctx.fillStyle = style.getPropertyValue('--bg');
      rctx.fillRect(0, Math.ceil(y), W, H);
      rctx.globalAlpha = 1;
      for (const ctx of [gctx, rctx]) {
        ctx.strokeStyle = style.getPropertyValue('--accent');
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
    }
    drawTiming(readout, exposure, scene, hz, scan);

    out('lineLabel').textContent = `Line time (${SENSOR_ROWS} rows)`;
    out('line').textContent = `${fmt((readout / SENSOR_ROWS) * 1000, 1)} µs`;
    if (scene === 'prop') {
      out('blurLabel').textContent = 'Motion during exposure';
      out('effectLabel').textContent = 'Rotation during readout';
      out('effect').textContent = `${fmt((rpm / 60000) * readout * 360, 0)}°`;
      out('blur').textContent = `${fmt((rpm / 60000) * exposure * 360, 1)}°`;
    } else {
      out('lineLabel').textContent = `Light period (${hz} Hz)`;
      out('line').textContent = `${fmt(1000 / hz, 2)} ms`;
      out('effectLabel').textContent = 'Flicker cycles across the frame';
      out('effect').textContent = fmt((hz * readout) / 1000, 2);
      out('blurLabel').textContent = 'Cycles in one exposure';
      const cycles = (hz * exposure) / 1000;
      out('blur').textContent = `${fmt(cycles, 2)}${Math.abs(cycles - Math.round(cycles)) < 0.005 && cycles >= 0.99 ? ' (no bands)' : ''}`;
    }
  };

  // In the flicker scene, snap the exposure to whole light cycles when it is close to one
  const snapExposure = () => {
    if (radioValue(root, 'rs-scene') !== 'flicker') return;
    const el = inputs.get('exposure')!;
    const period = 1000 / lightHz(val('hz'));
    const k = Math.round(exposureMs(Number(el.value)) / period);
    if (k < 1 || k * period > E_MAX) return;
    const pos = exposurePos(k * period);
    if (Math.abs(Number(el.value) - pos) <= SNAP) el.value = String(pos);
  };

  const redraw = scheduler(draw);
  root.querySelectorAll('input').forEach((el) => el.addEventListener('input', redraw));
  inputs.get('exposure')!.addEventListener('input', snapExposure);
  root.querySelectorAll<HTMLInputElement>('input[name="rs-scene"]').forEach((el) =>
    el.addEventListener('change', () => {
      exposureByScene[shownScene] = val('exposure');
      shownScene = el.value;
      inputs.get('exposure')!.value = String(exposureByScene[shownScene]);
    }),
  );
  // Reset restores the defaults but keeps the selected scene
  root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    for (const [el, v] of initial) {
      if (el.name === 'rs-scene' || el.name === 'rs-view') continue;
      if (typeof v === 'boolean') el.checked = v;
      else el.value = v;
    }
    setPlaying(false);
    Object.assign(exposureByScene, exposureDefaults);
    inputs.get('exposure')!.value = String(exposureDefaults[shownScene]);
    redraw();
  });

  // Animation: advance scene time in slow motion while the figure is on screen
  const tick = (now: number) => {
    if (lastNow && playing) {
      const dt = Math.min(50, now - lastNow) / SLOW_MOTION;
      if (radioValue(root, 'rs-scene') === 'prop' && radioValue(root, 'rs-view') === 'scan') {
        // Sweep the scan line down; each sweep is the next frame
        const readout = val('readout');
        let p = val('scan') / 100 + dt / readout;
        if (p >= 1) {
          p -= Math.floor(p);
          t0 += readout;
        }
        inputs.get('scan')!.value = String(p * 100);
      } else {
        t0 += dt;
      }
      draw();
    }
    lastNow = now;
    if (visible) requestAnimationFrame(tick);
    else lastNow = 0;
  };
  new IntersectionObserver(([entry]) => {
    const was = visible;
    visible = entry.isIntersecting;
    if (visible && !was) requestAnimationFrame(tick);
  }).observe(root);

  draw();
}
