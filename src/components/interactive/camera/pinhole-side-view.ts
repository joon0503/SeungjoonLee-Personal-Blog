/**
 * Implementation of <PinholeSideView />. Loaded lazily by PinholeSideView.astro.
 *
 * The slice X = 0 of the camera frame in <PinholeFrames />, seen with X
 * pointing toward the reader: Z (the optical axis) to the right, Y down, as
 * in OpenCV. A point P = (Y, Z) projects through the optical center C onto the
 * sensor at Z = −f (inverted) and, equivalently, onto the virtual image plane
 * at Z = +f (upright). Similar triangles give y = f·Y/Z.
 *
 * The sensor has a fixed size, so only points inside the field of view (the
 * wedge from C through the sensor's edges) are imaged; a point outside it is
 * flagged, and its would-be image point is marked off the sensor.
 *
 * c_y places the sensor relative to the optical axis: image coordinates are
 * v = y + c_y, measured down from the top edge of the image, so c_y is the
 * distance from that edge to the principal point (where the axis meets the
 * sensor). c_y = h/2 centers the sensor; other values shift it (lens shift),
 * which makes the field of view asymmetric.
 */
import { type Vec2, fmt, pointsAttr, scheduler, svg, svgPoint } from './camera-math';

const VW = 640;
const VH = 300;
const S = 40; // px per unit
const O: Vec2 = [200, VH / 2]; // the optical center C, in SVG coordinates
const Y_MAX = 3.3;
const SENSOR_H = 2.4; // sensor height h (same units as Y, Z, f and c_y)
const Z_MIN = 0.4;
const Z_MAX = (VW - O[0] - 16) / S;

/** Slice coordinates (Z along the axis, Y down) → SVG. */
const sv = (Z: number, Y: number): Vec2 => [O[0] + Z * S, O[1] + Y * S];
/** Signed value with a true minus sign. */
const num = (v: number) => fmt(v).replace('-', '−');

type Style = Partial<CSSStyleDeclaration>;

