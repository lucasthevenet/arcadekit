/* oxlint-disable no-plusplus, no-param-reassign, max-statements, max-lines-per-function, no-magic-numbers, id-length, func-style, no-nested-ternary, no-negated-condition, unicorn/no-negated-condition, oxc/branches-sharing-code, unicorn/no-array-fill-with-reference-type, unicorn/no-array-for-each, unicorn/numeric-separators-style, unicorn/switch-case-braces, no-inline-comments -- PROTOTYPE (#24 art): throwaway canvas painting */
// PROTOTYPE (#24 art), variant D: the cartoon sprite sheet and the painted ground tile.
// Everything is painted with the Canvas 2D API at startup: bold shapes, thick dark outlines,
// flat colour with one shade and one highlight.

export const CELL = 256;
export const COLS = 8;
export const SHEET = CELL * COLS;

export const OUTLINE = "#24182c";
const LW = 11;

export interface SheetSpec {
  readonly heroes: readonly { readonly id: string; readonly color: string }[];
  readonly enemies: readonly { readonly id: string; readonly color: string }[];
  readonly weapons: readonly {
    readonly id: string;
    readonly color: string;
    readonly kind: string;
  }[];
}

/** Where each thing lives in the sheet. Heroes: front, back. Enemies: two frames. */
export interface SheetLayout {
  readonly hero: number[];
  readonly enemy: number[];
  readonly shot: number[];
  readonly gem: number;
  readonly decor: number;
}

export const DECOR = {
  tuft: 0,
  flowers: 1,
  rock: 2,
  mushroom: 3,
  bush: 4,
  stone: 5,
  stump: 6,
} as const;
export const DECOR_COUNT = 7;

// ------------------------------------------------------------------ colour

