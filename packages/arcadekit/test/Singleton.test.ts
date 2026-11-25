import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { idOf } from "../src/ecs/component";
import { END, KIND_CODES, MAGIC, Writer } from "../src/ecs/snapshot";
import {
  Action,
  App,
  CommandBuffer,
  Commands,
  Component,
  EcsWorld,
  Field,
  Journal,
  Migrate,
  Plugin,
  Query,
  Save,
  Singleton,
  SnapshotError,
  System,
  Timeline,
  World,
  readSnapshot,
  writeSnapshot,
} from "../src/index";
import type { JsonValue } from "../src/index";

const Turn = Singleton.define(
  "sg/Turn",
  { player: Field.u8, round: Field.u32 },
  { player: 1, round: 0 }
);
const Score = Singleton.define(
  "sg/Score",
  { points: Field.f64, best: Field.json<string>() },
  { points: 0, best: "nobody" }
);
// One field of every kind.
const Everything = Singleton.define(
  "sg/Everything",
  {
    single: Field.f32,
    double: Field.f64,
    signed: Field.i32,
    unsigned: Field.u32,
    short: Field.u16,
    byte: Field.u8,
    other: Field.entity,
    note: Field.json<JsonValue>(),
    when: Field.schema(Schema.Date),
    handle: Field.transient<{ open: boolean }>(),
  },
  {
    single: 1.5,
    double: 2.25,
    signed: -3,
    unsigned: 4_000_000_000,
    short: 60_000,
    byte: 200,
    other: 7 as never,
    note: { nested: [1, "two"] },
    when: new Date("2026-01-02T03:04:05Z"),
    handle: undefined,
  }
);
const Body = Component.define("sg/Body", { x: Field.f32 });

const problemOf = (attempt: () => unknown): SnapshotError => {
  try {
    attempt();
  } catch (error) {
    if (error instanceof SnapshotError) {
      return error;
    }
    throw error;
  }
  throw new Error("nothing was refused");
};

describe("a singleton", () => {
  it("holds its initial value until it is written, and is read and written in place", () => {
    const world = new EcsWorld();
    const turn = world.singleton(Turn);
    expect({ ...turn }).toEqual({ player: 1, round: 0 });
    turn.player = 2;
    turn.round += 3;
    // One value per world, whoever asks.
    expect(world.singleton(Turn)).toBe(turn);
    expect(world.singleton(Turn).round).toBe(3);
    expect(Object.keys(turn)).toEqual(["player", "round"]);
    // A field keeps what its kind can hold, as a component's does.
    turn.player = 257;
    expect(turn.player).toBe(1);
    // Another world has its own.
    expect({ ...new EcsWorld().singleton(Turn) }).toEqual({
      player: 1,
      round: 0,
    });
  });

  it("has fields of every kind", () => {
    const world = new EcsWorld();
    const all = world.singleton(Everything);
    expect({ ...all }).toEqual({ ...Everything.initial });
    const handle = { open: true };
    all.handle = handle;
    all.note = "text";
    all.single = 0.1;
    expect(all.handle).toBe(handle);
    expect(all.note).toBe("text");
    expect(all.single).toBe(Math.fround(0.1));
  });

  it("is not a component: no entity has it, and its name is taken", () => {
    const world = new EcsWorld();
    expect(() => world.spawn(Turn.component)).toThrow(
      /"sg\/Turn" is a singleton.*World\.singleton\(\)/
    );
    const entity = world.spawn(Body.of({ x: 1 }));
    expect(() => world.add(entity, Turn.component.of(Turn.initial))).toThrow(
      /is a singleton/
    );
    expect(world.entityCount).toBe(1);
    // Queued, it is refused where the mistake is, and leaves no id behind.
    const commands = new CommandBuffer(world);
    expect(() => commands.spawn(Body, Turn.component)).toThrow(
      /is a singleton/
    );
    expect(() => commands.add(entity, Turn.component)).toThrow(
      /is a singleton/
    );
    expect(commands.size).toBe(0);
    expect(world.spawn(Body)).toBe(idOf(entity) + 1);
    world.singleton(Turn);
    expect(world.component("sg/Turn")).toBe(Turn.component);
    // A singleton and a component of one name, defined here alone, so that
    // this program's "sg/Turn" stays the one a load finds.
    world.singleton(Singleton.define("sg/Clash", { n: Field.u8 }, { n: 0 }));
    const clash = Component.define("sg/Clash", { player: Field.u8 });
    expect(() => world.spawn(clash)).toThrow(
      /Two different components are both named "sg\/Clash"/
    );
    expect(() =>
      world.singleton({ component: Body, initial: { x: 0 } })
    ).toThrow(/"sg\/Body" is a component, not a singleton/);
    // The plain form, with no Effect, is the same thing.
    const plain = Component.singleton("sg/Plain", { n: Field.i32 }, { n: 5 });
    expect(world.singleton(plain).n).toBe(5);
    expect(Turn.name).toBe("sg/Turn");
  });
});

