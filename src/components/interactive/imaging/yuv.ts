/**
 * Y′CbCr ("YUV") math shared by the chroma-subsampling, YUV-layout and range
 * figures.
 *
 * Everything here works on gamma-encoded R′G′B′ in [0, 1] (what sRGB pixels
 * already are), not on linear light: Y′ is luma, not luminance.
 */

export type YuvMatrix = '601' | '709';
export type YuvRange = 'full' | 'limited';

/** Luma weights (K_R, K_B) of each standard; K_G = 1 − K_R − K_B. */
export const KRB: Record<YuvMatrix, [number, number]> = {
  '601': [0.299, 0.114],
  '709': [0.2126, 0.0722],
};

/** R′G′B′ ∈ [0, 1] → (Y′ ∈ [0, 1], Cb, Cr ∈ [−0.5, 0.5]). */
export function rgbToYcc(r: number, g: number, b: number, m: YuvMatrix): [number, number, number] {
  const [kr, kb] = KRB[m];
  const y = kr * r + (1 - kr - kb) * g + kb * b;
  return [y, (b - y) / (2 * (1 - kb)), (r - y) / (2 * (1 - kr))];
}

/** Inverse of rgbToYcc. The result may leave [0, 1] for out-of-gamut inputs. */
export function yccToRgb(y: number, cb: number, cr: number, m: YuvMatrix): [number, number, number] {
  const [kr, kb] = KRB[m];
  const r = y + 2 * (1 - kr) * cr;
  const b = y + 2 * (1 - kb) * cb;
  const g = (y - kr * r - kb * b) / (1 - kr - kb);
  return [r, g, b];
}

/** The 3 × 3 matrix of rgbToYcc, rows Y′, Cb, Cr. */
export function yccMatrix(m: YuvMatrix): number[][] {
  const [kr, kb] = KRB[m];
  const kg = 1 - kr - kb;
  const sb = 2 * (1 - kb);
  const sr = 2 * (1 - kr);
  return [
    [kr, kg, kb],
    [-kr / sb, -kg / sb, (1 - kb) / sb],
    [(1 - kr) / sr, -kg / sr, -kb / sr],
  ];
}

const clamp8 = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

/**
 * Quantize to 8-bit codes. Full range: Y′ 0–255, chroma 0–255 around 128.
 * Limited ("TV") range: Y′ 16–235, chroma 16–240 around 128.
 */
export function quantize(y: number, cb: number, cr: number, range: YuvRange): [number, number, number] {
  if (range === 'full') return [clamp8(255 * y), clamp8(128 + 255 * cb), clamp8(128 + 255 * cr)];
  return [clamp8(16 + 219 * y), clamp8(128 + 224 * cb), clamp8(128 + 224 * cr)];
}

/** Interpret 8-bit codes as (Y′, Cb, Cr) under the given range. */
export function dequantize(Y: number, Cb: number, Cr: number, range: YuvRange): [number, number, number] {
  if (range === 'full') return [Y / 255, (Cb - 128) / 255, (Cr - 128) / 255];
  return [(Y - 16) / 219, (Cb - 128) / 224, (Cr - 128) / 224];
}
