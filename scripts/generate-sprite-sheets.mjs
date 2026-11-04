// Writes the demos' sprite sheets: pixel art painted in code, packed into one PNG per demo with
// an Aseprite JSON export ("hash" frames form) next to it. Run with `pnpm sprites`. The output
// is byte-identical every run, so regenerating never shows up as a diff. The art is ported from
// the pixel-art prototype on branch prototype/24-art (see ADR-0015). Swap a sheet for one
// exported from Aseprite, or mapped from a CC0 pack, with the same tag names.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = path.join(import.meta.dirname, "..");
const SURVIVOR_DIR = path.join(ROOT, "apps/survivor-demo/public/sprites");
const PUZZLE_DIR = path.join(ROOT, "apps/push-puzzle-demo/public/sprites");

// ---------------------------------------------------------------------------------------------
// Colours

const hexToRgba = (hex) => {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) : 255;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
};

const hexToHsl = (hex) => {
  const [r, g, b] = hexToRgba(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return [h / 6, s, l];
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));

const hslToHex = (h, s, l) => {
  const hh = ((h % 1) + 1) % 1;
  const ss = clamp01(s);
  const ll = clamp01(l);
  const f = (n) => {
    const k = (n + hh * 12) % 12;
    const a = ss * Math.min(ll, 1 - ll);
    const c = ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

/** Moves a colour's lightness and saturation, keeping its hue. */
const shade = (hex, dl, ds = 0) => {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s + ds, l + dl);
};

/**
 * A 5-step ramp from one colour, hue-shifted like hand-picked pixel palettes: o (darkest) 1 2 3 4.
 * Shadows lean toward red for warm hues and toward blue-purple for cool ones.
 */
const ramp = (hex) => {
  const [h, s, l] = hexToHsl(hex);
  const warm = h < 0.2 || h > 0.9;
  const shadowHue = (k) => (warm ? h - 0.035 * k : h + (0.7 - h) * 0.12 * k);
  const lightHue = h + (0.14 - h) * 0.06;
  return {
    o: hslToHex(shadowHue(2.5), s * 0.55 + 0.15, Math.min(0.17, l * 0.3)),
    1: hslToHex(shadowHue(1), Math.min(1, s * 1.05), l * 0.66),
    2: hex,
    3: hslToHex(lightHue, s, l + (1 - l) * 0.38),
    4: hslToHex(lightHue, s * 0.8, l + (1 - l) * 0.75),
  };
};

// Shared colours for every character.
const OUTLINE = "#140c1c";
const FIXED = {
  k: "#1a1226",
  w: "#ffffff",
  s: "#f4c9a0",
  S: "#c98f6c",
  r: "#ff8a8a",
  b: "#7a4a2b",
  B: "#3a2722",
  g: "#79a843",
  G: "#4b7531",
};

// Generic sprites are white and greys, so a tint multiplies them into any colour.
const GREY = {
  o: "#2a2a2a",
  1: "#9a9a9a",
  2: "#cfcfcf",
  3: "#ececec",
  4: "#ffffff",
  s: "#f2f2f2",
  S: "#bdbdbd",
  k: "#262626",
  r: "#d8d8d8",
  b: "#7c7c7c",
  B: "#545454",
  E: "#ffffff",
  F: "#bdbdbd",
  e: "#262626",
  w: "#ffffff",
};

// ---------------------------------------------------------------------------------------------
// Images: RGBA pixels, painted from character grids

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)] / 16;

// A small integer hash, so speckles are the same every run.
const hash = (x, y, seed = 0) => {
  let h = (x * 374_761_393 + y * 668_265_263 + seed * 2_246_822_519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
};

const image = (w, h) => ({ w, h, data: new Uint8Array(w * h * 4) });

const inside = (img, x, y) => x >= 0 && y >= 0 && x < img.w && y < img.h;

const get = (img, x, y) => {
  if (!inside(img, x, y)) {
    return [0, 0, 0, 0];
  }
  const o = (y * img.w + x) * 4;
  return [...img.data.subarray(o, o + 4)];
};

const set = (img, x, y, color) => {
  if (!inside(img, x, y)) {
    return;
  }
  const rgba = typeof color === "string" ? hexToRgba(color) : color;
  img.data.set(rgba, (y * img.w + x) * 4);
};

const opaque = (img, x, y) => get(img, x, y)[3] > 0;

const fill = (img, x0, y0, w, h, color) => {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      set(img, x, y, color);
    }
  }
};

/**
 * Keeps every other `ch` in a grid, in a checker, and clears the rest: a see-through fill made
 * of solid pixels. Sprites drawn opaque cut out partly transparent pixels, so art for them has
 * only fully opaque or fully clear pixels.
 */
const checker = (grid, ch) =>
  grid.map((row, y) =>
    [...row].map((c, x) => (c === ch && (x + y) % 2 === 1 ? "." : c)).join("")
  );

/** Paints a grid of characters; "." is transparent, any other character looks up `palette`. */
const fromGrid = (grid, palette) => {
  const w = Math.max(...grid.map((row) => row.length));
  const img = image(w, grid.length);
  for (const [y, row] of grid.entries()) {
    for (const [x, ch] of [...row].entries()) {
      if (ch === ".") {
        continue;
      }
      const color = palette[ch] ?? FIXED[ch];
      if (color === undefined) {
        throw new Error(`No colour for "${ch}"`);
      }
      set(img, x, y, color);
    }
  }
  return img;
};

