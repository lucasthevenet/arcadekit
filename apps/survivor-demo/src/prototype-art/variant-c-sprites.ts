/* oxlint-disable no-inline-comments, no-nested-ternary, no-param-reassign, no-plusplus, prefer-destructuring, complexity, class-methods-use-this, operator-assignment, unicorn/no-array-for-each, unicorn/prefer-math-trunc, oxc/branches-sharing-code, require-unicode-regexp -- PROTOTYPE (#24 art): throwaway pixel-pushing code */
// PROTOTYPE (#24 art), variant C: the pixel-art sprites, authored as character grids and painted
// onto one atlas canvas at startup. Every cell is CELL x CELL sprite pixels; a sprite sits
// bottom-centred in its cell with its feet on row FEET_ROW, so one quad shape fits them all.

export const CELL = 32;
export const ATLAS_COLS = 32;
export const ATLAS_ROWS = 8;
/** The row a standing sprite's feet rest on (the quad's origin). */
export const FEET_ROW = 30;

// Cell layout in the atlas.
export const HERO_CELLS = 0; // 8 per hero slot: 4 walk frames, 1 lying (down)
export const HERO_STRIDE = 8;
export const HERO_DOWN = 4;
export const GEM_CELLS = 32; // 3 colours x 2 frames (plain, sparkle)
export const SHOT_CELLS = 40; // bolt x2, bubble x2 (white, tinted in the shader)
export const ENEMY_CELLS = 64; // 4 per enemy type (2 used)
export const ENEMY_STRIDE = 4;

type Grid = readonly string[];

// ---------------------------------------------------------------- colours

const hexToHsl = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return [h / 6, s, l];
};

