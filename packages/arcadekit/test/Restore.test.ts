import { describe, expect, it } from "vitest";

import { idOf } from "../src/ecs/component.ts";
import { readSnapshot, writeSnapshot } from "../src/ecs/index.ts";
import {
  CommandBuffer,
  World as EcsWorld,
  SnapshotError,
} from "../src/ecs/index.ts";
import { Component } from "../src/ecs/index.ts";
import type { ComponentDef } from "../src/ecs/index.ts";
import { Field, Migrate, Query } from "../src/index.ts";
import type { Entity, JsonValue } from "../src/index.ts";
import { Shouts } from "./stores.ts";

const Body = Component.define("rs/Body", { x: Field.f32, y: Field.f32 });
const Marked = Component.tag("rs/Marked");
const Aura = Component.define(
  "rs/Aura",
  { power: Field.i32, note: Field.json<JsonValue>() },
  { storage: "sparse" }
);
const Chilled = Component.tag("rs/Chilled", { storage: "sparse" });
const ChildOf = Component.relation("rs/ChildOf", {
  onTargetDespawn: "despawn",
});
const Score = Component.singleton(
  "rs/Score",
  { points: Field.i32, name: Field.json<string>() },
  { points: 7, name: "nobody" }
);
const Level = Component.singleton(
  "rs/Level",
  { number: Field.u8 },
  { number: 3 }
);

/** The store each world of these tests holds, by world. */
const logs = new WeakMap<EcsWorld, Shouts>();
/** A world's store, attached the first time it is asked for. */
const logOf = (world: EcsWorld): Shouts => {
  let log = logs.get(world);
  if (log === undefined) {
    log = new Shouts("rs/Log");
    world._attach(log);
    logs.set(world, log);
  }
  return log;
};

// A spawn or an add of it fills in a body and a chill.
const Held = Component.tag("rs/Held", {
  requires: [Body.of({ x: 5, y: 6 }), Chilled],
});
const optional: ComponentDef[] = [Body, Marked, Aura, Chilled, Held];
const Bodies = Query.all(Body).pipe(Query.writes(Body));
const Warm = Query.all(Aura).pipe(Query.without(Chilled));
const Moved = Query.all(Body).pipe(Query.changed(Body));
const Born = Query.all(Body).pipe(Query.added(Body));

/**
 * Runs `steps` operations chosen by a seed against a world, and calls
 * `after` when each is done. The same seed does the same things to any
 * world that holds the same: what is alive is read from the world itself.
 */
const play = (
  world: EcsWorld,
  seed: number,
  steps: number,
  after: () => void = () => {}
): void => {
  // Attached before anything is done to the world, as an app's are.
  logOf(world);
  const dice = new EcsWorld({ seed }).random;
  const commands = new CommandBuffer(world);
  let serial = seed * 1000;
  const valueFor = (def: ComponentDef) =>
    def === Body
      ? Body.of({ x: ++serial, y: dice.next() })
      : def === Aura
        ? Aura.of({ power: ++serial, note: serial % 3 === 0 ? [serial] : "n" })
        : def;
  for (let step = 0; step < steps; step++) {
    const alive = world.view(Query.all()).entities();
    const choice = alive.length === 0 ? 0 : dice.int(0, 13);
    const entity = alive.length === 0 ? undefined : dice.pick(alive);
    if (choice <= 1 || entity === undefined) {
      const inputs = optional
        .filter(() => dice.int(0, 1) === 1)
        .map((def) => valueFor(def));
      if (choice === 0) {
        world.spawn(...inputs);
      } else {
        commands.spawn(...inputs);
        commands.apply();
      }
    } else if (choice === 2) {
      world.despawn(entity);
    } else if (choice === 3 || choice === 4) {
      const def = dice.pick(optional);
      if (world.has(entity, def)) {
        world.remove(entity, def);
      } else {
        world.add(entity, valueFor(def));
      }
    } else if (choice === 5) {
      world.random.next();
    } else if (choice === 6) {
      // A child of whatever is there, which goes when its parent goes.
      world.spawn(valueFor(Body), ChildOf.of({ target: entity }));
    } else if (choice === 7) {
      world.singleton(Score).points += dice.int(1, 9);
    } else if (choice === 8) {
      // A write that is taken back.
      world.begin();
      world.view(Bodies).each((body) => {
        body.x += 1;
      });
      world.singleton(Score).name = "undone";
      logOf(world).values.push("undone");
      world.rollback();
    } else if (choice === 9) {
      world.view(Bodies).each((body) => {
        body.y += 0.5;
      });
    } else if (choice === 12) {
      logOf(world).values.push(String(++serial));
    } else if (choice === 13) {
      // Taken from the front, as a reader that is done with them would.
      const log = logOf(world).values;
      log.splice(0, dice.int(0, log.length));
    } else if (world.has(entity, Body)) {
      world.set(entity, Body, { x: dice.next() });
    } else {
      world.add(entity, valueFor(Body));
    }
    after();
  }
};

