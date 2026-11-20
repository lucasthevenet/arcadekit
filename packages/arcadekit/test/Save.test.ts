import { Cause, Data, Effect, Exit, Logger, Option, Schema } from "effect";
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
  Plugin,
  Query,
  Random,
  Save,
  Script,
  System,
  Time,
} from "../src/index";

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
const Tallies = Query.all(Tally);
const Motes = Query.all(Mote);

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
let scriptStarts = 0;
/** A script with nothing of its own to lose: what it does follows from the time. */
const Pulsing = Effect.gen(function* () {
  scriptStarts++;
  const script = yield* Script;
  const actions = yield* Action.Actions;
  for (;;) {
    yield* script.nextTick;
    if ((yield* Time).tick % 5 === 0) {
      actions.enqueue(Pulse, {});
    }
  }
});

const Game = Plugin.make("sv/Game", {
  components: [Tally, Mote],
  events: [Sounded],
  systems: [Listen, Drift, Bot, Sound],
  handlers: [add, double, scatter, pulse],
  scripts: [Pulsing],
  setup: Effect.gen(function* () {
    setups++;
    const commands = yield* Commands;
    commands.spawn(
      Tally.of({ value: 1, heard: 0, rejections: 0, pulses: 0, echoes: 0 })
    );
    commands.spawn(Mote.of({ x: 0, name: "first" }));
  }),
});
const options = { plugins: [Game], seed: 21, checkpointEvery: 1 } as const;

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
  withApp(App.make(options), (app) => {
    let save: Save.Save | undefined;
    const hashes: number[] = [];
    for (let tick = 0; tick < ticks; tick++) {
      if (tick === saveAt) {
        // After this tick's moves have arrived, so that some are waiting.
        move(app, tick);
        save = unwrap(app.save());
      } else {
        move(app, tick);
      }
      app.tick(1 / 60);
      hashes.push(app.world.hash());
    }
    return {
      save: save!,
      hashes,
      log: [...app.actionLog],
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
      const { save } = recorded;
      expect(save.tick).toBe(saveAt);
      expect(save.delta).toBe(saveAt === 0 ? 0 : 1 / 60);
      const resumed = withApp(App.load(save, options), (app) => {
        expect(app.time).toEqual({
          tick: saveAt,
          elapsed: save.elapsed,
          delta: save.delta,
        });
        // The log starts again, and what the game logged after the save is
        // replayed against the checkpoints it took after every tick.
        expect(app.actionLog).toEqual([]);
        App.replay(app, recorded.log.slice(save.logLength), {
          delta: 1 / 60,
          ticks: 90 - saveAt,
        });
        return {
          hash: app.world.hash(),
          tally: app.world
            .view(Tallies)
            .entities()
            .map((e) => app.world.get(e, Tally)),
          time: { ...app.time },
          log: [...app.actionLog],
        };
      });
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

  it("holds the actions that were waiting, the simulation's own among them, and applies them in order", () => {
    withApp(App.make({ ...options, checkpointEvery: 0 }), (app) => {
      for (let i = 0; i < 12; i++) {
        app.tick(1);
      }
      // Tick 12 divides by 3 and by 4: the bot has enqueued an Add and a
      // Double. Then two more arrive from outside.
      app.enqueue(Add, { by: 100 });
      app.enqueueByName("sv/Double", {});
      const save = unwrap(app.save());
      expect(save.queued).toEqual([
        { name: "sv/Add", payload: { by: 7 } },
        { name: "sv/Double", payload: {} },
        { name: "sv/Add", payload: { by: 100 } },
        { name: "sv/Double", payload: {} },
      ]);
      app.tick(1);
      const expected = app.world.hash();
      const loaded = withApp(App.load(save, options), (other) => {
        other.tick(1);
        return other.world.hash();
      });
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
    const given = { systems: [Issue], handlers: [stamp] } as const;
    const save = withApp(App.make(given), (app) => {
      app.tick(1);
      const taken = unwrap(app.save());
      expect(taken.queued).toEqual([
        {
          name: "sv/Stamp",
          payload: { at: "1970-01-02T00:00:00.000Z", big: "5" },
        },
      ]);
      return taken;
    });
    stamps.length = 0;
    withApp(App.load(save, given), (app) => {
      app.tick(1);
    });
    expect(stamps).toEqual([[86_400_000, "bigint", 5n]]);
  });

  it("holds the events that were waiting, and how far each system had read them", () => {
    withApp(App.make({ ...options, checkpointEvery: 0 }), (app) => {
      for (let i = 0; i < 4; i++) {
        app.tick(1);
      }
      const save = unwrap(app.save());
      // The event of tick 4 is waiting: Sound has read it, Listen has not.
      expect(save.events).toEqual([
        {
          name: "sv/Sounded",
          payloads: [{ tick: 4, at: "1970-01-01T00:00:04.000Z" }],
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
      withApp(App.load(save, options), (other) => {
        expect(other.events.pending(Sounded)).toBe(1);
        other.tick(1);
        expect(heard(other)).toBe(1 + 2 + 3 + 4);
        other.tick(1);
        expect(heard(other)).toBe(expected);
        expect(other.world.hash()).toBe(app.world.hash());
      });
    });
  });

  it("does not run setup again, and starts every plugin's scripts again", () => {
    setups = 0;
    scriptStarts = 0;
    const save = withApp(App.make(options), (app) => {
      expect([setups, scriptStarts]).toEqual([1, 1]);
      app.tick(1);
      return unwrap(app.save());
    });
    withApp(App.load(save, options), (app) => {
      expect([setups, scriptStarts]).toEqual([1, 2]);
      // One tally and whatever motes the game had: none spawned twice.
      expect(app.world.view(Tallies).count()).toBe(1);
      // The script is running: on the fifth tick it fires a pulse.
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
      withApp(App.load(recorded.save, options), (app) => {
        App.replay(app, recorded.log.slice(recorded.save.logLength), {
          delta: 1 / 60,
          ticks: ticks - saveAt,
        });
        expect(app.world.hash()).toBe(recorded.hashes.at(-1));
      });
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
    withApp(App.load(decoded, options), (app) => {
      App.replay(app, recorded.log.slice(decoded.logLength), {
        delta: 1 / 60,
        ticks: 20,
      });
      expect(app.world.hash()).toBe(recorded.hashes.at(-1));
    });
    // A view into a larger buffer reads as itself.
    const padded = new Uint8Array(bytes.length + 9);
    padded.set(bytes, 5);
    expect(unwrap(Save.decode(padded.subarray(5, 5 + bytes.length)))).toEqual(
      recorded.save
    );
  });

  it("knows the components its plugins list, from the start", () => {
    withApp(App.make(options), (app) => {
      expect(app.world.component("sv/Tally")).toBe(Tally);
      expect(app.world.component("sv/Mote")).toBe(Mote);
    });
    const Loose = Component.define("sv/Loose", { n: Field.u8 });
    withApp(App.make({ components: [Loose] }), (app) => {
      expect(app.world.component("sv/Loose")).toBe(Loose);
    });
  });
});

describe("a game that cannot be saved as it stands", () => {
  const Typed = Action.define<{ readonly n: number }>()("sv/Typed");
  const typed = Action.handler(Typed, function* () {});
  const Quiet = Event.define<number>("sv/Quiet");
  const Hum = System.make("Hum", function* () {
    (yield* Quiet).emit(1);
  });
  const Blob = Component.define("sv/Blob", { v: Field.json<unknown>() });

  it("says which action is waiting with no schema to save it by", () => {
    withApp(App.make({ handlers: [typed] }), (app) => {
      app.enqueue(Typed, { n: 1 });
      const error = refusal(app.save());
      expect(error).toBeInstanceOf(Save.SaveRefused);
      expect(error.message).toMatch(
        /The action "sv\/Typed" is waiting for the next tick.*no schema/
      );
      // Once it has been applied there is nothing in the way.
      app.tick(1);
      expect(Exit.isSuccess(app.save())).toBe(true);
    });
  });

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
    withApp(App.make({ systems: [Issue], handlers: [small] }), (app) => {
      app.tick(1);
      expect(refusal(app.save()).message).toMatch(
        /The action "sv\/Small" is waiting.*payload its schema does not take/
      );
    });
  });

  it("says which event is waiting that no plugin lists", () => {
    const Loud = Event.define("sv/Loud", Schema.Number);
    const Shout = System.make("Shout", function* () {
      (yield* Loud).emit(1);
    });
    withApp(App.make({ systems: [Shout] }), (app) => {
      app.tick(1);
      const error = refusal(app.save());
      expect(error).toBeInstanceOf(Save.SaveRefused);
      expect(error.message).toBe(
        "The event \"sv/Loud\" is waiting to be read, and no plugin lists it, so a save that holds it could not be loaded. List it in a plugin's `events`, or in the app's."
      );
    });
    withApp(App.make({ systems: [Shout], events: [Loud] }), (app) => {
      app.tick(1);
      expect(Exit.isSuccess(app.save())).toBe(true);
    });
  });

  it("refuses to list an event with no schema to save it by", () => {
    expect(() =>
      withApp(App.make({ systems: [Hum], events: [Quiet] }), () => {})
    ).toThrow(
      'The event "sv/Quiet" is listed so that a save can hold it, and was defined with a type and no schema'
    );
  });

  it("says which event is waiting with no schema to save it by", () => {
    withApp(App.make({ systems: [Hum] }), (app) => {
      expect(Exit.isSuccess(app.save())).toBe(true);
      app.tick(1);
      const error = refusal(app.save());
      expect(error).toBeInstanceOf(Save.SaveRefused);
      expect(error.message).toMatch(/The event "sv\/Quiet".*no schema/);
    });
  });

  it("says which field holds what cannot be saved, and that commands are queued", () => {
    withApp(App.make({ components: [Blob] }), (app) => {
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
    withApp(App.make({ systems: [Greedy] }), (made) => {
      app = made;
      made.tick(1);
    });
    expect(String(thrown)).toMatch(/save\(\) was called during a tick/);
  });
});

describe("a save that cannot be loaded", () => {
  const load = (save: Save.Save, given: object = options) =>
    Effect.runSync(
      Effect.scoped(Effect.exit(App.load(save, given as typeof options)))
    );

  it("names a component that no plugin lists, and says where to list it", () => {
    const { save } = record(10, 5);
    const Partial = Plugin.make("sv/Partial", {
      components: [Tally],
      events: [Sounded],
      systems: [Listen, Drift, Bot, Sound],
      handlers: [add, double, scatter, pulse],
    });
    const error = refusal(load(save, { plugins: [Partial] }));
    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(error.problem).toBe("unknown component");
    expect(error.message).toMatch(
      /"sv\/Mote".*List it in a plugin's `components`, or in the app's\./
    );
    // The app's own list will do as well as a plugin's.
    expect(
      Exit.isSuccess(load(save, { plugins: [Partial], components: [Mote] }))
    ).toBe(true);
  });

  it("says how a component has changed since the save was taken", () => {
    const { save } = record(10, 5);
    const Changed = Plugin.make("sv/Changed", {
      components: [
        Tally,
        Component.define("sv/Mote", {
          x: Field.f64,
          name: Field.json<string>(),
        }),
      ],
    });
    const error = refusal(load(save, { plugins: [Changed] }));
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
    expect(problem(bytes.subarray(0, 40))).toBe("truncated");
    // The text between the header and the world: no longer JSON, then JSON
    // of another shape, then not text at all.
    const length = new DataView(bytes.buffer).getUint32(8, true);
    const broken = Uint8Array.from(bytes);
    broken[12] = 0x78;
    expect(problem(broken)).toBe("corrupt");
    const negative = Uint8Array.from(bytes);
    const text = new TextDecoder().decode(bytes.subarray(12, 12 + length));
    expect(text).toContain('"tick":5');
    negative.set(
      new TextEncoder().encode(text.replace('"tick":5', '"tick":-')),
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
    const altered = {
      ...save,
      events: save.events.map((events) => ({
        ...events,
        payloads: [{ tick: "five", at: "x" }],
      })),
    };
    expect(altered.events.length).toBe(1);
    const error = refusal(load(altered));
    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(error.problem).toBe("event changed");
    expect(error.message).toMatch(
      /The save holds the event "sv\/Sounded" in a form its schema no longer takes: .*A migration changes the events of a save in `events`\./s
    );
  });

  it("names a waiting event that no plugin lists, and says where to list it", () => {
    const { save } = record(10, 5);
    const Unlisted = Plugin.make("sv/Unlisted", {
      components: [Tally, Mote],
      systems: [Listen, Drift, Bot, Sound],
      handlers: [add, double, scatter, pulse],
    });
    const error = refusal(load(save, { plugins: [Unlisted] }));
    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(error.problem).toBe("unknown event");
    expect(error.message).toBe(
      "The save holds the event \"sv/Sounded\", waiting to be read, which no plugin lists. List it in a plugin's `events`, or in the app's."
    );
    // The app's own list will do as well as a plugin's.
    expect(
      Exit.isSuccess(load(save, { plugins: [Unlisted], events: [Sounded] }))
    ).toBe(true);
  });
});

describe("a plugin's scripts", () => {
  it("start with the app, after setup, and run like any other script", () => {
    const order: string[] = [];
    const Ticker = Effect.gen(function* () {
      order.push(`script sees ${(yield* Query.all(Tally)).count()} tally`);
      const script = yield* Script;
      for (;;) {
        yield* script.nextTick;
        order.push(`tick ${(yield* Time).tick}`);
      }
    });
    const WithScript = Plugin.make("sv/WithScript", {
      components: [Tally],
      scripts: [Ticker],
      setup: Effect.gen(function* () {
        order.push("setup");
        (yield* Commands).spawn(Tally);
      }),
    });
    withApp(App.make({ plugins: [WithScript] }), (app) => {
      expect(order).toEqual(["setup", "script sees 1 tally"]);
      app.tick(1);
      app.tick(1);
      expect(order.slice(2)).toEqual(["tick 1", "tick 2"]);
    });
  });

  it("are the only scripts running when a game is saved: one started by hand refuses the save until it ends", () => {
    const Forever = Effect.gen(function* () {
      const script = yield* Script;
      for (;;) {
        yield* script.nextTick;
      }
    });
    const Brief = Effect.gen(function* () {
      yield* (yield* Script).nextTick;
    });
    const Listed = Plugin.make("sv/Listed", { scripts: [Forever] });
    withApp(App.make({ plugins: [Listed] }), (app) => {
      expect(Exit.isSuccess(app.save())).toBe(true);
      app.spawnScript(Brief);
      expect(app.save()).toEqual(
        Exit.fail(
          new Save.SaveRefused({
            message:
              "A script started with app.spawnScript or Script.spawn is running, and a save can't hold where it is: after a load it would not run. Save once it has ended, or make it one of a plugin's scripts, which start again after a load and keep what they must not lose in the world.",
          })
        )
      );
      app.tick(1);
      expect(Exit.isSuccess(app.save())).toBe(true);
    });
  });

  it("are watched like any other: a failure is logged, and the scope's end interrupts them", () => {
    const logged: string[] = [];
    const logger = Logger.make<unknown, void>((entry) => {
      logged.push(
        `${String(entry.message)}: ${String(Cause.squash(entry.cause))}`
      );
    });
    let cleanedUp = false;
    const Failing = Effect.gen(function* () {
      yield* (yield* Script).nextTick;
      return yield* new TooBig();
    });
    const Forever = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => void (cleanedUp = true))
      );
      return yield* Effect.forever((yield* Script).nextTick);
    }).pipe(Effect.scoped);
    const Watched = Plugin.make("sv/Watched", { scripts: [Failing, Forever] });
    withApp(
      App.make({ plugins: [Watched] }).pipe(
        Effect.provide(Logger.layer([logger]))
      ),
      (app) => {
        app.tick(1);
        expect(logged.length).toBe(1);
        expect(logged[0]).toMatch(/A script failed at tick 1: .*TooBig/);
        expect(cleanedUp).toBe(false);
      }
    );
    expect(cleanedUp).toBe(true);
  });
});
