/**
 * Implementation of <YuvLayout />. Loaded lazily by YuvLayout.astro.
 *
 * Builds the byte sequence of a 4 × 4 image in each format, tags every byte
 * with the pixels it contributes to, and highlights pixels ↔ bytes on hover.
 * Y′CbCr values come from the gamma-encoded R′G′B′ pixels (BT.601, limited
 * range); a subsampled chroma byte is the average over the pixels it covers.
 */
import { radioValue } from './imaging';
import { quantize, rgbToYcc } from './yuv';

const N = 4;

/** 4 × 4 test image, sRGB hex, row by row. */
const PIXELS = [
  '#e63946', '#f4a261', '#2a9d8f', '#264653',
  '#ffb703', '#fb8500', '#8ecae6', '#219ebc',
  '#6a4c93', '#c77dff', '#80b918', '#2b9348',
  '#f1faee', '#a8dadc', '#457b9d', '#1d3557',
];

type Kind = 'Y' | 'U' | 'V' | 'R' | 'G' | 'B';

interface Byte {
  kind: Kind;
  /** Subscript: pixel (row, col) for Y/R/G/B, chroma sample (row, col) for U/V. */
  sub: string;
  pixels: number[];
  value: number;
}

interface Plane {
  name: string;
  rows: Byte[][];
}

interface Format {
  layout: string;
  sub: string;
  bpp: string;
  formula: string;
  bytes: (w: number, h: number) => number;
  about: string;
  planes: () => Plane[];
}

const rgb = PIXELS.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
const ycc = rgb.map(([r, g, b]) => quantize(...rgbToYcc(r / 255, g / 255, b / 255, '601'), 'limited'));

const pix = (r: number, c: number) => r * N + c;
const avg = (ps: number[], ch: 1 | 2) => Math.round(ps.reduce((s, p) => s + ycc[p][ch], 0) / ps.length);

const yByte = (r: number, c: number): Byte => ({ kind: 'Y', sub: `${r}${c}`, pixels: [pix(r, c)], value: ycc[pix(r, c)][0] });
const cByte = (kind: 'U' | 'V', sub: string, pixels: number[]): Byte => ({ kind, sub, pixels, value: avg(pixels, kind === 'U' ? 1 : 2) });

/** Pixels covered by chroma sample (j, i) when chroma is subsampled by sx × sy. */
const block = (j: number, i: number, sx: number, sy: number) => {
  const ps: number[] = [];
  for (let r = j * sy; r < (j + 1) * sy; r++) for (let c = i * sx; c < (i + 1) * sx; c++) ps.push(pix(r, c));
  return ps;
};

const range = (n: number) => [...Array(n).keys()];

function rgbPlanes(order: ('R' | 'G' | 'B')[]): Plane[] {
  return [
    {
      name: 'Interleaved, one plane',
      rows: range(N).map((r) =>
        range(N).flatMap((c) => order.map((k) => ({ kind: k, sub: `${r}${c}`, pixels: [pix(r, c)], value: rgb[pix(r, c)]['RGB'.indexOf(k)] }))),
      ),
    },
  ];
}

function packed422(order: string): Plane[] {
  return [
    {
      name: 'Packed, one plane (a macropixel of 4 bytes per 2 pixels)',
      rows: range(N).map((r) =>
        range(N / 2).flatMap((k) =>
          [...order].map((t) => {
            if (t === '0') return yByte(r, 2 * k);
            if (t === '1') return yByte(r, 2 * k + 1);
            return cByte(t as 'U' | 'V', `${r}${k}`, block(r, k, 2, 1));
          }),
        ),
      ),
    },
  ];
}

const yPlane = (): Plane => ({ name: 'Y′ plane', rows: range(N).map((r) => range(N).map((c) => yByte(r, c))) });

