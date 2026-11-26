/**
 * Whether two shapes touch, and every pair of entities of two queries whose
 * shapes touch.
 *
 *   const Bullets = Query.all(Transform2d.Position, Overlap.Circle, Bullet)
 *   const Enemies = Query.all(Transform2d.Position, Overlap.Circle, Enemy)
 *
 *   Overlap.pairs(commands, yield* Bullets, yield* Enemies, (bullet, enemy) => {
 *     ...
 *     return "first"                      // despawns the bullet
 *   })
 *
 *   Overlap.circles(ax, ay, 1, bx, by, 2)  // true when they touch
 *
 * A shape is a component beside `Transform2d.Position`: `Overlap.Circle`, a
 * radius, or `Overlap.Box`, a half width and a half height, centred on the
 * position. Shapes are in the game's units and ignore `Transform2d.Rotation`
 * and `Transform2d.Scale`, so a box always has its sides along the axes.
 *
 * Shapes touch when they share a point, so two circles whose edges meet
 * touch. The tests are plain functions that allocate nothing, and take no
 * square root, so they belong inside a loop of the tick and give the same
 * answer on every machine.
 */
import { Component, Field } from "./ecs/component.ts";
import type { ComponentDef, Entity } from "./ecs/component.ts";
import type { QueryView } from "./ecs/query.ts";
import { Position } from "./Transform2d.ts";

/**
 * A circle centred on the entity's `Transform2d.Position`, of `radius` in the
 * game's units.
 *
 * @category Components
 */
export const Circle = Component.define("arcadekit/Overlap.Circle", {
  radius: Field.f32,
});

/**
 * A box centred on the entity's `Transform2d.Position`, with its sides along
 * the axes, `halfWidth` either side of it and `halfHeight` above and below.
 *
 * @category Components
 */
export const Box = Component.define("arcadekit/Overlap.Box", {
  halfWidth: Field.f32,
  halfHeight: Field.f32,
});

/**
 * Returns whether two circles touch, given their centres and radii.
 *
 * @category Utilities
 */
export const circles = (
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number
): boolean => {
  const dx = bx - ax;
  const dy = by - ay;
  const reach = ar + br;
  return dx * dx + dy * dy <= reach * reach;
};

/**
 * Returns whether two boxes touch, given their centres and their half widths
 * and half heights.
 *
 * @category Utilities
 */
export const boxes = (
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number
): boolean => Math.abs(bx - ax) <= aw + bw && Math.abs(by - ay) <= ah + bh;

/**
 * Returns whether a circle and a box touch, given the circle's centre and
 * radius, then the box's centre, half width and half height.
 *
 * @category Utilities
 */
export const circleBox = (
  cx: number,
  cy: number,
  r: number,
  bx: number,
  by: number,
  bw: number,
  bh: number
): boolean => {
  // The point of the box nearest the circle's centre.
  const dx = Math.max(Math.abs(cx - bx) - bw, 0);
  const dy = Math.max(Math.abs(cy - by) - bh, 0);
  return dx * dx + dy * dy <= r * r;
};

/**
 * What a pair's callback says to despawn: the entity of the first query, of
 * the second, both, or neither.
 *
 * @category Models
 */
export type Despawn = "first" | "second" | "both" | "neither";

/**
 * The terms of a query `Overlap.pairs` takes: `Transform2d.Position`, then
 * `Overlap.Circle` or `Overlap.Box`, then any others.
 *
 * @category Type-level
 */
export type Shaped = readonly [
  typeof Position,
  typeof Circle | typeof Box,
  ...ComponentDef[],
];

/** One query's entities, read once per call into columns that are kept. */
interface Side {
  count: number;
  x: Float64Array;
  y: Float64Array;
  /** The radius of a circle, or the half width of a box. */
  w: Float64Array;
  /** The half height of a box. */
  h: Float64Array;
  spent: Uint8Array;
  ids: Entity[];
  circle: boolean;
}

const side = (): Side => ({
  count: 0,
  x: new Float64Array(64),
  y: new Float64Array(64),
  w: new Float64Array(64),
  h: new Float64Array(64),
  spent: new Uint8Array(64),
  ids: [],
  circle: true,
});

