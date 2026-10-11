/**
 * Implementation of <PinholeFrames />. Loaded lazily by PinholeFrames.astro.
 *
 * A labelled 3D drawing of the pinhole camera geometry, in the camera frame
 * (OpenCV: X right, Y down, Z forward along the optical axis):
 *
 *   - the optical center C and the camera axes,
 *   - the (virtual) image plane at Z = f, the principal point where the
 *     optical axis meets it, the image-plane axes x, y and the pixel axes u, v,
 *   - a point P, its ray to C and its projection p,
 *   - the plane X = 0 (shaded): the slice drawn by <PinholeSideView />, with
 *     P's shadow on it.
 *
 * Drag to orbit. The view is rendered with the same pinhole projection as the
 * other figures (a second, virtual camera looking at the scene).
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

const VW = 640;
const VH = 420;
const F = 1.6; // focal length (scene units)
const HW = 1.2; // image plane half-width
const HH = 0.9; // image plane half-height (4:3)
const P: Vec3 = [1.5, -1.3, 4.6];
const p: Vec3 = [(F * P[0]) / P[2], (F * P[1]) / P[2], F];
const Ps: Vec3 = [0, P[1], P[2]]; // P's shadow on the slice X = 0
const ps: Vec3 = [0, p[1], F];

/** Camera frame → a z-up display frame, so "up" on screen is −Y. */
const toWorld = ([x, y, z]: Vec3): Vec3 => [x, z, -y];
const TARGET = toWorld([0.2, 0, 2.2]);
const ORBIT_DEFAULT = { az: -44, el: 18, dist: 11 };

type Style = Partial<CSSStyleDeclaration>;

