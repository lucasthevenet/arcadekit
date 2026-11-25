import { describe, expect, it } from "vitest";

import { Drift } from "../src/net/index.ts";

/** Ada's side of a game of two, or of three, that begins at a tick. */
const ada = (peers: readonly string[] = ["ada", "grace"], start = 0) =>
  Drift.make({ peer: "ada", made: { game: 1, delta: 1 / 60, peers, start } });

describe("a peer's comparison of what the peers were made with", () => {
  const made = { game: 1, delta: 1 / 60, peers: ["ada", "grace"], start: 0 };

  it("holds nothing against a peer made the same, nor against its own word", () => {
    const drift = ada();
    drift.told("grace", made);
    drift.told("ada", { ...made, delta: 1 });
    expect(drift.drifted).toBeUndefined();
    expect(drift.compare(0, 0)).toBeUndefined();
  });

  it("stops at the first peer made otherwise, says every way it differs, and compares nothing more", () => {
    const drift = ada();
    drift.took(0, 10);
    drift.told("grace", { ...made, game: 2, start: 4 });
    const unlike = new Drift.Unlike({
      peer: "ada",
      other: "grace",
      mine: made,
      theirs: { ...made, game: 2, start: 4 },
      differ: ["game", "start"],
    });
    expect(drift.drifted).toEqual(unlike);
    drift.told("edsger", { ...made, delta: 1 });
    drift.heard("grace", 0, [{ tick: 0, hash: 11 }]);
    expect(drift.compare(0, 0)).toEqual(unlike);
    expect(unlike.message).toMatch(
      /^The peers "ada" and "grace" were not made alike: they play another game: .*; "ada" begins at tick 0 and "grace" at tick 4\. Give every peer the same seed or save\.$/u
    );
  });
});