/** Everything a game could read out of a world. */
const contents = (world: EcsWorld) => ({
  hash: world.hash(),
  entities: world
    .view(Query.all())
    .entities()
    .map((entity) => [
      entity,
      world.get(entity, Body),
      world.get(entity, Aura),
      world.has(entity, Marked),
      world.has(entity, Chilled),
      world.get(entity, ChildOf),
      world.sources(entity, ChildOf),
    ]),
  bodies: world.view(Bodies).entities(),
  warm: world.view(Warm).entities(),
  score: { ...world.singleton(Score) },
  level: { ...world.singleton(Level) },
  random: Array.from(world.random.state),
  log: [...logOf(world).values],
});

/** What a world does from here, step by step, for a seed. */
const future = (world: EcsWorld, seed: number, steps = 150): unknown[] => {
  const seen: unknown[] = [];
  play(world, seed, steps, () => {
    seen.push([
      world.hash(),
      [...logOf(world).values],
      world.view(Bodies).entities(),
      world.view(Warm).entities(),
      world.view(Moved, "watcher").entities(),
      world.view(Born, "watcher").entities(),
      world.removed(Body, "watcher").read(),
    ]);
  });
  seen.push(world.random.next(), world.spawn());
  return seen;
};

const known = [...optional, ChildOf, Score.component, Level.component];
const loaded = (bytes: Uint8Array): EcsWorld => {
  const world = new EcsWorld({ seed: 999 });
  // A world takes what a store held only if it has the store.
  logOf(world);
  world.load(bytes, known);
  // A new world is told what its singletons start as when it is asked.
  world.singleton(Score);
  world.singleton(Level);
  return world;
};

