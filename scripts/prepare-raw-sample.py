"""
Prepare the real raw sample used by the imaging figures of the "From Photons to Pixels" post.

Source: Sigma fp, 8-bit CinemaDNG (cinema mode, 4K, 8 bit), from raw.pixls.us (CC0 1.0, public domain).
  https://raw.pixls.us/getfile.php/7283/nice/Sigma%20-%20fp%20-%208bit%20(16:9).DNG
  sha256 b7e44ca41c5c5a01324967b2bd86175c7534f3df98cc3724d02edd29adb1942b

The file stores one 8-bit code per photosite (RGGB, uncompressed). The DNG's LinearizationTable
maps each code to a 12-bit linear value (0 … 4095) with black level 256. This script writes:

  raw-scene.png   a 2880 × 1920 crop (ColorChecker, handlebar stem) as a 480 × 320 RGGB mosaic
                  (downscaled by 6, then re-sampled through the CFA)
  raw-detail.png  a native-resolution 360 × 240 RGGB crop (the logo on the stem)
  raw-photo.png   the scene crop fully developed by LibRaw (AHD demosaic, camera WB, sRGB), 480 × 320
  raw-sample.json pattern, linearization table, black and white level, camera white balance and
                  camera → sRGB matrix

The mosaic PNGs hold the stored 8-bit codes, one per photosite (grayscale, no color profile).
Binned values are averaged in linear light and re-encoded to the nearest code of the table.

Usage (needs rawpy, tifffile, numpy, pillow):
  python scripts/prepare-raw-sample.py "path/to/Sigma - fp - 8bit (16:9).DNG" public/figures/photons-to-pixels
"""

import json
import sys
from pathlib import Path

import numpy as np
import rawpy
import tifffile
from PIL import Image

SCENE_CROP = (200, 120, 2880, 1920)  # x, y, w, h in photosites (even, so RGGB is kept)
SCENE_BIN = 6
OLPF_SIGMA = 0.8  # Gaussian blur before re-sampling, in output pixels (stands in for an optical low-pass filter)
DETAIL_CROP = (1640, 1300, 360, 240)  # the stem logo: sharp lettering on red-lit and white-lit metal
PHOTO_BRIGHT = 1.6  # LibRaw brightness for the developed photo

# Linear sRGB (D65) → XYZ
SRGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)


def blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur with edge padding."""
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    p = np.pad(img, r, mode="edge")
    p = sum(k[i] * p[:, i : i + img.shape[1]] for i in range(2 * r + 1))
    return sum(k[i] * p[i : i + img.shape[0], :] for i in range(2 * r + 1))


def encode(v: np.ndarray, lut: np.ndarray) -> np.ndarray:
    """Linear value → nearest 8-bit code of the (increasing) linearization table."""
    hi = np.clip(np.searchsorted(lut, v), 1, len(lut) - 1)
    lo = hi - 1
    return np.where(v - lut[lo] <= lut[hi] - v, lo, hi).astype(np.uint8)


def bin_mosaic(lin: np.ndarray, k: int) -> np.ndarray:
    """
    Downscale an RGGB mosaic by k (even) and re-sample it through the CFA. Each output block of
    k × k sites gets the mean R, G and B of that block, and keeps the one its filter passes. All
    three colors come from the same area, and a slight blur plays the optical low-pass filter,
    so fine detail does not alias into color speckle.
    """
    h, w = lin.shape[0] // k, lin.shape[1] // k
    kk = k // 2
    means = {}
    for name, dy, dx in (("R", 0, 0), ("G1", 0, 1), ("G2", 1, 0), ("B", 1, 1)):
        plane = lin[dy::2, dx::2]
        means[name] = plane[: h * kk, : w * kk].reshape(h, kk, w, kk).mean(axis=(1, 3))
    means = {name: blur(m, OLPF_SIGMA) for name, m in means.items()}
    out = (means["G1"] + means["G2"]) / 2
    out[0::2, 0::2] = means["R"][0::2, 0::2]
    out[1::2, 1::2] = means["B"][1::2, 1::2]
    return out


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)

    # The stored codes and the DNG tags that describe them
    page = tifffile.TiffFile(src).pages[0]
    codes = page.asarray()
    assert codes.dtype == np.uint8, codes.dtype
    tags = {t.code: t.value for t in page.tags.values()}
    assert tags[33422] == b"\x00\x01\x01\x02", "expected an RGGB CFA"
    lut = np.array(tags[50712], dtype=np.float64)  # LinearizationTable
    black = float(np.mean(np.array(tags[50714][0::2]) / np.array(tags[50714][1::2])))  # BlackLevel (rationals)
    white = float(tags[50717])  # WhiteLevel
    lin = lut[codes]

    x, y, w, h = SCENE_CROP
    scene = bin_mosaic(lin[y : y + h, x : x + w], SCENE_BIN)
    Image.fromarray(encode(scene, lut), mode="L").save(dst / "raw-scene.png", optimize=True)

    x, y, w, h = DETAIL_CROP
    detail = codes[y : y + h, x : x + w]
    Image.fromarray(detail, mode="L").save(dst / "raw-detail.png", optimize=True)

    # Reference development of the same crop, for the figures that start from an RGB image
    r = rawpy.imread(str(src))
    rgb = r.postprocess(use_camera_wb=True, output_bps=8, bright=PHOTO_BRIGHT)
    x, y, w, h = SCENE_CROP
    photo = Image.fromarray(rgb[y : y + h, x : x + w]).resize(scene.shape[::-1], Image.LANCZOS)
    photo.save(dst / "raw-photo.png", optimize=True)

    # Camera → sRGB for white-balanced camera RGB (dcraw convention: rows of cam_from_srgb sum to 1)
    assert tags[50779] == 21, "expected ColorMatrix2 calibrated for D65"
    cm2 = tags[50722]  # ColorMatrix2 (XYZ → camera), as rationals
    xyz_to_cam = (np.array(cm2[0::2]) / np.array(cm2[1::2])).reshape(3, 3)
    cam_from_srgb = xyz_to_cam @ SRGB_TO_XYZ
    cam_from_srgb /= cam_from_srgb.sum(axis=1, keepdims=True)
    srgb_from_cam = np.linalg.inv(cam_from_srgb)

    wb = np.array(r.camera_whitebalance[:3])
    meta = {
        "source": "Sigma fp, 8-bit CinemaDNG (raw.pixls.us, CC0 1.0)",
        "url": "https://raw.pixls.us/getfile.php/7283/nice/Sigma%20-%20fp%20-%208bit%20(16:9).DNG",
        "pattern": "RGGB",
        "lut": lut.astype(int).tolist(),
        "black": black,
        "blackCode": int(encode(np.array([black]), lut)[0]),
        "white": white,
        "wb": (wb / wb[1]).round(4).tolist(),
        "camToSrgb": srgb_from_cam.round(4).tolist(),
        "scene": {"file": "raw-scene.png", "width": scene.shape[1], "height": scene.shape[0], "bin": SCENE_BIN},
        "detail": {"file": "raw-detail.png", "width": detail.shape[1], "height": detail.shape[0], "bin": 1},
        "photo": {"file": "raw-photo.png", "width": photo.width, "height": photo.height},
    }
    (dst / "raw-sample.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(json.dumps({k: v for k, v in meta.items() if k != "lut"}, indent=2))


if __name__ == "__main__":
    main()