function semiPlanar420(first: 'U' | 'V'): Plane[] {
  const second = first === 'U' ? 'V' : 'U';
  return [
    yPlane(),
    {
      name: `Interleaved ${first}${second} plane (½ × ½ resolution)`,
      rows: range(N / 2).map((j) =>
        range(N / 2).flatMap((i) => [cByte(first, `${j}${i}`, block(j, i, 2, 2)), cByte(second, `${j}${i}`, block(j, i, 2, 2))]),
      ),
    },
  ];
}

function planar420(first: 'U' | 'V'): Plane[] {
  const chroma = (k: 'U' | 'V'): Plane => ({
    name: `${k} plane (½ × ½ resolution)`,
    // Each chroma row is half as wide as a Y′ row
    rows: range(N / 2).map((j) => range(N / 2).map((i) => cByte(k, `${j}${i}`, block(j, i, 2, 2)))),
  });
  return [yPlane(), chroma(first), chroma(first === 'U' ? 'V' : 'U')];
}

const RGB_FMT = { layout: 'Packed (interleaved)', sub: 'None (4:4:4)', bpp: '3', formula: 'w · h · 3', bytes: (w: number, h: number) => w * h * 3 };
const P422 = { layout: 'Packed (interleaved)', sub: '4:2:2', bpp: '2', formula: 'w · h · 2', bytes: (w: number, h: number) => w * h * 2 };
const SP420 = { layout: 'Semi-planar', sub: '4:2:0', bpp: '1.5', formula: 'w · h + 2 · (w/2) · (h/2) = w · h · 3/2', bytes: (w: number, h: number) => (w * h * 3) / 2 };
const P420 = { ...SP420, layout: 'Planar' };

const FORMATS: Record<string, Format> = {
  RGB24: { ...RGB_FMT, planes: () => rgbPlanes(['R', 'G', 'B']), about: 'Three bytes per pixel in R, G, B order. What most image libraries and neural networks expect.' },
  BGR24: { ...RGB_FMT, planes: () => rgbPlanes(['B', 'G', 'R']), about: 'Same bytes as RGB24 with R and B swapped: OpenCV’s default order, and the classic cause of blue faces.' },
  YUYV: { ...P422, planes: () => packed422('0U1V'), about: 'Also called YUY2. Two pixels share one U and one V: Y₀ U Y₁ V. The usual uncompressed output of USB (UVC) webcams.' },
  UYVY: { ...P422, planes: () => packed422('U0V1'), about: 'The same samples as YUYV in a different byte order: U Y₀ V Y₁. Common on capture cards and SDI/MIPI bridges.' },
  NV12: { ...SP420, planes: () => semiPlanar420('U'), about: 'A full-resolution Y′ plane followed by one plane of interleaved U, V pairs. The native format of most hardware video encoders and decoders.' },
  NV21: { ...SP420, planes: () => semiPlanar420('V'), about: 'NV12 with V before U in each pair. The default camera preview format on older Android.' },
  I420: { ...P420, planes: () => planar420('U'), about: 'Also called YU12 or IYUV. Three separate planes: Y′, then U, then V. What libx264 and most software codecs use internally.' },
  YV12: { ...P420, planes: () => planar420('V'), about: 'I420 with the V plane stored before the U plane.' },
};

const KIND_COLOR: Record<Kind, string> = {
  Y: 'var(--ch-y)',
  U: 'var(--ch-b)',
  V: 'var(--ch-r)',
  R: 'var(--ch-r)',
  G: 'var(--ch-g)',
  B: 'var(--ch-b)',
};

const pixelName = (p: number) => `(${Math.floor(p / N)}, ${p % N})`;

