/**
 * Implementation of <PinholeCamera />. Loaded lazily by PinholeCamera.astro.
 *
 * Two views of the same world:
 *   - an orbitable "scene" view showing the camera, its frustum, the virtual
 *     image plane and the projection rays, and
 *   - the image the camera actually sees, in pixel coordinates.
 *
 * Both views are rendered with the same pinhole projection (the scene view is
 * simply a second, virtual camera), using back-face culling and depth sorting.
 */
import {
  DEG,
  type Intrinsics,
  type Pose,
  type Vec2,
  type Vec3,
  add,
  cameraFromWorld,
  clipNear,
  clipRect,
  clipSegmentNear,
  cross,
  dot,
  fmt,
  lookAt,
  matVec,
  normalize,
  pointsAttr,
  project,
  renderMatrix,
  rotZ,
  scale,
  scheduler,
  sub,
  svg,
  transform,
  transpose,
  unproject,
} from './camera-math';

/* --- Scene definition ----------------------------------------------------- */

const W = 640; // camera image, pixels
const H = 480;
const SW = 480; // scene view, viewBox units
const SH = 360;
const NEAR = 0.05;
const PLANE_DEPTH = 1.1; // where the virtual image plane is drawn in the scene view
const LIGHT = normalize([-0.35, -0.55, 0.75]);

interface Mesh {
  vertices: Vec3[];
  faces: number[][];
  color: string;
}

const CUBE: Mesh = {
  color: 'var(--obj-a)',
  vertices: [
    [-0.5, -0.5, 0],
    [0.5, -0.5, 0],
    [0.5, 0.5, 0],
    [-0.5, 0.5, 0],
    [-0.5, -0.5, 1],
    [0.5, -0.5, 1],
    [0.5, 0.5, 1],
    [-0.5, 0.5, 1],
  ],
  faces: [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ],
};

const PYRAMID: Mesh = {
  color: 'var(--obj-b)',
  vertices: [
    [-0.6, -0.6, 0],
    [0.6, -0.6, 0],
    [0.6, 0.6, 0],
    [-0.6, 0.6, 0],
    [0, 0, 1.3],
  ],
  faces: [
    [0, 1, 2, 3],
    [0, 1, 4],
    [1, 2, 4],
    [2, 3, 4],
    [3, 0, 4],
  ],
};

/** Index of the pyramid apex, the point tracked in the readout. */
const APEX = 4;

/** Orient every face counter-clockwise seen from outside (outward normal). */
function orientFaces(mesh: Mesh): Mesh {
  const n = mesh.vertices.length;
  const centroid = scale(mesh.vertices.reduce(add, [0, 0, 0]), 1 / n);
  const faces = mesh.faces.map((f) => {
    const [a, b, c] = f.map((i) => mesh.vertices[i]);
    const normal = cross(sub(b, a), sub(c, a));
    return dot(normal, sub(a, centroid)) < 0 ? [...f].reverse() : f;
  });
  return { ...mesh, faces };
}

const MESHES = [orientFaces(CUBE), orientFaces(PYRAMID)];

interface ObjectState {
  x: number;
  y: number;
  z: number;
  yaw: number; // degrees
}

/** A face placed in the world, ready to be drawn by either view. */
interface WorldFace {
  points: Vec3[];
  center: Vec3;
  normal: Vec3;
  fill: string;
}

function placeObjects(objects: ObjectState[]): { faces: WorldFace[]; vertices: Vec3[][] } {
  const faces: WorldFace[] = [];
  const vertices: Vec3[][] = [];
  MESHES.forEach((mesh, k) => {
    const o = objects[k];
    const R = rotZ(o.yaw * DEG);
    const verts = mesh.vertices.map((v) => add(matVec(R, v), [o.x, o.y, o.z]));
    vertices.push(verts);
    for (const f of mesh.faces) {
      const points = f.map((i) => verts[i]);
      const normal = normalize(cross(sub(points[1], points[0]), sub(points[2], points[0])));
      const center = scale(points.reduce(add, [0, 0, 0]), 1 / points.length);
      const shade = Math.round(58 + 42 * Math.max(0, dot(normal, LIGHT)));
      faces.push({ points, center, normal, fill: `color-mix(in oklab, ${mesh.color} ${shade}%, black)` });
    }
  });
  return { faces, vertices };
}