describe("a singleton and the world's hash", () => {
  it("is not in it until it is written: reading changes nothing", () => {
    const world = new EcsWorld({ seed: 3 });
    world.spawn(Body.of({ x: 1 }));
    const before = world.hash();
    const turn = world.singleton(Turn);
    void turn.player;
    void { ...world.singleton(Score) };
    expect(world.hash()).toBe(before);
    turn.round = 1;
    expect(world.hash()).not.toBe(before);
  });

  it("changes with any one field of any one singleton, and with nothing else", () => {
    const build = (change?: (world: EcsWorld) => void): number => {
      const world = new EcsWorld({ seed: 3 });
      world.spawn(Body.of({ x: 1 }));
      world.singleton(Turn).round = 4;
      world.singleton(Score).best = "ann";
      world.singleton(Everything).byte = 1;
      change?.(world);
      return world.hash();
    };
    const same = build();
    expect(build()).toBe(same);
    const changes: ((world: EcsWorld) => void)[] = [
      (world) => (world.singleton(Turn).player = 2),
      (world) => (world.singleton(Turn).round = 5),
      (world) => (world.singleton(Score).points = 0.5),
      (world) => (world.singleton(Score).best = "bob"),
      (world) => (world.singleton(Everything).when = new Date(0)),
      (world) => (world.singleton(Everything).note = { nested: [1, "2"] }),
      (world) => (world.singleton(Everything).single = 1.25),
    ];
    const hashes = changes.map((change) => build(change));
    expect(new Set([same, ...hashes]).size).toBe(changes.length + 1);
    // A transient field is not part of the game's state.
    expect(
      build((world) => (world.singleton(Everything).handle = { open: false }))
    ).toBe(same);
    // Written back to what it was at first, it is still a written one.
    const untouched = new EcsWorld();
    const rewritten = new EcsWorld();
    rewritten.singleton(Turn).player = 1;
    expect(rewritten.hash()).not.toBe(untouched.hash());
    // The order singletons were first used in is not part of it.
    const forwards = new EcsWorld();
    forwards.singleton(Turn).round = 1;
    forwards.singleton(Score).points = 2;
    const backwards = new EcsWorld();
    backwards.singleton(Score).points = 2;
    backwards.singleton(Turn).round = 1;
    expect(backwards.hash()).toBe(forwards.hash());
    // Two singletons with the same fields are told apart by name.
    const Twin = Singleton.define(
      "sg/Twin",
      { player: Field.u8, round: Field.u32 },
      { player: 1, round: 0 }
    );
    const one = new EcsWorld();
    one.singleton(Turn).round = 1;
    const other = new EcsWorld();
    other.singleton(Twin).round = 1;
    expect(one.hash()).not.toBe(other.hash());
  });
});

