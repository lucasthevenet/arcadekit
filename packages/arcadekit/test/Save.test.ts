import { Cause, Data, Effect, Exit, Option, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
  Event,
  Field,
  Journal,
  Plugin,
  Query,
  Random,
  Save,
  System,
  Time,
  readSnapshot,
  writeSnapshot,
} from "../src/index";

/** What one store of a save's world held. */
const stored = (save: Save.Save, name: string): unknown =>
  readSnapshot(save.world).stores.find((store) => store.name === name)?.data;

/** The actions a save's world holds, queued for the next tick. */
const queuedIn = (save: Save.Save): unknown[] =>
  (stored(save, Action.INTAKE) as { queued: unknown[] } | undefined)?.queued ??
  [];

// --- a game with everything a save has to carry -----------------------------------

const Tally = Component.define("sv/Tally", {
  value: Field.f64,
  heard: Field.u32,
  rejections: Field.u32,
  pulses: Field.u32,
  echoes: Field.u32,
});
const Mote = Component.define("sv/Mote", {
  x: Field.f32,
  name: Field.json<string>(),
});
const Tallies = Query.all(Tally).pipe(Query.writes(Tally));
const Motes = Query.all(Mote).pipe(Query.writes(Mote));

const Add = Action.define("sv/Add", Schema.Struct({ by: Schema.Int }));
const Double = Action.define("sv/Double", Schema.Struct({}));
const Scatter = Action.define(
  "sv/Scatter",
  Schema.Struct({ count: Schema.Int })
);
const Pulse = Action.define("sv/Pulse", Schema.Struct({}));
class TooBig extends Data.TaggedError("TooBig")<{}> {}

const add = Action.handler(Add, function* ({ by }) {
  (yield* Tallies).each((tally) => {
    tally.value += by;
  });
});
// Doubling and adding do not commute, so the tally shows any change of order.
const double = Action.handler(Double, function* () {
  let refuse = false;
  (yield* Tallies).each((tally) => {
    tally.value *= 2;
    refuse = tally.value > 1e9;
  });
  if (refuse) {
    return yield* new TooBig();
  }
});
const scatter = Action.handler(Scatter, function* ({ count }) {
  const random = yield* Random;
  const commands = yield* Commands;
  for (let i = 0; i < count; i++) {
    commands.spawn(
      Mote.of({ x: random.next(), name: `mote ${random.int(1, 99)}` })
    );
  }
});
const pulse = Action.handler(Pulse, function* () {
  (yield* Tallies).each((tally) => {
    tally.pulses++;
  });
});

/** Emitted by the last system and read by the first, so it waits a tick. */
const Sounded = Event.define(
  "sv/Sounded",
  Schema.Struct({ tick: Schema.Int, at: Schema.Date })
);

let ticksRun = 0;
const Listen = System.make("Listen", function* () {
  ticksRun++;
  const sounded = (yield* Sounded).read();
  const refused = (yield* Action.Rejected).read().length;
  (yield* Tallies).each((tally) => {
    for (const sound of sounded) {
      // The date is a Date here, as it was emitted: seconds since 1970.
      tally.heard += sound.at.getTime() / 1000;
    }
    tally.rejections += refused;
  });
});
const Drift = System.make("Drift", function* () {
  const random = yield* Random;
  const commands = yield* Commands;
  (yield* Motes).each((mote, entity) => {
    mote.x += random.next() - 0.5;
    if (random.int(1, 12) === 1) {
      commands.despawn(entity);
    }
  });
});
/** An AI: it issues actions of its own, which wait for the next tick. */
const Bot = System.make("Bot", function* () {
  const { tick } = yield* Time;
  const actions = yield* Action.Actions;
  if (tick % 3 === 0) {
    actions.enqueue(Add, { by: 7 });
  }
  if (tick % 4 === 0) {
    actions.enqueue(Double, {});
  }
});
const Sound = System.make("Sound", function* () {
  const { tick } = yield* Time;
  const sounded = yield* Sounded;
  sounded.emit({ tick, at: new Date(tick * 1000) });
  // Read by this system at once, and by Listen on the next tick: the two
  // have read different amounts when a save is taken. Each event is counted
  // once here, so reading one again after a load would show.
  const echoes = sounded.read().length;
  (yield* Tallies).each((tally) => {
    tally.echoes += echoes;
  });
});

