/* oxlint-disable no-inline-comments, no-nested-ternary, no-param-reassign, no-plusplus, prefer-destructuring, complexity, class-methods-use-this, operator-assignment, unicorn/no-array-for-each, unicorn/prefer-math-trunc, oxc/branches-sharing-code, require-unicode-regexp -- PROTOTYPE (#24 art): throwaway pixel-pushing code */
// PROTOTYPE (#24 art), variant C: the arena floor, painted pixel by pixel once per arena size:
// dithered grass with dirt patches, tufts, flowers and pebbles, a stone wall at the border
// and a dark drop beyond it.

export const PX = 16; // sprite pixels per world unit
export const GROUND_MARGIN = 12; // world units of floor painted outside the arena
export const VOID_COLOR = "#0c0f17";

const hash = (x: number, y: number) => {
  let h = (x * 374_761_393 + y * 668_265_263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
};

const smooth = (t: number) => t * t * (3 - 2 * t);
const noise = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
};

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const GRASS = ["#284628", "#30532d", "#3a6332", "#467438", "#558540"].map(rgb);
const DIRT = ["#4a3a2c", "#5a4733", "#6b563d", "#7d6747"].map(rgb);
const STONE = {
  mortar: rgb("#26232e"),
  dark: rgb("#4a4656"),
  mid: rgb("#625e70"),
  light: rgb("#7f7a8e"),
  top: rgb("#9d98ab"),
};
const VOID = [rgb("#0c0f17"), rgb("#161c2a"), rgb("#232a3b")];

const TUFT = ["x...x", "x.x.x", ".xLx.", ".x.x."];
const FLOWER = [".p.", "pyp", ".p."];
const PEBBLE = [".oo.", "oLLo", "oLdo", ".oo."];

/** Paints the floor for an arena of `halfSize` world units, centred on the canvas. */
export const paintGround = (halfSize: number): HTMLCanvasElement => {
  const extent = halfSize + GROUND_MARGIN;
  const size = Math.round(extent * 2 * PX);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  const { data } = image;
  const edge = halfSize * PX; // arena edge, in px from the centre
  const wall = 20; // wall thickness in px, outside the edge
  const c = size / 2;

  for (let py = 0; py < size; py++) {
    const y = py - c;
    for (let px = 0; px < size; px++) {
      const x = px - c;
      const ax = Math.abs(x + 0.5);
      const ay = Math.abs(y + 0.5);
      const dEdge = Math.max(ax, ay) - edge; // < 0 inside
      const bay = BAYER[(py & 3) * 4 + (px & 3)]! / 16;
      let col: [number, number, number];

      if (dEdge >= wall) {
        // the drop beyond the wall: a dark cliff face just under it, then near-black depths
        const below = dEdge - wall;
        if (below < 6) {
          col =
            below < 2
              ? VOID[2]!
              : bay < 0.5 - below * 0.08
                ? VOID[2]!
                : VOID[1]!;
        } else {
          const n = noise(px / 30, py / 30);
          col = n > 0.68 && bay < 0.25 ? VOID[1]! : VOID[0]!;
          if (hash(px, py) > 0.9985) {
            col = VOID[2]!;
          }
        }
      } else if (dEdge >= 0) {
        // stone wall seen from above: two courses of staggered bricks, lit on the arena side
        const along = ax > ay ? py : px;
        const across = dEdge; // 0..wall-1, 0 against the grass
        const course = Math.floor(across / 10);
        const shift = course % 2 === 0 ? 0 : 8;
        const brickX = Math.floor((along + shift) / 16);
        const bx = (((along + shift) % 16) + 16) % 16;
        const by = across % 10;
        const shade = hash(brickX * 3 + course, ax > ay ? 17 : 5);
        if (bx === 0 || by === 9) {
          col = STONE.mortar;
        } else if (by === 0 || bx === 1) {
          col = STONE.top;
        } else if (by === 8 || bx === 15) {
          col = STONE.dark;
        } else {
          col = shade > 0.55 ? STONE.light : STONE.mid;
          const sp = hash(px, py);
          if (sp > 0.94) {
            col = STONE.dark;
          } else if (sp < 0.04) {
            col = STONE.top;
          }
        }
      } else {
        // grass and dirt: flat shade regions with dithered seams, the way it's drawn by hand
        const big =
          noise(px / 150, py / 150) * 0.65 + noise(px / 45, py / 45) * 0.35;
        const centre = Math.max(0, 1 - Math.hypot(x, y) / (PX * 6));
        const dirt = (big - 0.6) * 6 + centre * 1.2;
        const v = noise(px / 52, py / 52) * 0.6 + noise(px / 17, py / 17) * 0.4;
        const seam = (bay - 0.5) * 0.05;
        const speck = hash(px, py);
        if (dirt + seam * 4 > 0.35) {
          const k = v + seam;
          col = DIRT[k > 0.6 ? 2 : k > 0.36 ? 1 : 0]!;
          if (speck > 0.985) {
            col = DIRT[3]!;
          } else if (speck < 0.012) {
            col = DIRT[0]!;
          }
        } else {
          const k = v + seam;
          let i = k > 0.63 ? 3 : k > 0.4 ? 2 : 1;
          if (dirt > 0.22) {
            i = Math.max(0, i - 1);
          }
          if (speck > 0.992) {
            i = Math.min(4, i + 1);
          } else if (speck < 0.006) {
            i = Math.max(0, i - 1);
          }
          // shadow cast by the wall onto the grass
          if (dEdge > -5 || (dEdge > -8 && bay < 0.5)) {
            i = 0;
          }
          col = GRASS[i]!;
        }
      }
      const o = (py * size + px) * 4;
      data[o] = col[0];
      data[o + 1] = col[1];
      data[o + 2] = col[2];
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Decorations scattered on the grass, on a jittered grid.
  const stamp = (
    pattern: string[],
    x: number,
    y: number,
    colors: Record<string, string>
  ) => {
    for (let j = 0; j < pattern.length; j++) {
      for (let i = 0; i < pattern[j]!.length; i++) {
        const ch = pattern[j]![i]!;
        if (ch !== ".") {
          ctx.fillStyle = colors[ch]!;
          ctx.fillRect(x + i, y + j, 1, 1);
        }
      }
    }
  };
  const step = 12;
  const flowerColors = ["#f2e8ff", "#ffd86b", "#ff8fb0", "#9fd0ff"];
  for (let gy = 0; gy < size; gy += step) {
    for (let gx = 0; gx < size; gx += step) {
      const x = gx + Math.floor(hash(gx, gy + 7) * step);
      const y = gy + Math.floor(hash(gx + 3, gy) * step);
      const ax = Math.abs(x - c);
      const ay = Math.abs(y - c);
      if (Math.max(ax, ay) > edge - 8) {
        continue;
      }
      const roll = hash(gx * 3 + 1, gy * 5 + 2);
      const cluster = noise(x / 90, y / 90);
      if (roll < 0.22 + cluster * 0.2) {
        stamp(
          TUFT,
          x,
          y,
          hash(x, y) > 0.45
            ? { x: "#62964a", L: "#83b55a" }
            : { x: "#20391f", L: "#2a4a28" }
        );
      } else if (roll < 0.27 + cluster * 0.08) {
        const fc =
          flowerColors[Math.floor(hash(x, y + 1) * flowerColors.length)]!;
        stamp(FLOWER, x, y, { p: fc, y: "#ffe27a" });
      } else if (roll < 0.29) {
        stamp(PEBBLE, x, y, { o: "#2a2a30", L: "#8d8a96", d: "#5e5b68" });
      }
    }
  }
  return canvas;
};