/** Draws `src` over `dst` at (x, y), skipping transparent pixels. */
const blit = (dst, src, ox, oy) => {
  for (let y = 0; y < src.h; y += 1) {
    for (let x = 0; x < src.w; x += 1) {
      const c = get(src, x, y);
      if (c[3] > 0) {
        set(dst, ox + x, oy + y, c);
      }
    }
  }
};

/** Grows the image by 1 px on every side and draws a 1 px outline around its opaque pixels. */
const outline = (img, color = OUTLINE) => {
  const out = image(img.w + 2, img.h + 2);
  blit(out, img, 1, 1);
  for (let y = 0; y < out.h; y += 1) {
    for (let x = 0; x < out.w; x += 1) {
      if (opaque(out, x, y)) {
        continue;
      }
      const near =
        opaque(img, x - 1, y - 2) ||
        opaque(img, x - 1, y) ||
        opaque(img, x - 2, y - 1) ||
        opaque(img, x, y - 1);
      if (near) {
        set(out, x, y, color);
      }
    }
  }
  return out;
};

const flipX = (img) => {
  const out = image(img.w, img.h);
  for (let y = 0; y < img.h; y += 1) {
    for (let x = 0; x < img.w; x += 1) {
      set(out, img.w - 1 - x, y, get(img, x, y));
    }
  }
  return out;
};

/** Turns the image a quarter turn clockwise. */
const rotate = (img) => {
  const out = image(img.h, img.w);
  for (let y = 0; y < img.h; y += 1) {
    for (let x = 0; x < img.w; x += 1) {
      set(out, img.h - 1 - y, x, get(img, x, y));
    }
  }
  return out;
};