let setups = 0;
/** Fires a pulse every fifth tick: what it does follows from the time. */
const Pulsing = System.make("Pulsing", function* () {
  if ((yield* Time).tick % 5 === 0) {
    (yield* Action.Actions).enqueue(Pulse, {});
  }
});

const Game = Plugin.make("sv/Game", {
  systems: [Listen, Drift, Bot, Sound, Pulsing],
  handlers: [add, double, scatter, pulse],
  setup: Effect.gen(function* () {
    setups++;
    const commands = yield* Commands;
    commands.spawn(
      Tally.of({ value: 1, heard: 0, rejections: 0, pulses: 0, echoes: 0 })
    );
    commands.spawn(Mote.of({ x: 0, name: "first" }));
  }),
});
const Played = App.define({ plugins: [Game] });
const start = { seed: 21, checkpointEvery: 1 } as const;

const withApp = <T, E, A>(
  make: Effect.Effect<T, E, Scope.Scope>,
  use: (app: T) => A
): A => Effect.runSync(Effect.scoped(Effect.map(make, use)));

type GameApp = Effect.Success<
  ReturnType<typeof App.make<[], [], [typeof Game]>>
>;

/** Moves from outside, decided by the tick alone. */
const move = (app: GameApp, tick: number): void => {
  const dice = new EcsWorld({ seed: tick + 1 }).random;
  for (let n = dice.int(0, 2); n > 0; n--) {
    const choice = dice.int(1, 5);
    if (choice === 1) {
      app.enqueue(Add, { by: dice.int(1, 5) });
    } else if (choice === 2) {
      app.dispatch(Scatter, { count: dice.int(1, 3) });
    } else if (choice === 3) {
      app.enqueueByName("sv/Double", {});
    } else if (choice === 4) {
      app.dispatch(Add, { by: dice.int(1, 5) });
    } else {
      app.enqueueByName("sv/Add", { by: "not a number" });
    }
  }
};

const unwrap = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause);
  }
  return exit.value;
};
const refusal = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a refusal");
  }
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

/** Plays `ticks` ticks, saving after tick `saveAt`. */
const record = (ticks: number, saveAt: number) =>
  withApp(App.make(Played, start), (app) => {
    let save: Save.Save | undefined;
    let saved: { tick: number; elapsed: number; delta: number } | undefined;
    const hashes: number[] = [];
    for (let tick = 0; tick < ticks; tick++) {
      if (tick === saveAt) {
        // After this tick's moves have arrived, so that some are waiting.
        move(app, tick);
        save = unwrap(app.save());
        saved = { ...app.time };
      } else {
        move(app, tick);
      }
      app.tick(1 / 60);
      hashes.push(app.world.hash());
    }
    return {
      save: save!,
      saved: saved!,
      hashes,
      tail: app.record(save!),
      tally: app.world
        .view(Tallies)
        .entities()
        .map((e) => app.world.get(e, Tally)),
      time: { ...app.time },
    };
  });

