// The score's colour: red under the D boundary, a quick turn through orange across D and C, green from B.
// Built in OKLCH and kept inside sRGB at 92% of the gamut's chroma, so every step is as vivid as screens show.
// Agreed 18 Nov (variant C, stops on the grade boundaries). The number and the grade letter always go with it.

type Stop = [score: number, lightness: number, hue: number];

const STOPS: Record<'dark' | 'light', Stop[]> = {
  dark: [[0, 0.68, 29], [45, 0.68, 29], [62, 0.74, 58], [75, 0.74, 145], [100, 0.72, 152]],
  light: [[0, 0.5, 29], [45, 0.5, 29], [62, 0.52, 50], [75, 0.5, 145], [100, 0.48, 152]],
};

const toLinear = (l: number, c: number, h: number) => {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
};

const maxChroma = (l: number, h: number) => {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (toLinear(l, mid, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4)) lo = mid;
    else hi = mid;
  }
  return lo;
};

const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export const scoreColour = (score: number, ground: 'dark' | 'light'): string => {
  const stops = STOPS[ground];
  const s = Math.min(100, Math.max(0, score));
  const i = Math.max(1, stops.findIndex(([at]) => at >= s));
  const [a, la, ha] = stops[i - 1];
  const [b, lb, hb] = stops[i];
  const t = b === a ? 0 : (s - a) / (b - a);
  const l = la + (lb - la) * t;
  const h = ha + (hb - ha) * t;

  const rgb = toLinear(l, maxChroma(l, h) * 0.92, h);
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, encode(v))) * 255).toString(16).padStart(2, '0')).join('')}`;
};

if (import.meta.main) {
  const lum = (x: string) => {
    const c = [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  for (const [ground, bg] of [['dark', '#0c0d0d'], ['light', '#efeee9']] as const) {
    const all = Array.from({ length: 101 }, (_, s) => [s, contrast(scoreColour(s, ground), bg)] as const);
    const worst = all.reduce((p, q) => (q[1] < p[1] ? q : p));
    console.log(ground, 'lowest contrast', worst[1].toFixed(2), 'at', worst[0], ' samples', [21, 49, 50, 58, 63, 68, 74, 75, 85, 96].map((s) => `${s}:${scoreColour(s, ground)}`).join(' '));
  }
}