const bounds = (imgs) => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (const img of imgs) {
    for (let y = 0; y < img.h; y += 1) {
      for (let x = 0; x < img.w; x += 1) {
        if (opaque(img, x, y)) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
  }
  return { x0, y0, x1, y1 };
};

/**
 * Places an animation's frames into cells of w x h, all moved by the same offset so they
 * don't jitter. "feet" puts the lowest pixel on the bottom row, centred across; "centre"
 * centres the frames. Throws when the art doesn't fit, so a grid typo can't slip through.
 */
const place = (frames, w, h, anchor = "feet") => {
  const b = bounds(frames);
  const bw = b.x1 - b.x0 + 1;
  const bh = b.y1 - b.y0 + 1;
  if (bw > w || bh > h) {
    throw new Error(`Art of ${bw}x${bh} doesn't fit a ${w}x${h} cell`);
  }
  const ox = Math.floor((w - bw) / 2) - b.x0;
  const oy = (anchor === "feet" ? h - bh : Math.floor((h - bh) / 2)) - b.y0;
  return frames.map((frame) => {
    const out = image(w, h);
    blit(out, frame, ox, oy);
    return out;
  });
};

// ---------------------------------------------------------------------------------------------
// Sheets: frames grouped by tag, packed with 1 px of transparent padding, written as PNG + JSON

const createSheet = () => ({ frames: [], tags: [] });

/** Adds a tag; `durations` is one number for every frame, or one per frame (ms). */
const addTag = (sheet, name, frames, durations = 100) => {
  if (sheet.tags.some((tag) => tag.name === name)) {
    throw new Error(`Duplicate tag ${name}`);
  }
  const from = sheet.frames.length;
  for (const [i, img] of frames.entries()) {
    const duration = Array.isArray(durations) ? durations[i] : durations;
    sheet.frames.push({ name: `${name} ${i}`, img, duration });
  }
  sheet.tags.push({ name, from, to: sheet.frames.length - 1 });
};

const PACK_WIDTH = 256;

/** Shelf packing in insertion order: deterministic, and good enough for small sheets. */
const pack = (sheet) => {
  let x = 0;
  let y = 0;
  let shelf = 0;
  const placed = sheet.frames.map((frame) => {
    const w = frame.img.w + 2;
    const h = frame.img.h + 2;
    if (x + w > PACK_WIDTH) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    const spot = { ...frame, x: x + 1, y: y + 1 };
    x += w;
    shelf = Math.max(shelf, h);
    return spot;
  });
  const height = y + shelf;
  const atlas = image(PACK_WIDTH, height);
  for (const frame of placed) {
    blit(atlas, frame.img, frame.x, frame.y);
  }
  return { atlas, placed };
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

const crc32 = (bytes) => {
  let c = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
};

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A truecolour + alpha PNG, every row with filter 0 (none). */
const encodePng = (img) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.w, 0);
  header.writeUInt32BE(img.h, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = img.w * 4;
  const raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y += 1) {
    raw.set(
      img.data.subarray(y * stride, (y + 1) * stride),
      y * (stride + 1) + 1
    );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** The JSON Aseprite writes with `--format json-hash --list-tags`. */
const asepriteJson = (sheet, placed, atlas, imageName) => {
  const frames = {};
  for (const frame of placed) {
    const { w, h } = frame.img;
    frames[frame.name] = {
      frame: { x: frame.x, y: frame.y, w, h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w, h },
      sourceSize: { w, h },
      duration: frame.duration,
    };
  }
  return {
    frames,
    meta: {
      app: "scripts/generate-sprite-sheets.mjs",
      version: "1",
      image: imageName,
      format: "RGBA8888",
      size: { w: atlas.w, h: atlas.h },
      scale: "1",
      frameTags: sheet.tags.map((tag) => ({
        name: tag.name,
        from: tag.from,
        to: tag.to,
        direction: "forward",
        color: "#000000ff",
      })),
      layers: [{ name: "art", opacity: 255, blendMode: "normal" }],
      slices: [],
    },
  };
};

const writeSheet = (sheet, dir, name) => {
  const { atlas, placed } = pack(sheet);
  mkdirSync(dir, { recursive: true });
  const png = encodePng(atlas);
  const json = `${JSON.stringify(asepriteJson(sheet, placed, atlas, `${name}.png`), null, 2)}\n`;
  writeFileSync(path.join(dir, `${name}.png`), png);
  writeFileSync(path.join(dir, `${name}.json`), json);
  return {
    name,
    tags: sheet.tags.length,
    frames: placed.length,
    atlas,
    bytes: png.length,
  };
};

// ---------------------------------------------------------------------------------------------
// Survivors: heroes (24 px, facing right, feet on the bottom row)

// A hooded adventurer, big head and small body: hood and cloak in the hero's colour (1-4), the
// hood's inside "o", a scarf "E" (lit) and "F" (shaded) whose tail flies behind.
const HERO_TOP = [
  "........443322........",
  "......4433322221......",
  "....4333222222221.....",
  "...433222222oooooo....",
  "...3322222osssssss....",
  "...3222222osskssks....",
  "...3222222osskssks....",
  "...2222222osrsssrs....",
  "...12222222oSSSSo.....",
  "....11222222oooo1.....",
  "....FEEEEEEEEEEEF.....",
  "..FFE122222222221.....",
  ".FF..132222222s21.....",
  ".....13bbbbbbbbb1.....",
  ".....132222222221.....",
  ".....122222222221.....",
  "......1122222211......",
  ".......11111111.......",
];
// Walk frames: stand, front foot up, stand, back foot up.
const HERO_LEGS = [
  [
    "........BB..BB........",
    "........BB..BB........",
    "........bbb.bbb.......",
    "........bbb.bbb.......",
  ],
  [
    "........BB..BB........",
    "........BB..bbb.......",
    "........bbb.bbb.......",
    "........bbb...........",
  ],
  [
    "........BB..BB........",
    "........BB..BB........",
    "........bbb.bbb.......",
    "........bbb.bbb.......",
  ],
  [
    "........BB..BB........",
    "........bbb.BB........",
    "........bbb.bbb.......",
    "............bbb.......",
  ],
];

// The scarf is each hero's accent colour, picked to stand out from the hood.
const HEROES = [
  { id: "spark", color: "#ffd23f", scarf: "#3b7ae0" },
  { id: "ember", color: "#ff6b35", scarf: "#ffe27a" },
  { id: "tide", color: "#3fa7ff", scarf: "#f4f4ff" },
];

const heroFrames = (palette) => {
  const walk = HERO_LEGS.map((legs) =>
    outline(fromGrid([...HERO_TOP, ...legs], palette))
  );
  // Down: the standing frame on its back.
  const down = rotate(flipX(walk[0]));
  return {
    walk: place(walk, 24, 24),
    idle: place([walk[0]], 24, 24),
    down: place([down], 24, 24),
  };
};

const addHero = (sheet, id, palette) => {
  const frames = heroFrames(palette);
  addTag(sheet, `${id}/walk`, frames.walk, 110);
  addTag(sheet, `${id}/idle`, frames.idle, 500);
  addTag(sheet, `${id}/down`, frames.down, 500);
};

// ---------------------------------------------------------------------------------------------
// Survivors: enemies (16 px; "o" is the outline in the prototype's grids)

const SLIME = [
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

// Smaller than the prototype's, darker, with a black outline (added below) so a swarm reads
// as many bats.
const BAT = [
  [
    "2........2",
    "32......23",
    "321.22.123",
    "3212222123",
    ".21e22e12.",
    "..122221..",
    "...1ww1...",
  ],
  [
    "..........",
    "..........",
    "....22....",
    "..122221..",
    "321e22e123",
    "3221221223",
    "32.1ww1.23",
    "2........2",
  ],
];

const WRAITH_TOP = [
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
  ".oo3222222221oo.",
  "..o3222222211o..",
];
const WRAITH = [
  [...WRAITH_TOP, "..o32o222o21o...", "..o2o.o2o.o1o...", "...o...o...o...."],
  [...WRAITH_TOP, "..o322o222o1o...", "...o2o.o2o.o1o..", "....o...o...o..."],
];

// A stomping rock golem in 14 px: shaded boulders with moss on top, hand-placed.
const GOLEM = [
  [
    "....g4gg3.....",
    "..gGo34o32g...",
    ".gG3e33e321G..",
    "g3332ooo2221Gg",
    "3433322222211o",
    "33.322o222.11o",
    "32.2222o21.21o",
    "21.3222o22.11o",
    "1o.2221222.oo.",
    "...o222111o...",
    "..2321..2321..",
    "..1221..1221..",
    "..o11o..o11o..",
  ],
  [
    "....g4gg3.....",
    "..gGo34o32g...",
    ".gG3e33e321G..",
    "g3332ooo2221Gg",
    "3433322222211o",
    "33.322o222.11o",
    "32.2222o21.21o",
    "21.3222o22.oo.",
    "1o.2221222....",
    "...o222111o...",
    "..2321.2321...",
    "..1221.1221...",
    "..o11o........",
  ],
];

const ENEMIES = [
  // Colours from enemies.json, tuned for contrast against the grass.
  {
    id: "slime",
    color: "#7bd389",
    frames: SLIME,
    eye: "#1a1226",
    anchor: "feet",
    ms: 260,
    outline: false,
  },
  {
    id: "bat",
    color: "#6a4592",
    frames: BAT,
    eye: "#ff4d6d",
    anchor: "centre",
    ms: 120,
    outline: true,
  },
  {
    id: "golem",
    color: "#b3a48c",
    frames: GOLEM,
    eye: "#ffcf4a",
    anchor: "feet",
    ms: 380,
    outline: true,
  },
  {
    id: "wraith",
    color: "#d9d9f0",
    frames: WRAITH,
    eye: "#8ff7ff",
    anchor: "feet",
    ms: 300,
    outline: false,
  },
];

const addEnemy = (sheet, enemy) => {
  const palette = { ...ramp(enemy.color), e: enemy.eye };
  const imgs = enemy.frames.map((grid) => {
    const img = fromGrid(grid, palette);
    return enemy.outline
      ? outline(img, enemy.id === "bat" ? "#07040b" : OUTLINE)
      : img;
  });
  addTag(
    sheet,
    `${enemy.id}/move`,
    place(imgs, 16, 16, enemy.anchor),
    enemy.ms
  );
};

// The generic enemy: a round blob in greys, tinted with the enemy's colour.
const addGenericEnemy = (sheet) => {
  const imgs = SLIME.map((grid) =>
    fromGrid(grid, { ...GREY, o: OUTLINE, k: GREY.k })
  );
  addTag(sheet, "enemy/move", place(imgs, 16, 16), 260);
};

// ---------------------------------------------------------------------------------------------
// Survivors: gems, projectiles, aura, marker, shadow

// One gem tier per enemy XP value (1, 3 and 5 in the demo content): small blue, medium green,
// large red. A gem is a faceted diamond: light top-left facet, dark bottom-right.
const GEMS = [
  {
    id: "small",
    radius: 3,
    colors: { o: "#0d2440", a: "#1f6fb0", b: "#3fb4f0", c: "#a8ecff" },
  },
  {
    id: "medium",
    radius: 4,
    colors: { o: "#0f3320", a: "#2a8a3e", b: "#5fd36a", c: "#c6ffb0" },
  },
  {
    id: "large",
    radius: 5,
    colors: { o: "#40101e", a: "#b0283f", b: "#ff5a6a", c: "#ffc0c0" },
  },
];

const gem = (r, colors) => {
  const size = r * 2 + 1;
  const img = image(size, size + 1);
  for (let y = 0; y < size + 1; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - r;
      const dy = y <= r ? y - r : (y - r) * (r / (r + 1));
      const d = Math.abs(dx) + Math.abs(dy);
      if (d > r + 0.01) {
        continue;
      }
      let c = colors.b;
      if (d > r - 1) {
        c = colors.o;
      } else if (y < r && x <= r) {
        c = x - y > -1 && x + y < r * 2 ? colors.c : colors.b;
      } else if (y > r || x > r) {
        c = colors.a;
      }
      set(img, x, y, c);
    }
  }
  // The table: a lighter band across the widest row, and a white glint.
  for (let x = 1; x < size - 1; x += 1) {
    if (get(img, x, r)[3] > 0 && x !== 0 && x !== size - 1) {
      set(img, x, r, x <= r ? colors.c : colors.b);
    }
  }
  set(img, r - 1, r - 1, "#ffffff");
  return img;
};

const sparkle = (img, x, y, big) => {
  const out = image(img.w + 4, img.h + 4);
  blit(out, img, 2, 2);
  const cx = x + 2;
  const cy = y + 2;
  set(out, cx, cy, "#ffffff");
  const arm = big ? 2 : 1;
  for (let i = 1; i <= arm; i += 1) {
    const c = i === arm && big ? "#c8d0e0" : "#ffffff";
    set(out, cx - i, cy, c);
    set(out, cx + i, cy, c);
    set(out, cx, cy - i, c);
    set(out, cx, cy + i, c);
  }
  return out;
};

const addGems = (sheet) => {
  for (const { id, radius, colors } of GEMS) {
    const base = gem(radius, colors);
    const still = image(base.w + 4, base.h + 4);
    blit(still, base, 2, 2);
    const glintX = radius + 1;
    const glintY = 1;
    const frames = [
      still,
      sparkle(base, glintX, glintY, false),
      sparkle(base, glintX, glintY, true),
    ];
    addTag(sheet, `gem/${id}`, place(frames, 16, 16, "centre"), [900, 90, 120]);
  }
};

// Projectiles. Arc Bolt: a crackling yellow star with a white core. Bubble Shot: a glassy
// bubble with a rim light. Bigger and brighter than the prototype's.
const ARC = {
  d: "#c98a10",
  m: "#ffcc33",
  l: "#fff176",
  w: "#ffffff",
};
const BOLT_ARC = [
  [
    ".....d.....",
    "....dmd....",
    "...dmlmd...",
    "..dmlwlmd..",
    ".dmlwwwlmd.",
    "dmlwwwwwlmd",
    ".dmlwwwlmd.",
    "..dmlwlmd..",
    "...dmlmd...",
    "....dmd....",
    ".....d.....",
  ],
  [
    "d....m....d",
    ".d...l...d.",
    "..m.dld.m..",
    "...mlwlm...",
    "..dlwwwld..",
    "mllwwwwwllm",
    "..dlwwwld..",
    "...mlwlm...",
    "..m.dld.m..",
    ".d...l...d.",
    "d....m....d",
  ],
];
const BUBBLE = {
  o: "#1d5a8a",
  d: "#4aa6e8",
  m: "#8fd3ff",
  l: "#d6f2ff",
  f: "#8fd3ff",
  w: "#ffffff",
};
const BOLT_BUBBLE = [
  [
    "...oooooo...",
    "..odmmmmdo..",
    ".odwwffffdo.",
    "omwwfffffmdo",
    "omwffffffmdo",
    "omfffffffmdo",
    "omfffffffmdo",
    "omffffffldmo",
    "odmfffflmdo.",
    ".odmmmmmdo..",
    "..oooooooo..",
  ],
  [
    "............",
    "..oooooooo..",
    ".odmmmmmmdo.",
    "omwwfffffmdo",
    "omwffffffmdo",
    "omfffffffmdo",
    "omfffffflmdo",
    "odmffffldmo.",
    ".odmmmmmmdo.",
    "..oooooooo..",
    "............",
  ],
];
const BOLT_GENERIC = [
  [
    "...mmmm...",
    "..mlllld..",
    ".mlwwwwld.",
    "mlwwwwwwld",
    "mlwwwwwwld",
    "mlwwwwwwld",
    "mlwwwwwwld",
    ".mlwwwwld.",
    "..mlllld..",
    "...dddd...",
  ],
  [
    "..........",
    "...mmmm...",
    "..mllllm..",
    ".mlwwwwld.",
    ".mlwwwwld.",
    ".mlwwwwld.",
    ".mlwwwwld.",
    "..mlllld..",
    "...dddd...",
    "..........",
  ],
];
const SHOT_GREY = { d: "#8a8a8a", m: "#bdbdbd", l: "#e6e6e6", w: "#ffffff" };

// The trail: puffs left behind a projectile, from fresh to faded. White, tinted at draw time.
const TRAIL = [
  [".ww.", "wwww", "wwww", ".ww."],
  ["....", ".ww.", ".ww.", "...."],
  ["....", ".l..", "....", "...."],
];

const addShots = (sheet) => {
  addTag(
    sheet,
    "bolt/arc",
    place(
      BOLT_ARC.map((g) => fromGrid(g, ARC)),
      12,
      12,
      "centre"
    ),
    70
  );
  addTag(
    sheet,
    "bolt/bubble",
    place(
      BOLT_BUBBLE.map((g) => fromGrid(checker(g, "f"), BUBBLE)),
      12,
      12,
      "centre"
    ),
    160
  );
  addTag(
    sheet,
    "bolt/generic",
    place(
      BOLT_GENERIC.map((g) => fromGrid(g, SHOT_GREY)),
      12,
      12,
      "centre"
    ),
    90
  );
  addTag(
    sheet,
    "trail",
    place(
      TRAIL.map((g) => fromGrid(g, { w: "#ffffff", l: "#a8a8a8" })),
      4,
      4,
      "centre"
    ),
    60
  );
};

// The aura: a pixel ring with a dithered fill fading toward the middle, white so the weapon
// colour tints it. 64 px across; frame 1 pulses the fill outward.
const aura = (pulse) => {
  const size = 64;
  const img = image(size, size);
  const c = size / 2;
  const R = size / 2 - 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      if (d > R) {
        continue;
      }
      const edge = R - d;
      if (edge < 1.5) {
        set(img, x, y, "#ffffffe0");
      } else if (edge < 2.5) {
        set(img, x, y, "#ffffff70");
      } else {
        // Denser near the rim; the pulse frame pushes a band of dither inward.
        const t = 1 - edge / (R * 0.7);
        const band = pulse ? Math.max(0, 1 - Math.abs(edge - 8) / 3) * 0.35 : 0;
        const density = Math.max(0, t) * 0.5 + band;
        if (bayer(x, y) < density) {
          set(img, x, y, "#ffffff60");
        } else if (edge < R) {
          set(img, x, y, "#ffffff14");
        }
      }
    }
  }
  return img;
};