const hslToHex = (h: number, s: number, l: number): string => {
  h = ((h % 1) + 1) % 1;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

/** A 5-step ramp from one colour, hue-shifted like hand-picked pixel palettes: o 1 2 3 4. */
export const ramp = (hex: string): Record<string, string> => {
  const [h, s, l] = hexToHsl(hex);
  // Shadows lean blue/purple for cool hues, toward red for warm ones; highlights lean yellow.
  const warm = h < 0.2 || h > 0.9;
  const shadowHue = (k: number) =>
    warm ? h - 0.035 * k : h + (0.7 - h) * 0.12 * k;
  const lightHue = h + (0.14 - h) * 0.06;
  return {
    o: hslToHex(shadowHue(2.5), s * 0.55 + 0.15, Math.min(0.17, l * 0.3)),
    "1": hslToHex(shadowHue(1), Math.min(1, s * 1.05), l * 0.66),
    "2": hex,
    "3": hslToHex(lightHue, s, l + (1 - l) * 0.38),
    "4": hslToHex(lightHue, s * 0.8, l + (1 - l) * 0.75),
  };
};

const FIXED: Record<string, string> = {
  k: "#1a1226",
  w: "#ffffff",
  s: "#f4c9a0",
  S: "#c98f6c",
  b: "#7a4a2b",
  B: "#3a2722",
  r: "#ff7a8a",
  g: "#79a843",
  G: "#4b7531",
};

// ---------------------------------------------------------------- grids

// Hero: hooded adventurer, facing right; cloak/hood in the hero's colour.
const HERO_BODY: Grid = [
  ".....oooooo.....",
  "....o333322o....",
  "...o33222222o...",
  "..o3222222221o..",
  "..o22oooooo21o..",
  "..o22sskssk21o..",
  "..o22sskssk21o..",
  "..o12ssssSS11o..",
  ".o1112SSSS2111o.",
  ".o122222222221o.",
  ".o1s22333322s1o.",
  ".o1s2bbbbbb2s1o.",
  "..o1222222221o..",
  "..o1122222211o..",
  "...o11111111o...",
];
const HERO_LEGS: readonly Grid[] = [
  ["....oBo..oBo....", "...oBBo..oBBo...", "...oooo..oooo..."],
  ["....oBo..oBo....", "...oBBo..oooo...", "...oooo........."],
  ["....oBo..oBo....", "...oBBo..oBBo...", "...oooo..oooo..."],
  ["....oBo..oBo....", "...oooo..oBBo...", ".........oooo..."],
];
/** Walk frame f (0..3): stand, left step, stand, right step. */
const heroFrame = (f: number): Grid => [...HERO_BODY, ...HERO_LEGS[f]!];

const SLIME: readonly Grid[] = [
  [
    "......oooo......",
    "....oo3332oo....",
    "...o3ww33222o...",
    "..o3ww3322222o..",
    "..o33322222221o.",
    ".o33222k22k2221o",
    ".o32222k22k2221o",
    ".o2222r2222r211o",
    ".o1222222222211o",
    "..o11222222111o.",
    "...oo1111111oo..",
    ".....ooooooo....",
  ],
  [
    "................",
    "................",
    ".....oooooo.....",
    "...oo3333222oo..",
    "..o3ww3322222o..",
    ".o3ww32k22k2221o",
    "o332222k22k2221o",
    "o22222r2222r211o",
    "o12222222222211o",
    ".o112222222111o.",
    "..oo11111111oo..",
    "....oooooooo....",
  ],
];

const BAT: readonly Grid[] = [
  [
    "o..................o",
    "oo................oo",
    "o2o..............o1o",
    "o32o....o..o....o21o",
    "o322o..o2oo2o..o221o",
    ".o322oo222222oo221o.",
    ".o3221o2e22e2o1221o.",
    "..o2o.o222222o.o1o..",
    "...o...o2ww2o...o...",
    "........oooo........",
  ],
  [
    "....................",
    "....................",
    "....................",
    "....................",
    ".......o2oo2o.......",
    "..ooooo222222ooooo..",
    ".o3322o2e22e2o2211o.",
    "o33222o222222o22211o",
    "o2111o.o2ww2o.o111o.",
    "o1o.o1o.oooo.o1o.o1o",
    ".o...o........o...o.",
  ],
];

const WRAITH_TOP: Grid = [
  "......oooo......",
  "....oo3333oo....",
  "...o33333222o...",
  "..o3332222221o..",
  "..o3311111111o..",
  "..o31kkkkkk11o..",
  ".o321kekkek112o.",
  ".o321kkkkkk112o.",
  ".o32211kk11222o.",
  ".o332222222221o.",
  "o3o3222222221o1o",
  "o3o3222222221o1o",
  ".oo3222222221oo.",
  "..o3222222221o..",
  "..o3222222221o..",
  "..o3222222211o..",
];
const WRAITH: readonly Grid[] = [
  [...WRAITH_TOP, "..o32o222o21o...", "..o2o.o2o.o1o...", "...o...o...o...."],
  [...WRAITH_TOP, "..o322o222o1o...", "...o2o.o2o.o1o..", "....o...o...o..."],
];

const GEM: Grid = [
  "...o...",
  "..owo..",
  ".owcbo.",
  "owccbbo",
  "obcbbao",
  ".obbao.",
  "..oao..",
  "...o...",
];
const GEM_SPARKLE: Grid = [
  ".....w....",
  "...o.w....",
  "..owwwww..",
  ".owcbow...",
  "owccbbo...",
  "obcbbao...",
  ".obbao....",
  "..oao.....",
  "...o......",
];
const GEM_COLORS: readonly Record<string, string>[] = [
  { o: "#0d2440", a: "#1f6fb0", b: "#3fb4f0", c: "#a8ecff", w: "#ffffff" },
  { o: "#0f3320", a: "#2a8a3e", b: "#5fd36a", c: "#c6ffb0", w: "#ffffff" },
  { o: "#40101e", a: "#b0283f", b: "#ff5a6a", c: "#ffc0c0", w: "#ffffff" },
];

// Projectiles are white/grey intensities: d dim halo, m mid, l light, w white core.
const SHOT_GREY: Record<string, string> = {
  d: "#3a3a3a",
  m: "#7a7a7a",
  l: "#c0c0c0",
  w: "#ffffff",
};
const BOLT: readonly Grid[] = [
  [
    "....d....",
    "...dmd...",
    "..dmlmd..",
    ".dmlwlmd.",
    "dmlwwwlmd",
    ".dmlwlmd.",
    "..dmlmd..",
    "...dmd...",
    "....d....",
  ],
  [
    "....m....",
    "....l....",
    "...dld...",
    "..dlwld..",
    "mllwwwllm",
    "..dlwld..",
    "...dld...",
    "....l....",
    "....m....",
  ],
];
const BUBBLE: readonly Grid[] = [
  [
    "...mmmm...",
    ".mmd..dmm.",
    ".mww....m.",
    "mdw.....dm",
    "m........m",
    "m........m",
    "md......lm",
    ".m.....lm.",
    ".mmd..dmm.",
    "...mmmm...",
  ],
  [
    "..........",
    "..mmmmmm..",
    ".mww...dm.",
    "mdw.....dm",
    "m........m",
    "m........m",
    "md.....llm",
    ".mmd..dmm.",
    "..mmmmmm..",
    "..........",
  ],
];

// ---------------------------------------------------------------- procedural golem

const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** A stomping rock golem, built from shaded boulders with contour lines, then outlined. */
const golemFrame = (f: number): Grid => {
  const W = 26;
  const H = 25;
  const g: string[][] = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => ".")
  );
  const blob = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    moss = false
  ) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny > 1) {
          continue;
        }
        const ex = (x + 1.5 - cx) / rx;
        const ey = (y + 1.5 - cy) / ry;
        const wx = (x - 0.5 - cx) / rx;
        const wy = (y - 0.5 - cy) / ry;
        const edge =
          ex * ex + ny * ny > 1 ||
          wx * wx + ny * ny > 1 ||
          nx * nx + ey * ey > 1 ||
          nx * nx + wy * wy > 1;
        if (edge && g[y]![x] !== ".") {
          g[y]![x] = "o"; // contour where this boulder overlaps an earlier one
          continue;
        }
        const lit =
          -(nx * 0.55 + ny * 0.85) +
          (bayer4[(y % 4) * 4 + (x % 4)]! / 16 - 0.5) * 0.35;
        let c = lit > 0.62 ? "4" : lit > 0.18 ? "3" : lit > -0.45 ? "2" : "1";
        if (moss && ny < -0.35 && (x * 7 + y * 13) % 5 !== 0) {
          c = ny < -0.6 ? "g" : lit > 0 ? "g" : "G";
        }
        g[y]![x] = c;
      }
    }
  };
  const step = f === 1 ? 1 : 0;
  const lift = f === 1 ? 2 : 0;
  // legs (behind)
  blob(9, 21.5 - (f === 0 ? 2 : 0), 3.2, 3.2);
  blob(17, 21.5 - lift, 3.2, 3.2);
  // torso
  blob(13, 14 + step, 7.5, 6.5);
  // fists
  blob(4.2, 17 + (f === 1 ? -1 : 1), 3, 3.2);
  blob(21.8, 17 + (f === 1 ? 1 : -1), 3, 3.2);
  // shoulders
  blob(6, 9.5 + step, 4.6, 4.2, true);
  blob(20, 9.5 + step, 4.6, 4.2, true);
  // head
  blob(13, 6.5 + step, 4.2, 3.8, true);
  // eyes + brow, chest crack
  const ey = 7 + step;
  g[ey]![11] = "e";
  g[ey]![14] = "e";
  g[ey - 1]![10] = "o";
  g[ey - 1]![11] = "o";
  g[ey - 1]![14] = "o";
  g[ey - 1]![15] = "o";
  const crack = [
    [12, 12],
    [13, 13],
    [13, 14],
    [12, 15],
    [14, 15],
  ];
  for (const [x, y] of crack) {
    g[y! + step]![x!] = "o";
  }
  g[16 + step]![15] = "e";
  // outline pass
  const out = g.map((r) => [...r]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (g[y]![x] !== ".") {
        continue;
      }
      const n =
        (g[y - 1]?.[x] ?? ".") !== "." ||
        (g[y + 1]?.[x] ?? ".") !== "." ||
        (g[y]![x - 1] ?? ".") !== "." ||
        (g[y]![x + 1] ?? ".") !== ".";
      if (n) {
        out[y]![x] = "o";
      }
    }
  }
  return out.map((r) => r.join(""));
};