describe("a singleton in a snapshot", () => {
  const written = (): EcsWorld => {
    const world = new EcsWorld({ seed: 9 });
    world.spawn(Body.of({ x: 1 }));
    world.singleton(Turn).round = 12;
    const all = world.singleton(Everything);
    all.note = [1, { two: 2 }];
    all.when = new Date("2030-05-06T07:08:09Z");
    all.handle = { open: true };
    all.double = Math.PI;
    // Read, and never written.
    void world.singleton(Score).points;
    return world;
  };
  const listed = [Body, Turn.component, Score.component, Everything.component];

  it("is saved once it is written, and comes back as it was", () => {
    const world = written();
    const bytes = world.snapshot();
    const copy = new EcsWorld();
    copy.load(bytes, listed);
    expect(copy.hash()).toBe(world.hash());
    expect({ ...copy.singleton(Turn) }).toEqual({ player: 1, round: 12 });
    expect({ ...copy.singleton(Everything) }).toEqual({
      ...Everything.initial,
      note: [1, { two: 2 }],
      when: new Date("2030-05-06T07:08:09Z"),
      double: Math.PI,
      // Not saved.
      handle: undefined,
    });
    expect(copy.snapshot()).toEqual(bytes);
    // It goes on the same.
    copy.singleton(Turn).round++;
    world.singleton(Turn).round++;
    expect(copy.hash()).toBe(world.hash());
  });

  it("leaves one that was never written to the game that loads it", () => {
    const bytes = written().snapshot();
    // Only read, so not saved: the game that loads it starts it at its own
    // first value, whatever that is in its build.
    expect(
      readSnapshot(bytes).singletons.map((single) => single.component)
    ).not.toContain("sg/Score");
    const copy = new EcsWorld();
    copy.load(bytes, [Body, Turn.component, Everything.component]);
    expect({ ...copy.singleton(Score) }).toEqual(Score.initial);
    // And a world that only read a singleton before loading is still empty.
    const reader = new EcsWorld();
    expect(reader.singleton(Turn).round).toBe(0);
    reader.load(bytes, listed);
    expect(reader.singleton(Turn).round).toBe(12);
  });

  it("is refused by a world that has written one, or that does not know it as it was", () => {
    const bytes = written().snapshot();
    const wrote = new EcsWorld();
    wrote.singleton(Turn).round = 1;
    expect(problemOf(() => wrote.load(bytes, listed)).problem).toBe(
      "world not empty"
    );
    // One the world hasn't met is found by its definition.
    const found = new EcsWorld();
    found.load(bytes, [Body, Turn.component]);
    expect(found.singleton(Everything).double).toBe(Math.PI);
    // Another build's definitions, under names of their own, so that this
    // program's "sg/Turn" stays the one a load finds.
    const renamed = (to: string): Uint8Array => {
      const contents = readSnapshot(bytes);
      Migrate.renameComponent(contents, "sg/Turn", to);
      return writeSnapshot(contents);
    };
    const Shorter = Singleton.define(
      "sg/ShorterTurn",
      { player: Field.u8 },
      { player: 1 }
    );
    const changed = problemOf(() =>
      new EcsWorld().load(renamed("sg/ShorterTurn"), [
        Body,
        Shorter.component,
        Everything.component,
      ])
    );
    expect(changed.problem).toBe("component changed");
    expect(changed.message).toMatch(
      /Then: singleton \{ player: u8, round: u32 \}\. Now: singleton \{ player: u8 \}/
    );
    // A component of the same name and fields is not a singleton.
    const AsComponent = Component.define("sg/TurnAsComponent", {
      player: Field.u8,
      round: Field.u32,
    });
    const kind = problemOf(() =>
      new EcsWorld().load(renamed("sg/TurnAsComponent"), [
        Body,
        AsComponent,
        Everything.component,
      ])
    );
    expect(kind.problem).toBe("component changed");
    expect(kind.message).toMatch(/Then: singleton .* Now: table/);
    // A value its field cannot save is refused when the snapshot is taken.
    const world = written();
    // @ts-expect-error A function is not JSON.
    world.singleton(Everything).note = () => 1;
    const unsaved = problemOf(() => world.snapshot());
    expect(unsaved.problem).toBe("cannot be saved");
    expect(unsaved.message).toMatch(/"sg\/Everything\.note"/);
  });

  it("is refused when the bytes are cut short or do not hang together", () => {
    const bytes = written().snapshot();
    for (let length = bytes.length - 60; length < bytes.length; length++) {
      const error = problemOf(() =>
        new EcsWorld().load(bytes.subarray(0, length), listed)
      );
      expect(["truncated", "corrupt"]).toContain(error.problem);
    }
    const contents = readSnapshot(bytes);
    const twice = writeSnapshot({
      ...contents,
      singletons: [...contents.singletons, contents.singletons[0]!],
    });
    expect(problemOf(() => new EcsWorld().load(twice, listed)).message).toMatch(
      /two values for one singleton/
    );
    const inTable = writeSnapshot({
      ...contents,
      tables: [
        {
          components: ["sg/Body", "sg/Turn"],
          entities: contents.tables[0]!.entities,
          columns: {
            ...contents.tables[0]!.columns,
            "sg/Turn": contents.singletons.find(
              (each) => each.component === "sg/Turn"
            )!.columns,
          },
        },
      ],
    });
    expect(
      problemOf(() => new EcsWorld().load(inTable, listed)).message
    ).toMatch(/one that no table holds/);
    const asSingleton = writeSnapshot({
      ...contents,
      singletons: [
        ...contents.singletons,
        { component: "sg/Body", columns: { x: new Float32Array(1) } },
      ],
    });
    expect(
      problemOf(() => new EcsWorld().load(asSingleton, listed)).message
    ).toMatch(/a singleton is of a component that is not one/);
  });

  it("can still be read from a snapshot of the format before singletons", () => {
    const world = new EcsWorld({ seed: 2 });
    world.spawn(Body.of({ x: 5 }));
    const bytes = world.snapshot();
    // This world as the build that wrote format 2 wrote it. Format 1 is
    // format 2 without the count of singletons before the end.
    const second = Uint8Array.from(
      "414b57530200000079b860088046c1aa102e36af1289a87f01000000000000000000010000000700000073672f426f6479000100000001000000780001000000010000000000000001000000000000000000a0400000000000000000454e4421".match(
        /../gu
      )!,
      (byte) => Number.parseInt(byte, 16)
    );
    expect(new DataView(second.buffer).getUint32(4, true)).toBe(2);
    const old = new Uint8Array(second.length - 4);
    old.set(second.subarray(0, second.length - 8));
    old.set(second.subarray(second.length - 4), second.length - 8);
    new DataView(old.buffer).setUint32(4, 1, true);
    const copy = new EcsWorld();
    copy.load(old, [Body]);
    expect(copy.hash()).toBe(world.hash());
    expect(readSnapshot(old).singletons).toEqual([]);
    // Written again, it is in the format of today.
    expect(writeSnapshot(readSnapshot(old))).toEqual(bytes);
  });

  it("can still be read from a snapshot of format 3, which held its singletons after its entities", () => {
    const world = new EcsWorld({ seed: 2 });
    const body = world.spawn(Body.of({ x: 5 }));
    world.singleton(Turn).round = 12;
    // This world as the build that wrote format 3 wrote it: ids of eight
    // bytes, no stores, and the singletons last.
    const kind = (name: "f32" | "u8" | "u32"): number =>
      KIND_CODES.indexOf(name);
    const writer = new Writer(64);
    writer.u32(MAGIC);
    writer.u32(3);
    for (const word of world.random.state) {
      writer.u32(word);
    }
    // One slot, of generation 0, and none freed.
    writer.u32(1);
    writer.u32(0);
    writer.u32(0);
    // The components, in order of name.
    writer.u32(2);
    writer.text("sg/Body");
    writer.u8(0);
    writer.u32(1);
    writer.text("x");
    writer.u8(kind("f32"));
    writer.text("sg/Turn");
    writer.u8(2);
    writer.u32(2);
    writer.text("player");
    writer.u8(kind("u8"));
    writer.text("round");
    writer.u8(kind("u32"));
    // One table, of sg/Body, with one row.
    writer.u32(1);
    writer.u32(1);
    writer.u32(0);
    writer.u32(1);
    writer.f64(idOf(body));
    writer.numbers(new Float32Array([5]), 1, 4);
    // No sparse set, then the one singleton, sg/Turn.
    writer.u32(0);
    writer.u32(1);
    writer.u32(1);
    writer.u8(1);
    writer.u32(12);
    writer.u32(END);
    const third = writer.finish();

    const copy = new EcsWorld();
    copy.load(third, [Body, Turn.component]);
    expect(copy.hash()).toBe(world.hash());
    expect(copy.singleton(Turn).round).toBe(12);
    // Written again, it is in the format of today.
    expect(writeSnapshot(readSnapshot(third))).toEqual(world.snapshot());
  });

  it("describes itself, so a migration can change it by name", () => {
    const bytes = written().snapshot();
    const contents = readSnapshot(bytes);
    expect(writeSnapshot(contents)).toEqual(bytes);
    // In order of name, whatever order a migration leaves them in.
    expect(
      writeSnapshot({
        ...contents,
        singletons: contents.singletons.toReversed(),
      })
    ).toEqual(bytes);
    expect(contents.singletons.map((each) => each.component)).toEqual([
      "sg/Everything",
      "sg/Turn",
    ]);
    expect(contents.components.find((each) => each.name === "sg/Turn")).toEqual(
      {
        name: "sg/Turn",
        storage: "singleton",
        fields: [
          { name: "player", kind: "u8" },
          { name: "round", kind: "u32" },
        ],
      }
    );
    Migrate.renameComponent(contents, "sg/Turn", "sg/Clock");
    Migrate.renameField(contents, "sg/Clock", "round", "lap");
    Migrate.addField(contents, "sg/Clock", "speed", "f32", 2);
    Migrate.mapField(
      contents,
      "sg/Clock",
      "lap",
      "f64",
      (lap: number) => lap / 8
    );
    Migrate.removeField(contents, "sg/Clock", "player");
    Migrate.removeComponent(contents, "sg/Everything");
    const Clock = Singleton.define(
      "sg/Clock",
      { lap: Field.f64, speed: Field.f32 },
      { lap: 0, speed: 1 }
    );
    const copy = new EcsWorld();
    copy.load(writeSnapshot(contents), [Body, Clock.component]);
    expect({ ...copy.singleton(Clock) }).toEqual({ lap: 1.5, speed: 2 });
    expect(copy.component("sg/Everything")).toBeUndefined();
  });
});

