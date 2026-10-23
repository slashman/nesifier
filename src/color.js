// sRGB -> CIELAB (D65). Distances are squared Euclidean in Lab (CIE76), which is
// cheap and perceptually far better than raw RGB for picking from a fixed palette.
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function f(t) {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}

export function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function finv(t) {
  return t > 6 / 29 ? t ** 3 : (116 * t - 16) / (24389 / 27);
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = finv(fx) * 0.95047, y = finv(fy), z = finv(fz) * 1.08883;
  return [
    linearToSrgb(x * 3.2404542 - y * 1.5371385 - z * 0.4985314),
    linearToSrgb(-x * 0.969266 + y * 1.8760108 + z * 0.041556),
    linearToSrgb(x * 0.0556434 - y * 0.2040259 + z * 1.0572252),
  ];
}

export function dist2(a, b) {
  const d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

// Images repeat colors heavily, so memoize conversions on the exact 24-bit value.
const labCache = new Map();
export function labOf(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  let v = labCache.get(key);
  if (!v) {
    v = rgbToLab(r, g, b);
    labCache.set(key, v);
  }
  return v;
}
