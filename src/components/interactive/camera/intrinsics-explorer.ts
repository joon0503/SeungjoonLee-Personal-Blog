/**
 * Implementation of <IntrinsicsExplorer />. Loaded lazily by IntrinsicsExplorer.astro.
 *
 * Left: the normalized image plane (x/z, y/z), which does not depend on the
 * camera's intrinsics. Right: the same content in pixels after applying K.
 * The outlined region on the left is the part of the normalized plane that
 * lands inside the 640 × 480 sensor.
 */
import {
  DEG,
  type Intrinsics,
  type Vec2,
  fmt,
  pointsAttr,
  renderMatrix,
  scheduler,
  svg,
  unproject,
} from './camera-math';

const W = 640;
const H = 480;
const NW = 400; // normalized-plane view
const NH = 300;
const NS = 200; // px per normalized unit
const PIXEL_PITCH_MM = 0.00345; // 3.45 µm, a common machine-vision sensor

const toN = ([x, y]: Vec2): Vec2 => [NW / 2 + x * NS, NH / 2 + y * NS];
const toPx = (K: Intrinsics, [x, y]: Vec2): Vec2 => [K.fx * x + K.s * y + K.cx, K.fy * y + K.cy];

/* Content drawn on the normalized plane: a grid and two asymmetric shapes. */
const GRID_LINES: [Vec2, Vec2][] = [];
for (let k = -12; k <= 12; k++) {
  const v = k * 0.1;
  GRID_LINES.push([
    [v, -2],
    [v, 2],
  ]);
  GRID_LINES.push([
    [-2.5, v],
    [2.5, v],
  ]);
}
// A letter "F" (asymmetric, so flips and shears are obvious)
const LETTER_F: Vec2[] = [
  [0.1, -0.3],
  [0.36, -0.3],
  [0.36, -0.22],
  [0.18, -0.22],
  [0.18, -0.08],
  [0.3, -0.08],
  [0.3, 0],
  [0.18, 0],
  [0.18, 0.22],
  [0.1, 0.22],
];
const SQUARE: Vec2[] = [
  [-0.45, 0.05],
  [-0.25, 0.05],
  [-0.25, 0.25],
  [-0.45, 0.25],
];

export function mountIntrinsicsExplorer(root: HTMLElement): void {
  const normSvg = root.querySelector<SVGSVGElement>('[data-normalized]')!;
  const pixelSvg = root.querySelector<SVGSVGElement>('[data-pixels]')!;
  const inputs = new Map<string, HTMLInputElement>();
  root.querySelectorAll<HTMLInputElement>('input[data-in]').forEach((el) => inputs.set(el.dataset.in!, el));
  const val = (key: string) => Number(inputs.get(key)!.value);
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const initial = new Map([...inputs].map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));

  const draw = () => {
    const lock = inputs.get('lock')!.checked;
    if (lock) inputs.get('fy')!.value = inputs.get('fx')!.value;
    inputs.get('fy')!.disabled = lock;

    const K: Intrinsics = { fx: val('fx'), fy: val('fy'), cx: val('cx'), cy: val('cy'), s: val('s') };
    out('fx').textContent = K.fx.toFixed(0);
    out('fy').textContent = K.fy.toFixed(0);
    out('cx').textContent = K.cx.toFixed(0);
    out('cy').textContent = K.cy.toFixed(0);
    out('s').textContent = K.s.toFixed(0);

    const content = (map: (p: Vec2) => Vec2) => {
      const g = svg('g');
      for (const [a, b] of GRID_LINES) {
        const [p, q] = [map(a), map(b)];
        const axis = (Math.abs(a[0]) < 1e-9 && Math.abs(b[0]) < 1e-9) || (Math.abs(a[1]) < 1e-9 && Math.abs(b[1]) < 1e-9);
        g.append(
          svg(
            'line',
            { x1: p[0], y1: p[1], x2: q[0], y2: q[1] },
            { stroke: axis ? 'var(--text-faint)' : 'var(--border-strong)', strokeWidth: axis ? '1.5' : '1' },
          ),
        );
      }
      g.append(
        svg('polygon', { points: pointsAttr(LETTER_F.map(map)) }, { fill: 'var(--obj-a)' }),
        svg('polygon', { points: pointsAttr(SQUARE.map(map)) }, { fill: 'var(--obj-b)' }),
      );
      return g;
    };

    // Normalized plane + the sensor's footprint on it
    const footprint = (
      [
        [0, 0],
        [W, 0],
        [W, H],
        [0, H],
      ] as Vec2[]
    ).map((uv) => {
      const [x, y] = unproject(K, uv, 1);
      return toN([x, y]);
    });
    normSvg.replaceChildren(
      content(toN),
      svg('polygon', { points: pointsAttr(footprint) }, { fill: 'var(--accent)', fillOpacity: '0.08', stroke: 'var(--accent)', strokeWidth: '2' }),
      svg('circle', { cx: NW / 2, cy: NH / 2, r: 3.5 }, { fill: 'var(--text)' }),
    );

    // Pixel image
    const pp = [K.cx, K.cy];
    pixelSvg.replaceChildren(
      content((p) => toPx(K, p)),
      svg('path', { d: `M${pp[0] - 10},${pp[1]}h20M${pp[0]},${pp[1] - 10}v20` }, { stroke: 'var(--text)', strokeWidth: '2' }),
      svg('path', { d: 'M12,12h44M12,12v44' }, { stroke: 'var(--text-muted)', strokeWidth: '1.5', fill: 'none' }),
      Object.assign(svg('text', { x: 62, y: 17 }, { fill: 'var(--text-muted)', fontSize: '15px', fontStyle: 'italic' }), {
        textContent: 'u',
      }),
      Object.assign(svg('text', { x: 8, y: 72 }, { fill: 'var(--text-muted)', fontSize: '15px', fontStyle: 'italic' }), {
        textContent: 'v',
      }),
    );

    renderMatrix(out('K'), [
      [K.fx, K.s, K.cx],
      [0, K.fy, K.cy],
      [0, 0, 1],
    ], 0);
    const hfov = (Math.atan(K.cx / K.fx) + Math.atan((W - K.cx) / K.fx)) / DEG;
    const vfov = (Math.atan(K.cy / K.fy) + Math.atan((H - K.cy) / K.fy)) / DEG;
    out('fov').textContent = `${hfov.toFixed(1)}° × ${vfov.toFixed(1)}°`;
    out('mm').textContent = `${fmt(K.fx * PIXEL_PITCH_MM, 2)} mm`;
  };

  const redraw = scheduler(draw);
  inputs.forEach((el) => el.addEventListener('input', redraw));
  root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    for (const [k, v] of initial) {
      const el = inputs.get(k)!;
      if (typeof v === 'boolean') el.checked = v;
      else el.value = v;
    }
    redraw();
  });

  draw();
}