export function mountYuvLayout(root: HTMLElement): void {
  const body = root.querySelector<HTMLElement>('.yuv-body')!;
  const pixelsEl = root.querySelector<HTMLElement>('[data-pixels]')!;
  const memory = root.querySelector<HTMLElement>('[data-memory]')!;
  const out = (key: string) => root.querySelector<HTMLElement>(`[data-out="${key}"]`)!;
  const status = out('status');

  const pxEls = PIXELS.map((hex, p) => {
    const el = document.createElement('div');
    el.className = 'yuv-px';
    el.style.background = hex;
    el.dataset.p = String(p);
    el.title = `Pixel ${pixelName(p)}`;
    return el;
  });
  pixelsEl.replaceChildren(...pxEls);

  let byteEls: { el: HTMLElement; byte: Byte; offset: number }[] = [];

  const clear = () => {
    body.classList.remove('active');
    root.querySelectorAll('.on').forEach((el) => el.classList.remove('on'));
    status.textContent = 'Hover over a pixel or a byte.';
  };

  const showPixel = (p: number) => {
    clear();
    body.classList.add('active');
    pxEls[p].classList.add('on');
    const used = byteEls.filter((b) => b.byte.pixels.includes(p));
    used.forEach((b) => b.el.classList.add('on'));
    const [r, g, b] = rgb[p];
    const [Y, Cb, Cr] = ycc[p];
    status.textContent = `Pixel ${pixelName(p)}: R′G′B′ = (${r}, ${g}, ${b}), Y′CbCr = (${Y}, ${Cb}, ${Cr}). Built from ${used.length} bytes at offsets ${used.map((b) => b.offset).join(', ')}.`;
  };

  const showByte = (k: number) => {
    clear();
    body.classList.add('active');
    const { el, byte, offset } = byteEls[k];
    el.classList.add('on');
    byte.pixels.forEach((p) => pxEls[p].classList.add('on'));
    const shared = byte.pixels.length > 1 ? `, shared by the ${byte.pixels.length} pixels ${byte.pixels.map(pixelName).join(' ')}` : ` of pixel ${pixelName(byte.pixels[0])}`;
    status.textContent = `Byte ${offset}: ${byte.kind} = ${byte.value}${shared}.`;
  };

  const draw = () => {
    const name = radioValue(root, 'yuv-format');
    const fmt = FORMATS[name];
    const children: HTMLElement[] = [];
    byteEls = [];
    let offset = 0;
    for (const plane of fmt.planes()) {
      const title = document.createElement('div');
      title.className = 'yuv-plane';
      title.textContent = plane.name;
      children.push(title);
      for (const row of plane.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'yuv-row';
        const off = document.createElement('span');
        off.className = 'yuv-off';
        off.textContent = String(offset);
        rowEl.append(off);
        for (const byte of row) {
          const el = document.createElement('span');
          el.className = 'yuv-byte';
          el.style.setProperty('--c', KIND_COLOR[byte.kind]);
          el.dataset.k = String(byteEls.length);
          const sub = document.createElement('sub');
          sub.textContent = byte.sub;
          el.append(byte.kind, sub);
          rowEl.append(el);
          byteEls.push({ el, byte, offset: offset++ });
        }
        children.push(rowEl);
      }
    }
    memory.style.setProperty('--cols', String(Math.max(...fmt.planes().flatMap((pl) => pl.rows.map((r) => r.length)))));
    memory.replaceChildren(...children);

    out('total').textContent = `${offset} bytes`;
    out('layout').textContent = fmt.layout;
    out('sub').textContent = fmt.sub;
    out('bpp').textContent = `${fmt.bpp} (${Number(fmt.bpp) * 8} bits)`;
    out('formula').textContent = `${fmt.formula} → ${fmt.bytes(1920, 1080).toLocaleString('en-US')} B at 1080p`;
    out('about').textContent = fmt.about;
    clear();
  };

  // Hover (and tap, which fires pointerover on touch screens) highlights
  body.addEventListener('pointerover', (e) => {
    const t = e.target as HTMLElement;
    const px = t.closest<HTMLElement>('.yuv-px');
    const by = t.closest<HTMLElement>('.yuv-byte');
    if (px) showPixel(Number(px.dataset.p));
    else if (by) showByte(Number(by.dataset.k));
  });
  body.addEventListener('pointerleave', clear);
  root.querySelectorAll('input[name="yuv-format"]').forEach((el) => el.addEventListener('change', draw));

  draw();
}