const first = side();
const second = side();
let filling = first;
let busy = false;

const grow = (into: Side): void => {
  const size = into.x.length * 2;
  const copy = (old: Float64Array): Float64Array => {
    const next = new Float64Array(size);
    next.set(old);
    return next;
  };
  into.x = copy(into.x);
  into.y = copy(into.y);
  into.w = copy(into.w);
  into.h = copy(into.h);
  into.spent = new Uint8Array(size);
};

interface Placed {
  readonly x: number;
  readonly y: number;
}
interface Shape {
  readonly radius?: number;
  readonly halfWidth?: number;
  readonly halfHeight?: number;
}

const put = (position: Placed, shape: Shape): void => {
  const into = filling;
  const i = into.count;
  if (i === into.x.length) {
    grow(into);
  }
  into.x[i] = position.x;
  into.y[i] = position.y;
  if (into.circle) {
    into.w[i] = shape.radius ?? 0;
  } else {
    into.w[i] = shape.halfWidth ?? 0;
    into.h[i] = shape.halfHeight ?? 0;
  }
  into.spent[i] = 0;
  into.count = i + 1;
};

/** What `each` hands `put`: the two terms it reads, then whatever follows. */
const read: (position: Placed, shape: Shape, ...rest: unknown[]) => void = put;

const gather = (view: QueryView<Shaped>, into: Side): void => {
  const { spec } = view;
  const [placed, shape] = spec.terms;
  // A query of ComponentDefs, whose names the compiler doesn't know, gets
  // here with other terms.
  if (placed !== Position || (shape !== Circle && shape !== Box)) {
    throw new Error(
      `Overlap.pairs was given a query of ${spec.terms.map((term) => `"${term.name}"`).join(", ")}. It reads where an entity is from its first term, Transform2d.Position, and its shape from the second, Overlap.Circle or Overlap.Box.`
    );
  }
  if (spec.maybeDefs?.includes(shape) === true) {
    throw new Error(
      `Overlap.pairs was given a query where "${shape.name}" is a Query.maybe term. Every entity it pairs has a shape: make it a term the entity has.`
    );
  }
  if ((spec.changedDefs?.length ?? 0) + (spec.addedDefs?.length ?? 0) > 0) {
    throw new Error(
      "Overlap.pairs was given a change query, which would visit only what changed. Give it a query of every entity with a shape, and filter in the callback."
    );
  }
  into.count = 0;
  into.circle = shape === Circle;
  into.ids = view.entities();
  filling = into;
  view.each(read);
};

let despawning: { readonly despawn: (entity: Entity) => void } = {
  despawn: () => {},
};
let calling: (first: Entity, second: Entity) => Despawn = () => "neither";

/**
 * Hands a pair that touches to the callback and despawns what it says, and
 * returns whether the entity of the first query is spent.
 */
const meet = (i: number, j: number): boolean => {
  const a = first.ids[i]!;
  const b = second.ids[j]!;
  if (a === b) {
    return false;
  }
  const despawn = calling(a, b);
  if (despawn === "second" || despawn === "both") {
    second.spent[j] = 1;
    despawning.despawn(b);
  }
  if (despawn === "first" || despawn === "both") {
    despawning.despawn(a);
    return true;
  }
  return false;
};

// One loop for each two kinds of shape, so that each calls one test: an
// engine learns a loop by its place in the source, and one loop that chose
// its test per pair measured six times slower.
const circlesWithCircles = (): void => {
  const { x: ax, y: ay, w: ar, count: n } = first;
  const { x: bx, y: by, w: br, spent, count: m } = second;
  for (let i = 0; i < n; i++) {
    const x = ax[i]!;
    const y = ay[i]!;
    const r = ar[i]!;
    for (let j = 0; j < m; j++) {
      if (
        circles(x, y, r, bx[j]!, by[j]!, br[j]!) &&
        spent[j] === 0 &&
        meet(i, j)
      ) {
        break;
      }
    }
  }
};