export function mountPinholeFrames(root: HTMLElement): void {
  const plot = root.querySelector<SVGSVGElement>('[data-plot]')!;
  const K: Intrinsics = { fx: 760, fy: 760, cx: VW / 2, cy: VH / 2 + 10, s: 0 };
  const orbit = { ...ORBIT_DEFAULT };

  function draw() {
    const az = orbit.az * DEG;
    const el = orbit.el * DEG;
    const eye = add(TARGET, scale([Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)], orbit.dist));
    const pose = lookAt(eye, TARGET);
    const at = (X: Vec3): Vec2 => project(K, transform(pose, toWorld(X)));

    const g = svg('g');
    const line = (a: Vec3, b: Vec3, style: Style) => {
      const [p1, p2] = [at(a), at(b)];
      g.append(svg('line', { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1] }, { strokeLinecap: 'round', ...style }));
    };
    const arrow = (a: Vec3, b: Vec3, color: string, width = 2) => {
      line(a, b, { stroke: color, strokeWidth: String(width) });
      const [p1, p2] = [at(a), at(b)];
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (len < 6) return;
      const ux = (p2[0] - p1[0]) / len;
      const uy = (p2[1] - p1[1]) / len;
      const h = 8;
      g.append(
        svg(
          'path',
          {
            d: `M${p2[0]},${p2[1]}L${p2[0] - h * (ux - 0.45 * uy)},${p2[1] - h * (uy + 0.45 * ux)}L${p2[0] - h * (ux + 0.45 * uy)},${p2[1] - h * (uy - 0.45 * ux)}Z`,
          },
          { fill: color },
        ),
      );
    };
    const quad = (pts: Vec3[], style: Style) => g.append(svg('polygon', { points: pointsAttr(pts.map(at)) }, style));
    const dot = (X: Vec3, r: number, style: Style) => {
      const [x, y] = at(X);
      g.append(svg('circle', { cx: x, cy: y, r }, style));
    };
    /** Text at a 3D point plus a pixel offset; `_c` style subscripts become <tspan>s. */
    const label = (X: Vec3, text: string, [dx, dy]: Vec2, style: Style = {}) => {
      const [x, y] = at(X);
      const t = svg('text', { x: x + dx, y: y + dy }, { fontSize: '13px', fill: 'var(--text-muted)', ...style });
      for (const part of text.split(/(_\w)/)) {
        if (!part) continue;
        const span = svg('tspan', part.startsWith('_') ? { 'baseline-shift': 'sub' } : {}, part.startsWith('_') ? { fontSize: '0.75em', fontStyle: 'normal' } : {});
        span.textContent = part.startsWith('_') ? part.slice(1) : part;
        t.append(span);
      }
      g.append(t);
    };
    /** Label placed away from a crowded point, joined to it by a thin leader line. */
    const callout = (X: Vec3, text: string, [dx, dy]: Vec2, style: Style = {}) => {
      const [x, y] = at(X);
      const len = Math.hypot(dx, dy);
      const end: Vec2 = [x + dx * (1 - 6 / len), y + dy * (1 - 6 / len)];
      g.append(svg('line', { x1: x, y1: y, x2: end[0], y2: end[1] }, { stroke: style.fill ?? 'var(--text-muted)', strokeWidth: '0.75', opacity: '0.7' }));
      label(X, text, [dx + (dx >= 0 ? 3 : -3), dy + (dy >= 0 ? 10 : -2)], { textAnchor: dx >= 0 ? 'start' : 'end', ...style });
    };
    const math = { fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: '15px' };

    // Slice X = 0 (drawn by the side view), then the image plane.
    quad(
      [
        [0, -2.0, -0.6],
        [0, -2.0, 5.4],
        [0, 1.4, 5.4],
        [0, 1.4, -0.6],
      ],
      { fill: 'var(--hl)', fillOpacity: '0.07', stroke: 'var(--hl)', strokeOpacity: '0.45', strokeDasharray: '5 4' },
    );
    label([0, -2.0, 5.4], 'plane X_c = 0 (side view)', [-4, -8], { fill: 'var(--hl)', textAnchor: 'end', fontSize: '12px' });
    quad(
      [
        [-HW, -HH, F],
        [HW, -HH, F],
        [HW, HH, F],
        [-HW, HH, F],
      ],
      { fill: 'var(--accent)', fillOpacity: '0.07', stroke: 'var(--text-muted)', strokeWidth: '1.25' },
    );
    label([HW, HH, F], 'image plane Z_c = f', [8, 16], { fontSize: '12px' });

    // Optical axis, and the focal length as a dimension line under it.
    line([0, 0, 0], [0, 0, 6.2], { stroke: 'var(--text-faint)', strokeWidth: '1.25', strokeDasharray: '6 4' });
    label([0, 0, 6.2], 'optical axis', [6, 4], { fontSize: '12px', fill: 'var(--text-faint)' });
    const dimY = HH + 0.3; // below the image plane
    line([0, dimY, 0], [0, dimY, F], { stroke: 'var(--text-muted)', strokeWidth: '1' });
    line([0, dimY - 0.08, 0], [0, dimY + 0.08, 0], { stroke: 'var(--text-muted)', strokeWidth: '1' });
    line([0, dimY - 0.08, F], [0, dimY + 0.08, F], { stroke: 'var(--text-muted)', strokeWidth: '1' });
    line([0, HH, F], [0, dimY, F], { stroke: 'var(--text-faint)', strokeWidth: '0.75', strokeDasharray: '2 3' });
    label([0, dimY, F / 2], 'f', [0, 18], { ...math, textAnchor: 'middle', fill: 'var(--text)' });

    // P's shadow on the slice and its ray (what the side view shows).
    line(P, Ps, { stroke: 'var(--hl)', strokeWidth: '1', strokeDasharray: '2 3', opacity: '0.8' });
    line(Ps, [0, 0, 0], { stroke: 'var(--hl)', strokeWidth: '1', strokeDasharray: '4 3', opacity: '0.8' });
    dot(Ps, 3, { fill: 'var(--bg-subtle)', stroke: 'var(--hl)', strokeWidth: '1.5' });
    dot(ps, 2.5, { fill: 'var(--hl)' });

    // The ray from P through p to C.
    line(P, [0, 0, 0], { stroke: 'var(--accent)', strokeWidth: '1.5' });

    // Image-plane axes at the principal point, pixel axes at the top-left corner.
    arrow([0, 0, F], [0.55, 0, F], 'var(--text-muted)', 1.5);
    arrow([0, 0, F], [0, 0.55, F], 'var(--text-muted)', 1.5);
    label([0.55, 0, F], 'x', [4, 4], math);
    label([0, 0.55, F], 'y', [4, 12], math);
    arrow([-HW, -HH, F], [-HW + 0.6, -HH, F], 'var(--text)', 1.5);
    arrow([-HW, -HH, F], [-HW, -HH + 0.6, F], 'var(--text)', 1.5);
    label([-HW + 0.6, -HH, F], 'u', [4, -4], { ...math, fill: 'var(--text)' });
    label([-HW, -HH + 0.6, F], 'v', [-12, 10], { ...math, fill: 'var(--text)' });
    label([-HW, -HH, F], '(0, 0)', [-6, -8], { fontSize: '11px', textAnchor: 'end' });

    // Camera axes at C.
    arrow([0, 0, 0], [0.9, 0, 0], 'var(--ax-x)');
    arrow([0, 0, 0], [0, 0.9, 0], 'var(--ax-y)');
    arrow([0, 0, 0], [0, 0, 0.9], 'var(--ax-z)');
    label([0.9, 0, 0], 'X_c', [4, 12], { ...math, fill: 'var(--ax-x)' });
    label([0, 0.9, 0], 'Y_c', [-22, 6], { ...math, fill: 'var(--ax-y)' });
    label([0, 0, 0.9], 'Z_c', [-2, 18], { ...math, fill: 'var(--ax-z)' });

    // Points.
    dot([0, 0, 0], 4, { fill: 'var(--text)' });
    label([0, 0, 0], 'C', [-16, -6], { fill: 'var(--text)', fontWeight: '600', fontSize: '14px' });
    label([0, 0, 0], 'optical center', [-16, 10], { fontSize: '11px', textAnchor: 'end' });
    dot([0, 0, F], 4, { fill: 'var(--accent)', stroke: 'var(--bg-subtle)', strokeWidth: '1.5' });
    callout([0, 0, F], 'principal point (c_x, c_y)', [70, 56], { fill: 'var(--accent)', fontSize: '12px' });
    dot(p, 4, { fill: 'var(--hl)', stroke: 'var(--bg-subtle)', strokeWidth: '1.5' });
    callout(p, 'p = (x, y)', [14, -62], { ...math, fontSize: '14px', fill: 'var(--hl)' });
    dot(P, 5, { fill: 'var(--obj-a)', stroke: 'var(--bg-subtle)', strokeWidth: '1.5' });
    label(P, 'P = (X, Y, Z)', [10, -6], { ...math, fontSize: '14px', fill: 'var(--obj-a)' });

    plot.replaceChildren(g);
  }

  const redraw = scheduler(draw);

  let drag: { id: number; x: number; y: number } | null = null;
  plot.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    plot.setPointerCapture(e.pointerId);
  });
  plot.addEventListener('pointermove', (e) => {
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
  plot.addEventListener('pointerup', end);
  plot.addEventListener('pointercancel', end);
  plot.addEventListener('dblclick', () => {
    Object.assign(orbit, ORBIT_DEFAULT);
    redraw();
  });

  draw();
}
