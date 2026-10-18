/**
 * Implementation of <BayerMosaic />. Loaded lazily by BayerMosaic.astro.
 *
 * A grid of photosites, each tinted by the filter over it. Selecting a pixel
 * outlines the neighbours that bilinear demosaicing averages for each of its
 * two missing channels and writes out the formulas.
 */
import { svg } from '../camera/camera-math';
import { type BayerPattern, bayerChannel, radioValue } from './imaging';

const COLS = 10;
const ROWS = 8;
const CELL = 36;
const X0 = 34; // grid origin, leaving room for the row and column indices
const Y0 = 24;

const NAMES = ['R', 'G', 'B'] as const;
const COLOR = ['var(--ch-r)', 'var(--ch-g)', 'var(--ch-b)'];
const DASH = ['', '5 3', '2 2.5'];
const FRACTION: Record<number, string> = { 1: '', 2: '½', 3: '⅓', 4: '¼' };

const inGrid = ([x, y]: [number, number]) => x >= 0 && x < COLS && y >= 0 && y < ROWS;

/** Neighbours bilinear demosaicing averages for channel `c` at (x, y), clipped to the grid. */
function neighbours(p: BayerPattern, x: number, y: number, c: number): [number, number][] {
  const crossN: [number, number][] = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
  const diagN: [number, number][] = [[x - 1, y - 1], [x + 1, y - 1], [x - 1, y + 1], [x + 1, y + 1]];
  const horiz: [number, number][] = [[x - 1, y], [x + 1, y]];
  const vert: [number, number][] = [[x, y - 1], [x, y + 1]];
  const own = bayerChannel(p, x, y);
  let cand: [number, number][];
  if (own === 1) {
    // Green pixel: one of R/B sits left and right, the other above and below
    cand = bayerChannel(p, x + 1, y) === c ? horiz : vert;
  } else {
    cand = c === 1 ? crossN : diagN;
  }
  return cand.filter(inGrid);
}

export function mountBayerMosaic(root: HTMLElement): void {
  const grid = root.querySelector<SVGSVGElement>('[data-grid]')!;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  let sel: [number, number] = [4, 3];

  const draw = () => {
    const p = radioValue(root, 'bayer-pattern') as BayerPattern;
    const [sx, sy] = sel;
    const own = bayerChannel(p, sx, sy);
    const missing = [0, 1, 2].filter((c) => c !== own);
    const used = new Map<string, number>(); // "x,y" → channel it contributes
    for (const c of missing) for (const [x, y] of neighbours(p, sx, sy, c)) used.set(`${x},${y}`, c);

    const g = svg('g');
    // Row and column indices
    for (let x = 0; x < COLS; x++) {
      g.append(
        Object.assign(svg('text', { x: X0 + (x + 0.5) * CELL, y: Y0 - 8, 'text-anchor': 'middle' }, { fill: 'var(--text-faint)', fontSize: '11px' }), {
          textContent: String(x),
        }),
      );
    }
    for (let y = 0; y < ROWS; y++) {
      g.append(
        Object.assign(svg('text', { x: X0 - 10, y: Y0 + (y + 0.5) * CELL + 4, 'text-anchor': 'middle' }, { fill: 'var(--text-faint)', fontSize: '11px' }), {
          textContent: String(y),
        }),
      );
    }

    // Photosites
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const c = bayerChannel(p, x, y);
        const key = `${x},${y}`;
        const isSel = x === sx && y === sy;
        const involved = isSel || used.has(key);
        const cell = svg('g', { 'data-x': x, 'data-y': y }, { opacity: involved ? '1' : '0.4', cursor: 'pointer' });
        cell.append(
          svg('rect', { x: X0 + x * CELL + 1, y: Y0 + y * CELL + 1, width: CELL - 2, height: CELL - 2, rx: 3 }, { fill: COLOR[c], fillOpacity: '0.28' }),
          Object.assign(
            svg('text', { x: X0 + (x + 0.5) * CELL, y: Y0 + (y + 0.5) * CELL + 5, 'text-anchor': 'middle' }, { fill: COLOR[c], fontSize: '14px', fontWeight: '600' }),
            { textContent: NAMES[c] },
          ),
        );
        g.append(cell);
      }
    }

    // Outlines of the neighbours used for each missing channel
    for (const [key, c] of used) {
      const [x, y] = key.split(',').map(Number);
      g.append(
        svg(
          'rect',
          { x: X0 + x * CELL + 3, y: Y0 + y * CELL + 3, width: CELL - 6, height: CELL - 6, rx: 3 },
          { fill: 'none', stroke: COLOR[c], strokeWidth: '2.5', strokeDasharray: DASH[c], pointerEvents: 'none' },
        ),
      );
    }
    // Selected pixel
    g.append(
      svg(
        'rect',
        { x: X0 + sx * CELL, y: Y0 + sy * CELL, width: CELL, height: CELL, rx: 4 },
        { fill: 'none', stroke: 'var(--text)', strokeWidth: '3', pointerEvents: 'none' },
      ),
    );

    // The top-left 2 × 2 tile, which names the pattern
    g.append(
      svg(
        'rect',
        { x: X0 - 3, y: Y0 - 3, width: 2 * CELL + 6, height: 2 * CELL + 6, rx: 5 },
        { fill: 'none', stroke: 'var(--accent)', strokeWidth: '2', strokeDasharray: '6 3', pointerEvents: 'none' },
      ),
      Object.assign(svg('text', { x: X0, y: Y0 + ROWS * CELL + 24 }, { fill: 'var(--accent)', fontSize: '13px' }), {
        textContent: `Top-left tile: ${p[0]} ${p[1]} / ${p[2]} ${p[3]}  →  "${p}"`,
      }),
    );
    grid.replaceChildren(g);

    // Readouts
    out('pixel').textContent = `(row ${sy}, col ${sx}) measures ${NAMES[own]}; ${NAMES[missing[0]]} and ${NAMES[missing[1]]} are interpolated.`;
    missing.forEach((c, k) => {
      const ns = neighbours(p, sx, sy, c);
      const terms = ns.map(([x, y]) => `${NAMES[c]}(${y},${x})`).join(' + ');
      const el = out(k === 0 ? 'f1' : 'f2');
      el.textContent = `${NAMES[c]}̂(${sy},${sx}) = ${FRACTION[ns.length]}(${terms})`;
      el.style.color = COLOR[c];
    });
  };

  const pick = (event: PointerEvent) => {
    const cell = (event.target as Element).closest<SVGGElement>('g[data-x]');
    if (!cell) return;
    const next: [number, number] = [Number(cell.dataset.x), Number(cell.dataset.y)];
    if (next[0] === sel[0] && next[1] === sel[1]) return;
    sel = next;
    draw();
  };
  grid.addEventListener('pointermove', pick);
  grid.addEventListener('pointerdown', pick);
  root.querySelectorAll('input[name="bayer-pattern"]').forEach((el) => el.addEventListener('change', draw));

  draw();
}