// The hero's ground marker: a solid elliptical ring, white so the player slot colour tints it.
// The shadow: a soft dark ellipse under every standing sprite.
const ellipse = (w, h, paint) => {
  const img = image(w, h);
  const rx = w / 2;
  const ry = h / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = (x + 0.5 - rx) / rx;
      const ny = (y + 0.5 - ry) / ry;
      const d = Math.hypot(nx, ny);
      const color = paint(d, x, y);
      if (d <= 1 && color) {
        set(img, x, y, color);
      }
    }
  }
  return img;
};

const marker = () => {
  const outer = ellipse(22, 10, () => "#ffffff");
  const inner = ellipse(16, 6, () => "#ffffff");
  // Cut the inner ellipse out, centred in the outer one.
  for (let y = 0; y < inner.h; y += 1) {
    for (let x = 0; x < inner.w; x += 1) {
      if (opaque(inner, x, y)) {
        set(outer, x + 3, y + 2, [0, 0, 0, 0]);
      }
    }
  }
  return outer;
};

const shadow = () =>
  ellipse(16, 6, (d, x, y) => {
    if (d < 0.7) {
      return "#0a0612a0";
    }
    return bayer(x, y) < 0.5 ? "#0a061270" : "#0a061240";
  });

const addEffects = (sheet) => {
  addTag(sheet, "aura/ring", [aura(false), aura(true)], 260);
  addTag(sheet, "marker/ring", [marker()], 100);
  addTag(sheet, "shadow", [shadow()], 100);
};