describe("a saved game", () => {
  it("loads into a game that goes on exactly as the saved one did", () => {
    for (const saveAt of [0, 1, 7, 30, 59]) {
      const recorded = record(90, saveAt);
      const { save, saved } = recorded;
      expect(saved.tick).toBe(saveAt);
      expect(saved.delta).toBe(saveAt === 0 ? 0 : 1 / 60);
      withApp(App.make(Played, { save, checkpointEvery: 1 }), (app) => {
        // The world holds the game's time, so the save brings it back.
        expect(app.time).toEqual(saved);
        // The log starts again.
        expect(app.actionLog).toEqual([]);
      });
      // What the game logged after the save is replayed from the save, which
      // the recording holds, against the checkpoints it took after every tick.
      const resumed = withApp(
        Journal.replay(
          App.make(Played, { ...recorded.tail, checkpointEvery: 1 }),
          recorded.tail
        ),
        (app) => ({
          hash: app.world.hash(),
          tally: app.world
            .view(Tallies)
            .entities()
            .map((e) => app.world.get(e, Tally)),
          time: { ...app.time },
          log: [...app.actionLog],
        })
      );
      expect(resumed.hash).toBe(recorded.hashes.at(-1));
      expect(resumed.tally).toEqual(recorded.tally);
      expect(resumed.time.tick).toBe(90);
      expect(resumed.time.elapsed).toBeCloseTo(recorded.time.elapsed, 9);
      // Its first entry is the checkpoint of the state it was loaded in.
      expect(Action.isCheckpoint(resumed.log[0]!)).toBe(true);
      expect(resumed.log[0]!.tick).toBe(saveAt);
    }
    // The game was a busy one: actions refused, events heard, pulses fired.
    const [tally] = record(90, 5).tally;
    expect(tally!.rejections).toBeGreaterThan(5);
    expect(tally!.heard).toBeGreaterThan(1000);
    expect(tally!.pulses).toBeGreaterThan(10);
  });

  it("is not given a seed as well: it holds where the random sequence had got to", () => {
    const { save } = record(3, 1);
    expect(() =>
      // @ts-expect-error a save and a seed are not given together
      withApp(App.make(Played, { save, seed: 4 }), () => 0)
    ).toThrow(
      /App\.make was given a save and the seed 4\..* give one of the two/
    );
  });

  it("holds the actions that were waiting, the simulation's own among them, and applies them in order", () => {
    withApp(App.make(Played, { seed: 21, checkpointEvery: 0 }), (app) => {
      for (let i = 0; i < 12; i++) {
        app.tick(1);
      }
      // Tick 12 divides by 3 and by 4: the bot has enqueued an Add and a
      // Double. Then two more arrive from outside.
      app.enqueue(Add, { by: 100 });
      app.enqueueByName("sv/Double", {});
      const save = unwrap(app.save());
      expect(queuedIn(save)).toEqual([
        { name: "sv/Add", payload: { by: 7 } },
        { name: "sv/Double", payload: {} },
        { name: "sv/Add", payload: { by: 100 } },
        { name: "sv/Double", payload: {} },
      ]);
      app.tick(1);
      const expected = app.world.hash();
      const loaded = withApp(
        App.make(Played, { save, checkpointEvery: 1 }),
        (other) => {
          other.tick(1);
          return other.world.hash();
        }
      );
      expect(loaded).toBe(expected);
    });
  });

  it("gives a waiting action its payload back as the value it was, not as its JSON", () => {
    const stamps: unknown[] = [];
    const Stamp = Action.define(
      "sv/Stamp",
      Schema.Struct({ at: Schema.Date, big: Schema.BigInt })
    );
    const stamp = Action.handler(Stamp, function* ({ at, big }) {
      stamps.push([at instanceof Date && at.getTime(), typeof big, big]);
    });
    const Issue = System.make("Issue", function* () {
      (yield* Action.Actions).enqueue(Stamp, {
        at: new Date(86_400_000),
        big: 5n,
      });
    });
    const Stamped = App.define({ systems: [Issue], handlers: [stamp] });
    const save = withApp(App.make(Stamped), (app) => {
      app.tick(1);
      const taken = unwrap(app.save());
      expect(queuedIn(taken)).toEqual([
        {
          name: "sv/Stamp",
          payload: { at: "1970-01-02T00:00:00.000Z", big: "5" },
        },
      ]);
      return taken;
    });
    stamps.length = 0;
    withApp(App.make(Stamped, { save }), (app) => {
      app.tick(1);
    });
    expect(stamps).toEqual([[86_400_000, "bigint", 5n]]);
  });

  it("holds the events that were waiting, and how far each system had read them", () => {
    withApp(App.make(Played, { seed: 21, checkpointEvery: 0 }), (app) => {
      for (let i = 0; i < 4; i++) {
        app.tick(1);
      }
      const save = unwrap(app.save());
      // The event of tick 4 is waiting, in the world: Sound has read it,
      // Listen has not.
      expect(stored(save, Event.STORE)).toEqual([
        {
          name: "sv/Sounded",
          waiting: [{ tick: 4, at: "1970-01-01T00:00:04.000Z" }],
          read: { Sound: 1 },
        },
      ]);
      const heard = (of: GameApp) =>
        of.world.get(of.world.view(Tallies).entities()[0]!, Tally)!.heard;
      expect(heard(app)).toBe(1 + 2 + 3);
      app.tick(1);
      app.tick(1);
      const expected = heard(app);
      expect(expected).toBe(1 + 2 + 3 + 4 + 5);
      // Loaded, Listen hears tick 4 once, on the next tick, and no more.
      withApp(App.make(Played, { save, checkpointEvery: 1 }), (other) => {
        expect(other.events.pending(Sounded)).toBe(1);
        other.tick(1);
        expect(heard(other)).toBe(1 + 2 + 3 + 4);
        other.tick(1);
        expect(heard(other)).toBe(expected);
        expect(other.world.hash()).toBe(app.world.hash());
      });
    });
  });

  it("does not run setup again, and the game goes on", () => {
    setups = 0;
    const save = withApp(App.make(Played, start), (app) => {
      expect(setups).toBe(1);
      app.tick(1);
      return unwrap(app.save());
    });
    withApp(App.make(Played, { save, checkpointEvery: 1 }), (app) => {
      expect(setups).toBe(1);
      // One tally and whatever motes the game had: none spawned twice.
      expect(app.world.view(Tallies).count()).toBe(1);
      // It goes on: on the fifth tick it fires a pulse.
      for (let i = 0; i < 6; i++) {
        app.tick(1);
      }
      expect(
        app.world.get(app.world.view(Tallies).entities()[0]!, Tally)!.pulses
      ).toBe(1);
    });
  });

  it("costs the same to load after a long game as after a short one", () => {
    // A save is the world as it is, and the log since: loading replays the
    // ticks after the save, however many came before it.
    const ticksToLoad = (ticks: number, saveAt: number): number => {
      const recorded = record(ticks, saveAt);
      ticksRun = 0;
      withApp(
        Journal.replay(
          App.make(Played, { ...recorded.tail, checkpointEvery: 1 }),
          recorded.tail
        ),
        (app) => {
          expect(app.world.hash()).toBe(recorded.hashes.at(-1));
        }
      );
      return ticksRun;
    };
    expect(ticksToLoad(20, 10)).toBe(10);
    expect(ticksToLoad(1500, 1490)).toBe(10);
  });

  it("goes through bytes and back", () => {
    const recorded = record(40, 20);
    const bytes = Save.encode(recorded.save);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = unwrap(Save.decode(bytes));
    expect(decoded).toEqual(recorded.save);
    // It is the world's snapshot and a little text.
    expect(bytes.length).toBeLessThan(recorded.save.world.length + 600);
    // The game goes on from the save that was read as it did from the one
    // that was written.
    withApp(
      Journal.replay(
        App.make(Played, { save: decoded, checkpointEvery: 1 }),
        recorded.tail
      ),
      (app) => {
        expect(app.world.hash()).toBe(recorded.hashes.at(-1));
      }
    );
    // A view into a larger buffer reads as itself.
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 5);
    expect(unwrap(Save.decode(padded.subarray(5, 5 + bytes.length)))).toEqual(
      recorded.save
    );
  });
});

