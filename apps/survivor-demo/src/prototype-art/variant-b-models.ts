// PROTOTYPE (#24 art), variant B: low-poly models built in code. Every model is merged into one
// non-indexed BufferGeometry with per-vertex color plus three custom attributes the shader reads:
// aGlow (self-lit amount), aWing (bat wing flap weight) and aSway (wraith tail sway weight).
import * as THREE from "three";

export const rng = (start: number) => {
  let seed = start;
  return () => {
    seed = Math.trunc(seed + 0x6d_2b_79_f5) % 4_294_967_296;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

/** Position, XYZ rotation and scale as one matrix (build time only). */
export const tf = (
  x = 0,
  y = 0,
  z = 0,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx
) =>
  new THREE.Matrix4().compose(
    tmpPos.set(x, y, z),
    tmpQuat.setFromEuler(tmpEuler.set(rx, ry, rz)),
    tmpScale.set(sx, sy, sz)
  );

interface PartOptions {
  glow?: number;
  wing?: number;
  /** Sway weight from the vertex's model-space position. */
  sway?: (p: THREE.Vector3) => number;
  /** Per-face brightness jitter, 0..1. */
  jitter?: number;
  /** Darken toward the bottom: [yLow, yHigh, factorLow]. */
  gradient?: readonly [number, number, number];
  /** Bends the color toward `tint` by a weight from the position. */
  tint?: { color: string; weight: (p: THREE.Vector3) => number };
  /** Moves each vertex (in the part's own space, before the transform). */
  deform?: (p: THREE.Vector3) => void;
}

export class ModelBuilder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly glow: number[] = [];
  private readonly wing: number[] = [];
  private readonly sway: number[] = [];
  private readonly random = rng(7);

  add(
    source: THREE.BufferGeometry,
    color: string | THREE.Color,
    matrix: THREE.Matrix4 = new THREE.Matrix4(),
    o: PartOptions = {}
  ): this {
    const geo = source.index ? source.toNonIndexed() : source.clone();
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    if (o.deform) {
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        o.deform(v);
        p.setXYZ(i, v.x, v.y, v.z);
      }
    }
    geo.applyMatrix4(matrix);
    const base = new THREE.Color(color);
    const tint = o.tint ? new THREE.Color(o.tint.color) : null;
    const c = new THREE.Color();
    let face = 1;
    for (let i = 0; i < p.count; i++) {
      if (i % 3 === 0) {
        face = 1 + (this.random() - 0.5) * 2 * (o.jitter ?? 0.06);
      }
      v.fromBufferAttribute(p, i);
      this.pos.push(v.x, v.y, v.z);
      c.copy(base);
      if (tint && o.tint) {
        c.lerp(tint, THREE.MathUtils.clamp(o.tint.weight(v), 0, 1));
      }
      let k = face;
      if (o.gradient) {
        const [y0, y1, low] = o.gradient;
        const t = THREE.MathUtils.clamp((v.y - y0) / (y1 - y0), 0, 1);
        k *= low + (1 - low) * t;
      }
      this.col.push(c.r * k, c.g * k, c.b * k);
      this.glow.push(o.glow ?? 0);
      this.wing.push(o.wing ?? 0);
      this.sway.push(o.sway ? o.sway(v) : 0);
    }
    geo.dispose();
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aGlow", new THREE.Float32BufferAttribute(this.glow, 1));
    g.setAttribute("aWing", new THREE.Float32BufferAttribute(this.wing, 1));
    g.setAttribute("aSway", new THREE.Float32BufferAttribute(this.sway, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const shade = (hex: string, k: number) => {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return c;
};

const ico = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);
const dodeca = (r: number) => new THREE.DodecahedronGeometry(r, 0);
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const cone = (r: number, h: number, seg = 5) =>
  new THREE.ConeGeometry(r, h, seg);
/** A cone without its base, for shapes whose base is never seen (grass, tree tiers). */
const spike = (r: number, h: number, seg = 5) =>
  new THREE.ConeGeometry(r, h, seg, 1, true);
const cyl = (rt: number, rb: number, h: number, seg = 6) =>
  new THREE.CylinderGeometry(rt, rb, h, seg);

// ---------------------------------------------------------------- enemies (unit radius)

/** A squashy faceted blob with big eyes; its base sits on y = 0. */
export const slimeGeometry = (color: string) => {
  const m = new ModelBuilder();
  const top = 1.55;
  m.add(ico(1, 1), color, tf(0, 0.36 * 0.9, 0, 0, 0.3, 0, 1.05, 0.9, 1.05), {
    deform: (p) => {
      p.y = Math.max(p.y, -0.4);
    },
    gradient: [0, top, 0.55],
    jitter: 0.08,
  });
  // A glossy highlight on the crown.
  m.add(
    ico(0.26),
    shade(color, 1).lerp(new THREE.Color("#ffffff"), 0.55),
    tf(-0.32, 1.15, 0.2, 0, 0, 0, 1, 0.45, 1),
    {
      glow: 0.25,
    }
  );
  for (const s of [-1, 1]) {
    m.add(
      ico(0.23, 0),
      "#ffffff",
      tf(s * 0.34, 0.82, 0.74, 0, 0, 0, 1, 1.15, 0.8),
      { glow: 0.2 }
    );
    m.add(ico(0.12), "#15121c", tf(s * 0.31, 0.82, 0.92));
  }
  m.add(box(0.26, 0.06, 0.08), shade(color, 0.35), tf(0, 0.55, 0.93));
  return m.build();
};

/** Body, head with ears and glowing eyes, and membrane wings hinged at the origin. */
export const batGeometry = (color: string) => {
  const m = new ModelBuilder();
  const dark = shade(color, 0.55);
  m.add(ico(0.5, 0), dark, tf(0, -0.05, -0.05, 0.3, 0, 0, 0.9, 1, 1.15), {
    jitter: 0.1,
  });
  m.add(ico(0.36, 0), shade(color, 0.7), tf(0, 0.25, 0.42));
  for (const s of [-1, 1]) {
    m.add(cone(0.14, 0.42, 4), dark, tf(s * 0.19, 0.62, 0.36, 0, 0, -s * 0.35));
    m.add(
      box(0.11, 0.08, 0.06),
      "#ffd34d",
      tf(s * 0.13, 0.32, 0.74, 0, s * 0.25, 0),
      { glow: 1.6 }
    );
    m.add(
      cone(0.035, 0.14, 3),
      "#ffffff",
      tf(s * 0.07, 0.08, 0.72, Math.PI, 0, 0)
    );
    // Little feet.
    m.add(cone(0.06, 0.2, 3), dark, tf(s * 0.15, -0.5, -0.1, Math.PI, 0, 0));
  }
  // Wings: a scalloped membrane, then a darker leading-edge bone. Right side, mirrored.
  const outline: [number, number][] = [
    [0.25, 0.3],
    [0.9, 0.55],
    [1.75, 0.45],
    [1.55, -0.2],
    [1.25, -0.05],
    [1, -0.55],
    [0.7, -0.25],
    [0.42, -0.55],
    [0.25, -0.3],
  ];
  for (const s of [-1, 1]) {
    const pts: number[] = [];
    const root = outline[0]!;
    for (let i = 1; i < outline.length - 1; i++) {
      const a = outline[i]!;
      const b = outline[i + 1]!;
      for (const [x, z] of [root, a, b]) {
        // A slight upward dihedral toward the tip.
        pts.push(s * x, x * 0.08, z);
      }
    }
    const wing = new THREE.BufferGeometry();
    wing.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    m.add(wing, shade(color, 1.05), undefined, {
      wing: 1,
      jitter: 0.12,
      tint: {
        color: shade(color, 0.6).getStyle(),
        weight: (p) => (Math.abs(p.x) - 0.3) / 1.4,
      },
    });
    m.add(
      box(1.6, 0.06, 0.07),
      dark,
      tf(s * 1, 0.1, 0.48, 0, s * 0.03, s * 0.06),
      { wing: 1 }
    );
  }
  return m.build();
};

/** A blocky rock man with glowing cracks, mossy shoulders and heavy fists. */
export const golemGeometry = (color: string) => {
  const m = new ModelBuilder();
  const dark = shade(color, 0.62);
  const moss = "#6f9b47";
  const ember = "#ff9a3c";
  const rock = { jitter: 0.16, gradient: [0, 2.3, 0.6] as const };
  for (const s of [-1, 1]) {
    m.add(
      box(0.44, 0.62, 0.48),
      dark,
      tf(s * 0.33, 0.31, 0, 0, s * 0.1, 0),
      rock
    );
    m.add(
      dodeca(0.44),
      color,
      tf(s * 0.9, 1.62, -0.02, 0.3, s * 0.4, 0, 1, 0.85, 1),
      rock
    );
    m.add(
      dodeca(0.3),
      moss,
      tf(s * 0.92, 1.92, -0.05, 0, 0, 0, 1.05, 0.35, 1.05),
      { jitter: 0.2 }
    );
    m.add(
      box(0.36, 0.78, 0.38),
      color,
      tf(s * 1, 1.05, 0.06, 0.15, 0, s * 0.08),
      rock
    );
    m.add(dodeca(0.34), dark, tf(s * 1.02, 0.55, 0.2, 0.4, 0.3, 0), rock);
    m.add(box(0.1, 0.07, 0.05), ember, tf(s * 0.13, 2.03, 0.47), { glow: 2 });
  }
  m.add(
    dodeca(0.78),
    color,
    tf(0, 1.25, 0, 0.2, 0.5, 0.1, 1.2, 0.95, 0.85),
    rock
  );
  m.add(dodeca(0.36), color, tf(0, 2, 0.2, 0.3, 0.2, 0, 1.05, 0.85, 1), rock);
  m.add(dodeca(0.22), moss, tf(-0.05, 2.24, 0.12, 0, 0, 0, 1.3, 0.4, 1.2), {
    jitter: 0.2,
  });
  // Glowing cracks on the chest.
  m.add(box(0.08, 0.5, 0.05), ember, tf(0.05, 1.3, 0.66, 0, 0, 0.35), {
    glow: 1.6,
  });
  m.add(box(0.06, 0.3, 0.05), ember, tf(-0.14, 1.12, 0.64, 0, 0, -0.6), {
    glow: 1.6,
  });
  return m.build();
};

const sway = (p: THREE.Vector3) => THREE.MathUtils.clamp(1 - p.y / 1.4, 0, 1);

/** A floating hooded ghost that tapers to a ragged tip; the tail sways in the shader. */
export const wraithGeometry = (color: string) => {
  const m = new ModelBuilder();
  const r = rng(11);
  const robe = [
    [0.02, 0],
    [0.22, 0.3],
    [0.42, 0.75],
    [0.54, 1.2],
    [0.5, 1.6],
    [0.3, 1.8],
    [0, 1.85],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const deep = "#3b3f9a";
  m.add(new THREE.LatheGeometry(robe, 7), color, tf(0, 0, 0, 0, 0.2, 0), {
    deform: (p) => {
      if (p.y < 1) {
        const k = 1 + (r() - 0.5) * 0.6 * (1 - p.y);
        p.x *= k;
        p.z *= k;
      }
    },
    glow: 0.18,
    sway,
    jitter: 0.1,
    tint: { color: deep, weight: (p) => (1.3 - p.y) / 1.1 },
  });
  // A tattered mantle over the shoulders.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.2;
    m.add(
      cone(0.2, 0.7, 4),
      shade(color, 0.72),
      tf(
        Math.sin(a) * 0.5,
        1.4,
        Math.cos(a) * 0.5,
        Math.PI + Math.cos(a) * 0.35,
        0,
        -Math.sin(a) * 0.35
      ),
      {
        glow: 0.12,
        tint: { color: deep, weight: (p) => (1.4 - p.y) * 1.2 },
        sway: () => 0.15,
      }
    );
  }
  // The hood, peaked and swept back, open at the front.
  const hood = [
    [0, -0.05],
    [0.4, 0.05],
    [0.46, 0.3],
    [0.36, 0.55],
    [0.12, 0.78],
    [0, 0.82],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  m.add(
    new THREE.LatheGeometry(hood, 7),
    shade(color, 0.92),
    tf(0, 1.65, -0.04),
    {
      glow: 0.14,
      deform: (p) => {
        // Pull the crown back into a peak.
        p.z -= Math.max(0, p.y - 0.3) * 0.7;
      },
    }
  );
  // The dark face inside the hood and its eyes.
  m.add(ico(0.3, 1), "#0b0a16", tf(0, 1.93, 0.2, -0.2, 0, 0, 0.95, 1, 0.75));
  for (const s of [-1, 1]) {
    m.add(
      ico(0.075, 0),
      "#8ff2ff",
      tf(s * 0.11, 1.95, 0.42, 0, 0, 0, 1, 0.7, 1),
      { glow: 2.6 }
    );
    // Sleeves reaching forward, with bony hands.
    m.add(
      cone(0.17, 0.75, 5),
      shade(color, 0.85),
      tf(s * 0.48, 1.35, 0.3, -Math.PI / 2 - 0.5, 0, s * 0.25),
      {
        glow: 0.14,
        sway: () => 0.25,
      }
    );
    m.add(ico(0.08), "#c9c3d9", tf(s * 0.55, 1.12, 0.68), {
      glow: 0.2,
      sway: () => 0.25,
    });
  }
  return m.build();
};

// ---------------------------------------------------------------- heroes

export interface HeroParts {
  body: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  cape: THREE.BufferGeometry;
  hand: THREE.BufferGeometry;
}

/** A small adventurer in the hero's colour; spark wears a wizard hat, ember a horned helm, tide a hood. */
export const heroGeometry = (
  id: string,
  color: string,
  weaponColor: string
): HeroParts => {
  const skin = "#f1c7a0";
  const darkTint = shade(color, 0.6);
  const body = new ModelBuilder();
  body.add(cyl(0.24, 0.34, 0.52, 7), color, tf(0, 0.62, 0), {
    gradient: [0.36, 0.9, 0.75],
  });
  body.add(cyl(0.31, 0.33, 0.08, 7), "#5a3a24", tf(0, 0.44, 0));
  body.add(box(0.1, 0.08, 0.05), "#ffd56a", tf(0, 0.44, 0.31), { glow: 0.3 });
  body.add(cyl(0.27, 0.27, 0.08, 7), darkTint, tf(0, 0.86, 0));
  // Head and face.
  body.add(ico(0.25, 1), skin, tf(0, 1.1, 0.02));
  for (const s of [-1, 1]) {
    body.add(box(0.05, 0.09, 0.03), "#1f1a26", tf(s * 0.085, 1.12, 0.255));
    body.add(box(0.06, 0.03, 0.02), "#f39a8a", tf(s * 0.15, 1.04, 0.22), {
      glow: 0.1,
    });
    // Shoulders.
    body.add(ico(0.12, 0), darkTint, tf(s * 0.29, 0.84, 0));
  }
  if (id === "spark") {
    body.add(cyl(0.44, 0.44, 0.05, 8), darkTint, tf(0, 1.27, 0));
    body.add(cone(0.3, 0.62, 7), color, tf(0, 1.58, -0.05, -0.28, 0, 0.12), {
      gradient: [1.3, 1.9, 0.7],
    });
    body.add(cyl(0.3, 0.31, 0.07, 7), "#3b2b55", tf(0, 1.32, -0.01));
    body.add(ico(0.06), "#fff6b0", tf(0.1, 1.9, -0.22), { glow: 1.4 });
    // Hair tufts under the brim.
    body.add(ico(0.12), "#7a4b2a", tf(0, 1.18, -0.16));
  } else if (id === "ember") {
    body.add(cyl(0.22, 0.29, 0.26, 7), "#b9bdc9", tf(0, 1.26, -0.01), {
      jitter: 0.12,
    });
    body.add(box(0.06, 0.2, 0.06), "#b9bdc9", tf(0, 1.15, 0.28));
    body.add(box(0.1, 0.16, 0.42), color, tf(0, 1.48, -0.06), { glow: 0.15 });
    for (const s of [-1, 1]) {
      body.add(
        cone(0.07, 0.3, 5),
        "#f4e6c8",
        tf(s * 0.3, 1.36, 0, 0, 0, -s * 1)
      );
      body.add(ico(0.15), "#b9bdc9", tf(s * 0.31, 0.88, 0), { jitter: 0.1 });
    }
  } else {
    body.add(
      ico(0.32, 1),
      darkTint,
      tf(0, 1.15, -0.07, 0, 0, 0, 1, 1.05, 1.05),
      {
        deform: (p) => {
          if (p.z > 0.12) {
            p.z = 0.12 + (p.z - 0.12) * 0.2;
          }
        },
      }
    );
    body.add(cone(0.12, 0.3, 5), darkTint, tf(0, 1.32, -0.3, -1.2, 0, 0));
  }
  const leg = new ModelBuilder()
    .add(box(0.15, 0.3, 0.17), "#3d3550", tf(0, -0.15, 0))
    .add(box(0.17, 0.12, 0.24), "#2a2130", tf(0, -0.32, 0.03))
    .build();
  const cape = new ModelBuilder()
    .add(box(0.5, 0.62, 0.04), darkTint, tf(0, -0.31, 0, 0, 0, 0), {
      deform: (p) => {
        if (p.y < 0) {
          p.x *= 1.25;
        }
      },
      gradient: [-0.62, 0, 0.7],
    })
    .build();
  const hand = new ModelBuilder().add(ico(0.08), skin, tf(0, 0, 0));
  if (id === "ember") {
    hand.add(box(0.07, 0.07, 0.24), "#5a3a24", tf(0, 0, 0.1));
    hand.add(box(0.2, 0.05, 0.08), "#c9a24a", tf(0, 0, 0.22));
    hand.add(box(0.06, 0.04, 0.72), "#dfe4ee", tf(0, 0, 0.6), { glow: 0.15 });
  } else {
    hand.add(cyl(0.03, 0.03, 1.15, 5), "#6b4a2c", tf(0, 0.12, 0));
    hand.add(ico(0.12, 0), weaponColor, tf(0, 0.76, 0), { glow: 1.6 });
    hand.add(cone(0.05, 0.18, 4), "#6b4a2c", tf(0.06, 0.66, 0, 0, 0, -0.5));
  }
  return { body: body.build(), leg, cape, hand: hand.build() };
};

// ---------------------------------------------------------------- props

export const gemGeometry = () => {
  const g = new THREE.OctahedronGeometry(0.2, 0).toNonIndexed();
  g.scale(0.85, 1.5, 0.85);
  g.computeVertexNormals();
  return g;
};

export const pineGeometry = () =>
  new ModelBuilder()
    .add(cyl(0.12, 0.18, 0.8, 5), "#5b3e2a", tf(0, 0.4, 0))
    .add(spike(1.1, 1.4, 6), "#2f6b45", tf(0, 1.3, 0), {
      gradient: [0.6, 2, 0.65],
      jitter: 0.1,
    })
    .add(spike(0.85, 1.2, 6), "#3a7d4f", tf(0, 2, 0, 0, 0.5, 0), {
      gradient: [1.4, 2.6, 0.7],
      jitter: 0.1,
    })
    .add(spike(0.55, 1, 6), "#4a9159", tf(0, 2.7, 0, 0, 1, 0), {
      gradient: [2.2, 3.2, 0.75],
      jitter: 0.1,
    })
    .build();

export const rockGeometry = () =>
  new ModelBuilder()
    .add(dodeca(0.6), "#8d8a86", tf(0, 0.25, 0, 0.3, 0.4, 0.1, 1.1, 0.7, 0.9), {
      jitter: 0.16,
      gradient: [-0.1, 0.7, 0.6],
    })
    .add(dodeca(0.32), "#7f7c78", tf(0.5, 0.12, 0.2, 0.5, 0.2, 0, 1, 0.7, 1), {
      jitter: 0.16,
    })
    .build();

export const tuftGeometry = () => {
  const m = new ModelBuilder();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    m.add(
      spike(0.06, 0.42 + (i % 2) * 0.16, 3),
      i % 2 ? "#8e9a52" : "#6f8243",
      tf(
        Math.cos(a) * 0.08,
        0.2,
        Math.sin(a) * 0.08,
        Math.sin(a) * 0.35,
        0,
        -Math.cos(a) * 0.35
      ),
      {
        gradient: [0, 0.5, 0.55],
      }
    );
  }
  return m.build();
};

export const flowerGeometry = () =>
  new ModelBuilder()
    .add(cyl(0.015, 0.015, 0.3, 3), "#4f8a3a", tf(0, 0.15, 0))
    .add(ico(0.09, 0), "#ffffff", tf(0, 0.32, 0, 0, 0, 0, 1, 0.6, 1), {
      glow: 0.15,
    })
    .add(ico(0.04, 0), "#ffd23f", tf(0, 0.36, 0), { glow: 0.3 })
    .build();
