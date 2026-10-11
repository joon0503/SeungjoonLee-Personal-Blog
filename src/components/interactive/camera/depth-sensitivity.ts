/**
 * Implementation of <DepthSensitivity />. Loaded lazily by DepthSensitivity.astro.
 *
 * Two points P = (X₀, Y₀, Z₀) and P′ = (X₀, Y₀, Z₀ + δZ) in the camera frame
 * project to (u, v) = (f_x X / Z + c_x, f_y Y / Z + c_y) and light pixel
 * (⌊u⌋, ⌊v⌋). Three views:
 *
 *   - the scene in 3D (drag to orbit): C, the image plane with its pixel grid
 *     at an arbitrary distance (the pixel a ray lands in does not depend on
 *     it), both rays and the pixels they light;
 *   - the rendered image, fixed to the full frame, with a magnified inset when
 *     pixels are too small to see;
 *   - the column u of P′ against δZ: exact and lit pixel (a staircase), with
 *     the article's worst-case bound δZ_min = Z₀² / (|f_x X₀| − Z₀).
 */
import {
  DEG,
  type Intrinsics,
  type Vec2,
  type Vec3,
  add,
  lookAt,
  pointsAttr,
  project,
  scale,
  scheduler,
  svg,
  transform,
} from './camera-math';

type Style = Partial<CSSStyleDeclaration>;
type Range = [min: number, max: number, step: number, value: number];

interface Preset {
  W: number;
  H: number;
  Y0: number;
  /** Distance of the drawn image plane (m), and the length that maps to one 3D view unit. */
  plane: number;
  unit: number;
  /** Grid spacing in pixels in the 3D view. */
  grid: number;
  sliders: { dZ: Range; Z0: Range; X0: Range; fx: Range };
}

const PRESETS: Record<string, Preset> = {
  // A 16 × 12-pixel camera: P and P′ are 15 cm apart and the pixels are visible.
  exaggerated: {
    W: 16,
    H: 12,
    Y0: 0.1,
    plane: 1,
    unit: 1,
    grid: 1,
    sliders: { dZ: [0, 1500, 5, 150], Z0: [1, 4, 0.05, 2], X0: [-1, 1, 0.01, 0.55], fx: [4, 40, 1, 12] },
  },
  // The camera of the article's example: f_x = 933 px, 1600 × 1200 px, P at X₀ = 0.1 m, Z₀ = 0.5 m.
  article: {
    W: 1600,
    H: 1200,
    Y0: 0.02,
    plane: 0.25,
    unit: 0.25,
    grid: 100,
    sliders: { dZ: [0, 10, 0.05, 1], Z0: [0.2, 2, 0.01, 0.5], X0: [-0.3, 0.3, 0.005, 0.1], fx: [200, 2000, 1, 933] },
  },
};

/* 3D view */
const SW = 640;
const SH = 380;
const VIEW_K: Intrinsics = { fx: 1150, fy: 1150, cx: SW / 2, cy: SH / 2, s: 0 };
const ORBIT_DEFAULT = { az: -50, el: 22, dist: 6.4 };
/** Camera frame (x right, y down, z forward) → a z-up display frame. */
const toWorld = ([x, y, z]: Vec3): Vec3 => [x, z, -y];

/* Rendered image */
const IW = 640;
const IH = 480;
const LOUPE_PX = 9; // pixels across the inset
const LOUPE = 198; // inset size (view units)

/* Plot */
const PL = 64;
const PR = 28;
const PT = 16;
const PB = 44;
const PW = 480 - PL - PR;
const PH = 360 - PT - PB;