/** Ground grid segments on z = 0. */
const GRID: [Vec3, Vec3][] = [];
for (let i = -4; i <= 4; i++) {
  GRID.push([
    [i, -4, 0],
    [i, 4, 0],
  ]);
  GRID.push([
    [-4, i, 0],
    [4, i, 0],
  ]);
}

const AXES: { dir: Vec3; color: string; label: string }[] = [
  { dir: [1, 0, 0], color: 'var(--ax-x)', label: 'x' },
  { dir: [0, 1, 0], color: 'var(--ax-y)', label: 'y' },
  { dir: [0, 0, 1], color: 'var(--ax-z)', label: 'z' },
];

/* --- A view = a pinhole camera + an SVG ----------------------------------- */

interface View {
  K: Intrinsics;
  pose: Pose;
  eye: Vec3; // camera center in world coordinates
}

const cameraCenter = (pose: Pose): Vec3 => scale(matVec(transpose(pose.R), pose.t), -1);

/** Project a world segment, clipped to the near plane. */
function segment(view: View, a: Vec3, b: Vec3): [Vec2, Vec2] | null {
  const clipped = clipSegmentNear(transform(view.pose, a), transform(view.pose, b), NEAR);
  return clipped && [project(view.K, clipped[0]), project(view.K, clipped[1])];
}

function line(p: [Vec2, Vec2], style: Partial<CSSStyleDeclaration>, attrs: Record<string, string | number> = {}) {
  return svg('line', { x1: p[0][0], y1: p[0][1], x2: p[1][0], y2: p[1][1], ...attrs }, style);
}

/** Visible faces of the scene in `view`, back-to-front, as projected polygons. */
function renderFaces(view: View, faces: WorldFace[]): { face: WorldFace; poly: Vec2[] }[] {
  const out: { face: WorldFace; poly: Vec2[]; depth: number }[] = [];
  for (const face of faces) {
    if (dot(face.normal, sub(view.eye, face.center)) <= 0) continue; // back face
    const cam = face.points.map((p) => transform(view.pose, p));
    const clipped = clipNear(cam, NEAR);
    if (clipped.length < 3) continue;
    const depth = cam.reduce((s, p) => s + p[2], 0) / cam.length;
    out.push({ face, poly: clipped.map((p) => project(view.K, p)), depth });
  }
  return out.sort((a, b) => b.depth - a.depth);
}

/* --- Mount ---------------------------------------------------------------- */