export function mountPinholeSideView(root: HTMLElement): void {
  const plot = root.querySelector<SVGSVGElement>('[data-plot]')!;
  const fIn = root.querySelector<HTMLInputElement>('[data-in="f"]')!;
  const cyIn = root.querySelector<HTMLInputElement>('[data-in="cy"]')!;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const status = out('status');

  let Z = 6;
  let Y = -2; // above the axis (Y points down)

  const layer = () => svg('g');
  const tri = layer();
  const guides = layer();
  const rays = layer();
  const camera = layer();
  const arrows = layer();
  const labels = svg('g', {}, { fontSize: '13px' });
  const handle = svg(
    'circle',
    { r: 7 },
    {
      fill: 'var(--obj-a)',
      stroke: 'var(--bg-subtle)',
      strokeWidth: '2',
      cursor: 'grab',
    },
  );
  const frame = layer(); // static: title and axis triad
  plot.replaceChildren(frame, tri, guides, camera, rays, arrows, labels, handle);

  const seg = (a: Vec2, b: Vec2, style: Style) => svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style);
  /** Text; `_c` style subscripts become <tspan>s. */
  const text = (p: Vec2, s: string, style: Style = {}) => {
    const t = svg('text', { x: p[0], y: p[1] }, { fill: 'var(--text-muted)', ...style });
    for (const part of s.split(/(_\w)/)) {
      if (!part) continue;
      const sub = part.startsWith('_');
      const span = svg('tspan', sub ? { 'baseline-shift': 'sub' } : {}, sub ? { fontSize: '0.75em', fontStyle: 'normal' } : {});
      span.textContent = sub ? part.slice(1) : part;
      t.append(span);
    }
    return t;
  };
  const arrow = (from: Vec2, to: Vec2, color: string, width = 3, head = 8) => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const len = Math.hypot(dx, dy);
    const g = svg(
      'g',
      {},
      {
        stroke: color,
        strokeWidth: String(width),
        strokeLinecap: 'round',
        fill: 'none',
      },
    );
    g.append(seg(from, to, {}));
    if (len > head) {
      const ux = dx / len;
      const uy = dy / len;
      g.append(
        svg('path', {
          d: `M${to[0] - head * (ux - 0.5 * uy)},${to[1] - head * (uy + 0.5 * ux)}L${to[0]},${to[1]}L${to[0] - head * (ux + 0.5 * uy)},${to[1] - head * (uy - 0.5 * ux)}`,
        }),
      );
    }
    return g;
  };
  const math: Style = {
    fontFamily: 'var(--serif)',
    fontStyle: 'italic',
    fontSize: '15px',
  };

  /**
   * A drafting-style dimension along the optical axis, from x1 to x2 at height
   * `row`: extension lines (from `extFrom`, the axis by default) just past the
   * row, a continuous dimension line with an arrowhead at each end, and the
   * value set just outside the line (ISO style), centered on it or at
   * `labelAt`. A value wider than its line goes past the end named by
   * `outside`, so two short neighbours never overlap. `equal` draws a double
   * congruence tick across the middle of the line, the geometry mark for
   * segments of equal length.
   */
  const dimension = (
    x1: number,
    x2: number,
    row: number,
    label: string,
    color: string,
    {
      extFrom = O[1],
      labelAt,
      equal = false,
      outside = 'right',
    }: { extFrom?: number; labelAt?: number; equal?: boolean; outside?: 'left' | 'right' } = {},
  ) => {
    const [a, b] = [Math.min(x1, x2), Math.max(x1, x2)];
    const g = svg('g', {}, { stroke: color, fill: color });
    const dir = Math.sign(row - extFrom) || 1; // the side of the line away from where it is measured from
    const ext = (x: number) => seg([x, extFrom + dir * 4], [x, row + dir * 6], { strokeWidth: '0.75', opacity: '0.7' });
    g.append(ext(a), ext(b), seg([a, row], [b, row], { strokeWidth: '1' }));
    const h = 6;
    if (b - a > 3 * h) {
      const head = (x: number, d: number) =>
        svg('path', { d: `M${x},${row}L${x + d * h},${row - h * 0.45}L${x + d * h},${row + h * 0.45}Z` }, { stroke: 'none' });
      g.append(head(a, 1), head(b, -1));
    }
    const mid = (a + b) / 2;
    if (equal) {
      // Congruence ticks, as in geometry figures: two short hairlines perpendicular to the line,
      // crossing it at its middle; small enough to stay clear of the value.
      for (const dx of [-1.75, 1.75]) g.append(seg([mid + dx, row - 3.5], [mid + dx, row + 3.5], { strokeWidth: '1' }));
    }
    // The value just outside the line (away from what it measures from), clear of the ticks.
    const textW = label.length * 6.4;
    const y = dir > 0 ? row + 17 : row - 8;
    const wide = textW > b - a - 4;
    const [x, anchor] = wide ? (outside === 'right' ? [b + 4, 'start'] : [a - 4, 'end']) : [labelAt ?? mid, 'middle'];
    g.append(
      text([x, y], label, {
        fill: color,
        stroke: 'none',
        fontSize: '13px',
        fontVariantNumeric: 'tabular-nums',
        textAnchor: anchor,
      }),
    );
    return g;
  };

  // Title and the axis triad (Z right, Y down, X out of the page).
  {
    const t0: Vec2 = [36, VH - 54];
    frame.append(
      text([12, 22], 'Slice X_c = 0 of the camera frame', {
        fill: 'var(--hl)',
        fontSize: '13px',
        fontWeight: '600',
      }),
      text([12, 40], 'X_c points toward you', {
        fill: 'var(--text-faint)',
        fontSize: '12px',
      }),
      arrow(t0, [t0[0] + 34, t0[1]], 'var(--ax-z)', 2, 6),
      arrow(t0, [t0[0], t0[1] + 34], 'var(--ax-y)', 2, 6),
      svg('circle', { cx: t0[0], cy: t0[1], r: 5 }, { fill: 'var(--bg-subtle)', stroke: 'var(--ax-x)', strokeWidth: '1.5' }),
      svg('circle', { cx: t0[0], cy: t0[1], r: 1.6 }, { fill: 'var(--ax-x)' }),
      text([t0[0] + 38, t0[1] + 4], 'Z_c', {
        ...math,
        fontSize: '13px',
        fill: 'var(--ax-z)',
      }),
      text([t0[0] + 6, t0[1] + 46], 'Y_c', {
        ...math,
        fontSize: '13px',
        fill: 'var(--ax-y)',
      }),
      text([t0[0] - 10, t0[1] - 10], 'X_c', {
        ...math,
        fontSize: '13px',
        fill: 'var(--ax-x)',
        textAnchor: 'middle',
      }),
    );
  }

  function draw() {
    const f = Number(fIn.value);
    const cy = Number(cyIn.value);
    const y = (f * Y) / Z;
    // The sensor in image coordinates (y down, origin on the optical axis).
    const yTop = -cy; // v = 0
    const yBottom = SENSOR_H - cy; // v = h
    const inView = y >= yTop && y <= yBottom;
    out('f').textContent = fmt(f);
    out('cy').textContent = fmt(cy);
    out('Y').textContent = num(Y);
    out('Z').textContent = fmt(Z);
    out('y').textContent = `${fmt(f)} × ${num(Y)} / ${fmt(Z)} = ${num(y)}`;
    out('v').textContent = `${num(y)} + ${fmt(cy)} = ${num(y + cy)}${inView ? '' : ` (outside 0…${fmt(SENSOR_H)})`}`;

    const top = sv(Z, Y);
    const base = sv(Z, 0);
    const sensorTop = sv(-f, -y);
    const virtualTop = sv(f, y);
    // Dimension labels go on the side of the axis away from the object.
    const above = Y > 0;
    const side = above ? -1 : 1; // −1: dimensions above the axis, +1: below

    tri.replaceChildren(
      svg('polygon', { points: pointsAttr([O, base, top]) }, { fill: 'var(--obj-a)', fillOpacity: '0.12' }),
      svg('polygon', { points: pointsAttr([O, sv(f, 0), virtualTop]) }, { fill: 'var(--hl)', fillOpacity: '0.22' }),
    );

    // Field of view: the wedge from C through the edges of the (virtual) sensor.
    const zEnd = (VW - O[0]) / S + 1;
    const slopeTop = yTop / f;
    const slopeBottom = yBottom / f;
    // "field of view" label: inside the wedge, in the top-right corner (just under the
    // upper edge). If the upper edge runs too close to the axis, use the bottom-right corner.
    const LABEL_W = 92;
    const edgeAt = (x: number, slope: number) => O[1] + slope * (x - O[0]); // edge's SVG y at SVG x
    const topY = Math.max(edgeAt(VW - 10 - LABEL_W, slopeTop), 20) + 16;
    const fovLabel: Vec2 =
      topY < O[1] - 16 ? [VW - 10, topY] : [VW - 10, Math.min(edgeAt(VW - 10 - LABEL_W, slopeBottom), VH - 14) - 6];
    // c_y as a dimension just left of the virtual image plane, from the top edge to the axis.
    const xPlane = sv(f, 0)[0];
    const xDim = xPlane - 9;
    const tick = (yv: number) =>
      seg([xDim - 4, sv(0, yv)[1]], [xDim + 4, sv(0, yv)[1]], {
        stroke: 'var(--text-muted)',
        strokeWidth: '1',
      });
    guides.replaceChildren(
      svg(
        'polygon',
        {
          points: pointsAttr([O, sv(zEnd, slopeTop * zEnd), sv(zEnd, slopeBottom * zEnd)]),
        },
        { fill: 'var(--accent)', fillOpacity: '0.05' },
      ),
      seg(O, sv(zEnd, slopeTop * zEnd), {
        stroke: 'var(--accent)',
        strokeOpacity: '0.45',
        strokeWidth: '1',
        strokeDasharray: '3 4',
      }),
      seg(O, sv(zEnd, slopeBottom * zEnd), {
        stroke: 'var(--accent)',
        strokeOpacity: '0.45',
        strokeWidth: '1',
        strokeDasharray: '3 4',
      }),
      seg([0, O[1]], [VW, O[1]], {
        stroke: 'var(--border-strong)',
        strokeWidth: '1',
        strokeDasharray: '4 4',
      }),
      seg([xPlane, 30], [xPlane, VH - 22], {
        stroke: 'var(--text-faint)',
        strokeWidth: '1.25',
        strokeDasharray: '5 4',
      }),
      // The virtual sensor: the part of the virtual image plane that is imaged.
      seg(sv(f, yTop), sv(f, yBottom), {
        stroke: 'var(--hl)',
        strokeOpacity: '0.4',
        strokeWidth: '4',
        strokeLinecap: 'butt',
      }),
      ...(cy > 0.05
        ? [
            seg([xDim, sv(0, yTop)[1]], [xDim, O[1]], {
              stroke: 'var(--text-muted)',
              strokeWidth: '1',
            }),
            tick(yTop),
            tick(0),
            // Label above the top end when P is above the axis (the ray then runs left of the line);
            // beside the middle of the line when P is below (the dimension rows are then above).
            text([xDim - 4, side > 0 ? sv(0, yTop)[1] - 14 : (sv(0, yTop)[1] + O[1]) / 2 + 4], `c_y = ${fmt(cy)}`, {
              fill: 'var(--text)',
              fontSize: '12px',
              textAnchor: 'end',
              fontVariantNumeric: 'tabular-nums',
            }),
          ]
        : []),
      text(fovLabel, 'field of view', {
        fill: 'var(--accent)',
        fontSize: '12px',
        textAnchor: 'end',
        opacity: '0.85',
      }),
    );

    // Camera box: the back wall is the sensor (inverted, so it spans −yBottom…−yTop),
    // the pinhole C is in the front wall.
    const boxTop = -yBottom - 0.35;
    const boxBottom = -yTop + 0.35;
    // Dimension rows, on the side of the axis away from P: both f's just past the housing, then Z.
    const housingEdge = sv(0, side > 0 ? boxBottom : boxTop)[1];
    // Each row needs room for its value on the outer side; Z stays clear of the title at the top.
    const fRow = side > 0 ? Math.min(housingEdge + 14, VH - 74) : Math.max(housingEdge - 14, 82);
    const zRow = fRow + side * 32;
    const gap = 0.12;
    camera.replaceChildren(
      svg(
        'path',
        {
          d:
            `M${sv(0, -gap).join(',')}L${sv(0, boxTop).join(',')}L${sv(-f, boxTop).join(',')}` +
            `M${sv(-f, boxBottom).join(',')}L${sv(0, boxBottom).join(',')}L${sv(0, gap).join(',')}`,
        },
        { stroke: 'var(--text-muted)', strokeWidth: '1.5', fill: 'none' },
      ),
      seg(sv(-f, -yBottom), sv(-f, -yTop), {
        stroke: 'var(--text)',
        strokeWidth: '3',
      }),
    );

    rays.replaceChildren(
      seg(top, sensorTop, {
        stroke: 'var(--accent)',
        strokeWidth: '1.25',
        strokeDasharray: inView ? '' : '4 4',
        opacity: inView ? '1' : '0.6',
      }),
      svg('circle', { cx: O[0], cy: O[1], r: 3.5 }, { fill: 'var(--text)' }),
    );

    // Off the sensor: the image arrows fade and an × marks where p would land.
    const imageArrow = (from: Vec2, to: Vec2) => {
      const g = arrow(from, to, 'var(--hl)');
      if (!inView) {
        g.style.opacity = '0.4';
        g.style.strokeDasharray = '4 3';
      }
      return g;
    };
    const cross = ([x, y]: Vec2) =>
      svg(
        'path',
        {
          d: `M${x - 5},${y - 5}L${x + 5},${y + 5}M${x - 5},${y + 5}L${x + 5},${y - 5}`,
        },
        { stroke: 'var(--ax-x)', strokeWidth: '2', strokeLinecap: 'round' },
      );
    arrows.replaceChildren(
      arrow(base, top, 'var(--obj-a)'),
      imageArrow(sv(-f, 0), sensorTop),
      imageArrow(sv(f, 0), virtualTop),
      ...(inView ? [] : [cross(sensorTop), cross(virtualTop)]),
    );
    handle.style.fill = inView ? 'var(--obj-a)' : 'var(--bg-subtle)';
    handle.style.stroke = inView ? 'var(--bg-subtle)' : 'var(--obj-a)';

    const value: Style = {
      fontSize: '13px',
      fontVariantNumeric: 'tabular-nums',
    };
    labels.replaceChildren(
      // On P's side of the housing; the dimension rows use the other side.
      text([sv(-f, 0)[0], above ? sv(0, boxBottom)[1] + 18 : sv(0, boxTop)[1] - 8], 'sensor', {
        textAnchor: 'middle',
      }),
      // At the end of the plane's line that is free of the dimension rows.
      text([sv(f, 0)[0], side > 0 ? 22 : VH - 8], 'virtual image plane', {
        textAnchor: 'middle',
        fill: 'var(--text-faint)',
        fontSize: '12px',
      }),
      // C's label goes on P's side of the axis; the dimensions use the other side.
      text([O[0] - 8, above ? O[1] + 18 : O[1] - 8], 'C', {
        textAnchor: 'end',
        fill: 'var(--text)',
        fontWeight: '600',
      }),
      text([top[0] + 12, top[1] + (above ? 16 : -2)], 'P', {
        ...math,
        fill: 'var(--obj-a)',
        fontWeight: '600',
      }),
      text([top[0] + 10, (top[1] + base[1]) / 2 + 5], `Y = ${num(Y)}`, {
        ...value,
        fill: 'var(--obj-a)',
      }),
      text([virtualTop[0] + 8, (virtualTop[1] + O[1]) / 2 + 5], `y = ${num(y)}`, { ...value, fill: 'var(--hl)' }),
      // f twice, in one row just outside the housing: behind C to the sensor and in front of C to
      // the virtual image plane, with "//" marks to show they are the same length.
      dimension(sv(-f, 0)[0], O[0], fRow, `f = ${fmt(f)}`, 'var(--text)', { extFrom: housingEdge, equal: true, outside: 'left' }),
      dimension(O[0], sv(f, 0)[0], fRow, `f = ${fmt(f)}`, 'var(--text)', { equal: true }),
      // Z one row further out; its value sits between the virtual plane and P when there is room.
      dimension(O[0], base[0], zRow, `Z = ${fmt(Z)}`, 'var(--text-muted)', {
        labelAt: base[0] - sv(f, 0)[0] > 110 ? (sv(f, 0)[0] + base[0]) / 2 : undefined,
      }),
      text([VW - 8, O[1] - 8], 'Z_c (optical axis)', {
        textAnchor: 'end',
        fill: 'var(--text-faint)',
        fontSize: '12px',
      }),
      ...(inView
        ? []
        : [
            text([virtualTop[0] + 9, virtualTop[1] + (y < 0 ? -8 : 16)], 'off the sensor', {
              fill: 'var(--ax-x)',
              fontSize: '12px',
              fontWeight: '600',
            }),
          ]),
    );
    status.classList.toggle('warn', !inView);
    status.innerHTML = inView
      ? '<i>P</i> is inside the field of view: its image point lands on the sensor.'
      : '<i>P</i> is outside the field of view: its image point lands off the sensor, so it does not appear in the image.';

    handle.setAttribute('cx', String(top[0]));
    handle.setAttribute('cy', String(top[1]));
  }

  const redraw = scheduler(draw);
  fIn.addEventListener('input', redraw);
  cyIn.addEventListener('input', redraw);

  let dragging: number | null = null;
  const moveTo = (e: PointerEvent) => {
    const [x, y] = svgPoint(plot, e);
    Z = Math.min(Z_MAX, Math.max(Z_MIN, (x - O[0]) / S));
    Y = Math.min(Y_MAX, Math.max(-Y_MAX, (y - O[1]) / S));
    redraw();
  };
  plot.addEventListener('pointerdown', (e) => {
    dragging = e.pointerId;
    plot.setPointerCapture(e.pointerId);
    moveTo(e);
  });
  plot.addEventListener('pointermove', (e) => {
    if (dragging === e.pointerId) moveTo(e);
  });
  const end = () => {
    dragging = null;
  };
  plot.addEventListener('pointerup', end);
  plot.addEventListener('pointercancel', end);

  draw();
}