// ---------------------------------------------------------------------------------------------
// Survivors: ground tiles (16 px). Low contrast so the characters stand out.

const GRASS = ["#2f4f2c", "#355830", "#3a5f34", "#406638"];
const DIRT = ["#4f4031", "#574735", "#5f4d3a", "#685541"];
const STONE = {
  mortar: "#24212c",
  dark: "#45414f",
  mid: "#5a5668",
  light: "#6f6a80",
  top: "#9893aa",
};
const VOID = ["#0c0f17", "#141a26"];

/** A 16 px grass tile: one flat shade with a few soft specks. */
const grassTile = (seed) => {
  const img = image(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const n = hash(x, y, seed);
      let tone = 2;
      if (n > 0.93) {
        tone = 3;
      } else if (n < 0.08) {
        tone = 1;
      }
      set(img, x, y, GRASS[tone]);
    }
  }
  // A couple of two-pixel blades, darker, never a stamped shape.
  for (let i = 0; i < 3; i += 1) {
    const x = Math.floor(hash(i, seed, 7) * 16);
    const y = Math.floor(hash(seed, i, 9) * 15);
    if (seed % 2 === 0) {
      set(img, x, y, GRASS[1]);
      set(img, x, y + 1, GRASS[0]);
    }
  }
  return img;
};