describe("a singleton in a transaction", () => {
  it("is put back on rollback, and is unwritten again if it was", () => {
    const world = new EcsWorld();
    world.singleton(Score).points = 5;
    const before = world.hash();
    const turn = world.singleton(Turn);
    const score = world.singleton(Score);
    const all = world.singleton(Everything);

    world.begin();
    turn.round = 9;
    turn.player = 2;
    turn.round = 10;
    score.best = "eve";
    all.note = "rewritten";
    all.when = new Date(1);
    // Its own writes are there to be read.
    expect(turn.round).toBe(10);
    expect(world.hash()).not.toBe(before);
    world.rollback();
    expect({ ...turn }).toEqual({ player: 1, round: 0 });
    expect({ ...score }).toEqual({ points: 5, best: "nobody" });
    expect({ ...all }).toEqual({ ...Everything.initial });
    // Turn and Everything were never written, and are not again.
    expect(world.hash()).toBe(before);

    world.begin();
    turn.round = 9;
    world.commit();
    expect(turn.round).toBe(9);
    const kept = world.hash();
    expect(kept).not.toBe(before);
    world.begin();
    turn.round = 11;
    world.rollback();
    expect(turn.round).toBe(9);
    expect(world.hash()).toBe(kept);
  });
});

// --- in an app --------------------------------------------------------------------