export function mountPinholeCamera(root: HTMLElement): void {
  const sceneSvg = root.querySelector<SVGSVGElement>('[data-scene]')!;
  const imageSvg = root.querySelector<SVGSVGElement>('[data-image]')!;
  const inputs = new Map<string, HTMLInputElement>();
  root.querySelectorAll<HTMLInputElement>('input[data-in]').forEach((el) => inputs.set(el.dataset.in!, el));
  const val = (key: string) => Number(inputs.get(key)!.value);
  const checked = (key: string) => inputs.get(key)!.checked;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`);
  const setOut = (key: string, text: string) => {
    const el = out(key);
    if (el) el.textContent = text;
  };

  const initialObjects: ObjectState[] = [
    { x: 0, y: 0.8, z: 0, yaw: 20 },
    { x: 0.6, y: -1.1, z: 0, yaw: 0 },
  ];
  let objects = initialObjects.map((o) => ({ ...o }));
  let selected = 0;
  const initialInputs = new Map([...inputs].map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));

  const orbitDefault = { az: -68, el: 26, dist: 11 };
  const orbit = { ...orbitDefault };
  const ORBIT_TARGET: Vec3 = [-2.3, -0.6, 0.8];
  const sceneK: Intrinsics = { fx: 520, fy: 520, cx: SW / 2, cy: SH / 2, s: 0 };

  function syncObjectSliders() {
    const o = objects[selected];
    inputs.get('objX')!.value = String(o.x);
    inputs.get('objY')!.value = String(o.y);
    inputs.get('objZ')!.value = String(o.z);
    inputs.get('objYaw')!.value = String(o.yaw);
  }

  // Layers
  const scene = {
    grid: svg('g', {}, { stroke: 'var(--border-strong)', strokeWidth: '1' }),
    axes: svg('g', {}, { strokeWidth: '2', strokeLinecap: 'round' }),
    faces: svg('g', {}, { stroke: 'var(--bg-subtle)', strokeWidth: '0.75', strokeLinejoin: 'round' }),
    plane: svg('g'),
    rays: svg('g', {}, { stroke: 'var(--accent)', strokeWidth: '1', strokeDasharray: '3 3', opacity: '0.7' }),
    camera: svg('g', {}, { strokeLinecap: 'round', strokeLinejoin: 'round' }),
    marks: svg('g'),
    labels: svg('g', {}, { fontSize: '12px', fontStyle: 'italic' }),
  };
  sceneSvg.replaceChildren(...Object.values(scene));

  const image = {
    grid: svg('g', {}, { stroke: 'var(--border-strong)', strokeWidth: '1.25' }),
    axes: svg('g', {}, { strokeWidth: '3', strokeLinecap: 'round' }),
    faces: svg('g', {}, { stroke: 'var(--bg-subtle)', strokeWidth: '1', strokeLinejoin: 'round' }),
    overlay: svg('g'),
  };
  imageSvg.replaceChildren(...Object.values(image));

  function draw() {
    // Read controls
    const o = objects[selected];
    o.x = val('objX');
    o.y = val('objY');
    o.z = val('objZ');
    o.yaw = val('objYaw');

    const f = val('f');
    const K: Intrinsics = { fx: f, fy: f, cx: W / 2, cy: H / 2, s: 0 };
    const camPose = cameraFromWorld([val('camX'), val('camY'), val('camZ')], val('yaw') * DEG, val('pitch') * DEG, val('roll') * DEG);
    const cam: View = { K, pose: camPose, eye: cameraCenter(camPose) };

    const az = orbit.az * DEG;
    const el = orbit.el * DEG;
    const eye = add(ORBIT_TARGET, scale([Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)], orbit.dist));
    const obs: View = { K: sceneK, pose: lookAt(eye, ORBIT_TARGET), eye };

    for (const key of ['camX', 'camY', 'camZ', 'objX', 'objY', 'objZ']) setOut(key, fmt(val(key), 1));
    for (const key of ['yaw', 'pitch', 'roll', 'objYaw']) setOut(key, `${val(key).toFixed(0)}°`);
    setOut('f', `${f.toFixed(0)} px`);
    setOut('fov', `${(2 * Math.atan(W / 2 / f) / DEG).toFixed(0)}° × ${(2 * Math.atan(H / 2 / f) / DEG).toFixed(0)}°`);

    const { faces, vertices } = placeObjects(objects);
    const toCamWorld = (Xc: Vec3): Vec3 => matVec(transpose(camPose.R), sub(Xc, camPose.t));

    /* ---- Camera image ---- */

    image.grid.replaceChildren(
      ...GRID.flatMap(([a, b]) => {
        const s = segment(cam, a, b);
        return s ? [line(s, {})] : [];
      }),
    );
    image.axes.replaceChildren(
      ...AXES.flatMap(({ dir, color }) => {
        const s = segment(cam, [0, 0, 0], dir);
        return s ? [line(s, { stroke: color })] : [];
      }),
    );
    const imageFaces = renderFaces(cam, faces);
    image.faces.replaceChildren(
      ...imageFaces.map(({ face, poly }) => svg('polygon', { points: pointsAttr(poly) }, { fill: face.fill })),
    );

    const apexW = vertices[1][APEX];
    const apexC = transform(camPose, apexW);
    const apexUV = apexC[2] > NEAR ? project(K, apexC) : null;
    const apexInImage = apexUV !== null && apexUV[0] >= 0 && apexUV[0] <= W && apexUV[1] >= 0 && apexUV[1] <= H;

    image.overlay.replaceChildren();
    // Principal point and pixel axes
    image.overlay.append(
      svg('path', { d: `M${W / 2 - 8},${H / 2}h16M${W / 2},${H / 2 - 8}v16` }, { stroke: 'var(--text-faint)', strokeWidth: '1.5' }),
      svg('path', { d: 'M12,12h44M12,12v44' }, { stroke: 'var(--text-muted)', strokeWidth: '1.5', fill: 'none' }),
      textAt([62, 17], 'u', { fill: 'var(--text-muted)', fontSize: '15px', fontStyle: 'italic' }),
      textAt([8, 72], 'v', { fill: 'var(--text-muted)', fontSize: '15px', fontStyle: 'italic' }),
      textAt([W / 2 + 10, H / 2 + 22], 'principal point', { fill: 'var(--text-faint)', fontSize: '13px' }),
    );
    if (apexInImage) {
      image.overlay.append(
        svg('circle', { cx: apexUV[0], cy: apexUV[1], r: 6 }, { fill: 'var(--hl)', stroke: 'var(--bg-subtle)', strokeWidth: '2' }),
        textAt([apexUV[0] + 10, apexUV[1] - 10], `(${apexUV[0].toFixed(0)}, ${apexUV[1].toFixed(0)})`, {
          fill: 'var(--hl)',
          fontSize: '15px',
          fontWeight: '600',
        }),
      );
    }
    if (imageFaces.length === 0) {
      image.overlay.append(
        textAt([W / 2, H / 2 - 24], 'No objects in view', { fill: 'var(--text-faint)', fontSize: '18px', textAnchor: 'middle' }),
      );
    }

    /* ---- Scene view ---- */

    scene.grid.replaceChildren(
      ...GRID.flatMap(([a, b]) => {
        const s = segment(obs, a, b);
        return s ? [line(s, {})] : [];
      }),
    );

    scene.axes.replaceChildren();
    scene.labels.replaceChildren();
    for (const { dir, color, label } of AXES) {
      const s = segment(obs, [0, 0, 0], dir);
      if (!s) continue;
      scene.axes.append(line(s, { stroke: color }));
      scene.labels.append(textAt([s[1][0] + 4, s[1][1] - 4], label, { fill: color }));
    }

    scene.faces.replaceChildren(
      ...renderFaces(obs, faces).map(({ face, poly }) => svg('polygon', { points: pointsAttr(poly) }, { fill: face.fill })),
    );

    // Camera frustum and the virtual image plane in front of the center
    const C = cam.eye;
    const corners: Vec2[] = [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ];
    const planeW = corners.map((uv) => toCamWorld(unproject(K, uv, PLANE_DEPTH)));
    const proj = (X: Vec3): Vec2 | null => {
      const Xc = transform(obs.pose, X);
      return Xc[2] > NEAR ? project(obs.K, Xc) : null;
    };
    const Cs = proj(C);
    const planeS = planeW.map(proj);

    scene.plane.replaceChildren();
    if (planeS.every((p) => p)) {
      scene.plane.append(
        svg('polygon', { points: pointsAttr(planeS as Vec2[]) }, { fill: 'var(--bg)', fillOpacity: '0.8', stroke: 'none' }),
      );
      if (checked('showImage')) {
        // What the sensor sees, painted onto the virtual image plane.
        for (const { face, poly } of imageFaces) {
          const clipped = clipRect(poly, W, H);
          if (clipped.length < 3) continue;
          const pts = clipped.map((uv) => proj(toCamWorld(unproject(K, uv, PLANE_DEPTH))));
          if (pts.some((p) => !p)) continue;
          scene.plane.append(svg('polygon', { points: pointsAttr(pts as Vec2[]) }, { fill: face.fill }));
        }
      }
    }

    // Projection rays: every object vertex that lands inside the image
    scene.rays.replaceChildren();
    scene.marks.replaceChildren();
    if (checked('showRays') && Cs) {
      vertices.forEach((verts, k) => {
        verts.forEach((X, i) => {
          const Xc = transform(camPose, X);
          if (Xc[2] <= NEAR) return;
          const uv = project(K, Xc);
          if (uv[0] < 0 || uv[0] > W || uv[1] < 0 || uv[1] > H) return;
          const Xs = proj(X);
          if (!Xs) return;
          const isApex = k === 1 && i === APEX;
          scene.rays.append(line([Xs, Cs], isApex ? { stroke: 'var(--hl)', opacity: '1', strokeDasharray: 'none' } : {}));
          const onPlane = proj(toCamWorld(scale(Xc, PLANE_DEPTH / Xc[2])));
          if (onPlane) {
            scene.marks.append(
              svg('circle', { cx: onPlane[0], cy: onPlane[1], r: isApex ? 3 : 2 }, { fill: isApex ? 'var(--hl)' : 'var(--accent)' }),
            );
          }
        });
      });
    }
    const apexS = proj(apexW);
    if (apexS) {
      scene.marks.append(
        svg('circle', { cx: apexS[0], cy: apexS[1], r: 3.5 }, { fill: 'var(--hl)', stroke: 'var(--bg-subtle)', strokeWidth: '1.5' }),
      );
    }

    scene.camera.replaceChildren();
    if (Cs && planeS.every((p) => p)) {
      const ps = planeS as Vec2[];
      scene.camera.append(
        svg(
          'path',
          { d: ps.map((p) => `M${Cs[0]},${Cs[1]}L${p[0]},${p[1]}`).join('') + `M${ps.map((p) => p.join(',')).join('L')}Z` },
          { stroke: 'var(--text-muted)', strokeWidth: '1.25', fill: 'none' },
        ),
      );
      // Top edge of the image (v = 0) drawn thicker, so the image orientation is readable.
      scene.camera.append(line([ps[0], ps[1]], { stroke: 'var(--text)', strokeWidth: '2.5' }));
    }
    // Camera axes: x right, y down, z forward
    const Rwc = transpose(camPose.R);
    AXES.forEach(({ color, label }, j) => {
      const dir: Vec3 = [Rwc[0][j], Rwc[1][j], Rwc[2][j]];
      const s = segment(obs, C, add(C, scale(dir, 0.45)));
      if (!s) return;
      scene.camera.append(line(s, { stroke: color, strokeWidth: '2' }));
      const t = textAt([s[1][0] + 3, s[1][1] + 4], label, { fill: color, fontSize: '11px' });
      t.append(svg('tspan', { dy: 3 }, { fontSize: '8px', fontStyle: 'normal' }));
      t.lastChild!.textContent = 'c';
      scene.labels.append(t);
    });
    if (Cs) {
      scene.camera.append(svg('circle', { cx: Cs[0], cy: Cs[1], r: 3 }, { fill: 'var(--text)' }));
      scene.labels.append(textAt([Cs[0] - 14, Cs[1] - 6], 'C', { fill: 'var(--text)', fontStyle: 'normal', fontWeight: '600' }));
    }

    /* ---- Readouts ---- */

    renderMatrix(out('K')!, [
      [K.fx, K.s, K.cx],
      [0, K.fy, K.cy],
      [0, 0, 1],
    ], 0);
    renderMatrix(
      out('Rt')!,
      camPose.R.map((row, i) => [...row, camPose.t[i]]),
      2,
      3,
    );
    setOut('apexW', `(${apexW.map((v) => fmt(v)).join(', ')})`);
    setOut('apexC', `(${apexC.map((v) => fmt(v)).join(', ')})`);
    setOut(
      'apexUV',
      apexC[2] <= NEAR ? 'behind the camera' : `(${apexUV![0].toFixed(1)}, ${apexUV![1].toFixed(1)})${apexInImage ? '' : ' — outside image'}`,
    );
  }

  function textAt([x, y]: Vec2, text: string, style: Partial<CSSStyleDeclaration>) {
    const t = svg('text', { x, y }, style);
    t.textContent = text;
    return t;
  }

  const redraw = scheduler(draw);

  inputs.forEach((el) => el.addEventListener('input', redraw));

  root.querySelectorAll<HTMLInputElement>('input[name="object"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      selected = Number(radio.value);
      syncObjectSliders();
      redraw();
    });
  });

  // Orbit the scene view by dragging.
  let drag: { id: number; x: number; y: number } | null = null;
  sceneSvg.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    sceneSvg.setPointerCapture(e.pointerId);
  });
  sceneSvg.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    orbit.az -= (e.clientX - drag.x) * 0.4;
    orbit.el = Math.min(85, Math.max(-5, orbit.el + (e.clientY - drag.y) * 0.4));
    drag.x = e.clientX;
    drag.y = e.clientY;
    redraw();
  });
  const endDrag = () => {
    drag = null;
  };
  sceneSvg.addEventListener('pointerup', endDrag);
  sceneSvg.addEventListener('pointercancel', endDrag);

  root.querySelector('[data-action="reset"]')!.addEventListener('click', () => {
    for (const [k, v] of initialInputs) {
      const el = inputs.get(k)!;
      if (typeof v === 'boolean') el.checked = v;
      else el.value = v;
    }
    objects = initialObjects.map((o) => ({ ...o }));
    selected = 0;
    root.querySelector<HTMLInputElement>('input[name="object"][value="0"]')!.checked = true;
    Object.assign(orbit, orbitDefault);
    syncObjectSliders();
    redraw();
  });

  // Object sliders start out showing object 0.
  selected = Number(root.querySelector<HTMLInputElement>('input[name="object"]:checked')?.value ?? 0);
  syncObjectSliders();
  draw();
}
