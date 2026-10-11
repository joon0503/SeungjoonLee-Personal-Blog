/**
 * Small linear-algebra, projection and SVG helpers shared by the camera
 * figures. Plain arrays, no dependencies.
 *
 * Conventions follow OpenCV: the camera frame has x right, y down and z
 * forward (along the optical axis). The world frame is z-up.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Row-major 3×3 matrix. */
export type Mat3 = [Vec3, Vec3, Vec3];

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  s: number;
}

/** A rigid transform x_b = R x_a + t. */
export interface Pose {
  R: Mat3;
  t: Vec3;
}

export const DEG = Math.PI / 180;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

export const matVec = (M: Mat3, v: Vec3): Vec3 => [dot(M[0], v), dot(M[1], v), dot(M[2], v)];

export const transpose = (M: Mat3): Mat3 => [
  [M[0][0], M[1][0], M[2][0]],
  [M[0][1], M[1][1], M[2][1]],
  [M[0][2], M[1][2], M[2][2]],
];

export function matMul(A: Mat3, B: Mat3): Mat3 {
  const Bt = transpose(B);
  return [
    [dot(A[0], Bt[0]), dot(A[0], Bt[1]), dot(A[0], Bt[2])],
    [dot(A[1], Bt[0]), dot(A[1], Bt[1]), dot(A[1], Bt[2])],
    [dot(A[2], Bt[0]), dot(A[2], Bt[1]), dot(A[2], Bt[2])],
  ];
}

export const rotX = (a: number): Mat3 => [
  [1, 0, 0],
  [0, Math.cos(a), -Math.sin(a)],
  [0, Math.sin(a), Math.cos(a)],
];
export const rotY = (a: number): Mat3 => [
  [Math.cos(a), 0, Math.sin(a)],
  [0, 1, 0],
  [-Math.sin(a), 0, Math.cos(a)],
];
export const rotZ = (a: number): Mat3 => [
  [Math.cos(a), -Math.sin(a), 0],
  [Math.sin(a), Math.cos(a), 0],
  [0, 0, 1],
];

/**
 * Rotation of the camera optical frame relative to a z-up "body" frame
 * (x forward, y left, z up): optical x = −y_body, y = −z_body, z = x_body.
 */
const R_BODY_OPTICAL: Mat3 = [
  [0, 0, 1],
  [-1, 0, 0],
  [0, -1, 0],
];

/**
 * Camera-from-world pose of a camera at `center` (world coordinates) with
 * yaw / pitch / roll in radians (ZYX, pitch positive = looking down).
 */
export function cameraFromWorld(center: Vec3, yaw: number, pitch: number, roll: number): Pose {
  const R_wc = matMul(matMul(matMul(rotZ(yaw), rotY(pitch)), rotX(roll)), R_BODY_OPTICAL);
  const R = transpose(R_wc);
  return { R, t: scale(matVec(R, center), -1) };
}

/** Camera-from-world pose of a camera at `eye` looking at `target`, world z up. */
export function lookAt(eye: Vec3, target: Vec3): Pose {
  const z = normalize(sub(target, eye));
  const x = normalize(cross(z, [0, 0, 1]));
  const y = cross(z, x);
  const R: Mat3 = [x, y, z];
  return { R, t: scale(matVec(R, eye), -1) };
}

export const transform = (P: Pose, X: Vec3): Vec3 => add(matVec(P.R, X), P.t);

/** Pinhole projection of a camera-frame point to pixels. */
export function project(K: Intrinsics, [x, y, z]: Vec3): Vec2 {
  return [K.fx * (x / z) + K.s * (y / z) + K.cx, K.fy * (y / z) + K.cy];
}

/** Back-project a pixel to the camera-frame point at depth `z`. */
export function unproject(K: Intrinsics, [u, v]: Vec2, z: number): Vec3 {
  const y = (v - K.cy) / K.fy;
  const x = (u - K.cx - K.s * y) / K.fx;
  return [x * z, y * z, z];
}

/** Sutherland–Hodgman: keep the part of a camera-frame polygon with z ≥ near. */
export function clipNear(poly: Vec3[], near: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ina = a[2] >= near;
    const inb = b[2] >= near;
    if (ina) out.push(a);
    if (ina !== inb) {
      const k = (near - a[2]) / (b[2] - a[2]);
      out.push(add(a, scale(sub(b, a), k)));
    }
  }
  return out;
}

/** Clip a camera-frame segment to z ≥ near; null if it is entirely behind. */
export function clipSegmentNear(a: Vec3, b: Vec3, near: number): [Vec3, Vec3] | null {
  if (a[2] < near && b[2] < near) return null;
  if (a[2] >= near && b[2] >= near) return [a, b];
  const k = (near - a[2]) / (b[2] - a[2]);
  const m = add(a, scale(sub(b, a), k));
  return a[2] >= near ? [a, m] : [m, b];
}

/** Clip a 2D polygon to the axis-aligned rectangle [0, w] × [0, h]. */
export function clipRect(poly: Vec2[], w: number, h: number): Vec2[] {
  const edges: [number, number, boolean][] = [
    [0, 0, false], // axis, bound, keep ≤ bound?
    [0, w, true],
    [1, 0, false],
    [1, h, true],
  ];
  let out = poly;
  for (const [axis, bound, upper] of edges) {
    const input = out;
    out = [];
    const inside = (p: Vec2) => (upper ? p[axis] <= bound : p[axis] >= bound);
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) {
        const k = (bound - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
      }
    }
    if (out.length === 0) break;
  }
  return out;
}

/* --- DOM helpers ---------------------------------------------------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  style: Partial<CSSStyleDeclaration> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  Object.assign(el.style, style);
  return el;
}

export const pointsAttr = (pts: Vec2[]): string =>
  pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** Pointer position in the SVG's user (viewBox) coordinates. */
export function svgPoint(el: SVGSVGElement, event: PointerEvent): Vec2 {
  const pt = el.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const local = pt.matrixTransform(el.getScreenCTM()!.inverse());
  return [local.x, local.y];
}

/** Format a number for readouts; avoids "-0.00". */
export function fmt(v: number, digits = 2): string {
  const s = v.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

/** Render a bracketed matrix into `el` (a `.matrix` element with CSS grid). */
export function renderMatrix(el: HTMLElement, rows: number[][], digits = 2, splitAfter?: number): void {
  el.style.setProperty('--cols', String(rows[0].length));
  el.replaceChildren(
    ...rows.flatMap((row) =>
      row.map((v, j) => {
        const cell = document.createElement('span');
        cell.textContent = fmt(v, digits);
        if (splitAfter !== undefined && j === splitAfter) cell.className = 'split';
        return cell;
      }),
    ),
  );
}

/** Coalesce redraw requests into one per animation frame. */
export function scheduler(draw: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      draw();
    });
  };
}