describe("a peer's comparison of checkpoints", () => {
  it("sends each of its own once, and only when its tick is final", () => {
    const drift = ada();
    drift.took(0, 10);
    drift.took(1, 11);
    // Nothing is sure before it is compared up to a final tick.
    expect(drift.unsent()).toEqual([]);
    expect(drift.compare(0, 1)).toBeUndefined();
    expect(drift.unsent()).toEqual([{ tick: 0, hash: 10 }]);
    expect(drift.unsent()).toEqual([]);
    expect(drift.unanswered).toBe(1);
    drift.compare(1, 1);
    expect(drift.unsent()).toEqual([{ tick: 1, hash: 11 }]);
    expect(drift.unanswered).toBe(2);
  });

  it("sends the hash of a tick as it was last run, when the tick was run again", () => {
    const drift = ada();
    drift.took(3, 30);
    // A rewind ran tick 3 again, and it came out otherwise.
    drift.took(3, 31);
    drift.compare(3, 3);
    expect(drift.unsent()).toEqual([{ tick: 3, hash: 31 }]);
  });

  it("agrees when every peer says the same, once every peer has said", () => {
    const drift = ada(["ada", "edsger", "grace"]);
    drift.took(0, 10);
    drift.heard("grace", 0, [{ tick: 0, hash: 10 }]);
    // Edsger has not said: the tick waits, so that a report would be whole.
    expect(drift.compare(0, 0)).toBeUndefined();
    expect(drift.unanswered).toBe(1);
    drift.heard("edsger", 0, [{ tick: 0, hash: 10 }]);
    expect(drift.compare(0, 0)).toBeUndefined();
    expect(drift.unanswered).toBe(0);
    expect(drift.drifted).toBeUndefined();
  });

  it("finds the first tick whose hashes differ, with every peer's hash and the last tick they agreed at", () => {
    const drift = ada(["ada", "edsger", "grace"]);
    for (const [tick, hash] of [
      [0, 10],
      [1, 11],
      [2, 12],
    ] as const) {
      drift.took(tick, hash);
    }
    drift.heard("grace", 0, [{ tick: 0, hash: 10 }]);
    drift.heard("edsger", 0, [{ tick: 0, hash: 10 }]);
    drift.heard("grace", 1, [
      { tick: 1, hash: 11 },
      { tick: 2, hash: 12 },
    ]);
    drift.heard("edsger", 1, [
      { tick: 1, hash: 99 },
      { tick: 2, hash: 98 },
    ]);
    const found = drift.compare(2, 2);
    expect(found).toBeInstanceOf(Drift.Drifted);
    expect(found).toMatchObject({
      tick: 1,
      peer: "ada",
      hashes: { ada: 11, edsger: 99, grace: 11 },
      agreedAt: 0,
    });
    expect(drift.drifted).toBe(found);
    // It stops there: nothing later is compared, or made final.
    drift.took(3, 13);
    expect(drift.compare(3, 3)).toBe(found);
    expect(drift.unsent()).toEqual([
      { tick: 0, hash: 10 },
      { tick: 1, hash: 11 },
      { tick: 2, hash: 12 },
    ]);
  });

  it("says they never agreed when the first tick differs", () => {
    const drift = ada();
    drift.took(0, 10);
    drift.heard("grace", 0, [{ tick: 0, hash: 20 }]);
    const found = drift.compare(0, 0);
    expect(found).toMatchObject({ tick: 0, agreedAt: undefined });
    expect(found!.message).toMatch(/did not start from the same state/);
  });

  it("compares nothing past the last final tick, which a peer is not sure of yet", () => {
    const drift = ada();
    drift.took(0, 10);
    drift.took(1, 11);
    drift.heard("grace", 0, [
      { tick: 0, hash: 10 },
      { tick: 1, hash: 77 },
    ]);
    expect(drift.compare(0, 1)).toBeUndefined();
    expect(drift.compare(1, 1)).toMatchObject({ tick: 1, agreedAt: 0 });
  });

  it("takes a peer's checkpoints in the order it sent them, whatever order its messages come in", () => {
    const drift = ada();
    drift.took(0, 10);
    drift.took(1, 11);
    // Grace's second message arrives first: it waits for the first.
    drift.heard("grace", 1, [{ tick: 1, hash: 77 }]);
    expect(drift.compare(1, 1)).toBeUndefined();
    expect(drift.unanswered).toBe(2);
    drift.heard("grace", 0, [{ tick: 0, hash: 10 }]);
    // So the tick they agreed at is known when the next one differs.
    expect(drift.compare(1, 1)).toMatchObject({ tick: 1, agreedAt: 0 });
  });

  it("begins with each peer's message for the tick the game begins at", () => {
    const drift = ada(["ada", "grace"], 9);
    drift.took(9, 90);
    drift.heard("grace", 9, [{ tick: 9, hash: 91 }]);
    expect(drift.compare(9, 9)).toMatchObject({ tick: 9 });
  });

  it("holds nothing against a checkpoint it took none for, or from a name that is no peer", () => {
    const drift = ada();
    drift.took(0, 10);
    // One grace took by hand, at a tick ada's log records none for.
    drift.heard("grace", 0, [
      { tick: 0, hash: 10 },
      { tick: 5, hash: 55 },
    ]);
    drift.heard("mallory", 0, [{ tick: 0, hash: 66 }]);
    expect(drift.compare(5, 5)).toBeUndefined();
    expect(drift.unanswered).toBe(0);
    // It was let go of: a hash ada takes for that tick later waits again.
    drift.took(5, 50);
    expect(drift.compare(5, 5)).toBeUndefined();
    expect(drift.unanswered).toBe(1);
  });

  it("lets go of a checkpoint no peer has answered in 600 ticks", () => {
    const drift = ada();
    drift.took(0, 10);
    drift.compare(0, 0);
    expect(drift.unanswered).toBe(1);
    drift.compare(0, 600);
    expect(drift.unanswered).toBe(1);
    drift.compare(0, 601);
    expect(drift.unanswered).toBe(0);
    // An answer that comes after all has nothing to be held against.
    drift.heard("grace", 0, [{ tick: 0, hash: 99 }]);
    expect(drift.compare(0, 601)).toBeUndefined();
  });
});