const dirtColor = (x, y, seed) => {
  const n = hash(x, y, seed + 40);
  if (n > 0.9) {
    return DIRT[3];
  }
  if (n > 0.6) {
    return DIRT[2];
  }
  return n < 0.08 ? DIRT[0] : DIRT[1];
};

const dirtTile = (seed) => {
  const img = image(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      set(img, x, y, dirtColor(x, y, seed));
    }
  }
  return img;
};

/**
 * A soft dirt patch to lay over the grass: an irregular blob that thins out through a
 * dither at its border, transparent outside.
 */
const patch = (w, h, seed) => {
  const img = image(w, h);
  const wobble = (a) =>
    1 +
    0.12 * Math.sin(a * 2 + seed) +
    0.08 * Math.sin(a * 3 + seed * 2.3) +
    0.05 * Math.sin(a * 5 + seed * 0.7);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = (x + 0.5 - w / 2) / (w / 2 - 1);
      const ny = (y + 0.5 - h / 2) / (h / 2 - 1);
      const d = Math.hypot(nx, ny) / wobble(Math.atan2(ny, nx)) / 0.8;
      // Solid inside 0.65, dithered out to 1.
      const fade = (1 - d) / 0.35;
      if (d < 0.65 || bayer(x, y) < fade) {
        set(img, x, y, dirtColor(x, y, seed));
      }
    }
  }
  return img;
};

/**
 * The arena wall seen from above, for the north side: two courses of staggered stones, lit
 * along the arena side (the bottom row), with a dark drop on the far side. Other sides are
 * this turned.
 */
const wallTile = () => {
  const img = image(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const course = y < 8 ? 0 : 1;
      const by = y % 8;
      const bx = (x + course * 4) % 8;
      const stone = Math.floor((x + course * 4) / 8) + course * 3;
      let c = hash(stone, course, 3) > 0.5 ? STONE.light : STONE.mid;
      if (bx === 0 || by === 7) {
        c = STONE.mortar;
      } else if (by === 0 || bx === 1) {
        c = STONE.top;
      } else if (by === 6 || bx === 7) {
        c = STONE.dark;
      } else if (hash(x, y, 11) > 0.92) {
        c = STONE.dark;
      }
      set(img, x, y, c);
    }
  }
  // The far side drops away; the arena side gets a bright lip and a dark seam.
  fill(img, 0, 0, 16, 1, VOID[1]);
  fill(img, 0, 14, 16, 1, STONE.top);
  fill(img, 0, 15, 16, 1, STONE.mortar);
  return img;
};

/** An outer corner: the wall tile with the arena only at the bottom-right. */
const wallCorner = () => {
  const img = wallTile();
  // The right column becomes the lip of the side running down from here.
  for (let y = 0; y < 16; y += 1) {
    if (y >= 1) {
      set(img, 14, y, STONE.top);
      set(img, 15, y, STONE.mortar);
    }
  }
  set(img, 14, 15, STONE.mortar);
  return img;
};

const voidTile = (seed) => {
  const img = image(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      set(img, x, y, hash(x, y, seed + 90) > 0.985 ? VOID[1] : VOID[0]);
    }
  }
  return img;
};

const addGround = (sheet) => {
  addTag(
    sheet,
    "ground/grass",
    [0, 1, 2, 3].map((seed) => grassTile(seed)),
    100
  );
  addTag(
    sheet,
    "ground/dirt",
    [0, 1, 2].map((seed) => dirtTile(seed)),
    100
  );
  // Patches come in three sizes, each centred in the same 48 x 32 frame.
  const patches = [patch(48, 32, 1), patch(40, 28, 2), patch(32, 24, 3)];
  addTag(
    sheet,
    "ground/patch",
    patches.map((img) => place([img], 48, 32, "centre")[0]),
    100
  );
  const north = wallTile();
  const corner = wallCorner();
  // Each edge tile is named for the side of the arena it sits on.
  addTag(sheet, "edge/n", [north], 100);
  addTag(sheet, "edge/e", [rotate(north)], 100);
  addTag(sheet, "edge/s", [rotate(rotate(north))], 100);
  addTag(sheet, "edge/w", [rotate(rotate(rotate(north)))], 100);
  addTag(sheet, "edge/nw", [corner], 100);
  addTag(sheet, "edge/ne", [rotate(corner)], 100);
  addTag(sheet, "edge/se", [rotate(rotate(corner))], 100);
  addTag(sheet, "edge/sw", [rotate(rotate(rotate(corner)))], 100);
  addTag(sheet, "edge/void", [voidTile(0), voidTile(1)], 100);
};