class NotYourTurn extends Schema.TaggedError<NotYourTurn>()("NotYourTurn", {
  waitingFor: Schema.Number,
}) {}
class Caught extends Schema.TaggedError<Caught>()("Caught", {}) {}
const EndTurn = Action.define(
  "sg/EndTurn",
  Schema.Struct({ player: Schema.Int }),
  { refusals: [NotYourTurn] }
);
const Cheat = Action.define("sg/Cheat", Schema.Struct({}), {
  refusals: [Caught],
});

const endTurn = Action.handler(EndTurn, function* ({ player }) {
  const turn = yield* Turn.writes;
  if (turn.player !== player) {
    return yield* NotYourTurn.make({ waitingFor: turn.player });
  }
  turn.player = player === 1 ? 2 : 1;
  turn.round++;
  return turn.round;
});
const cheat = Action.handler(Cheat, function* () {
  const turn = yield* Turn.writes;
  const score = yield* Score.writes;
  turn.round += 100;
  score.points += 1000;
  score.best = "the cheat";
  return yield* Caught.make({});
});
const Reward = System.tick("Reward", function* () {
  const turn = yield* Turn.writes;
  const score = yield* Score.writes;
  if (turn.round > 0 && turn.round % 2 === 0) {
    score.points += turn.round;
    score.best = `player ${turn.player}`;
  }
});
const Rules = Plugin.make("sg/Rules", {
  systems: [Reward],
  handlers: [endTurn, cheat],
});