const GOLEM: readonly Grid[] = [golemFrame(0), golemFrame(1)];

// ---------------------------------------------------------------- painting

export class Atlas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Bumped every time the atlas is repainted, so the texture knows to re-upload. */
  version = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = ATLAS_COLS * CELL;
    this.canvas.height = ATLAS_ROWS * CELL;
    this.ctx = this.canvas.getContext("2d")!;
    this.paintFixed();
  }

  private cellXY(cell: number): [number, number] {
    return [(cell % ATLAS_COLS) * CELL, Math.floor(cell / ATLAS_COLS) * CELL];
  }

  /** Paints a grid bottom-centred on the feet row (or centred, for loose items). */
  private paint(
    cell: number,
    grid: Grid,
    colors: Record<string, string>,
    centred = false
  ) {
    const [cx, cy] = this.cellXY(cell);
    const { ctx } = this;
    ctx.clearRect(cx, cy, CELL, CELL);
    const h = grid.length;
    const w = Math.max(...grid.map((r) => r.length));
    const ox = cx + Math.floor((CELL - w) / 2);
    const oy = centred ? cy + Math.floor((CELL - h) / 2) : cy + FEET_ROW - h;
    for (let y = 0; y < h; y++) {
      const row = grid[y]!;
      for (let x = 0; x < row.length; x++) {
        const ch = row[x]!;
        if (ch === ".") {
          continue;
        }
        const color = colors[ch] ?? FIXED[ch] ?? "#ff00ff";
        ctx.fillStyle = color;
        ctx.fillRect(ox + x, oy + y, 1, 1);
      }
    }
    this.version++;
  }

  private paintFixed() {
    GEM_COLORS.forEach((colors, i) => {
      this.paint(GEM_CELLS + i * 2, GEM, colors, true);
      this.paint(GEM_CELLS + i * 2 + 1, GEM_SPARKLE, colors, true);
    });
    this.paint(SHOT_CELLS, BOLT[0]!, SHOT_GREY, true);
    this.paint(SHOT_CELLS + 1, BOLT[1]!, SHOT_GREY, true);
    this.paint(SHOT_CELLS + 2, BUBBLE[0]!, SHOT_GREY, true);
    this.paint(SHOT_CELLS + 3, BUBBLE[1]!, SHOT_GREY, true);
  }

  paintHero(slot: number, color: string) {
    const colors = ramp(color);
    const base = HERO_CELLS + slot * HERO_STRIDE;
    for (let f = 0; f < 4; f++) {
      this.paint(base + f, heroFrame(f), colors);
    }
    // Lying down: the standing frame turned on its side.
    const stand = heroFrame(0);
    const w = 16;
    const lying: string[] = [];
    for (let x = 0; x < w; x++) {
      let row = "";
      for (let y = stand.length - 1; y >= 0; y--) {
        row += stand[y]![x] ?? ".";
      }
      lying.push(row);
    }
    // trim empty rows so it rests on the feet row
    while (lying.length && /^\.+$/.test(lying.at(-1)!)) {
      lying.pop();
    }
    this.paint(base + HERO_DOWN, lying, colors);
  }

  paintEnemy(type: number, id: string, color: string) {
    const colors = ramp(color);
    const frames =
      id === "bat"
        ? BAT
        : id === "golem"
          ? GOLEM
          : id === "wraith"
            ? WRAITH
            : SLIME;
    const eye =
      id === "bat" ? "#ff4d6d" : id === "golem" ? "#ffcf4a" : "#8ff7ff";
    for (let f = 0; f < 2; f++) {
      this.paint(ENEMY_CELLS + type * ENEMY_STRIDE + f, frames[f]!, {
        ...colors,
        e: eye,
      });
    }
  }
}
