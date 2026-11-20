import { describe, expect, it } from "vitest";

import { readSnapshot, writeSnapshot } from "../src/ecs/index";
import {
  CommandBuffer,
  Component,
  EcsWorld,
  Field,
  Migrate,
  Query,
  SnapshotError,
} from "../src/index";
import type { ComponentDef, Entity } from "../src/index";

const Body = Component.define("rs/Body", { x: Field.f32, y: Field.f32 });
const Marked = Component.tag("rs/Marked");
const Aura = Component.define(
  "rs/Aura",
  { power: Field.i32, note: Field.json<unknown>() },
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

const optional: ComponentDef[] = [Body, Marked, Aura, Chilled];
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
    const choice = alive.length === 0 ? 0 : dice.int(0, 11);
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
      world.rollback();
    } else if (choice === 9) {
      world.view(Bodies).each((body) => {
        body.y += 0.5;
      });
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
});

/** What a world does from here, step by step, for a seed. */
const future = (world: EcsWorld, seed: number, steps = 150): unknown[] => {
  const seen: unknown[] = [];
  play(world, seed, steps, () => {
    seen.push([
      world.hash(),
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
        .toSorted((a, b) => a - b)
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
        .toSorted((a, b) => a - b)
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