const survivorsSheet = () => {
  const sheet = createSheet();
  for (const hero of HEROES) {
    addHero(sheet, hero.id, {
      ...ramp(hero.color),
      E: hero.scarf,
      F: shade(hero.scarf, -0.2),
    });
  }
  addHero(sheet, "hero", GREY);
  for (const enemy of ENEMIES) {
    addEnemy(sheet, enemy);
  }
  addGenericEnemy(sheet);
  addGems(sheet);
  addShots(sheet);
  addEffects(sheet);
  addGround(sheet);
  return sheet;
};

// ---------------------------------------------------------------------------------------------
// Push-puzzle: a cosy dungeon on the same 16 px grid

const DUNGEON = {
  mortar: "#221c28",
  floor: ["#3e3546", "#463c4f", "#4e4358", "#574b62"],
  wallTop: ["#5d5070", "#6d6083", "#7f7296", "#9a8fb0"],
  wallFace: ["#2c2433", "#3a3044", "#473b53"],
  pit: ["#08060b", "#120e17", "#1c1624"],
  gold: ["#7a4f12", "#c98a1c", "#f2c14e", "#fff0b0"],
};

/** Flagstones: stones of 8 x 8 (or 16 x 8 with `long`), mortar on the top and left. */
const floorTile = (seed, long = false) => {
  const img = image(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const row = y < 8 ? 0 : 1;
      const wide = long && row === 0;
      const sx = wide ? 0 : Math.floor(x / 8);
      const lx = wide ? x : x % 8;
      const ly = y % 8;
      const tone = 1 + Math.floor(hash(sx, row, seed) * 2.5);
      let c = DUNGEON.floor[tone];
      if (lx === 0 || ly === 0) {
        c = DUNGEON.mortar;
      } else if (lx === 1 || ly === 1) {
        c = DUNGEON.floor[Math.min(3, tone + 1)];
      } else if (hash(x, y, seed + 20) > 0.93) {
        c = DUNGEON.floor[tone - 1];
      }
      set(img, x, y, c);
    }
  }
  return img;
};

/** The top of a wall, seen from above: bricks lit from the top-left. */
const wallTopTile = () => {
  const img = image(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const course = Math.floor(y / 4);
      const bx = (x + (course % 2) * 4) % 8;
      const by = y % 4;
      const tone =
        hash(Math.floor((x + (course % 2) * 4) / 8), course, 5) > 0.5 ? 2 : 1;
      let lit = tone;
      if (bx === 0 || by === 3) {
        lit = 0;
      } else if (by === 0) {
        lit = 3;
      }
      set(img, x, y, DUNGEON.wallTop[lit]);
    }
  }
  return img;
};

/** The face of a wall, drawn where floor lies below it: darker bricks, shadow at the foot. */
const wallFaceTile = () => {
  const img = image(16, 16);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const course = Math.floor(y / 5);
      const bx = (x + (course % 2) * 4) % 8;
      const by = y % 5;
      let tone =
        hash(Math.floor((x + (course % 2) * 4) / 8), course, 9) > 0.5 ? 2 : 1;
      if (bx === 0 || by === 4) {
        tone = 0;
      }
      set(img, x, y, DUNGEON.wallFace[tone]);
    }
  }
  fill(img, 0, 0, 16, 2, DUNGEON.wallTop[3]);
  fill(img, 0, 2, 16, 1, DUNGEON.wallTop[1]);
  fill(img, 0, 15, 16, 1, DUNGEON.pit[1]);
  return img;
};

/** The goal: a gold rune ring set into the floor. */
const goalTile = () => {
  const img = floorTile(0);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
      if (d >= 5 && d < 6) {
        set(img, x, y, DUNGEON.gold[2]);
      } else if (d >= 6 && d < 7) {
        set(img, x, y, DUNGEON.gold[0]);
      } else if (d < 2) {
        set(img, x, y, DUNGEON.gold[3]);
      } else if (d < 3) {
        set(img, x, y, DUNGEON.gold[1]);
      }
    }
  }
  return img;
};

/** A hole: a dark pit with a lit far lip and a sheer near wall. `inside` paints its content. */
const holeTile = (insideImg) => {
  const img = floorTile(1);
  fill(img, 2, 2, 12, 12, DUNGEON.pit[0]);
  // The near (top) wall of the pit is visible going down.
  fill(img, 2, 2, 12, 3, DUNGEON.pit[2]);
  fill(img, 2, 5, 12, 1, DUNGEON.pit[1]);
  for (const [x, y] of [
    [2, 2],
    [13, 2],
    [2, 13],
    [13, 13],
  ]) {
    set(img, x, y, DUNGEON.floor[1]);
  }
  fill(img, 3, 14, 10, 1, DUNGEON.floor[3]);
  if (insideImg) {
    blit(img, insideImg, 2, 3);
  }
  return img;
};