const circlesWithBoxes = (): void => {
  const { x: ax, y: ay, w: ar, count: n } = first;
  const { x: bx, y: by, w: bw, h: bh, spent, count: m } = second;
  for (let i = 0; i < n; i++) {
    const x = ax[i]!;
    const y = ay[i]!;
    const r = ar[i]!;
    for (let j = 0; j < m; j++) {
      if (
        circleBox(x, y, r, bx[j]!, by[j]!, bw[j]!, bh[j]!) &&
        spent[j] === 0 &&
        meet(i, j)
      ) {
        break;
      }
    }
  }
};

const boxesWithCircles = (): void => {
  const { x: ax, y: ay, w: aw, h: ah, count: n } = first;
  const { x: bx, y: by, w: br, spent, count: m } = second;
  for (let i = 0; i < n; i++) {
    const x = ax[i]!;
    const y = ay[i]!;
    const w = aw[i]!;
    const h = ah[i]!;
    for (let j = 0; j < m; j++) {
      if (
        circleBox(bx[j]!, by[j]!, br[j]!, x, y, w, h) &&
        spent[j] === 0 &&
        meet(i, j)
      ) {
        break;
      }
    }
  }
};

const boxesWithBoxes = (): void => {
  const { x: ax, y: ay, w: aw, h: ah, count: n } = first;
  const { x: bx, y: by, w: bw, h: bh, spent, count: m } = second;
  for (let i = 0; i < n; i++) {
    const x = ax[i]!;
    const y = ay[i]!;
    const w = aw[i]!;
    const h = ah[i]!;
    for (let j = 0; j < m; j++) {
      if (
        boxes(x, y, w, h, bx[j]!, by[j]!, bw[j]!, bh[j]!) &&
        spent[j] === 0 &&
        meet(i, j)
      ) {
        break;
      }
    }
  }
};

/**
 * Calls `fn` for every pair of an entity of `a` and an entity of `b` whose
 * shapes touch, and despawns what it says to. An entity it despawns takes
 * part in no later pair of the call, so a bullet hits once and an enemy dies
 * once.
 *
 *   const commands = yield* Commands
 *   Overlap.pairs(commands, yield* Bullets, yield* Enemies, (bullet, enemy) => {
 *     const hp = world.get(enemy, Enemy)!.hp - 1
 *     world.set(enemy, Enemy, { hp })
 *     return hp > 0 ? "first" : "both"
 *   })
 *
 * **Details**
 *
 * - Each query's terms start with `Transform2d.Position`, then
 *   `Overlap.Circle` or `Overlap.Box`, then any others, as `Overlap.Shaped`
 *   says. A query of other terms doesn't compile, and a change query throws.
 * - Where every entity is, and its shape, is read once, before the first
 *   pair. A change `fn` makes to a position counts from the next call.
 * - Pairs come in the order of `a`'s entities, and for each, of `b`'s. An
 *   entity that both queries match is not paired with itself.
 * - It despawns through `commands`, which the system applies when it
 *   finishes, as it would any other despawn.
 * - It tests every pair, so its cost grows with the product of the two
 *   counts: about 2.5 ms for a thousand circles against a thousand. A call
 *   makes an array of each query's ids, and nothing for each pair.
 *
 * **Gotchas**
 *
 * - An entity `fn` despawns through `commands` itself, rather than by what it
 *   returns, still takes part in the later pairs of the call.
 * - `fn` can't call `Overlap.pairs` again, which throws.
 *
 * @category Utilities
 */
export const pairs = (
  commands: { readonly despawn: (entity: Entity) => void },
  a: QueryView<Shaped>,
  b: QueryView<Shaped>,
  fn: (first: Entity, second: Entity) => Despawn
): void => {
  if (busy) {
    throw new Error(
      "Overlap.pairs was called from inside its own callback. Make the second call after the first returns."
    );
  }
  busy = true;
  try {
    gather(a, first);
    gather(b, second);
    despawning = commands;
    calling = fn;
    if (first.circle) {
      if (second.circle) {
        circlesWithCircles();
      } else {
        circlesWithBoxes();
      }
    } else if (second.circle) {
      boxesWithCircles();
    } else {
      boxesWithBoxes();
    }
  } finally {
    busy = false;
  }
};