describe("a game that cannot be saved as it stands", () => {
  const Blob = Component.define("sv/Blob", { v: Field.json<unknown>() });

  it("says which action is waiting with a payload its schema does not take", () => {
    const Small = Action.define(
      "sv/Small",
      Schema.Struct({
        n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
      })
    );
    const small = Action.handler(Small, function* () {});
    const Issue = System.make("Issue", function* () {
      (yield* Action.Actions).enqueue(Small, { n: 9 });
    });
    withApp(
      App.make(App.define({ systems: [Issue], handlers: [small] })),
      (app) => {
        app.tick(1);
        expect(refusal(app.save()).message).toMatch(
          /^Can't save the actions queued for the next tick: the action "sv\/Small" has a payload its schema does not take/
        );
      }
    );
  });

  it("says which field holds what cannot be saved, and that commands are queued", () => {
    withApp(App.make(App.define({})), (app) => {
      const entity = app.world.spawn(Blob.of({ v: () => 1 }));
      expect(refusal(app.save()).message).toContain('"sv/Blob.v"');
      app.world.set(entity, Blob, { v: "fine" });
      expect(Exit.isSuccess(app.save())).toBe(true);
      app.commands.despawn(entity);
      expect(refusal(app.save()).message).toMatch(
        /1 commands are queued and not applied/
      );
      app.tick(1);
      expect(Exit.isSuccess(app.save())).toBe(true);
    });
  });

  it("is not saved in the middle of a tick", () => {
    let app: App.Any | undefined;
    let thrown: unknown;
    const Greedy = System.make("Greedy", function* () {
      try {
        app!.save();
      } catch (error) {
        thrown = error;
      }
    });
    withApp(App.make(App.define({ systems: [Greedy] })), (made) => {
      app = made;
      made.tick(1);
    });
    expect(String(thrown)).toMatch(/save\(\) was called during a tick/);
  });
});

