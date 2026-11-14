import { describe, expect, it } from "vitest";

import { Gait } from "../../src/render-three/index";

// Times and lingers here are sums of powers of two, so each comparison is exact.

describe("a gait", () => {
  it("takes a first update as no move", () => {
    const gait = Gait.make();
    expect(gait.moving).toBe(false);
    Gait.update(gait, 3, 4, 10);
    expect([gait.moving, gait.since]).toStrictEqual([false, 10]);
    // Standing where it appeared.
    Gait.update(gait, 3, 4, 11);
    expect([gait.moving, gait.since]).toStrictEqual([false, 10]);
  });

  it("is moving from a change of position, since the update that saw it", () => {
    const gait = Gait.make({ linger: 0.25 });
    Gait.update(gait, 0, 0, 1);
    Gait.update(gait, 0.5, 0, 2);
    expect([gait.moving, gait.since]).toStrictEqual([true, 2]);
    // Still walking: the walk began where it began.
    Gait.update(gait, 1, 0, 2.125);
    expect([gait.moving, gait.since]).toStrictEqual([true, 2]);
    // A change along z alone is a move too.
    const other = Gait.make({ linger: 0.25 });
    Gait.update(other, 0, 0, 1);
    Gait.update(other, 0, 0.5, 2);
    expect(other.moving).toBe(true);
  });

  it("holds moving for linger after the last change, then falls", () => {
    const gait = Gait.make({ linger: 0.25 });
    Gait.update(gait, 0, 0, 0);
    Gait.update(gait, 1, 0, 1);
    Gait.update(gait, 1, 0, 1.125);
    const lingering = [gait.moving, gait.since];
    // Each change of position holds it for the whole linger again: without this one it
    // would stand at 1.25.
    Gait.update(gait, 2, 0, 1.1875);
    Gait.update(gait, 2, 0, 1.375);
    const held = [gait.moving, gait.since];
    // A quarter of a second after the last change, to the instant.
    Gait.update(gait, 2, 0, 1.4375);
    expect({
      lingering,
      held,
      fallen: [gait.moving, gait.since],
    }).toStrictEqual({
      lingering: [true, 1],
      held: [true, 1],
      fallen: [false, 1.4375],
    });
  });

  it("lingers a tenth of a second unless told", () => {
    const gait = Gait.make();
    Gait.update(gait, 0, 0, 0);
    Gait.update(gait, 1, 0, 1);
    Gait.update(gait, 1, 0, 1.0625);
    const before = gait.moving;
    Gait.update(gait, 1, 0, 1.125);
    expect([before, gait.moving]).toStrictEqual([true, false]);
  });

  it("starts a new walk when the last one ran out between two updates", () => {
    const gait = Gait.make({ linger: 0.25 });
    Gait.update(gait, 0, 0, 0);
    Gait.update(gait, 1, 0, 1);
    // No update saw it stand, and it walks again: a walk of its own, from its first frame.
    Gait.update(gait, 2, 0, 5);
    expect([gait.moving, gait.since]).toStrictEqual([true, 5]);
  });

  it("forgets on reset: the next update is a first one, and no move", () => {
    const gait = Gait.make({ linger: 0.25 });
    Gait.update(gait, 0, 0, 0);
    Gait.update(gait, 1, 0, 1);
    Gait.reset(gait);
    expect(gait.moving).toBe(false);
    // Somewhere else, within the linger of the move before the reset.
    Gait.update(gait, 5, 5, 1.0625);
    const first = [gait.moving, gait.since];
    Gait.update(gait, 5, 5, 1.125);
    expect({ first, next: [gait.moving, gait.since] }).toStrictEqual({
      first: [false, 1.0625],
      next: [false, 1.0625],
    });
    // And it walks from there as any other.
    Gait.update(gait, 6, 5, 2);
    expect([gait.moving, gait.since]).toStrictEqual([true, 2]);
  });
});