const WOOD = {
  o: "#2a160c",
  x: "#3d2412",
  1: "#6b3f1f",
  2: "#93602f",
  3: "#b8823f",
  4: "#d9a95c",
  m: "#8a8a99",
  M: "#c9c9d6",
};
const CRATE = [
  "oooooooooooooo",
  "o4333333333331",
  "o3mM22222mM221",
  "o3M2222222M221",
  "o32222222222x1",
  "o3222222222x21",
  "o322222222x221",
  "o32222222x2221",
  "o3222222x22221",
  "o322222x222221",
  "o32222x2222221",
  "o3mM2x222mM221",
  "o3M2x2222M2221",
  "o111111111111o",
];

const crate = (palette) => fromGrid(CRATE, palette);

const boxTile = (palette) => {
  const img = image(16, 16);
  // A shadow under the crate's foot, darker than any floor.
  fill(img, 2, 15, 13, 1, "#2a2333");
  blit(img, crate(palette), 1, 1);
  return img;
};

// The player: a small hooded adventurer with a scarf, 4 walk frames in each direction.
const P_RIGHT = [
  "....4433....",
  "..44332221..",
  ".4332222221.",
  ".3222ooooo..",
  ".322osssss..",
  ".322ossksk..",
  ".222osrssr..",
  "..122oSSS1..",
  "..FEEEEEEF..",
  ".FE122222s1.",
  "..1bbbbbbb1.",
  "..12222221..",
];
const P_DOWN = [
  "...433322...",
  "..43322221..",
  ".4322222221.",
  ".32oooooo21.",
  ".32oskksko1.",
  ".32oskksko1.",
  ".22osrrsso1.",
  "..12oSSo21..",
  "..FEEEEEEF..",
  ".s12222221s.",
  ".1bbbbbbbb1.",
  "..12222221..",
];
const P_UP = [
  "...433322...",
  "..43333221..",
  ".4333222221.",
  ".3332222221.",
  ".3322222221.",
  ".3222222211.",
  ".2222222211.",
  "..12222211..",
  "..FEEEEEEF..",
  ".s12222221s.",
  ".1bbbbbbbb1.",
  "..12222221..",
];
const P_LEGS = [
  ["...BB..BB...", "...bb..bb..."],
  ["...BB..bb...", "...bb......."],
  ["...BB..BB...", "...bb..bb..."],
  ["...bb..BB...", ".......bb..."],
];

const PLAYER = { ...ramp("#d9583b"), E: "#ffe27a", F: shade("#ffe27a", -0.2) };

const playerFrames = (top) =>
  place(
    P_LEGS.map((legs) => outline(fromGrid([...top, ...legs], PLAYER))),
    16,
    16
  );

const puzzleSheet = () => {
  const sheet = createSheet();
  addTag(sheet, "floor", [floorTile(0), floorTile(1, true), floorTile(2)], 100);
  addTag(sheet, "wall", [wallTopTile()], 100);
  addTag(sheet, "wall/face", [wallFaceTile()], 100);
  addTag(sheet, "goal", [goalTile()], 100);
  addTag(sheet, "hole", [holeTile()], 100);
  // A box sunk in a hole: its top sits a little below the floor, darkened.
  const sunk = {
    ...WOOD,
    2: "#6e4824",
    3: "#875c30",
    4: "#9f7340",
    1: "#4e2e16",
  };
  const sunkCrate = image(12, 11);
  blit(sunkCrate, place([crate(sunk)], 14, 14, "centre")[0], -1, -1);
  addTag(sheet, "hole/filled", [holeTile(sunkCrate)], 100);
  addTag(sheet, "box", [boxTile(WOOD)], 100);
  // On a goal the crate's rim and corners turn gold, so a solved box reads at a glance.
  const gilded = {
    ...WOOD,
    o: DUNGEON.gold[1],
    1: DUNGEON.gold[0],
    m: DUNGEON.gold[2],
    M: DUNGEON.gold[3],
    4: "#f2c879",
    3: "#d19a4a",
  };
  addTag(sheet, "box/on-goal", [boxTile(gilded)], 100);
  const right = playerFrames(P_RIGHT);
  // Idle breathes: the second frame drops the head a pixel onto the body.
  const breathe = [".", ...P_RIGHT.slice(0, 11), ...P_LEGS[0]];
  const idle = place(
    [[...P_RIGHT, ...P_LEGS[0]], breathe].map((grid) =>
      outline(fromGrid(grid, PLAYER))
    ),
    16,
    16
  );
  addTag(sheet, "player/idle", idle, [600, 400]);
  addTag(sheet, "player/walk", right, 110);
  addTag(sheet, "player/up", playerFrames(P_UP), 110);
  addTag(sheet, "player/down", playerFrames(P_DOWN), 110);
  return sheet;
};

// ---------------------------------------------------------------------------------------------

const written = [
  writeSheet(survivorsSheet(), SURVIVOR_DIR, "survivors"),
  writeSheet(puzzleSheet(), PUZZLE_DIR, "push-puzzle"),
];
for (const sheet of written) {
  console.log(
    `Wrote ${sheet.name}.png (${sheet.atlas.w}x${sheet.atlas.h}, ${sheet.frames} frames, ${sheet.tags} tags, ${(sheet.bytes / 1024).toFixed(1)} KB).`
  );
}