const mm = (m: number) => {
  const v = m * 1000;
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} mm`;
};
const decimals = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
const signed = (v: number, d: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);

function text(x: number, y: number, content: string, style: Style = {}, attrs: Record<string, string | number> = {}) {
  const el = svg('text', { x, y, ...attrs }, { fill: 'var(--text-muted)', fontSize: '14px', ...style });
  el.textContent = content;
  return el;
}

export function mountDepthSensitivity(root: HTMLElement): void {
  const sceneSvg = root.querySelector<SVGSVGElement>('[data-scene]')!;
  const imageSvg = root.querySelector<SVGSVGElement>('[data-image]')!;
  const plotSvg = root.querySelector<SVGSVGElement>('[data-plot]')!;
  const inputs = new Map<string, HTMLInputElement>();
  root.querySelectorAll<HTMLInputElement>('input[data-in]').forEach((el) => inputs.set(el.dataset.in!, el));
  const presetInputs = [...root.querySelectorAll<HTMLInputElement>('input[name="preset"]')];
  const val = (key: string) => Number(inputs.get(key)!.value);
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const orbit = { ...ORBIT_DEFAULT };
  let preset = PRESETS.exaggerated;

  const applyPreset = (name: string) => {
    preset = PRESETS[name];
    for (const [key, [min, max, step, value]] of Object.entries(preset.sliders)) {
      const el = inputs.get(key)!;
      Object.assign(el, { min: String(min), max: String(max), step: String(step) });
      el.value = String(value);
    }
    out('size').textContent = `${preset.W} × ${preset.H} px`;
    out('grid').textContent = preset.grid === 1 ? '1 cell = 1 pixel' : `1 cell = ${preset.grid} × ${preset.grid} px`;
  };

  function draw() {
    const { W, H, Y0, grid } = preset;
    const fx = val('fx');
    const X0 = val('X0');
    const Z0 = val('Z0');
    const dZ = val('dZ') / 1000;
    const dZmax = Number(inputs.get('dZ')!.max) / 1000;
    const cx = W / 2;
    const cy = H / 2;
    const P: Vec3 = [X0, Y0, Z0];
    const P1: Vec3 = [X0, Y0, Z0 + dZ];
    const uvOf = ([x, y, z]: Vec3): Vec2 => [(fx * x) / z + cx, (fx * y) / z + cy];
    const uv0 = uvOf(P);
    const uv1 = uvOf(P1);
    const pix0: Vec2 = [Math.floor(uv0[0]), Math.floor(uv0[1])];
    const pix1: Vec2 = [Math.floor(uv1[0]), Math.floor(uv1[1])];
    const inside = ([k, l]: Vec2) => k >= 0 && k < W && l >= 0 && l < H;
    const same = pix0[0] === pix1[0] && pix0[1] === pix1[1];

    // δZ at which P′ first leaves P's pixel: u (or v) moves toward the principal point and reaches the pixel's edge.
    const firstChange = (offset: number, coord: number, c: number) => {
      const dir = Math.sign(offset);
      if (dir === 0) return Infinity;
      const edge = dir > 0 ? Math.floor(coord) : Math.floor(coord) + 1;
      if ((edge - c) * dir <= 0) return Infinity;
      return (fx * offset) / (edge - c) - Z0;
    };
    const first = Math.min(firstChange(X0, uv0[0], cx), firstChange(Y0, uv0[1], cy));
    const D = Math.abs(fx * X0) - Z0;
    const dZmin = D > 0 ? (Z0 * Z0) / D : Infinity;

    /* --- Readouts ----------------------------------------------------------- */
    for (const key of ['dZ', 'Z0', 'X0', 'fx']) {
      const el = inputs.get(key)!;
      out(key).textContent = Number(el.value).toFixed(decimals(Number(el.step)));
    }
    out('pix0').textContent = inside(pix0) ? `(${pix0[0]}, ${pix0[1]})` : 'outside';
    out('pix1').textContent = inside(pix1) ? `(${pix1[0]}, ${pix1[1]})` : 'outside';
    out('duv').textContent = `(${signed(uv1[0] - uv0[0], 3)}, ${signed(uv1[1] - uv0[1], 3)}) px`;
    out('min').textContent = Number.isFinite(dZmin) ? mm(dZmin) : '∞';
    const status = out('status');
    status.classList.toggle('on', !same);
    if (!inside(pix0) || !inside(pix1)) {
      status.textContent = 'P or P′ is outside the image: move it back into the field of view.';
    } else if (same) {
      status.textContent =
        `Identical images: P and P′ both light pixel (${pix0[0]}, ${pix0[1]}), so the camera cannot see the move. ` +
        (Number.isFinite(first) ? `The image first changes at δZ = ${mm(first)}.` : 'It never changes, however far P′ moves.');
    } else {
      status.textContent =
        `The images differ: P′ lights pixel (${pix1[0]}, ${pix1[1]}) instead of (${pix0[0]}, ${pix0[1]}).` +
        (dZ <= dZmin ? ' This is below δZ_min only because P started near a pixel edge.' : '');
    }

    /* --- 3D scene ----------------------------------------------------------- */
    {
      const { unit, plane: d } = preset;
      const az = orbit.az * DEG;
      const el = orbit.el * DEG;
      const target = toWorld([0.2, 0.1, 1.15]);
      const eye = add(target, scale([Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)], orbit.dist));
      const pose = lookAt(eye, target);
      /** Camera-frame point in metres → screen. */
      const at = (X: Vec3): Vec2 => project(VIEW_K, transform(pose, toWorld(scale(X, 1 / unit))));
      /** Pixel coordinates → the point on the drawn image plane. */
      const onPlane = (u: number, v: number): Vec3 => [((u - cx) / fx) * d, ((v - cy) / fx) * d, d];

      const g = svg('g');
      const line = (a: Vec3, b: Vec3, style: Style) => {
        const [p, q] = [at(a), at(b)];
        g.append(svg('line', { x1: p[0], y1: p[1], x2: q[0], y2: q[1] }, { strokeLinecap: 'round', ...style }));
      };
      const poly = (pts: Vec3[], style: Style) => g.append(svg('polygon', { points: pointsAttr(pts.map(at)) }, style));
      const dot = (X: Vec3, r: number, style: Style) => {
        const [x, y] = at(X);
        g.append(svg('circle', { cx: x, cy: y, r }, style));
      };
      const label = (X: Vec3, content: string, [dx, dy]: Vec2, style: Style = {}) => {
        const [x, y] = at(X);
        g.append(text(x + dx, y + dy, content, style));
      };
      const math = { fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: '16px' };

      // Image plane and its pixel grid.
      poly([onPlane(0, 0), onPlane(W, 0), onPlane(W, H), onPlane(0, H)], {
        fill: 'var(--bg)',
        stroke: 'var(--text-muted)',
        strokeWidth: '1.25',
      });
      for (let k = grid; k < W; k += grid) line(onPlane(k, 0), onPlane(k, H), { stroke: 'var(--border-strong)', strokeWidth: '0.75' });
      for (let l = grid; l < H; l += grid) line(onPlane(0, l), onPlane(W, l), { stroke: 'var(--border-strong)', strokeWidth: '0.75' });
      label(onPlane(W, H), 'image plane', [6, 14], { fontSize: '12px' });

      // Optical axis, rays and where they cross the image plane.
      const zFar = Math.max(Z0 + dZ, 2 * unit) + 0.4 * unit;
      line([0, 0, 0], [0, 0, zFar], { stroke: 'var(--text-faint)', strokeWidth: '1.25', strokeDasharray: '6 4' });
      line(P1, [0, 0, 0], { stroke: 'var(--obj-b)', strokeWidth: '1.5' });
      line(P, [0, 0, 0], { stroke: 'var(--obj-a)', strokeWidth: '1.5' });
      // Lit pixels, over the rays that land in them (when a pixel is big enough to draw).
      const cell = ([k, l]: Vec2): Vec3[] => [onPlane(k, l), onPlane(k + 1, l), onPlane(k + 1, l + 1), onPlane(k, l + 1)];
      if (grid === 1) {
        if (same && inside(pix0)) {
          const [a, b, c, e] = cell(pix0);
          poly([a, b, c], { fill: 'var(--obj-a)' });
          poly([a, c, e], { fill: 'var(--obj-b)' });
        } else {
          if (inside(pix0)) poly(cell(pix0), { fill: 'var(--obj-a)' });
          if (inside(pix1)) poly(cell(pix1), { fill: 'var(--obj-b)' });
        }
      }
      dot(onPlane(...uv1), 2.5, { fill: 'var(--bg)', stroke: 'var(--obj-b)', strokeWidth: '1.5' });
      dot(onPlane(...uv0), 2.5, { fill: 'var(--bg)', stroke: 'var(--obj-a)', strokeWidth: '1.5' });

      // δZ between the points, then the points.
      line(P, P1, { stroke: 'var(--text-muted)', strokeWidth: '1', strokeDasharray: '3 3' });
      dot(P1, 5, { fill: 'var(--obj-b)', stroke: 'var(--bg-subtle)', strokeWidth: '1.5' });
      dot(P, 5, { fill: 'var(--obj-a)', stroke: 'var(--bg-subtle)', strokeWidth: '1.5' });
      const [sp, sp1] = [at(P), at(P1)];
      const apart = Math.hypot(sp1[0] - sp[0], sp1[1] - sp[1]) > 24;
      label(P, 'P', [-8, -10], { ...math, fill: 'var(--obj-a)', textAnchor: 'end' });
      label(P1, 'P′', apart ? [8, -10] : [8, 18], { ...math, fill: 'var(--obj-b)' });

      // Camera axes and the optical center.
      const axis = 0.35 * unit;
      for (const [dir, color, name] of [
        [[axis, 0, 0], 'var(--ax-x)', 'X'],
        [[0, axis, 0], 'var(--ax-y)', 'Y'],
        [[0, 0, axis], 'var(--ax-z)', 'Z'],
      ] as [Vec3, string, string][]) {
        line([0, 0, 0], dir, { stroke: color, strokeWidth: '2' });
        label(dir, name, [4, 4], { ...math, fontSize: '13px', fill: color });
      }
      dot([0, 0, 0], 4, { fill: 'var(--text)' });
      label([0, 0, 0], 'C', [-14, -6], { fill: 'var(--text)', fontWeight: '600' });

      sceneSvg.replaceChildren(g);
    }

    /* --- Rendered image ------------------------------------------------------ */
    {
      const s = IW / W; // view units per pixel
      const g = svg('g');
      g.append(svg('rect', { x: 0, y: 0, width: IW, height: IH }, { fill: 'var(--bg)' }));
      /** Lit pixels, grid and exact projections in a window of pixels; `map` takes pixel coordinates to the view. */
      const pixels = (k0: number, l0: number, cols: number, rows: number, map: (u: number, v: number) => Vec2, size: number) => {
        const layer = svg('g');
        const cellPts = ([k, l]: Vec2): Vec2[] => [map(k, l), map(k + 1, l), map(k + 1, l + 1), map(k, l + 1)];
        const within = ([k, l]: Vec2) => inside([k, l]) && k >= k0 && k < k0 + cols && l >= l0 && l < l0 + rows;
        // At full-frame scale a pixel of a large image is sub-pixel on screen; draw it at least 3 units wide.
        const grow = Math.max(0, (3 - size) / 2);
        const quad = ([a, b, c, e]: Vec2[]): Vec2[] => [
          [a[0] - grow, a[1] - grow],
          [b[0] + grow, b[1] - grow],
          [c[0] + grow, c[1] + grow],
          [e[0] - grow, e[1] + grow],
        ];
        if (same && within(pix0)) {
          const [a, b, c, e] = quad(cellPts(pix0));
          layer.append(
            svg('polygon', { points: pointsAttr([a, b, c]) }, { fill: 'var(--obj-a)' }),
            svg('polygon', { points: pointsAttr([a, c, e]) }, { fill: 'var(--obj-b)' }),
          );
        } else {
          if (within(pix0)) layer.append(svg('polygon', { points: pointsAttr(quad(cellPts(pix0))) }, { fill: 'var(--obj-a)' }));
          if (within(pix1)) layer.append(svg('polygon', { points: pointsAttr(quad(cellPts(pix1))) }, { fill: 'var(--obj-b)' }));
        }
        if (size >= 6) {
          for (let k = k0; k <= k0 + cols; k++) {
            const [a, b] = [map(k, l0), map(k, l0 + rows)];
            layer.append(svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, { stroke: 'var(--border-strong)', strokeWidth: '1' }));
          }
          for (let l = l0; l <= l0 + rows; l++) {
            const [a, b] = [map(k0, l), map(k0 + cols, l)];
            layer.append(svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, { stroke: 'var(--border-strong)', strokeWidth: '1' }));
          }
          // Exact (sub-pixel) projections.
          for (const [uv, color] of [
            [uv0, 'var(--obj-a)'],
            [uv1, 'var(--obj-b)'],
          ] as [Vec2, string][]) {
            if (!within([Math.floor(uv[0]), Math.floor(uv[1])])) continue;
            const [x, y] = map(...uv);
            layer.append(svg('circle', { cx: x, cy: y, r: Math.min(6, size * 0.18) }, { fill: 'var(--bg)', stroke: color, strokeWidth: '2' }));
          }
        }
        return layer;
      };
      g.append(pixels(0, 0, W, H, (u, v) => [u * s, v * s], s));

      if (s < 6) {
        // Pixels are too small at this scale: magnify the neighbourhood of the two points.
        const k0 = Math.floor((uv0[0] + uv1[0]) / 2) - (LOUPE_PX - 1) / 2;
        const l0 = Math.floor((uv0[1] + uv1[1]) / 2) - (LOUPE_PX - 1) / 2;
        const m = LOUPE / LOUPE_PX;
        const midX = (k0 + LOUPE_PX / 2) * s;
        const midY = (l0 + LOUPE_PX / 2) * s;
        const ox = midX > IW / 2 ? 14 : IW - LOUPE - 14;
        const oy = midY > IH / 2 ? 14 : IH - LOUPE - 14;
        const box = Math.max(10, LOUPE_PX * s);
        const [bx, by] = [midX - box / 2, midY - box / 2];
        // Leader lines from the marked region to the near corners of the inset.
        const nearX = ox > bx ? bx + box : bx;
        const insetX = ox > bx ? ox : ox + LOUPE;
        g.append(
          svg('line', { x1: nearX, y1: by, x2: insetX, y2: oy }, { stroke: 'var(--text-faint)', strokeWidth: '1' }),
          svg('line', { x1: nearX, y1: by + box, x2: insetX, y2: oy + LOUPE }, { stroke: 'var(--text-faint)', strokeWidth: '1' }),
          svg('rect', { x: bx, y: by, width: box, height: box }, { fill: 'none', stroke: 'var(--text-muted)', strokeWidth: '1.25' }),
          svg('rect', { x: ox, y: oy, width: LOUPE, height: LOUPE }, { fill: 'var(--bg)', stroke: 'var(--text-muted)', strokeWidth: '1.25' }),
          pixels(k0, l0, LOUPE_PX, LOUPE_PX, (u, v) => [ox + (u - k0) * m, oy + (v - l0) * m], m),
          // Label on the side of the inset away from the image edge.
          text(ox, oy > IH / 2 ? oy - 8 : oy + LOUPE + 22, `${LOUPE_PX} × ${LOUPE_PX} px`, { fontSize: '18px' }),
        );
      }
      g.append(svg('rect', { x: 0, y: 0, width: IW, height: IH }, { fill: 'none', stroke: 'var(--text-muted)', strokeWidth: '1.5' }));
      imageSvg.replaceChildren(g);
    }

    /* --- Plot: column u of P′ vs δZ ------------------------------------------ */
    {
      const u = (dz: number) => (fx * X0) / (Z0 + dz) + cx;
      const uEnd = u(dZmax);
      let lo = Math.min(uv0[0], uEnd) - 0.6;
      let hi = Math.max(uv0[0], uEnd) + 0.6;
      if (hi - lo < 4) {
        const mid = (hi + lo) / 2;
        lo = mid - 2;
        hi = mid + 2;
      }
      const px = (dz: number) => PL + (dz / dZmax) * PW;
      const py = (uu: number) => PT + ((hi - uu) / (hi - lo)) * PH;
      const g = svg('g');

      // Pixel bands [k, k + 1), labelled at their centers.
      const kLo = Math.floor(lo);
      const kHi = Math.floor(hi);
      const every = Math.max(1, Math.ceil((kHi - kLo + 1) / 10));
      for (let k = kLo; k <= kHi; k++) {
        const yTop = Math.max(PT, py(k + 1));
        const yBot = Math.min(PT + PH, py(k));
        if (yBot <= yTop) continue;
        if (k % 2 === 0) g.append(svg('rect', { x: PL, y: yTop, width: PW, height: yBot - yTop }, { fill: 'var(--bg)', opacity: '0.8' }));
        if (k % every === 0 && py(k + 0.5) > PT + 6 && py(k + 0.5) < PT + PH - 2) {
          g.append(text(PL - 10, py(k + 0.5) + 5, String(k), { fontSize: '15px' }, { 'text-anchor': 'end' }));
        }
      }
      // While P′ is still in P's pixel the images are identical; the worst-case bound.
      const sameEnd = Math.min(first, dZmax);
      if (sameEnd > 0) {
        g.append(svg('rect', { x: PL, y: PT, width: px(sameEnd) - PL, height: PH }, { fill: 'var(--accent)', opacity: '0.08' }));
        if (px(sameEnd) - PL > 110) g.append(text(PL + 6, PT + 16, 'same image as P', { fill: 'var(--accent)', fontSize: '15px' }));
      }
      if (dZmin <= dZmax) {
        const x = px(dZmin);
        g.append(
          svg('line', { x1: x, y1: PT, x2: x, y2: PT + PH }, { stroke: 'var(--text-muted)', strokeWidth: '1.25', strokeDasharray: '5 4' }),
          text(x + 4, PT + PH - 8, 'δZ_min', { fontSize: '15px' }),
        );
      }

      // Exact u (curve) and the lit column (staircase).
      const N = 600;
      const curve: Vec2[] = [];
      let stairs = '';
      let prevK = NaN;
      for (let i = 0; i <= N; i++) {
        const dz = (i / N) * dZmax;
        const uu = u(dz);
        curve.push([px(dz), py(uu)]);
        const k = Math.floor(uu);
        if (i === 0) stairs = `M${px(dz).toFixed(1)},${py(k + 0.5).toFixed(1)}`;
        else if (k !== prevK) stairs += `H${px(dz).toFixed(1)}V${py(k + 0.5).toFixed(1)}`;
        prevK = k;
      }
      stairs += `H${px(dZmax).toFixed(1)}`;
      g.append(
        svg('path', { d: stairs }, { fill: 'none', stroke: 'var(--obj-b)', strokeWidth: '3' }),
        svg('polyline', { points: pointsAttr(curve) }, { fill: 'none', stroke: 'var(--text-muted)', strokeWidth: '1.25' }),
      );

      // P at δZ = 0, P′ at the current δZ; frame and axes.
      const xd = px(dZ);
      g.append(
        svg('line', { x1: xd, y1: PT, x2: xd, y2: PT + PH }, { stroke: 'var(--text-faint)', strokeWidth: '1' }),
        svg('circle', { cx: px(0), cy: py(pix0[0] + 0.5), r: 5 }, { fill: 'var(--obj-a)', stroke: 'var(--bg-subtle)', strokeWidth: '1.5' }),
        svg('circle', { cx: xd, cy: py(pix1[0] + 0.5), r: 5 }, { fill: 'var(--obj-b)', stroke: 'var(--bg-subtle)', strokeWidth: '1.5' }),
        svg('circle', { cx: xd, cy: py(uv1[0]), r: 3 }, { fill: 'var(--text-muted)' }),
        svg('rect', { x: PL, y: PT, width: PW, height: PH }, { fill: 'none', stroke: 'var(--border-strong)' }),
        text(PL, PT + PH + 18, '0', { fontSize: '15px' }, { 'text-anchor': 'middle' }),
        text(PL + PW / 2, PT + PH + 18, String(+(dZmax * 500).toPrecision(3)), { fontSize: '15px' }, { 'text-anchor': 'middle' }),
        text(PL + PW, PT + PH + 18, String(+(dZmax * 1000).toPrecision(3)), { fontSize: '15px' }, { 'text-anchor': 'middle' }),
        text(PL + PW / 2, PT + PH + 38, 'δZ (mm)', { fontStyle: 'italic', fontSize: '16px' }, { 'text-anchor': 'middle' }),
        text(16, PT + PH / 2, 'u (px)', { fontStyle: 'italic', fontSize: '16px' }, { 'text-anchor': 'middle', transform: `rotate(-90 16 ${PT + PH / 2})` }),
      );
      plotSvg.replaceChildren(g);
    }
  }

  const redraw = scheduler(draw);
  inputs.forEach((el) => el.addEventListener('input', redraw));
  for (const radio of presetInputs) {
    radio.addEventListener('change', () => {
      applyPreset(radio.value);
      redraw();
    });
  }
  root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    applyPreset(presetInputs.find((r) => r.checked)?.value ?? 'exaggerated');
    Object.assign(orbit, ORBIT_DEFAULT);
    redraw();
  });

  // Drag to orbit the 3D view; double-click to reset it.
  let drag: { id: number; x: number; y: number } | null = null;
  sceneSvg.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    sceneSvg.setPointerCapture(e.pointerId);
  });
  sceneSvg.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    orbit.az -= (e.clientX - drag.x) * 0.4;
    orbit.el = Math.min(80, Math.max(-60, orbit.el + (e.clientY - drag.y) * 0.4));
    drag.x = e.clientX;
    drag.y = e.clientY;
    redraw();
  });
  const end = () => {
    drag = null;
  };
  sceneSvg.addEventListener('pointerup', end);
  sceneSvg.addEventListener('pointercancel', end);
  sceneSvg.addEventListener('dblclick', () => {
    Object.assign(orbit, ORBIT_DEFAULT);
    redraw();
  });

  applyPreset(presetInputs.find((r) => r.checked)?.value ?? 'exaggerated');
  draw();
}
