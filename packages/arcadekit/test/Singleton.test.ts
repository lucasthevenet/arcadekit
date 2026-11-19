import { Cause, Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  CommandBuffer,
  Component,
  EcsWorld,
  Field,
  Migrate,
  Plugin,
  Query,
  readSnapshot,
  Save,
  Script,
  Singleton,
  SnapshotError,
  System,
  writeSnapshot,
} from "../src/index";

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
    note: Field.json<unknown>(),
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

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

const problemOf = (attempt: () => void): SnapshotError => {
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
    expect({ ...turn }).toStrictEqual({ player: 1, round: 0 });
    turn.player = 2;
    turn.round += 3;
    // One value per world, whoever asks.
    expect(world.singleton(Turn)).toBe(turn);
    expect(world.singleton(Turn).round).toBe(3);
    expect(Object.keys(turn)).toStrictEqual(["player", "round"]);
    // A field keeps what its kind can hold, as a component's does.
    turn.player = 257;
    expect(turn.player).toBe(1);
    // Another world has its own.
    expect({ ...new EcsWorld().singleton(Turn) }).toStrictEqual({
      player: 1,
      round: 0,
    });
  });

  it("has fields of every kind", () => {
    const world = new EcsWorld();
    const all = world.singleton(Everything);
    expect({ ...all }).toStrictEqual({ ...Everything.initial });
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
      /"sg\/Turn" is a singleton.*World\.singleton\(\)/u
    );
    const entity = world.spawn(Body.of({ x: 1 }));
    expect(() => world.add(entity, Turn.component.of(Turn.initial))).toThrow(
      /is a singleton/u
    );
    expect(world.entityCount).toBe(1);
    // Queued, it is refused where the mistake is, and leaves no id behind.
    const commands = new CommandBuffer(world);
    expect(() => commands.spawn(Body, Turn.component)).toThrow(
      /is a singleton/u
    );
    expect(() => commands.add(entity, Turn.component)).toThrow(
      /is a singleton/u
    );
    expect(commands.size).toBe(0);
    expect(world.spawn(Body)).toBe(entity + 1);
    world.singleton(Turn);
    expect(world.component("sg/Turn")).toBe(Turn.component);
    const clash = Component.define("sg/Turn", { player: Field.u8 });
    expect(() => world.spawn(clash)).toThrow(
      /Two different components are both named "sg\/Turn"/u
    );
    expect(() =>
      world.singleton({ component: Body, initial: { x: 0 } })
    ).toThrow(/"sg\/Body" is a component, not a singleton/u);
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
    expect({ ...copy.singleton(Turn) }).toStrictEqual({ player: 1, round: 12 });
    expect({ ...copy.singleton(Everything) }).toStrictEqual({
      ...Everything.initial,
      note: [1, { two: 2 }],
      when: new Date("2030-05-06T07:08:09Z"),
      double: Math.PI,
      // Not saved.
      handle: undefined,
    });
    expect(copy.snapshot()).toStrictEqual(bytes);
    // It goes on the same.
    copy.singleton(Turn).round += 1;
    world.singleton(Turn).round += 1;
    expect(copy.hash()).toBe(world.hash());
  });

  it("leaves one that was never written to the game that loads it", () => {
    const bytes = written().snapshot();

    // The same name and fields, another first value: a newer build.
    const Rescored = Singleton.define(
      "sg/Score",
      { points: Field.f64, best: Field.json<string>() },
      { points: 100, best: "the house" }
    );

    const copy = new EcsWorld();
    copy.load(bytes, [Body, Turn.component, Everything.component]);
    expect({ ...copy.singleton(Rescored) }).toStrictEqual({
      points: 100,
      best: "the house",
    });
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

    const unknown = problemOf(() =>
      new EcsWorld().load(bytes, [Body, Turn.component])
    );

    expect(unknown.problem).toBe("unknown component");
    expect(unknown.component).toBe("sg/Everything");

    const Shorter = Singleton.define(
      "sg/Turn",
      { player: Field.u8 },
      { player: 1 }
    );

    const changed = problemOf(() =>
      new EcsWorld().load(bytes, [
        Body,
        Shorter.component,
        Everything.component,
      ])
    );

    expect(changed.problem).toBe("component changed");
    expect(changed.message).toMatch(
      /Then: singleton \{ player: u8, round: u32 \}\. Now: singleton \{ player: u8 \}/u
    );

    // A component of the same name and fields is not a singleton.
    const AsComponent = Component.define("sg/Turn", {
      player: Field.u8,
      round: Field.u32,
    });

    const kind = problemOf(() =>
      new EcsWorld().load(bytes, [Body, AsComponent, Everything.component])
    );

    expect(kind.problem).toBe("component changed");
    expect(kind.message).toMatch(/Then: singleton .* Now: table/u);
    // A value its field cannot save is refused when the snapshot is taken.
    const world = written();
    world.singleton(Everything).note = () => 1;
    const unsaved = problemOf(() => world.snapshot());
    expect(unsaved.problem).toBe("cannot be saved");
    expect(unsaved.message).toMatch(/"sg\/Everything\.note"/u);
  });

  it("is refused when the bytes are cut short or do not hang together", () => {
    const bytes = written().snapshot();

    for (let length = bytes.length - 60; length < bytes.length; length += 1) {
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
      /two values for one singleton/u
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
    ).toMatch(/one that no table holds/u);

    const asSingleton = writeSnapshot({
      ...contents,
      singletons: [
        ...contents.singletons,
        { component: "sg/Body", columns: { x: new Float32Array(1) } },
      ],
    });

    expect(
      problemOf(() => new EcsWorld().load(asSingleton, listed)).message
    ).toMatch(/a singleton is of a component that is not one/u);
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
    old.set(second.subarray(0, -8));
    old.set(second.subarray(-4), second.length - 8);
    new DataView(old.buffer).setUint32(4, 1, true);
    const copy = new EcsWorld();
    copy.load(old, [Body]);
    expect(copy.hash()).toBe(world.hash());
    expect(readSnapshot(old).singletons).toStrictEqual([]);
    // Written again, it is in the format of today.
    expect(writeSnapshot(readSnapshot(old))).toStrictEqual(bytes);
  });

  it("describes itself, so a migration can change it by name", () => {
    const bytes = written().snapshot();
    const contents = readSnapshot(bytes);
    expect(writeSnapshot(contents)).toStrictEqual(bytes);
    // In order of name, whatever order a migration leaves them in.
    expect(
      writeSnapshot({
        ...contents,
        singletons: contents.singletons.toReversed(),
      })
    ).toStrictEqual(bytes);
    expect(contents.singletons.map((each) => each.component)).toStrictEqual([
      "sg/Everything",
      "sg/Turn",
    ]);
    expect(
      contents.components.find((each) => each.name === "sg/Turn")
    ).toStrictEqual({
      name: "sg/Turn",
      storage: "singleton",
      fields: [
        { name: "player", kind: "u8" },
        { name: "round", kind: "u32" },
      ],
    });
    Migrate.renameComponent(contents, "sg/Turn", "sg/Clock");
    Migrate.renameField(contents, "sg/Clock", "round", "lap");
    Migrate.addField(contents, "sg/Clock", "speed", "f32", 2);
    Migrate.mapField(contents, "sg/Clock", "lap", "f64", (lap) => lap / 8);
    Migrate.removeField(contents, "sg/Clock", "player");
    Migrate.removeComponent(contents, "sg/Everything");

    const Clock = Singleton.define(
      "sg/Clock",
      { lap: Field.f64, speed: Field.f32 },
      { lap: 0, speed: 1 }
    );

    const copy = new EcsWorld();
    copy.load(writeSnapshot(contents), [Body, Clock.component]);
    expect({ ...copy.singleton(Clock) }).toStrictEqual({ lap: 1.5, speed: 2 });
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
    expect({ ...turn }).toStrictEqual({ player: 1, round: 0 });
    expect({ ...score }).toStrictEqual({ points: 5, best: "nobody" });
    expect({ ...all }).toStrictEqual({ ...Everything.initial });
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

const EndTurn = Action.define(
  "sg/EndTurn",
  Schema.Struct({ player: Schema.Int })
);

const Cheat = Action.define("sg/Cheat", Schema.Struct({}));

class NotYourTurn extends Data.TaggedError("NotYourTurn")<{
  readonly waitingFor: number;
}> {}

class Caught extends Data.TaggedError("Caught") {}

const endTurn = Action.handler(EndTurn, function* ({ player }) {
  const turn = yield* Turn;

  if (turn.player !== player) {
    return yield* Effect.fail(new NotYourTurn({ waitingFor: turn.player }));
  }

  turn.player = player === 1 ? 2 : 1;
  turn.round += 1;

  return turn.round;
});

const cheat = Action.handler(Cheat, function* () {
  const turn = yield* Turn;
  const score = yield* Score;
  turn.round += 100;
  score.points += 1000;
  score.best = "the cheat";

  return yield* Effect.fail(new Caught());
});

const Reward = System.make("Reward", function* () {
  const turn = yield* Turn;
  const score = yield* Score;

  if (turn.round > 0 && turn.round % 2 === 0) {
    score.points += turn.round;
    score.best = `player ${turn.player}`;
  }
});

const Rules = Plugin.make("sg/Rules", {
  components: [Turn, Score],
  systems: [Reward],
  handlers: [endTurn, cheat],
});

describe("a singleton in an app", () => {
  it("is what `yield*` gives a handler, a system and a script, to read and to write", () => {
    run(
      Effect.gen(function* () {
        const app = yield* App.make({ plugins: [Rules], checkpointEvery: 1 });
        const rounds: number[] = [];
        app.spawnScript(
          Effect.gen(function* () {
            const script = yield* Script;

            for (;;) {
              rounds.push((yield* Turn).round);
              yield* script.nextTick;
            }
          })
        );
        expect(app.dispatch(EndTurn, { player: 2 })).toStrictEqual(
          Exit.fail(new NotYourTurn({ waitingFor: 1 }))
        );
        expect(app.dispatch(EndTurn, { player: 1 })).toStrictEqual(
          Exit.succeed(1)
        );
        app.tick(1);
        expect(app.dispatch(EndTurn, { player: 2 })).toStrictEqual(
          Exit.succeed(2)
        );
        app.tick(1);
        expect({ ...app.world.singleton(Turn) }).toStrictEqual({
          player: 1,
          round: 2,
        });
        expect({ ...app.world.singleton(Score) }).toStrictEqual({
          points: 2,
          best: "player 1",
        });
        expect(rounds).toStrictEqual([0, 1, 2]);
        // No entity was needed for any of it.
        expect(app.world.entityCount).toBe(0);
        expect(app.world.view(Query.all()).count()).toBe(0);
      })
    );
  });

  it("is as it was after a refused action, and the game replays", () => {
    run(
      Effect.gen(function* () {
        const app = yield* App.make({ plugins: [Rules], checkpointEvery: 1 });
        const before = app.world.hash();
        expect(Exit.isFailure(app.dispatch(Cheat, {}))).toBe(true);
        // Never written, so never there.
        expect(app.world.hash()).toBe(before);

        for (let move = 0; move < 12; move += 1) {
          app.dispatch(EndTurn, { player: (move % 2) + 1 });
          app.dispatch(Cheat, {});
          app.enqueue(Cheat, {});
          app.tick(1);
        }

        expect({ ...app.world.singleton(Turn) }).toStrictEqual({
          player: 1,
          round: 12,
        });
        expect(app.world.singleton(Score).points).toBe(42);

        const again = yield* App.make({
          plugins: [Rules],
          checkpointEvery: 1,
        });

        App.replay(again, app.actionLog, { delta: 1, ticks: 12 });
        expect(again.world.hash()).toBe(app.world.hash());
      })
    );
  });

  it("is saved with the game, and loaded by a game that lists it", () => {
    run(
      Effect.gen(function* () {
        const app = yield* App.make({ plugins: [Rules], checkpointEvery: 1 });

        for (let move = 0; move < 5; move += 1) {
          app.dispatch(EndTurn, { player: (move % 2) + 1 });
          app.tick(1);
        }

        const save = app.save();

        if (Exit.isFailure(save)) {
          throw new Error("the save was refused");
        }

        const read = Save.decode(Save.encode(save.value));

        if (Exit.isFailure(read)) {
          throw new Error("the save did not decode");
        }

        const loaded = yield* App.load(read.value, {
          plugins: [Rules],
          checkpointEvery: 1,
        });

        expect(loaded.world.hash()).toBe(app.world.hash());
        expect({ ...loaded.world.singleton(Turn) }).toStrictEqual({
          player: 2,
          round: 5,
        });
        expect(loaded.dispatch(EndTurn, { player: 2 })).toStrictEqual(
          Exit.succeed(6)
        );
        app.dispatch(EndTurn, { player: 2 });
        loaded.tick(1);
        app.tick(1);
        expect(loaded.world.hash()).toBe(app.world.hash());
        expect(loaded.world.singleton(Score).points).toBe(12);

        // A game that does not list it cannot read the save, and says why.
        const refused = yield* Effect.exit(
          App.load(read.value, { handlers: [endTurn], systems: [Reward] })
        );

        expect(
          Exit.isFailure(refused) ? Cause.squash(refused.cause) : undefined
        ).toMatchObject({
          _tag: "LoadRefused",
          problem: "unknown component",
          message: expect.stringMatching(
            /"sg\/Score".*List it in a plugin's `components`/u
          ),
        });
      })
    );
  });
});