describe("a singleton in an app", () => {
  it("is what `yield*` gives a handler and a system, to read and to write", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const rounds: number[] = [];
        const Watch = System.tick("Watch", function* () {
          rounds.push((yield* Turn).round);
        });
        const app = yield* App.make(
          App.define({ plugins: [Rules], systems: [Watch] }),
          { checkpointEvery: 1 }
        );
        const world = yield* app.read(World);
        expect(app.dispatch(EndTurn, { player: 2 })).toEqual(
          Exit.fail(NotYourTurn.make({ waitingFor: 1 }))
        );
        expect(app.dispatch(EndTurn, { player: 1 })).toEqual(Exit.succeed(1));
        app.tick(1);
        expect(app.dispatch(EndTurn, { player: 2 })).toEqual(Exit.succeed(2));
        app.tick(1);
        expect({ ...world.singleton(Turn) }).toEqual({
          player: 1,
          round: 2,
        });
        expect({ ...world.singleton(Score) }).toEqual({
          points: 2,
          best: "player 1",
        });
        expect(rounds).toEqual([1, 2]);
        // No entity was needed for any of it.
        expect(world.entityCount).toBe(0);
        expect((yield* app.read(Query.all())).count()).toBe(0);
      })
    );
  });

  it("is as it was after a refused action, and the game replays", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const game = App.define({ plugins: [Rules] });
        const app = yield* App.make(game, { checkpointEvery: 1 });
        const world = yield* app.read(World);
        const before = world.hash();
        expect(Exit.isFailure(app.dispatch(Cheat, {}))).toBe(true);
        // Never written, so never there.
        expect(world.hash()).toBe(before);
        for (let move = 0; move < 12; move++) {
          app.dispatch(EndTurn, { player: (move % 2) + 1 });
          app.dispatch(Cheat, {});
          app.enqueue(Cheat, {});
          app.tick(1);
        }
        expect({ ...world.singleton(Turn) }).toEqual({
          player: 1,
          round: 12,
        });
        expect(world.singleton(Score).points).toBe(42);
        const played = app.record();
        const again = yield* Journal.replay(played, game, {
          checkpointEvery: 1,
        });
        expect((yield* again.read(World)).hash()).toBe(world.hash());
      })
    );
  });

  it("is saved with the game, and loaded by a game with no list of its components", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Rules] }), {
          checkpointEvery: 1,
        });
        const world = yield* app.read(World);
        for (let move = 0; move < 5; move++) {
          app.dispatch(EndTurn, { player: (move % 2) + 1 });
          app.tick(1);
        }
        const savedHash = world.hash();
        const save = app.save();
        if (Exit.isFailure(save)) {
          throw new Error("the save was refused");
        }
        const read = Save.decode(Save.encode(save.value));
        if (Exit.isFailure(read)) {
          throw new Error("the save did not decode");
        }
        const loaded = yield* App.make(App.define({ plugins: [Rules] }), {
          save: read.value,
          checkpointEvery: 1,
        });
        const loadedWorld = yield* loaded.read(World);
        expect(loadedWorld.hash()).toBe(world.hash());
        expect({ ...loadedWorld.singleton(Turn) }).toEqual({
          player: 2,
          round: 5,
        });
        expect(loaded.dispatch(EndTurn, { player: 2 })).toEqual(
          Exit.succeed(6)
        );
        app.dispatch(EndTurn, { player: 2 });
        loaded.tick(1);
        app.tick(1);
        expect(loadedWorld.hash()).toBe(world.hash());
        expect(loadedWorld.singleton(Score).points).toBe(12);

        // A game whose plugins name no components reads it as well: the
        // save finds them by their definitions.
        const bare = yield* App.make(
          App.define({ handlers: [endTurn], systems: [Reward] }),
          { save: read.value }
        );
        expect((yield* bare.read(World)).hash()).toBe(savedHash);
      })
    );
  });
});

