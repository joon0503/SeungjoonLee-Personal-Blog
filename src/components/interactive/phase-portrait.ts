/**
 * Implementation of <PhasePortrait />. Loaded lazily by PhasePortrait.astro.
 * Plain DOM + SVG, no dependencies.
 */

type Vec = [number, number];

const SIZE = 400; // SVG viewBox size
const L = 3; // plot covers [-L, L]²
const GRID = 17; // vector field arrows per side
const DT = 0.02;
const MAX_STEPS = 2000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const toScreen = ([x, y]: Vec): Vec => [
  ((x + L) / (2 * L)) * SIZE,
  ((L - y) / (2 * L)) * SIZE,
];

const toWorld = ([sx, sy]: Vec): Vec => [
  (sx / SIZE) * 2 * L - L,
  L - (sy / SIZE) * 2 * L,
];

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  style: Partial<CSSStyleDeclaration> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  Object.assign(el.style, style);
  return el;
}

/** Integrate ẋ = f(x) with classical RK4 until the state leaves the plot or settles. */
function integrate(f: (x: Vec) => Vec, x0: Vec): Vec[] {
  const path: Vec[] = [x0];
  let x = x0;
  for (let i = 0; i < MAX_STEPS; i++) {
    const k1 = f(x);
    const k2 = f([x[0] + (DT / 2) * k1[0], x[1] + (DT / 2) * k1[1]]);
    const k3 = f([x[0] + (DT / 2) * k2[0], x[1] + (DT / 2) * k2[1]]);
    const k4 = f([x[0] + DT * k3[0], x[1] + DT * k3[1]]);
    x = [
      x[0] + (DT / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
      x[1] + (DT / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
    ];
    path.push(x);
    if (Math.abs(x[0]) > 2 * L || Math.abs(x[1]) > 2 * L) break;
    if (Math.hypot(x[0], x[1]) < 1e-3) break;
  }
  return path;
}

function describe(zeta: number, omega: number): { eigs: string; kind: string } {
  const re = -zeta * omega;
  const disc = zeta * zeta - 1;
  const fmt = (v: number) => (Math.abs(v) < 5e-3 ? '0.00' : v.toFixed(2));

  let eigs: string;
  if (disc < 0) {
    eigs = `${fmt(re)} ± ${fmt(omega * Math.sqrt(-disc))}i`;
  } else {
    const r = omega * Math.sqrt(disc);
    eigs = `${fmt(re - r)}, ${fmt(re + r)}`;
  }

  let kind: string;
  if (Math.abs(zeta) < 5e-3) kind = 'Center (undamped)';
  else if (zeta < 0) kind = disc < 0 ? 'Unstable focus' : 'Unstable node';
  else if (Math.abs(disc) < 5e-3) kind = 'Stable node (critically damped)';
  else if (disc < 0) kind = 'Stable focus (underdamped)';
  else kind = 'Stable node (overdamped)';

  return { eigs, kind };
}

export function mountPhasePortrait(root: HTMLElement): void {
  const plot = root.querySelector<SVGSVGElement>('[data-plot]')!;
  const zetaIn = root.querySelector<HTMLInputElement>('[data-in="zeta"]')!;
  const omegaIn = root.querySelector<HTMLInputElement>('[data-in="omega"]')!;
  const out = (name: string) => root.querySelector<HTMLElement>(`[data-out="${name}"]`)!;

  const defaultStarts: Vec[] = Array.from({ length: 8 }, (_, k) => {
    const a = (k / 8) * 2 * Math.PI + Math.PI / 8;
    return [2.6 * Math.cos(a), 2.6 * Math.sin(a)];
  });
  let starts: Vec[] = [...defaultStarts];

  // Static layers: axes. Dynamic layers are redrawn on every change.
  const axes = svg('g', {}, { stroke: 'var(--border-strong)', strokeWidth: '1' });
  axes.append(
    svg('line', { x1: 0, y1: SIZE / 2, x2: SIZE, y2: SIZE / 2 }),
    svg('line', { x1: SIZE / 2, y1: 0, x2: SIZE / 2, y2: SIZE }),
  );
  const labels = svg('g', {}, { fill: 'var(--text-faint)', fontSize: '12px', fontStyle: 'italic' });
  const xLabel = svg('text', { x: SIZE - 6, y: SIZE / 2 - 6, 'text-anchor': 'end' });
  xLabel.textContent = 'x₁';
  const yLabel = svg('text', { x: SIZE / 2 + 6, y: 14 });
  yLabel.textContent = 'x₂';
  labels.append(xLabel, yLabel);

  const field = svg('g', {}, { stroke: 'var(--text-faint)', strokeWidth: '1', strokeLinecap: 'round' });
  const trajectories = svg(
    'g',
    {},
    { stroke: 'var(--accent)', strokeWidth: '1.75', fill: 'none', strokeLinejoin: 'round' },
  );
  const markers = svg('g', {}, { fill: 'var(--accent)' });
  plot.replaceChildren(axes, field, trajectories, markers, labels);

  function draw() {
    const zeta = Number(zetaIn.value);
    const omega = Number(omegaIn.value);
    const f = ([x1, x2]: Vec): Vec => [x2, -omega * omega * x1 - 2 * zeta * omega * x2];

    out('zeta').textContent = zeta.toFixed(2);
    out('omega').textContent = omega.toFixed(2);
    const { eigs, kind } = describe(zeta, omega);
    out('eigs').textContent = eigs;
    out('kind').textContent = kind;

    // Vector field: fixed-length segments with a small arrowhead, opacity ∝ speed.
    field.replaceChildren();
    const step = (2 * L) / (GRID - 1);
    const len = (SIZE / GRID) * 0.35;
    const maxSpeed = Math.hypot(L, omega * omega * L + 2 * Math.abs(zeta) * omega * L);
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const p: Vec = [-L + i * step, -L + j * step];
        const [dx, dy] = f(p);
        const speed = Math.hypot(dx, dy);
        if (speed < 1e-9) continue;
        const [cx, cy] = toScreen(p);
        const ux = dx / speed;
        const uy = -dy / speed; // screen y points down
        const tip: Vec = [cx + ux * len, cy + uy * len];
        const tail: Vec = [cx - ux * len, cy - uy * len];
        const head = len * 0.45;
        const path =
          `M${tail[0]},${tail[1]}L${tip[0]},${tip[1]}` +
          `M${tip[0] - head * (ux - 0.5 * uy)},${tip[1] - head * (uy + 0.5 * ux)}` +
          `L${tip[0]},${tip[1]}` +
          `L${tip[0] - head * (ux + 0.5 * uy)},${tip[1] - head * (uy - 0.5 * ux)}`;
        field.append(
          svg('path', { d: path, fill: 'none' }, { opacity: String(0.35 + 0.55 * Math.min(1, speed / maxSpeed)) }),
        );
      }
    }

    // Trajectories from each start point.
    trajectories.replaceChildren();
    markers.replaceChildren();
    for (const x0 of starts) {
      const points = integrate(f, x0).map(toScreen);
      trajectories.append(
        svg('polyline', { points: points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') }),
      );
      const [sx, sy] = points[0];
      markers.append(svg('circle', { cx: sx, cy: sy, r: 3 }));
    }
  }

  zetaIn.addEventListener('input', draw);
  omegaIn.addEventListener('input', draw);

  plot.addEventListener('click', (event) => {
    const pt = plot.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const local = pt.matrixTransform(plot.getScreenCTM()!.inverse());
    starts.push(toWorld([local.x, local.y]));
    if (starts.length > 24) starts = starts.slice(-24);
    draw();
  });

  root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    starts = [...defaultStarts];
    draw();
  });

  draw();
}