describe("a save that cannot be loaded", () => {
  const load = (save: Save.Save, game: object = Played) =>
    Effect.runSync(
      Effect.scoped(
        Effect.exit(
          App.make(game as typeof Played, { save, checkpointEvery: 1 })
        )
      )
    );

  it("says how a component has changed since the save was taken", () => {
    // The game as it was, and as a later build of it defines the component.
    const Before = Component.define("sv/Shifting", { x: Field.f32 });
    const save = withApp(App.make(App.define({})), (app) => {
      app.world.spawn(Before.of({ x: 1 }));
      return unwrap(app.save());
    });
    Component.define("sv/Shifting", { x: Field.f64 });
    const error = refusal(load(save, App.define({})));
    expect(error.problem).toBe("component changed");
    expect(error.message).toContain("x: f32");
    expect(error.message).toContain("x: f64");
  });

  it("is refused when its world is damaged", () => {
    const { save } = record(10, 5);
    const error = refusal(
      load({ ...save, world: save.world.subarray(0, save.world.length - 9) })
    );
    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(["truncated", "corrupt"]).toContain(error.problem);
    expect(refusal(load({ ...save, world: new Uint8Array(40) })).problem).toBe(
      "not a snapshot"
    );
  });

  it("is refused as bytes that are not a save, or are cut short, or damaged", () => {
    const bytes = Save.encode(record(10, 5).save);
    const problem = (given: Uint8Array) => refusal(Save.decode(given)).problem;
    expect(problem(new Uint8Array(0))).toBe("not a save");
    expect(problem(new TextEncoder().encode("<html>no</html>"))).toBe(
      "not a save"
    );
    expect(refusal(Save.decode(new Uint8Array(30)))).toBeInstanceOf(
      Save.LoadRefused
    );
    const newer = Uint8Array.from(bytes);
    new DataView(newer.buffer).setUint32(4, 9, true);
    expect(problem(newer)).toBe("newer format");
    // Cut inside the text that comes before the world.
    expect(problem(bytes.subarray(0, 20))).toBe("truncated");
    // The text between the header and the world: no longer JSON, then JSON
    // of another shape, then not text at all.
    const length = new DataView(bytes.buffer).getUint32(8, true);
    const broken = Uint8Array.from(bytes);
    broken[12] = 0x78;
    expect(problem(broken)).toBe("corrupt");
    const negative = Uint8Array.from(bytes);
    const text = new TextDecoder().decode(bytes.subarray(12, 12 + length));
    expect(text).toContain('"logLength":1');
    negative.set(
      new TextEncoder().encode(text.replace('"logLength":1', '"logLength":-1')),
      12
    );
    expect(problem(negative)).toBe("corrupt");
    // Whole JSON that is not a save's: a member under another name.
    const reshaped = Uint8Array.from(bytes);
    expect(text).toContain('"logLength"');
    reshaped.set(
      new TextEncoder().encode(text.replace('"logLength"', '"logLengtx"')),
      12
    );
    expect(problem(reshaped)).toBe("corrupt");
    const notText = Uint8Array.from(bytes);
    notText[20] = 0xff;
    expect(problem(notText)).toBe("corrupt");
    // Cut inside the world: the save's own shape is whole, and the world
    // is found short when it is loaded.
    const short = unwrap(Save.decode(bytes.subarray(0, bytes.length - 5)));
    expect(refusal(load(short))).toBeInstanceOf(Save.LoadRefused);
  });

  it("says which waiting event no longer reads, when its schema has changed, as it is loaded", () => {
    const { save } = record(10, 5);
    const world = readSnapshot(save.world);
    const waiting = world.stores.find((store) => store.name === Event.STORE)
      ?.data as { name: string; waiting: unknown[] }[];
    const sounded = waiting.find((events) => events.name === "sv/Sounded");
    expect(sounded).toBeDefined();
    sounded!.waiting = [{ tick: "five", at: "x" }];
    const error = refusal(load({ ...save, world: writeSnapshot(world) }));
    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(error.problem).toBe("store changed");
    expect(error.message).toMatch(
      /^Can't load the "sv\/Sounded" events waiting to be read: one is in a form that is no longer taken: .*A migration changes the events and the queued actions of a save in `world.stores`\.$/s
    );
  });

  it("says a migration is what brings a save with a component this program doesn't define up to it", () => {
    const { save } = record(10, 5);
    const world = readSnapshot(save.world);
    world.components.push({ name: "sv/Gone", storage: "table", fields: [] });
    const error = refusal(load({ ...save, world: writeSnapshot(world) }));
    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(error.problem).toBe("unknown component");
    expect(error.message).toMatch(
      /"sv\/Gone", which this program doesn't define.* A migration renames or removes a component in a save\.$/su
    );
  });

  it("finds what it holds by definition, and names an event this program doesn't define", () => {
    const { save } = record(10, 5);
    // No plugin lists the components or the waiting events.
    const Bare = Plugin.make("sv/Bare", {
      systems: [Listen, Drift, Bot, Sound],
      handlers: [add, double, scatter, pulse],
    });
    const world = readSnapshot(save.world);
    const waiting = world.stores.find((store) => store.name === Event.STORE)
      ?.data as { name: string; waiting: unknown[]; read: object }[];
    expect(waiting.map((events) => events.name)).toContain("sv/Sounded");
    expect(Exit.isSuccess(load(save, App.define({ plugins: [Bare] })))).toBe(
      true
    );

    waiting.push({ name: "sv/Never", waiting: [1], read: {} });
    const renamed = { ...save, world: writeSnapshot(world) };
    const error = refusal(load(renamed, App.define({ plugins: [Bare] })));
    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(error.problem).toBe("store changed");
    expect(error.message).toBe(
      'The snapshot holds an event named "sv/Never" waiting to be read, which this program doesn\'t define: it was renamed or removed since. A migration changes the events and the queued actions of a save in `world.stores`.'
    );
  });
});