const hex = (c: string): [number, number, number] => {
  const n = Number.parseInt(c.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (r: number, g: number, b: number) =>
  `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
const mix = (a: string, b: string, t: number) => {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
};
/** Darker, a touch cooler and more saturated: the shade side. */
const shade = (c: string, t = 0.32) => mix(c, "#3a1f5c", t);
const light = (c: string, t = 0.45) => mix(c, "#ffffff", t);
const alpha = (c: string, a: number) => {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${a})`;
};

// ------------------------------------------------------------------ helpers

type Ctx = CanvasRenderingContext2D;

const outline = (ctx: Ctx, p: Path2D, w = LW) => {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = w;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke(p);
};

/** Flat fill, a shade crescent (bottom right) and a soft highlight (top left), then the outline. */
const body = (
  ctx: Ctx,
  p: Path2D,
  base: string,
  opts: {
    shadeOffset?: [number, number];
    hi?: [number, number, number, number];
    shadeAmt?: number;
    w?: number;
  } = {}
) => {
  const [sx, sy] = opts.shadeOffset ?? [-14, -16];
  ctx.fillStyle = shade(base, opts.shadeAmt ?? 0.32);
  ctx.fill(p);
  ctx.save();
  ctx.clip(p);
  ctx.translate(sx, sy);
  ctx.fillStyle = base;
  ctx.fill(p);
  ctx.restore();
  if (opts.hi) {
    const [hx, hy, rx, ry] = opts.hi;
    ctx.save();
    ctx.clip(p);
    ctx.fillStyle = alpha("#ffffff", 0.42);
    ctx.beginPath();
    ctx.ellipse(hx, hy, rx, ry, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  outline(ctx, p, opts.w ?? LW);
};

const ellipse = (x: number, y: number, rx: number, ry: number, rot = 0) => {
  const p = new Path2D();
  p.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  return p;
};

const poly = (pts: number[]) => {
  const p = new Path2D();
  p.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) {
    p.lineTo(pts[i]!, pts[i + 1]!);
  }
  p.closePath();
  return p;
};

/** A cartoon eye: white, outline, pupil looking right, glint. */
const eye = (
  ctx: Ctx,
  x: number,
  y: number,
  rx: number,
  ry: number,
  look = 7,
  pupil = OUTLINE
) => {
  const p = ellipse(x, y, rx, ry);
  ctx.fillStyle = "#ffffff";
  ctx.fill(p);
  outline(ctx, p, 7);
  ctx.fillStyle = pupil;
  ctx.beginPath();
  ctx.ellipse(x + look, y + 3, rx * 0.55, ry * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x + look + rx * 0.18, y - ry * 0.12, rx * 0.2, 0, Math.PI * 2);
  ctx.fill();
};

const blush = (ctx: Ctx, x: number, y: number) => {
  ctx.fillStyle = "rgba(255,110,140,0.45)";
  ctx.beginPath();
  ctx.ellipse(x, y, 15, 9, 0, 0, Math.PI * 2);
  ctx.fill();
};

const glow = (
  ctx: Ctx,
  x: number,
  y: number,
  r: number,
  color: string,
  a = 0.8
) => {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, alpha(color, a));
  g.addColorStop(1, alpha(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
};

// ------------------------------------------------------------------ heroes

const heroBody = () => {
  const p = new Path2D();
  p.moveTo(128, 70);
  p.bezierCurveTo(196, 70, 206, 128, 204, 168);
  p.bezierCurveTo(202, 216, 172, 230, 128, 230);
  p.bezierCurveTo(84, 230, 54, 216, 52, 168);
  p.bezierCurveTo(50, 128, 60, 70, 128, 70);
  return p;
};

const accessory = (ctx: Ctx, id: string, color: string, back: boolean) => {
  if (id === "spark") {
    // Spiky hair and a lightning antenna.
    const hair = poly([
      70, 104, 76, 58, 100, 84, 112, 40, 132, 78, 154, 44, 160, 84, 186, 60,
      188, 106,
    ]);
    body(ctx, hair, mix(color, "#ffb000", 0.35), { hi: [100, 66, 16, 8] });
    const bolt = poly([
      176, 4, 146, 44, 166, 46, 150, 82, 196, 34, 174, 32, 192, 4,
    ]);
    ctx.fillStyle = "#fffbe0";
    ctx.fill(bolt);
    outline(ctx, bolt, 8);
  } else if (id === "ember") {
    // A flame on top of the head.
    const flame = new Path2D();
    flame.moveTo(128, 104);
    flame.bezierCurveTo(78, 104, 76, 66, 98, 44);
    flame.bezierCurveTo(98, 62, 108, 66, 114, 62);
    flame.bezierCurveTo(108, 36, 124, 14, 142, 6);
    flame.bezierCurveTo(136, 30, 150, 44, 160, 36);
    flame.bezierCurveTo(166, 52, 182, 70, 172, 90);
    flame.bezierCurveTo(166, 102, 150, 104, 128, 104);
    body(ctx, flame, "#ff4a1c", { shadeOffset: [-8, -10] });
    const inner = new Path2D();
    inner.moveTo(128, 98);
    inner.bezierCurveTo(104, 98, 102, 76, 116, 60);
    inner.bezierCurveTo(118, 72, 128, 72, 132, 50);
    inner.bezierCurveTo(144, 64, 156, 76, 150, 88);
    inner.bezierCurveTo(146, 96, 138, 98, 128, 98);
    ctx.fillStyle = "#ffd23f";
    ctx.fill(inner);
  } else if (id === "tide") {
    // A curling wave cap with foam.
    const wave = new Path2D();
    wave.moveTo(66, 108);
    wave.bezierCurveTo(60, 60, 110, 30, 160, 40);
    wave.bezierCurveTo(196, 48, 206, 84, 182, 96);
    wave.bezierCurveTo(166, 104, 148, 92, 156, 78);
    wave.bezierCurveTo(140, 74, 128, 84, 132, 96);
    wave.bezierCurveTo(110, 100, 86, 98, 66, 108);
    body(ctx, wave, mix(color, "#1c5fd6", 0.35), { hi: [96, 60, 22, 9] });
    ctx.fillStyle = "#ffffff";
    for (const [x, y, r] of [
      [168, 52, 7],
      [182, 64, 5],
      [150, 46, 5],
    ] as const) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const leaf = ellipse(146, 56, 26, 12, -0.6);
    body(ctx, leaf, "#6fcf5a");
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(128, 76);
    ctx.quadraticCurveTo(126, 60, 136, 50);
    ctx.stroke();
  }
  if (back) {
    ctx.globalAlpha = 1;
  }
};

const paintHero = (ctx: Ctx, id: string, color: string, back: boolean) => {
  // Feet first, under the body.
  for (const x of [98, 158]) {
    body(ctx, ellipse(x, 232, 26, 15), shade(color, 0.55), {
      shadeOffset: [-4, -6],
    });
  }
  // Little arms.
  body(ctx, ellipse(56, 178, 15, 21, 0.3), shade(color, 0.12), {
    shadeOffset: [-4, -6],
  });
  body(ctx, ellipse(200, 178, 15, 21, -0.3), shade(color, 0.12), {
    shadeOffset: [-4, -6],
  });
  const b = heroBody();
  body(ctx, b, color, { hi: [96, 104, 26, 16], shadeOffset: [-16, -14] });
  if (!back) {
    // Belly.
    ctx.save();
    ctx.clip(b);
    ctx.fillStyle = alpha("#ffffff", 0.3);
    ctx.beginPath();
    ctx.ellipse(138, 204, 46, 30, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    outline(ctx, b);
    eye(ctx, 118, 138, 20, 27, 8);
    eye(ctx, 166, 138, 20, 27, 8);
    blush(ctx, 98, 172);
    blush(ctx, 188, 172);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(146, 172, 13, 0.25, Math.PI - 0.25);
    ctx.stroke();
  } else {
    // A seam down the back.
    ctx.save();
    ctx.clip(b);
    ctx.fillStyle = alpha(shade(color, 0.5), 0.35);
    ctx.beginPath();
    ctx.ellipse(128, 170, 38, 46, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    outline(ctx, b);
  }
  accessory(ctx, id, color, back);
};

// ------------------------------------------------------------------ enemies

const paintSlime = (ctx: Ctx, color: string, blink: boolean) => {
  const p = new Path2D();
  p.moveTo(40, 226);
  p.bezierCurveTo(22, 222, 20, 196, 36, 176);
  p.bezierCurveTo(52, 118, 88, 74, 130, 74);
  p.bezierCurveTo(172, 74, 206, 118, 220, 176);
  p.bezierCurveTo(236, 196, 234, 222, 214, 226);
  // Gooey drips along the base.
  p.bezierCurveTo(196, 238, 180, 222, 164, 230);
  p.bezierCurveTo(146, 240, 130, 226, 112, 232);
  p.bezierCurveTo(92, 240, 74, 222, 58, 230);
  p.bezierCurveTo(50, 234, 44, 230, 40, 226);
  p.closePath();
  body(ctx, p, color, { shadeOffset: [-16, -18], shadeAmt: 0.38 });
  // Inner goo glow and big shine.
  ctx.save();
  ctx.clip(p);
  ctx.fillStyle = alpha("#ffffff", 0.18);
  ctx.beginPath();
  ctx.ellipse(126, 200, 70, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = alpha("#ffffff", 0.85);
  ctx.beginPath();
  ctx.ellipse(86, 118, 22, 11, -0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(66, 146, 6, 0, Math.PI * 2);
  ctx.fill();
  outline(ctx, p);
  // Face.
  if (blink) {
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    for (const x of [124, 172]) {
      ctx.beginPath();
      ctx.arc(x, 150, 12, 0.2, Math.PI - 0.2);
      ctx.stroke();
    }
  } else {
    for (const x of [124, 172]) {
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.ellipse(x, 152, 11, 17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x + 3, 145, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const mouth = new Path2D();
  mouth.moveTo(134, 180);
  mouth.quadraticCurveTo(148, 198, 162, 180);
  mouth.closePath();
  ctx.fillStyle = "#7a2440";
  ctx.fill(mouth);
  outline(ctx, mouth, 6);
  blush(ctx, 100, 176);
  blush(ctx, 196, 176);
};

const paintBat = (ctx: Ctx, color: string, up: boolean) => {
  const wingColor = shade(color, 0.3);
  for (const side of [-1, 1]) {
    const w = new Path2D();
    const x0 = 128 + side * 34;
    if (up) {
      w.moveTo(x0, 116);
      w.bezierCurveTo(
        128 + side * 70,
        60,
        128 + side * 100,
        30,
        128 + side * 120,
        40
      );
      w.bezierCurveTo(
        128 + side * 112,
        70,
        128 + side * 116,
        90,
        128 + side * 104,
        110
      );
      w.quadraticCurveTo(128 + side * 92, 96, 128 + side * 82, 116);
      w.quadraticCurveTo(128 + side * 70, 106, 128 + side * 60, 128);
      w.quadraticCurveTo(128 + side * 50, 120, x0, 140);
    } else {
      w.moveTo(x0, 120);
      w.bezierCurveTo(
        128 + side * 80,
        110,
        128 + side * 110,
        130,
        128 + side * 122,
        170
      );
      w.quadraticCurveTo(128 + side * 104, 162, 128 + side * 96, 180);
      w.quadraticCurveTo(128 + side * 84, 166, 128 + side * 72, 182);
      w.quadraticCurveTo(128 + side * 62, 164, 128 + side * 50, 172);
      w.quadraticCurveTo(128 + side * 44, 156, x0, 152);
    }
    w.closePath();
    body(ctx, w, wingColor, { shadeOffset: [0, -10], shadeAmt: 0.3 });
    // Wing bones.
    ctx.strokeStyle = alpha(OUTLINE, 0.5);
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x0, 128);
    ctx.lineTo(128 + side * (up ? 104 : 96), up ? 70 : 160);
    ctx.stroke();
  }
  // Ears.
  for (const side of [-1, 1]) {
    const ear = poly([
      128 + side * 22,
      96,
      128 + side * 46,
      58,
      128 + side * 52,
      108,
    ]);
    body(ctx, ear, color, { shadeOffset: [-4, -4] });
    ctx.fillStyle = "#ff8fb4";
    ctx.fill(
      poly([128 + side * 32, 96, 128 + side * 44, 74, 128 + side * 46, 102])
    );
  }
  const b = ellipse(128, 138, 54, 50);
  body(ctx, b, color, { hi: [104, 112, 18, 10], shadeOffset: [-12, -14] });
  // Fuzzy belly.
  ctx.save();
  ctx.clip(b);
  ctx.fillStyle = alpha(light(color, 0.5), 0.6);
  ctx.beginPath();
  ctx.ellipse(132, 170, 30, 22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  outline(ctx, b);
  // Angry yellow eyes.
  for (const x of [114, 150]) {
    const e = ellipse(x, 132, 13, 15);
    ctx.fillStyle = "#ffe14d";
    ctx.fill(e);
    outline(ctx, e, 6);
    ctx.fillStyle = OUTLINE;
    ctx.beginPath();
    ctx.ellipse(x + 4, 134, 4, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(98, 112);
  ctx.lineTo(124, 120);
  ctx.moveTo(166, 112);
  ctx.lineTo(140, 120);
  ctx.stroke();
  // Fangs.
  for (const x of [124, 144]) {
    const f = poly([x - 6, 156, x + 6, 156, x, 170]);
    ctx.fillStyle = "#ffffff";
    ctx.fill(f);
    outline(ctx, f, 4);
  }
};

const paintGolem = (ctx: Ctx, color: string, stomp: boolean) => {
  const rock = color;
  const armY = stomp ? 168 : 184;
  // Arms behind the body.
  body(
    ctx,
    poly([
      30,
      armY - 40,
      66,
      armY - 52,
      76,
      armY + 6,
      44,
      armY + 30,
      22,
      armY + 6,
    ]),
    shade(rock, 0.1),
    { shadeOffset: [-6, -8] }
  );
  const ay2 = stomp ? 192 : 172;
  body(
    ctx,
    poly([
      226,
      ay2 - 40,
      190,
      ay2 - 52,
      180,
      ay2 + 6,
      212,
      ay2 + 30,
      234,
      ay2 + 6,
    ]),
    shade(rock, 0.1),
    { shadeOffset: [-6, -8] }
  );
  // Legs.
  body(ctx, poly([70, 196, 112, 196, 116, 236, 64, 236]), shade(rock, 0.25), {
    shadeOffset: [-4, -4],
  });
  body(ctx, poly([142, 196, 186, 196, 192, 236, 140, 236]), shade(rock, 0.25), {
    shadeOffset: [-4, -4],
  });
  // Torso: a chunky boulder.
  const torso = poly([
    58, 100, 92, 70, 166, 66, 202, 96, 212, 156, 192, 208, 128, 220, 64, 208,
    46, 156,
  ]);
  body(ctx, torso, rock, { hi: [92, 100, 30, 14], shadeOffset: [-18, -18] });
  // Moss on the shoulders.
  ctx.save();
  ctx.clip(torso);
  ctx.fillStyle = "#6f9a4a";
  ctx.beginPath();
  ctx.ellipse(90, 74, 40, 16, 0.1, 0, Math.PI * 2);
  ctx.ellipse(176, 80, 30, 12, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#8dbb5c";
  ctx.beginPath();
  ctx.ellipse(84, 70, 24, 8, 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  outline(ctx, torso);
  // Cracks.
  ctx.strokeStyle = alpha(OUTLINE, 0.75);
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(80, 176);
  ctx.lineTo(98, 160);
  ctx.lineTo(94, 140);
  ctx.moveTo(170, 186);
  ctx.lineTo(160, 170);
  ctx.lineTo(174, 158);
  ctx.moveTo(130, 220);
  ctx.lineTo(126, 200);
  ctx.stroke();
  // Brow ridge and glowing eyes.
  ctx.fillStyle = shade(rock, 0.55);
  ctx.beginPath();
  ctx.roundRect(84, 108, 104, 40, 16);
  ctx.fill();
  glow(ctx, 112, 128, 30, "#ffb52e", 0.7);
  glow(ctx, 164, 128, 30, "#ffb52e", 0.7);
  for (const x of [112, 164]) {
    const e = poly([x - 16, 122, x + 16, 120, x + 12, 136, x - 12, 136]);
    ctx.fillStyle = "#ffe066";
    ctx.fill(e);
    outline(ctx, e, 5);
    ctx.fillStyle = "#fffbe6";
    ctx.fillRect(x - 6, 124, 10, 5);
  }
  // A grim mouth.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(116, 172);
  ctx.lineTo(132, 166);
  ctx.lineTo(152, 174);
  ctx.stroke();
};

const paintWraith = (ctx: Ctx, color: string, sway: boolean) => {
  const s = sway ? 1 : -1;
  const p = new Path2D();
  p.moveTo(128, 40);
  p.bezierCurveTo(182, 40, 204, 86, 202, 132);
  p.bezierCurveTo(200, 170, 186, 196, 160 + 18 * s, 214);
  p.bezierCurveTo(146 + 30 * s, 226, 130 + 52 * s, 238, 128 + 64 * s, 226);
  p.bezierCurveTo(118 + 40 * s, 238, 100, 212, 104, 200);
  p.bezierCurveTo(90, 214, 70, 210, 76, 192);
  p.bezierCurveTo(58, 182, 54, 160, 54, 132);
  p.bezierCurveTo(52, 86, 74, 40, 128, 40);
  p.closePath();
  // Faint spectral aura behind.
  glow(ctx, 128, 130, 110, "#b9c6ff", 0.35);
  body(ctx, p, color, {
    hi: [94, 76, 24, 14],
    shadeOffset: [-18, -22],
    shadeAmt: 0.42,
  });
  // Wispy arms.
  for (const side of [-1, 1]) {
    const arm = new Path2D();
    arm.moveTo(128 + side * 66, 120);
    arm.bezierCurveTo(
      128 + side * 104,
      110,
      128 + side * 114,
      130 + 10 * s * side,
      128 + side * 120,
      150 + 8 * s * side
    );
    arm.bezierCurveTo(
      128 + side * 100,
      150,
      128 + side * 86,
      150,
      128 + side * 70,
      156
    );
    arm.closePath();
    body(ctx, arm, shade(color, 0.08), { shadeOffset: [0, -6] });
  }
  // Hollow eyes with cyan glints.
  for (const x of [108, 152]) {
    ctx.fillStyle = OUTLINE;
    ctx.beginPath();
    ctx.ellipse(x, 104, 16, 22, x < 128 ? 0.2 : -0.2, 0, Math.PI * 2);
    ctx.fill();
    glow(ctx, x + 2, 106, 16, "#6ff7ff", 0.9);
    ctx.fillStyle = "#e8ffff";
    ctx.beginPath();
    ctx.arc(x + 3, 106, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  const mouth = ellipse(132, 146, 12, 16);
  ctx.fillStyle = OUTLINE;
  ctx.fill(mouth);
};

// ------------------------------------------------------------------ pickups and shots

const GEM_COLORS = ["#4fd8ff", "#5dea6b", "#ff4f9a"];

const paintGem = (ctx: Ctx, color: string) => {
  const cx = 128;
  const top = 50;
  const mid = 104;
  const bot = 222;
  const w = 74;
  const tw = 40;
  const outer = poly([
    cx - tw,
    top,
    cx + tw,
    top,
    cx + w,
    mid,
    cx,
    bot,
    cx - w,
    mid,
  ]);
  glow(ctx, cx, 130, 120, color, 0.45);
  ctx.fillStyle = color;
  ctx.fill(outer);
  ctx.fillStyle = light(color, 0.55);
  ctx.fill(poly([cx - tw, top, cx + tw, top, cx + 22, mid, cx - 22, mid]));
  ctx.fillStyle = light(color, 0.25);
  ctx.fill(poly([cx - tw, top, cx - 22, mid, cx - w, mid]));
  ctx.fillStyle = shade(color, 0.2);
  ctx.fill(poly([cx + tw, top, cx + w, mid, cx + 22, mid]));
  ctx.fillStyle = shade(color, 0.4);
  ctx.fill(poly([cx + 22, mid, cx + w, mid, cx, bot]));
  ctx.fillStyle = light(color, 0.12);
  ctx.fill(poly([cx - w, mid, cx - 22, mid, cx, bot]));
  ctx.strokeStyle = alpha(OUTLINE, 0.45);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - w, mid);
  ctx.lineTo(cx + w, mid);
  ctx.moveTo(cx - 22, mid);
  ctx.lineTo(cx, bot);
  ctx.lineTo(cx + 22, mid);
  ctx.stroke();
  outline(ctx, outer, 10);
  // Sparkle.
  ctx.fillStyle = "#ffffff";
  const sx = cx - 30;
  const sy = 76;
  ctx.fill(
    poly([
      sx,
      sy - 22,
      sx + 5,
      sy - 5,
      sx + 22,
      sy,
      sx + 5,
      sy + 5,
      sx,
      sy + 22,
      sx - 5,
      sy + 5,
      sx - 22,
      sy,
      sx - 5,
      sy - 5,
    ])
  );
};

const paintBolt = (ctx: Ctx, color: string) => {
  // A comet pointing +x: soft tail, glowing core with an outline, little sparks.
  glow(ctx, 160, 128, 90, color, 0.55);
  const tail = new Path2D();
  tail.moveTo(160, 92);
  tail.bezierCurveTo(110, 96, 60, 112, 14, 128);
  tail.bezierCurveTo(60, 144, 110, 160, 160, 164);
  tail.closePath();
  const g = ctx.createLinearGradient(14, 0, 170, 0);
  g.addColorStop(0, alpha(color, 0));
  g.addColorStop(1, alpha(light(color, 0.3), 0.95));
  ctx.fillStyle = g;
  ctx.fill(tail);
  const core = ellipse(162, 128, 44, 40);
  const rg = ctx.createRadialGradient(170, 118, 4, 162, 128, 44);
  rg.addColorStop(0, "#ffffff");
  rg.addColorStop(0.45, light(color, 0.5));
  rg.addColorStop(1, color);
  ctx.fillStyle = rg;
  ctx.fill(core);
  outline(ctx, core, 10);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(150, 112, 12, 7, -0.5, 0, Math.PI * 2);
  ctx.fill();
  // Zigzag sparks.
  ctx.strokeStyle = alpha(OUTLINE, 0.9);
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(210, 92);
  ctx.lineTo(222, 104);
  ctx.lineTo(216, 110);
  ctx.lineTo(232, 122);
  ctx.moveTo(206, 168);
  ctx.lineTo(224, 160);
  ctx.lineTo(222, 172);
  ctx.lineTo(238, 166);
  ctx.stroke();
};

const paintBubble = (ctx: Ctx, color: string) => {
  const c = ellipse(128, 128, 82, 82);
  const rg = ctx.createRadialGradient(150, 150, 10, 128, 128, 84);
  rg.addColorStop(0, alpha(color, 0.45));
  rg.addColorStop(0.75, alpha(color, 0.7));
  rg.addColorStop(1, alpha(light(color, 0.4), 0.95));
  ctx.fillStyle = rg;
  ctx.fill(c);
  outline(ctx, c, 10);
  ctx.strokeStyle = alpha("#ffffff", 0.95);
  ctx.lineWidth = 12;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(128, 128, 60, Math.PI * 1.05, Math.PI * 1.45);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(170, 168, 9, 0, Math.PI * 2);
  ctx.fill();
};

// ------------------------------------------------------------------ decor

const paintDecor = (ctx: Ctx, kind: number) => {
  switch (kind) {
    case DECOR.tuft: {
      for (const [x, h, lean, c] of [
        [100, 120, -30, "#5aa652"],
        [156, 110, 34, "#5aa652"],
        [128, 150, 4, "#78c45e"],
        [112, 96, -10, "#93d66a"],
        [146, 92, 16, "#93d66a"],
      ] as const) {
        const blade = new Path2D();
        blade.moveTo(x - 14, 232);
        blade.quadraticCurveTo(
          x - 4 + lean * 0.3,
          232 - h * 0.6,
          x + lean,
          232 - h
        );
        blade.quadraticCurveTo(x + 6 + lean * 0.3, 232 - h * 0.5, x + 14, 232);
        blade.closePath();
        body(ctx, blade, c, { shadeOffset: [-5, 0] });
      }
      break;
    }
    case DECOR.flowers: {
      // A leafy mound with three flowers.
      const mound = new Path2D();
      mound.moveTo(46, 232);
      mound.bezierCurveTo(40, 180, 90, 160, 128, 168);
      mound.bezierCurveTo(170, 160, 218, 180, 210, 232);
      mound.closePath();
      body(ctx, mound, "#5fae58", {
        hi: [96, 186, 22, 8],
        shadeOffset: [-10, -12],
      });
      for (const [x, y, rot] of [
        [74, 196, -0.6],
        [182, 196, 0.6],
      ] as const) {
        body(ctx, ellipse(x, y, 30, 13, rot), "#7cc865", {
          shadeOffset: [-4, -4],
        });
      }
      for (const [x, y, c] of [
        [96, 120, "#ffffff"],
        [156, 104, "#ffd84d"],
        [128, 86, "#ff8fb4"],
      ] as const) {
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 4, 200);
        ctx.stroke();
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          const pt = ellipse(
            x + Math.cos(a) * 15,
            y + Math.sin(a) * 15,
            13,
            13
          );
          ctx.fillStyle = c;
          ctx.fill(pt);
          outline(ctx, pt, 5);
        }
        const centre = ellipse(x, y, 9, 9);
        ctx.fillStyle = "#ffb12b";
        ctx.fill(centre);
        outline(ctx, centre, 5);
      }
      break;
    }
    case DECOR.rock: {
      const r = poly([
        50, 230, 64, 170, 112, 130, 170, 136, 206, 180, 214, 230,
      ]);
      body(ctx, r, "#a7a3b5", {
        hi: [100, 160, 24, 10],
        shadeOffset: [-14, -14],
      });
      const r2 = poly([150, 232, 168, 196, 214, 194, 236, 232]);
      body(ctx, r2, "#8f8aa1", { shadeOffset: [-6, -8] });
      break;
    }
    case DECOR.mushroom: {
      for (const [x, s] of [
        [108, 1],
        [168, 0.7],
      ] as const) {
        const stem = poly([
          x - 16 * s,
          232,
          x - 12 * s,
          232 - 70 * s,
          x + 12 * s,
          232 - 70 * s,
          x + 16 * s,
          232,
        ]);
        body(ctx, stem, "#f5ead2", { shadeOffset: [-4, 0] });
        const cap = new Path2D();
        cap.moveTo(x - 56 * s, 232 - 64 * s);
        cap.bezierCurveTo(
          x - 56 * s,
          232 - 140 * s,
          x + 56 * s,
          232 - 140 * s,
          x + 56 * s,
          232 - 64 * s
        );
        cap.closePath();
        body(ctx, cap, "#e8453c", {
          hi: [x - 22 * s, 232 - 108 * s, 14 * s, 8 * s],
        });
        ctx.fillStyle = "#ffffff";
        for (const [dx, dy, r] of [
          [-24, -88, 9],
          [14, -104, 11],
          [32, -78, 7],
        ] as const) {
          ctx.beginPath();
          ctx.arc(x + dx * s, 232 + dy * s, r * s, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case DECOR.bush: {
      const p = new Path2D();
      p.moveTo(36, 230);
      p.bezierCurveTo(14, 200, 40, 150, 76, 160);
      p.bezierCurveTo(80, 104, 160, 96, 172, 148);
      p.bezierCurveTo(214, 140, 240, 196, 216, 230);
      p.closePath();
      body(ctx, p, "#4f9a52", {
        hi: [96, 136, 26, 12],
        shadeOffset: [-16, -18],
      });
      for (const [x, y] of [
        [92, 180],
        [140, 160],
        [180, 196],
        [118, 208],
      ] as const) {
        const b = ellipse(x, y, 9, 9);
        ctx.fillStyle = "#ff4f6d";
        ctx.fill(b);
        outline(ctx, b, 4);
      }
      break;
    }
    case DECOR.stone: {
      // A mossy standing stone with a glowing rune: the arena's edge markers.
      const p = poly([78, 234, 70, 90, 96, 30, 158, 26, 186, 80, 180, 234]);
      body(ctx, p, "#8c8aa6", {
        hi: [104, 70, 18, 30],
        shadeOffset: [-20, -10],
      });
      ctx.save();
      ctx.clip(p);
      ctx.fillStyle = "#6f9a4a";
      ctx.beginPath();
      ctx.ellipse(120, 30, 60, 22, 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#5c8c3c";
      ctx.beginPath();
      ctx.ellipse(110, 234, 80, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      outline(ctx, p);
      glow(ctx, 128, 140, 40, "#7cf3ff", 0.6);
      ctx.strokeStyle = "#c9fbff";
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(128, 108);
      ctx.lineTo(128, 172);
      ctx.moveTo(112, 124);
      ctx.lineTo(144, 152);
      ctx.moveTo(144, 124);
      ctx.lineTo(112, 152);
      ctx.stroke();
      break;
    }
    case DECOR.stump: {
      const side = poly([60, 230, 66, 130, 190, 130, 196, 230]);
      body(ctx, side, "#9a6a43", { shadeOffset: [-14, 0] });
      const top = ellipse(128, 130, 62, 24);
      ctx.fillStyle = "#e3c08a";
      ctx.fill(top);
      ctx.strokeStyle = "#b58a58";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.ellipse(128, 130, 36, 13, 0, 0, Math.PI * 2);
      ctx.ellipse(128, 130, 14, 5, 0, 0, Math.PI * 2);
      ctx.stroke();
      outline(ctx, top, 9);
      break;
    }
    default:
      break;
  }
};

// ------------------------------------------------------------------ the sheet

const cellCtx = (ctx: Ctx, cell: number) => {
  ctx.setTransform(
    1,
    0,
    0,
    1,
    (cell % COLS) * CELL,
    Math.floor(cell / COLS) * CELL
  );
};

/** Paints (or repaints) the whole sheet for some content. */
export const paintSheet = (
  canvas: HTMLCanvasElement,
  spec: SheetSpec
): SheetLayout => {
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, SHEET, SHEET);
  let next = 0;
  const take = (n: number) => {
    const c = next;
    next += n;
    return c;
  };
  const layout: SheetLayout = {
    hero: [],
    enemy: [],
    shot: [],
    gem: 0,
    decor: 0,
  };
  for (const h of spec.heroes.slice(0, 8)) {
    const c = take(2);
    layout.hero.push(c);
    cellCtx(ctx, c);
    paintHero(ctx, h.id, h.color, false);
    cellCtx(ctx, c + 1);
    paintHero(ctx, h.id, h.color, true);
  }
  for (const e of spec.enemies.slice(0, 8)) {
    const c = take(2);
    layout.enemy.push(c);
    for (let f = 0; f < 2; f++) {
      cellCtx(ctx, c + f);
      if (e.id === "bat") {
        paintBat(ctx, e.color, f === 0);
      } else if (e.id === "golem") {
        paintGolem(ctx, e.color, f === 1);
      } else if (e.id === "wraith") {
        paintWraith(ctx, e.color, f === 1);
      } else {
        paintSlime(ctx, e.color, f === 1);
      }
    }
  }
  for (const w of spec.weapons.slice(0, 8)) {
    const c = take(1);
    layout.shot.push(c);
    cellCtx(ctx, c);
    if (w.id.includes("bubble")) {
      paintBubble(ctx, w.color);
    } else {
      paintBolt(ctx, w.color);
    }
  }
  (layout as { gem: number }).gem = take(GEM_COLORS.length);
  GEM_COLORS.forEach((color, k) => {
    cellCtx(ctx, layout.gem + k);
    paintGem(ctx, color);
  });
  (layout as { decor: number }).decor = take(DECOR_COUNT);
  for (let k = 0; k < DECOR_COUNT; k++) {
    cellCtx(ctx, layout.decor + k);
    paintDecor(ctx, k);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return layout;
};

// ------------------------------------------------------------------ the ground tile

/** A small seeded random, so the ground is the same every load. */
export const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const GROUND_TILE = 1024;
export const GROUND_BASE = "#5f8f5a";

/** A tileable meadow: soft colour blobs, grass strokes, flowers and pebbles. */
export const paintGroundTile = (canvas: HTMLCanvasElement) => {
  const S = GROUND_TILE;
  const ctx = canvas.getContext("2d")!;
  const r = rng(7);
  ctx.fillStyle = GROUND_BASE;
  ctx.fillRect(0, 0, S, S);
  const wrapped = (
    draw: (x: number, y: number) => void,
    x: number,
    y: number
  ) => {
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        draw(x + ox, y + oy);
      }
    }
  };
  // Soft blobs of lighter and darker green.
  for (let i = 0; i < 260; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = 30 + r() * 110;
    const c = r() < 0.5 ? "#7aa865" : r() < 0.5 ? "#4d7c50" : "#86ad62";
    wrapped(
      (px, py) => {
        const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
        g.addColorStop(0, alpha(c, 0.32));
        g.addColorStop(1, alpha(c, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fill();
      },
      x,
      y
    );
  }
  // Grass strokes: little three-blade tufts.
  ctx.lineCap = "round";
  for (let i = 0; i < 300; i++) {
    const x = r() * S;
    const y = r() * S;
    const dark = r() < 0.6;
    const sz = 8 + r() * 10;
    wrapped(
      (px, py) => {
        ctx.strokeStyle = dark ? "#43704a" : "#8fbd6c";
        ctx.lineWidth = dark ? 4.5 : 3.5;
        ctx.beginPath();
        ctx.moveTo(px - sz * 0.6, py - sz * 0.9);
        ctx.quadraticCurveTo(px - sz * 0.2, py - sz * 0.2, px, py);
        ctx.quadraticCurveTo(
          px + sz * 0.1,
          py - sz * 0.6,
          px + sz * 0.1,
          py - sz * 1.2
        );
        ctx.moveTo(px, py);
        ctx.quadraticCurveTo(
          px + sz * 0.3,
          py - sz * 0.3,
          px + sz * 0.7,
          py - sz * 0.8
        );
        ctx.stroke();
      },
      x,
      y
    );
  }
  // Pebbles.
  for (let i = 0; i < 14; i++) {
    const x = r() * S;
    const y = r() * S;
    const rx = 6 + r() * 9;
    const ry = rx * (0.6 + r() * 0.3);
    wrapped(
      (px, py) => {
        ctx.fillStyle = "#a9a59a";
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#c8c4b8";
        ctx.beginPath();
        ctx.ellipse(
          px - rx * 0.25,
          py - ry * 0.3,
          rx * 0.5,
          ry * 0.4,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
        ctx.strokeStyle = alpha(OUTLINE, 0.55);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      },
      x,
      y
    );
  }
  // Tiny flowers.
  for (let i = 0; i < 26; i++) {
    const x = r() * S;
    const y = r() * S;
    const c = ["#ffffff", "#ffe066", "#ffb3cf", "#c8b6ff"][
      Math.floor(r() * 4)
    ]!;
    wrapped(
      (px, py) => {
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(
            px + Math.cos(a) * 5,
            py + Math.sin(a) * 5,
            4.2,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
        ctx.fillStyle = "#ff9f1c";
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      },
      x,
      y
    );
  }
};