describe("a cache rebuilt from the world, kept in a transient field of a singleton", () => {
  const Spot = Component.define("sg/Spot", { x: Field.i32 });
  /** Which spots are where: what a system would otherwise keep in a service. */
  const Index = Singleton.define(
    "sg/Index",
    { byX: Field.transient<Record<number, number>>() },
    { byX: undefined }
  );
  const Spots = Query.all(Spot);
  let built = 0;
  /** Reads the index, and builds it from the world when it has none. */
  const Look = System.tick("sg/Look", function* () {
    const index = yield* Index.writes;
    if (index.byX === undefined) {
      built++;
      const byX: Record<number, number> = {};
      (yield* Spots).each((spot) => {
        byX[spot.x] = (byX[spot.x] ?? 0) + 1;
      });
      index.byX = byX;
    }
  });
  class Refused extends Schema.TaggedError<Refused>()("sg/Refused", {}) {}
  const Clear = Action.define(
    "sg/Clear",
    Schema.Struct({ refuse: Schema.Boolean }),
    { refusals: [Refused] }
  );
  const clear = Action.handler(Clear, function* ({ refuse }) {
    (yield* Index.writes).byX = {};
    if (refuse) {
      return yield* Refused.make({});
    }
  });
  const Spotted = Plugin.make("sg/Spotted", {
    handlers: [clear],
    systems: [Look],
    setup: Effect.gen(function* () {
      const commands = yield* Commands.spawns(Spot);
      commands.spawn(Spot.of({ x: 1 }));
      commands.spawn(Spot.of({ x: 1 }));
      commands.spawn(Spot.of({ x: 2 }));
    }),
  });
  const Game = App.define({ plugins: [Spotted] });

  it("is built once, put back by a refused action, built again after a load, and kept by a rewind unless written since", () => {
    built = 0;
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(Game);
        const byX = () => Effect.map(app.read(Index), (index) => index.byX);
        app.tick(1);
        app.tick(1);
        expect(built).toBe(1);
        expect(yield* byX()).toEqual({ 1: 2, 2: 1 });
        // A refused action's replacement is undone with the rest of it.
        expect(Exit.isFailure(app.dispatch(Clear, { refuse: true }))).toBe(
          true
        );
        expect(yield* byX()).toEqual({ 1: 2, 2: 1 });
        const moment = Timeline.capture(app);
        expect(Exit.isSuccess(moment)).toBe(true);
        // A save doesn't hold it: the loaded game builds it again.
        const save = app.save();
        expect(Exit.isSuccess(save)).toBe(true);
        if (Exit.isFailure(save) || Exit.isFailure(moment)) {
          return;
        }
        const loaded = yield* App.make(Game, { save: save.value });
        expect((yield* loaded.read(Index)).byX).toBeUndefined();
        loaded.tick(1);
        expect(built).toBe(2);
        expect((yield* loaded.read(Index)).byX).toEqual({ 1: 2, 2: 1 });
        // A rewind keeps it, since nothing wrote the singleton since.
        Timeline.rewind(app, moment.value);
        expect(yield* byX()).toEqual({ 1: 2, 2: 1 });
        app.tick(1);
        expect(built).toBe(2);
        // Written since the moment, it is put back empty: the next tick
        // builds it again.
        expect(Exit.isSuccess(app.dispatch(Clear, { refuse: false }))).toBe(
          true
        );
        Timeline.rewind(app, moment.value);
        expect(yield* byX()).toBeUndefined();
        app.tick(1);
        expect(built).toBe(3);
        expect(yield* byX()).toEqual({ 1: 2, 2: 1 });
      })
    );
  });
});