describe("a world that is restored from a snapshot", () => {
  it("holds what a new world that loaded it holds, and goes on the same", () => {
    for (const seed of [21, 22, 23, 24]) {
      const world = new EcsWorld({ seed });
      world.singleton(Score);
      world.singleton(Level);
      play(world, seed, 150);
      const bytes = world.snapshot();
      const then = contents(world);
      // On from there, into a future that is then given up.
      play(world, seed + 50, 150);
      expect(contents(world)).not.toEqual(then);

      world.restore(bytes);
      expect(contents(world)).toEqual(then);
      expect(contents(world)).toEqual(contents(loaded(bytes)));
      // Byte for byte what it was restored from.
      expect(world.snapshot()).toEqual(bytes);
      // And from there, what a new world does: the same ids for the next
      // entities, the same order, the same numbers, the same changes seen.
      expect(future(world, seed + 100)).toEqual(
        future(loaded(bytes), seed + 100)
      );
    }
  });

  it("can be restored again and again, to an earlier snapshot or a later one", () => {
    const world = new EcsWorld({ seed: 31 });
    world.singleton(Score);
    world.singleton(Level);
    const taken: { bytes: Uint8Array; held: unknown }[] = [];
    for (let i = 0; i < 5; i++) {
      play(world, 40 + i, 60);
      taken.push({ bytes: world.snapshot(), held: contents(world) });
    }
    for (const at of [4, 0, 3, 3, 1, 4, 2, 0]) {
      play(world, 70 + at, 25);
      world.restore(taken[at]!.bytes);
      expect(contents(world), `snapshot ${at}`).toEqual(taken[at]!.held);
    }
    expect(future(world, 90)).toEqual(future(loaded(taken[0]!.bytes), 90));
  });

  it("empties a world when the snapshot is of an empty one", () => {
    const empty = new EcsWorld({ seed: 4 }).snapshot();
    const world = new EcsWorld({ seed: 5 });
    world.singleton(Score).points = 100;
    play(world, 6, 80);
    // Hashed first: a hash works out the order of the sparse sets and
    // keeps it, and those sets are about to be gone.
    world.hash();
    world.restore(empty);
    expect(world.entityCount).toBe(0);
    expect(world.view(Bodies).entities()).toEqual([]);
    expect(world.hash()).toBe(new EcsWorld({ seed: 4 }).hash());
    expect(world.singleton(Score).points).toBe(7);
    // The first entity of a world, again.
    expect(world.spawn(Marked)).toBe(new EcsWorld().spawn(Marked));
  });

  it("keeps a singleton the object it was, with what the snapshot says in it", () => {
    const world = new EcsWorld();
    const score = world.singleton(Score);
    const level = world.singleton(Level);
    score.points = 40;
    const bytes = world.snapshot();
    score.points = 99;
    score.name = "someone";
    // Written only after the snapshot: it goes back to its initial value,
    // and is as good as absent again.
    level.number = 9;
    world.restore(bytes);
    // Read through the objects that were held, before the world is asked.
    expect({ ...score }).toEqual({ points: 40, name: "nobody" });
    expect(level.number).toBe(3);
    expect(world.singleton(Score)).toBe(score);
    expect(world.singleton(Level)).toBe(level);
    expect(world.hash()).toBe(loaded(bytes).hash());
    expect(world.snapshot()).toEqual(bytes);
    // And it is written through the same object afterwards.
    score.points = 41;
    expect(world.singleton(Score).points).toBe(41);
    expect(world.hash()).not.toBe(loaded(bytes).hash());
  });

  it("puts back a singleton that the snapshot's loader had not been told the start of", () => {
    const source = new EcsWorld();
    source.singleton(Score).points = 12;
    const written = source.snapshot();
    const unwritten = new EcsWorld().snapshot();
    // This world knows the singleton as a load made it: by its fields.
    const world = new EcsWorld();
    world.load(written, [Score.component]);
    world.restore(unwritten);
    // Told what it starts as only now, it has that.
    expect({ ...world.singleton(Score) }).toEqual({
      points: 7,
      name: "nobody",
    });
    world.restore(written);
    expect(world.singleton(Score).points).toBe(12);
  });

  it("keeps its random generator, set to where the snapshot had it", () => {
    const world = new EcsWorld({ seed: 77 });
    const { random } = world;
    random.next();
    const bytes = world.snapshot();
    const expected = [random.next(), random.next()];
    random.int(1, 6);
    world.restore(bytes);
    expect(world.random).toBe(random);
    expect([random.next(), random.next()]).toEqual(expected);
  });

  it("has a view that was asked for before throw, and gives a new one that works", () => {
    const world = new EcsWorld();
    world.spawn(Body.of({ x: 1, y: 1 }));
    const bytes = world.snapshot();
    const before = world.view(Bodies);
    const watching = world.view(Moved, "watcher");
    const gone = world.removed(Body, "watcher");
    world.spawn(Body.of({ x: 2, y: 2 }));
    world.restore(bytes);
    for (const use of [
      () => before.each(() => {}),
      () => before.eachChunk(() => {}),
      () => before.entities(),
      () => before.count(),
      () => watching.entities(),
    ]) {
      expect(use).toThrow(
        /view was used after its world was restored.*Ask for it again/u
      );
    }
    expect(() => gone.read()).toThrow(/after its world was restored/u);
    const after = world.view(Bodies);
    expect(after).not.toBe(before);
    expect(after.count()).toBe(1);
    expect(world.removed(Body, "watcher").read()).toEqual([]);
  });

  it("forgets what change queries had yet to visit, and takes back what was saved with the snapshot", () => {
    const world = new EcsWorld();
    const first = world.spawn(Body.of({ x: 1, y: 1 }));
    const second = world.spawn(Body.of({ x: 2, y: 2 }));
    const third = world.spawn(Body.of({ x: 3, y: 3 }));
    // The watcher has seen everything, and then one write it has not.
    world.view(Moved, "watcher").entities();
    world.removed(Body, "watcher").read();
    world.set(second, Body, { x: 20 });
    const bytes = world.snapshot();
    const changes = world.saveChanges();
    // What follows is given up.
    world.set(third, Body, { x: 30 });
    world.despawn(first);
    expect(
      world
        .view(Moved, "watcher")
        .entities()
        .toSorted((a, b) => idOf(a) - idOf(b))
    ).toEqual([second, third]);

    world.restore(bytes);
    world.restoreChanges(changes);
    // Where it was when the snapshot was taken, and no further.
    expect(world.view(Moved, "watcher").count()).toBe(1);
    expect(world.view(Moved, "watcher").entities()).toEqual([second]);
    expect(world.removed(Body, "watcher").read()).toEqual([]);
    // And it hears of what is written from here on.
    world.set(first, Body, { x: 10 });
    world.despawn(third);
    expect(world.view(Moved, "watcher").entities()).toEqual([first]);
    expect(world.removed(Body, "watcher").read()).toEqual([third]);

    // With nothing taken back, a watcher starts over: everything is new.
    world.restore(bytes);
    expect(
      world
        .view(Moved, "watcher")
        .entities()
        .toSorted((a, b) => idOf(a) - idOf(b))
    ).toEqual([first, second, third]);
  });

  it("works out again who points at whom", () => {
    const world = new EcsWorld();
    const tank = world.spawn(Marked);
    const turret = world.spawn(ChildOf.of({ target: tank }));
    const bytes = world.snapshot();
    const truck = world.spawn(Marked);
    world.add(turret, ChildOf.of({ target: truck }));
    world.spawn(ChildOf.of({ target: truck }));
    world.restore(bytes);
    expect(world.sources(tank, ChildOf)).toEqual([turret]);
    expect(world.isAlive(truck)).toBe(false);
    world.despawn(tank);
    expect(world.isAlive(turret)).toBe(false);
    expect(world.entityCount).toBe(0);
  });

  it("is refused in the middle of a loop, in a transaction, and with a spawn queued", () => {
    const world = new EcsWorld();
    const ball = world.spawn(Body.of({ x: 1, y: 1 }));
    const bytes = world.snapshot();
    const before = world.hash();
    expect(() =>
      world.view(Bodies).each(() => {
        world.restore(bytes);
      })
    ).toThrow(/restore/u);
    world.begin();
    expect(() => world.restore(bytes)).toThrow(
      /between begin\(\) and commit\(\) or rollback\(\)/u
    );
    world.rollback();
    const commands = new CommandBuffer(world);
    const queued = commands.spawn(Marked);
    expect(() => world.restore(bytes)).toThrow(
      /1 entities were spawned through a CommandBuffer that has not been applied/u
    );
    commands.rollback(0);
    expect(world.hash()).toBe(before);
    world.restore(bytes);
    expect(world.isAlive(ball)).toBe(true);
    expect(world.isAlive(queued as Entity)).toBe(false);
  });

  it("refuses bytes that are not a snapshot, as load does", () => {
    const world = new EcsWorld();
    world.spawn(Marked);
    expect(() => world.restore(new Uint8Array([1, 2, 3]))).toThrow(
      SnapshotError
    );
    const other = new EcsWorld();
    other.spawn(Component.tag("rs/Stranger"));
    const contents = readSnapshot(other.snapshot());
    Migrate.renameComponent(contents, "rs/Stranger", "rs/Undefined");
    let refused: unknown;
    try {
      world.restore(writeSnapshot(contents));
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(SnapshotError);
    expect((refused as SnapshotError).problem).toBe("unknown component");
  });
});

const Auras = Query.all(Aura).pipe(Query.writes(Aura));

describe("a world rewound to a moment it captured", () => {
  it("leaves what a restore of a snapshot taken then leaves, whatever the order of the moments", () => {
    for (const seed of [11, 12, 13, 14]) {
      const world = new EcsWorld({ seed });
      world.singleton(Score);
      world.singleton(Level);
      const taken: {
        readonly moment: ReturnType<EcsWorld["_capture"]>;
        readonly bytes: Uint8Array;
      }[] = [];
      const take = (): void => {
        taken.push({ moment: world._capture(), bytes: world.snapshot() });
      };
      for (let i = 0; i < 6; i++) {
        play(world, seed * 10 + i, 40);
        world.hash();
        take();
      }
      for (const at of [5, 0, 3, 3, 1, 4, 2, 5, 0]) {
        play(world, seed * 100 + at, 30);
        if (at === 4) {
          // Every table made anew: the moment's take their place again.
          world.restore(taken[1]!.bytes);
        }
        world._rewind(taken[at]!.moment, []);
        expect(contents(world), `seed ${seed}, moment ${at}`).toEqual(
          contents(loaded(taken[at]!.bytes))
        );
        expect(world.snapshot()).toEqual(taken[at]!.bytes);
        // Moments of a future given up can be gone back to as well.
        play(world, seed * 1000 + at, 20);
        take();
      }
      const last = taken.at(-1)!;
      world._rewind(last.moment, []);
      expect(future(world, seed + 7)).toEqual(
        future(loaded(last.bytes), seed + 7)
      );
    }
  });

  it("goes back to a moment with more freed slots than a call takes arguments", () => {
    const world = new EcsWorld();
    const spawned = Array.from({ length: 200_000 }, () =>
      world.spawn(Body.of({ x: 1, y: 1 }))
    );
    for (const entity of spawned) {
      world.despawn(entity);
    }
    const moment = world._capture();
    const bytes = world.snapshot();
    world.spawn(Body.of({ x: 2, y: 2 }));
    world._rewind(moment, []);
    expect(world.snapshot()).toEqual(bytes);
  });

  it("puts back what a spawn and an add filled in, and hashes it as the full hash does", () => {
    const Ship = Component.define(
      "rs/Ship",
      { fuel: Field.i32 },
      {
        requires: [Body.of({ x: 1, y: 2 }), Aura.of({ power: 3, note: "n" })],
      }
    );
    const world = new EcsWorld();
    const a = world.spawn(Marked);
    world.hash();
    const moment = world._capture();
    const bytes = world.snapshot();
    const b = world.spawn(Ship);
    world.add(a, Ship.of({ fuel: 4 }));
    expect(world.hash()).toBe(world._fullHash());
    // Added again with a value: the ship's own row is written in place.
    world.add(a, Ship.of({ fuel: 5 }));
    expect(world.get(a, Ship)).toEqual({ fuel: 5 });
    expect(world.hash()).toBe(world._fullHash());
    world.remove(b, Body);
    world.add(b, Ship);
    expect(world.get(b, Body)).toEqual({ x: 1, y: 2 });
    expect(world.hash()).toBe(world._fullHash());
    world._rewind(moment, []);
    expect(world.hash()).toBe(world._fullHash());
    expect(world.snapshot()).toEqual(bytes);
    expect(world.has(a, Body)).toBe(false);
  });

  it("hashes as the full hash does after every step, through captures and rewinds", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const world = new EcsWorld({ seed });
      world.singleton(Score);
      world.singleton(Level);
      const moments: ReturnType<EcsWorld["_capture"]>[] = [];
      // Each step's hash and full hash, and where it was taken.
      const differ: string[] = [];
      const compare = (where: string): void => {
        if (world.hash() !== world._fullHash()) {
          differ.push(where);
        }
      };
      let step = 0;
      play(world, seed, 400, () => {
        compare(`step ${step}`);
        step++;
        if (step % 5 === 0) {
          world.view(Bodies).eachChunk((start, end, body) => {
            for (let i = start; i < end; i++) {
              body.y[i]! += 1;
            }
          });
          world.view(Auras).each((aura) => {
            aura.power += 1;
          });
          compare(`step ${step}, after a loop`);
        }
        if (step % 7 === 0) {
          moments.push(world._capture());
        }
        if (step % 23 === 0) {
          world._rewind(moments[(step * 31) % moments.length]!, []);
          compare(`step ${step}, after a rewind`);
        }
      });
      expect(differ, `seed ${seed}`).toEqual([]);
    }
  });
});
