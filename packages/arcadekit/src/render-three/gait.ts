/**
 * Gaits: whether a character a view draws is walking, worked out from the positions it is shown
 * at.
 *
 * Whether a character walks is a view's question: the rules hold a position and no animation. A
 * view answers it from the positions it draws, with a little time after the last move, so a
 * frame with no step, or the gap between two turns of a held key, doesn't flicker the character
 * back to standing. A gait is data work a view does in its frame, so its functions are plain
 * (ADR-0024).
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

const TypeId = "~arcadekit/render-three/Gait";

/**
 * Whether one character a view draws is walking, from the positions it is shown at.
 *
 * **When to use**
 *
 * Keep one for each character a view animates, and update it once per frame drawn; then read
 * `moving` to pick the walk or the idle tag, and `since` to play it from its first frame.
 *
 * **Details**
 *
 * Nothing allocates after it is made. It has no facing: which way a character looks is the
 * game's to say, from its rules or from the way it last moved.
 *
 * **Example** (Picking the walk while the hero moves)
 *
 * ```ts
 * import { Gait } from "arcadekit/render-three";
 *
 * const gait = Gait.make({ linger: 0.25 });
 * Gait.update(gait, 0, 0, 1);
 * Gait.update(gait, 0.5, 0, 2);
 * [gait.moving, gait.since]; // => [true, 2]
 * // A quarter of a second after the last move, it stands again.
 * Gait.update(gait, 0.5, 0, 2.25);
 * [gait.moving, gait.since]; // => [false, 2.25]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Gait extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** Seconds it still counts as moving after its position last changed. */
  readonly linger: number;
  /** True from a change of position until `linger` seconds after the last one. */
  readonly moving: boolean;
  /** The time of the update that last changed `moving`, or of the first one. */
  readonly since: number;
}

/** What the module's functions keep, which no caller reads. */
type Internal = Types.Mutable<Gait> & {
  /** False until the first update since it was made or reset. */
  placed: boolean;
  x: number;
  z: number;
  movedAt: number;
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Gait) {
    return {
      _id: "Gait",
      linger: this.linger,
      moving: this.moving,
      since: this.since,
    };
  },
};

/**
 * Checks whether a value is a gait.
 *
 * **When to use**
 *
 * Narrow an unknown value before updating it.
 *
 * **Example** (Recognising a gait)
 *
 * ```ts
 * import { Gait } from "arcadekit/render-three";
 *
 * Gait.isGait(Gait.make()); // => true
 * Gait.isGait({ moving: false, since: 0 }); // => false
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isGait = (value: unknown): value is Gait =>
  Predicate.hasProperty(value, TypeId);

/**
 * Makes a gait that has seen no position yet.
 *
 * **When to use**
 *
 * When a view is made, once for each character it animates.
 *
 * **Details**
 *
 * `linger` defaults to 0.1 seconds. A linger of 0 is never moving.
 *
 * **Example** (Making a gait)
 *
 * ```ts
 * import { Gait } from "arcadekit/render-three";
 *
 * const gait = Gait.make();
 * [gait.linger, gait.moving]; // => [0.1, false]
 * Gait.make({ linger: 0.15 }).linger; // => 0.15
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = (options?: { readonly linger?: number }): Gait => {
  const self = Object.create(Proto) as Internal;
  self.linger = options?.linger ?? 0.1;
  self.moving = false;
  self.since = 0;
  self.placed = false;
  self.x = 0;
  self.z = 0;
  self.movedAt = Number.NEGATIVE_INFINITY;
  return self;
};

/**
 * Tells the gait where the character is drawn at `time`, the view's seconds.
 *
 * **When to use**
 *
 * Once per frame drawn, before reading `moving` and `since`.
 *
 * **Details**
 *
 * The first update since the gait was made or reset is no move. A change of position along x
 * or z is a move, and holds `moving` for the whole `linger` again. A walk whose `linger` ran
 * out before this update ended then, though no update saw it end: a change of position now
 * starts a new one, and `since` is this update's time.
 *
 * **Example** (A walk that ran out between two frames)
 *
 * ```ts
 * import { Gait } from "arcadekit/render-three";
 *
 * const gait = Gait.make({ linger: 0.25 });
 * Gait.update(gait, 0, 0, 0);
 * Gait.update(gait, 1, 0, 1);
 * // No update saw it stand, and it walks again: a walk of its own, from its first frame.
 * gait.pipe(Gait.update(2, 0, 5));
 * [gait.moving, gait.since]; // => [true, 5]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const update: {
  (x: number, z: number, time: number): (self: Gait) => void;
  (self: Gait, x: number, z: number, time: number): void;
} = dual(4, (self: Gait, x: number, z: number, time: number): void => {
  const gait = self as Internal;
  if (!gait.placed) {
    gait.placed = true;
    gait.x = x;
    gait.z = z;
    gait.moving = false;
    gait.since = time;
    return;
  }
  const lingering = time - gait.movedAt < gait.linger;
  let moving = lingering;
  if (x !== gait.x || z !== gait.z) {
    gait.x = x;
    gait.z = z;
    gait.movedAt = time;
    moving = gait.linger > 0;
  }
  if (moving !== gait.moving || (moving && !lingering)) {
    gait.moving = moving;
    gait.since = time;
  }
});

/**
 * Forgets the position: the next update is a first one, and no move.
 *
 * **When to use**
 *
 * When a new run starts, so a character that appears somewhere else doesn't walk there.
 *
 * **Example** (Starting a new run at rest)
 *
 * ```ts
 * import { Gait } from "arcadekit/render-three";
 *
 * const gait = Gait.make({ linger: 0.25 });
 * Gait.update(gait, 0, 0, 0);
 * Gait.update(gait, 1, 0, 1);
 * Gait.reset(gait);
 * Gait.update(gait, 5, 5, 1.0625);
 * [gait.moving, gait.since]; // => [false, 1.0625]
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const reset = (self: Gait): void => {
  const gait = self as Internal;
  gait.placed = false;
  gait.movedAt = Number.NEGATIVE_INFINITY;
  gait.moving = false;
};
