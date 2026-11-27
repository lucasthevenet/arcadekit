import { assert, describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Schema,
} from "effect";

import {
  World as EcsWorld,
  readSnapshot,
  writeSnapshot,
} from "../src/ecs/index.ts";
import {
  Action,
  App,
  Assets,
  Commands,
  Component,
  Driver,
  Event,
  Field,
  Grid,
  Plugin,
  Query,
  Random,
  Replay,
  Save,
  Singleton,
  Sound,
  State,
  System,
  Test,
  Time,
  Timeline,
  Timer,
  View,
  World,
} from "../src/index.ts";
import type { JsonValue } from "../src/index.ts";
import * as Build from "../src/internal/build.ts";
import { thrown } from "./checks.ts";

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
  name: Field.json<string>(""),
});
const Tallies = Query.all(Tally).pipe(Query.writes(Tally));
/** The tallies, read from outside the game. */
const Counted = Query.all(Tally);
const Motes = Query.all(Mote).pipe(Query.writes(Mote));

class TooBig extends Schema.TaggedError<TooBig>()("TooBig", {}) {}
const Add = Action.define("sv/Add", Schema.Struct({ by: Schema.Int }));
const Double = Action.define("sv/Double", Schema.Struct({}), {
  error: TooBig,
});
const Scatter = Action.define(
  "sv/Scatter",
  Schema.Struct({ count: Schema.Int })
);
const Pulse = Action.define("sv/Pulse", Schema.Struct({}));

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
    return yield* TooBig.make({});
  }
});
const scatter = Action.handler(Scatter, function* ({ count }) {
  const random = yield* Random;
  const commands = yield* Commands.spawns(Mote);
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
const Listen = System.tick("Listen", function* () {
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
const Drift = System.tick("Drift", function* () {
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
const Bot = System.tick("Bot", function* () {
  const { tick } = yield* Time;
  const actions = yield* Action.Actions;
  if (tick % 3 === 0) {
    actions.enqueue(Add, { by: 7 });
  }
  if (tick % 4 === 0) {
    actions.enqueue(Double, {});
  }
});
const Sounding = System.tick("Sound", function* () {
  const { tick } = yield* Time;
  (yield* Sounded.emits).emit({ tick, at: new Date(tick * 1000) });
});
/**
 * Reads what Sounding emits on the tick it is emitted, and Listen on the next:
 * the two have read different amounts when a save is taken. Each event is
 * counted once here, so reading one again after a load would show.
 */
const Echo = System.tick("Echo", function* () {
  const echoes = (yield* Sounded).read().length;
  (yield* Tallies).each((tally) => {
    tally.echoes += echoes;
  });
});

let setups = 0;
/** Fires a pulse every fifth tick: what it does follows from the time. */
const Pulsing = System.tick("Pulsing", function* () {
  if ((yield* Time).tick % 5 === 0) {
    (yield* Action.Actions).enqueue(Pulse, {});
  }
});

const Game = Plugin.make("sv/Game", {
  systems: [Listen, Drift, Bot, Sounding, Echo, Pulsing],
  handlers: [add, double, scatter, pulse],
  setup: Effect.gen(function* () {
    setups++;
    const commands = yield* Commands.spawns(Tally, Mote);
    commands.spawn(
      Tally.of({ value: 1, heard: 0, rejections: 0, pulses: 0, echoes: 0 })
    );
    commands.spawn(Mote.of({ x: 0, name: "first" }));
  }),
});
const Played = App.define({ plugins: [Game] });
const start = { seed: 21, hashEvery: 1 } as const;

/** Runs `use` with an app and its world, as `app.read(World)` gives it. */
const withApp = <T extends Pick<App.Any, "read">, E, A, E2 = never>(
  make: Effect.Effect<T, E>,
  use: (app: T, world: Effect.Success<typeof World>) => Effect.Effect<A, E2>
) =>
  Effect.flatMap(make, (app) =>
    Effect.flatMap(app.read(World), (world) => use(app, world))
  );

/** Each tally of a game, read from outside it. */
const talliesOf = (app: Pick<App.Any, "read">) =>
  app.read(
    Effect.gen(function* () {
      const world = yield* World;
      return (yield* Counted).entities().map((e) => world.get(e, Tally));
    })
  );

type GameApp = Effect.Success<
  ReturnType<typeof App.make<[], [], [typeof Game]>>
>;

/** Moves from outside, decided by the tick alone. */
const move = Effect.fnUntraced(function* (app: GameApp, tick: number) {
  const dice = new EcsWorld({ seed: tick + 1 }).random;
  for (let n = dice.int(0, 2); n > 0; n--) {
    const choice = dice.int(1, 5);
    if (choice === 1) {
      yield* app.enqueue(Add, { by: dice.int(1, 5) });
    } else if (choice === 2) {
      yield* app.dispatch(Scatter, { count: dice.int(1, 3) });
    } else if (choice === 3) {
      yield* app.enqueueByName("sv/Double", {});
    } else if (choice === 4) {
      yield* app.dispatch(Add, { by: dice.int(1, 5) });
    } else {
      yield* app.enqueueByName("sv/Add", { by: "not a number" });
    }
  }
});

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
const record = Effect.fnUntraced(function* (ticks: number, saveAt: number) {
  return yield* withApp(App.make(Played, start), (app, world) =>
    Effect.gen(function* () {
      let save: Save.Save | undefined;
      let saved: { tick: number; elapsed: number; delta: number } | undefined;
      const hashes: number[] = [];
      for (let tick = 0; tick < ticks; tick++) {
        if (tick === saveAt) {
          // After this tick's moves have arrived, so that some are waiting.
          yield* move(app, tick);
          save = unwrap(yield* Effect.exit(Save.make(app)));
          saved = { ...app.time };
        } else {
          yield* move(app, tick);
        }
        yield* app.tick(1 / 60);
        hashes.push(world.hash());
      }
      return {
        save: save!,
        saved: saved!,
        hashes,
        tail: yield* Replay.record(app, save!),
        tally: yield* talliesOf(app),
        time: { ...app.time },
      };
    })
  );
});

describe("a saved game", () => {
  it.effect("loads into a game that goes on exactly as the saved one did", () =>
    Effect.gen(function* () {
      for (const saveAt of [0, 1, 7, 30, 59]) {
        const recorded = yield* record(90, saveAt);
        const { save, saved } = recorded;
        expect(saved.tick).toBe(saveAt);
        expect(saved.delta).toBe(saveAt === 0 ? 0 : 1 / 60);
        yield* withApp(App.make(Played, { save, hashEvery: 1 }), (app) =>
          Effect.gen(function* () {
            // The world holds the game's time, so the save brings it back.
            expect(app.time).toEqual(saved);
            // The log starts again.
            expect(app.actionLog).toEqual([]);
          })
        );
        // What the game logged after the save is replayed from the save, which
        // the recording holds, against the hash checks it took after every tick.
        const resumed = yield* withApp(
          Replay.verify(recorded.tail, Played, { hashEvery: 1 }),
          (app, world) =>
            Effect.gen(function* () {
              return {
                hash: world.hash(),
                tally: yield* talliesOf(app),
                time: { ...app.time },
                log: [...app.actionLog],
              };
            })
        );
        expect(resumed.hash).toBe(recorded.hashes.at(-1));
        expect(resumed.tally).toEqual(recorded.tally);
        expect(resumed.time.tick).toBe(90);
        expect(resumed.time.elapsed).toBeCloseTo(recorded.time.elapsed, 9);
        // Its first entry is the hash check of the state it was loaded in.
        expect(Action.isHashCheck(resumed.log[0]!)).toBe(true);
        expect(resumed.log[0]!.tick).toBe(saveAt);
      }
      // The game was a busy one: actions refused, events heard, pulses fired.
      const [tally] = (yield* record(90, 5)).tally;
      expect(tally!.rejections).toBeGreaterThan(5);
      expect(tally!.heard).toBeGreaterThan(1000);
      expect(tally!.pulses).toBeGreaterThan(10);
    })
  );

  it.effect(
    "is not given a seed as well: it holds where the random sequence had got to",
    () =>
      Effect.gen(function* () {
        const { save } = yield* record(3, 1);
        expect(
          yield* thrown(
            // @ts-expect-error a save and a seed are not given together
            App.make(Played, { save, seed: 4 })
          )
        ).toThrow(
          /App\.make was given a save and the seed 4\..* give one of the two/
        );
      })
  );

  it.effect(
    "is given as a seed or a save, as a host that loads a save if it has one gives it, and may fail as a load does",
    () =>
      Effect.gen(function* () {
        const { save, saved } = yield* record(3, 1);
        const start = (from: Save.Save | undefined) =>
          from === undefined ? { seed: 4 } : { save: from };
        const loaded = App.make(Played, start(save));
        expectTypeOf<
          Effect.Error<typeof loaded>
        >().toEqualTypeOf<Save.LoadRefused>();
        const fresh = App.make(Played, { seed: 4 });
        expectTypeOf<Effect.Error<typeof fresh>>().toEqualTypeOf<never>();
        const [again, seeded] = [yield* loaded, yield* fresh];
        expect([again.time, seeded.time.tick]).toEqual([saved, 0]);
        yield* again.close;
        yield* seeded.close;
      })
  );

  it.effect(
    "holds the actions that were waiting, the simulation's own among them, and applies them in order",
    () =>
      withApp(App.make(Played, { seed: 21, hashEvery: 0 }), (app, world) =>
        Effect.gen(function* () {
          for (let i = 0; i < 12; i++) {
            yield* app.tick(1);
          }
          // Tick 12 divides by 3 and by 4: the bot has enqueued an Add and a
          // Double. Then two more arrive from outside.
          yield* app.enqueue(Add, { by: 100 });
          yield* app.enqueueByName("sv/Double", {});
          const save = unwrap(yield* Effect.exit(Save.make(app)));
          expect(queuedIn(save)).toEqual([
            { name: "sv/Add", payload: { by: 7 } },
            { name: "sv/Double", payload: {} },
            { name: "sv/Add", payload: { by: 100 } },
            { name: "sv/Double", payload: {} },
          ]);
          yield* app.tick(1);
          const expected = world.hash();
          const loaded = yield* withApp(
            App.make(Played, { save, hashEvery: 1 }),
            (other, itsWorld) =>
              Effect.gen(function* () {
                yield* other.tick(1);
                return itsWorld.hash();
              })
          );
          expect(loaded).toBe(expected);
        })
      )
  );

  it.effect(
    "gives a waiting action its payload back as the value it was, not as its JSON",
    () =>
      Effect.gen(function* () {
        const stamps: unknown[] = [];
        const Stamp = Action.define(
          "sv/Stamp",
          Schema.Struct({ at: Schema.Date, big: Schema.BigInt })
        );
        const stamp = Action.handler(Stamp, function* ({ at, big }) {
          stamps.push([at instanceof Date && at.getTime(), typeof big, big]);
        });
        const Issue = System.tick("Issue", function* () {
          (yield* Action.Actions).enqueue(Stamp, {
            at: new Date(86_400_000),
            big: 5n,
          });
        });
        const Stamped = App.define({ systems: [Issue], handlers: [stamp] });
        const save = yield* withApp(App.make(Stamped), (app) =>
          Effect.gen(function* () {
            yield* app.tick(1);
            const taken = unwrap(yield* Effect.exit(Save.make(app)));
            expect(queuedIn(taken)).toEqual([
              {
                name: "sv/Stamp",
                payload: { at: "1970-01-02T00:00:00.000Z", big: "5" },
              },
            ]);
            return taken;
          })
        );
        stamps.length = 0;
        yield* withApp(App.make(Stamped, { save }), (app) => app.tick(1));
        expect(stamps).toEqual([[86_400_000, "bigint", 5n]]);
      })
  );

  it.effect(
    "holds the events that were waiting, and how far each system had read them",
    () =>
      withApp(App.make(Played, { seed: 21, hashEvery: 0 }), (app, world) =>
        Effect.gen(function* () {
          for (let i = 0; i < 4; i++) {
            yield* app.tick(1);
          }
          const save = unwrap(yield* Effect.exit(Save.make(app)));
          // The event of tick 4 is waiting, in the world: Echo has read it,
          // Listen has not.
          expect(stored(save, Event.STORE)).toEqual([
            {
              name: "sv/Sounded",
              waiting: [{ tick: 4, at: "1970-01-01T00:00:04.000Z" }],
              read: { Echo: 1 },
            },
          ]);
          const heard = Effect.fnUntraced(function* (of: GameApp) {
            return (yield* talliesOf(of)).map((tally) => tally?.heard);
          });
          expect(yield* heard(app)).toEqual([1 + 2 + 3]);
          yield* app.tick(1);
          yield* app.tick(1);
          const expected = yield* heard(app);
          expect(expected).toEqual([1 + 2 + 3 + 4 + 5]);
          // Loaded, Listen hears tick 4 once, on the next tick, and no more.
          yield* withApp(
            App.make(Played, { save, hashEvery: 1 }),
            (other, itsWorld) =>
              Effect.gen(function* () {
                expect((yield* other.inspect()).stores[Event.STORE]).toEqual({
                  "sv/Sounded": [{ tick: 4, at: "1970-01-01T00:00:04.000Z" }],
                });
                yield* other.tick(1);
                expect(yield* heard(other)).toEqual([1 + 2 + 3 + 4]);
                yield* other.tick(1);
                expect(yield* heard(other)).toEqual(expected);
                expect(itsWorld.hash()).toBe(world.hash());
              })
          );
        })
      )
  );

  it.effect("does not run setup again, and the game goes on", () =>
    Effect.gen(function* () {
      setups = 0;
      const save = yield* withApp(App.make(Played, start), (app) =>
        Effect.gen(function* () {
          expect(setups).toBe(1);
          yield* app.tick(1);
          return unwrap(yield* Effect.exit(Save.make(app)));
        })
      );
      yield* withApp(App.make(Played, { save, hashEvery: 1 }), (app) =>
        Effect.gen(function* () {
          expect(setups).toBe(1);
          // One tally and whatever motes the game had: none spawned twice.
          expect(yield* talliesOf(app)).toHaveLength(1);
          // It goes on: on the fifth tick it fires a pulse.
          for (let i = 0; i < 6; i++) {
            yield* app.tick(1);
          }
          expect((yield* talliesOf(app)).map((tally) => tally?.pulses)).toEqual(
            [1]
          );
        })
      );
    })
  );

  it.effect(
    "costs the same to load after a long game as after a short one",
    () =>
      Effect.gen(function* () {
        // A save is the world as it is, and the log since: loading replays the
        // ticks after the save, however many came before it.
        const ticksToLoad = Effect.fnUntraced(function* (
          ticks: number,
          saveAt: number
        ) {
          const recorded = yield* record(ticks, saveAt);
          ticksRun = 0;
          yield* withApp(
            Replay.verify(recorded.tail, Played, { hashEvery: 1 }),
            (_, world) =>
              Effect.gen(function* () {
                expect(world.hash()).toBe(recorded.hashes.at(-1));
              })
          );
          return ticksRun;
        });
        expect(yield* ticksToLoad(20, 10)).toBe(10);
        expect(yield* ticksToLoad(1500, 1490)).toBe(10);
      })
  );

  it.effect("goes through bytes and back", () =>
    Effect.gen(function* () {
      const recorded = yield* record(40, 20);
      const bytes = Save.encode(recorded.save);
      expect(bytes).toBeInstanceOf(Uint8Array);
      const decoded = unwrap(Save.decode(bytes));
      expect(decoded).toEqual(recorded.save);
      // It is the world's snapshot and a little text.
      expect(bytes.length).toBeLessThan(recorded.save.world.length + 600);
      // The game goes on from the save that was read as it did from the one
      // that was written.
      const { tail } = recorded;
      assert(tail.save !== undefined);
      yield* withApp(
        Replay.verify({ ...tail, save: decoded }, Played, {
          hashEvery: 1,
        }),
        (_, world) =>
          Effect.gen(function* () {
            expect(world.hash()).toBe(recorded.hashes.at(-1));
          })
      );
      // A view into a larger buffer reads as itself.
      const padded = new Uint8Array(bytes.length + 9);
      padded.set(bytes, 5);
      expect(unwrap(Save.decode(padded.subarray(5, 5 + bytes.length)))).toEqual(
        recorded.save
      );
    })
  );
});

describe("a game that cannot be saved as it stands", () => {
  const Blob = Component.define("sv/Blob", { v: Field.json<JsonValue>(null) });

  it.effect(
    "says which action is waiting with a payload its schema does not take",
    () =>
      Effect.gen(function* () {
        const Small = Action.define(
          "sv/Small",
          Schema.Struct({
            n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
          })
        );
        const small = Action.handler(Small, function* () {});
        const Issue = System.tick("Issue", function* () {
          (yield* Action.Actions).enqueue(Small, { n: 9 });
        });
        yield* withApp(
          App.make(App.define({ systems: [Issue], handlers: [small] })),
          (app) =>
            Effect.gen(function* () {
              yield* app.tick(1);
              expect(
                refusal(yield* Effect.exit(Save.make(app))).message
              ).toMatch(
                /^Can't save the actions queued for the next tick: the action "sv\/Small" has a payload its schema does not take/
              );
            })
        );
      })
  );

  it.effect("says which field holds what cannot be saved", () =>
    Effect.gen(function* () {
      const Mend = Action.define("sv/Mend", Schema.Struct({}));
      const mend = Action.handler(Mend, function* () {
        const world = yield* World.writes(Blob);
        for (const entity of (yield* Query.all(Blob)).entities()) {
          world.set(entity, Blob, { v: "fine" });
        }
      });
      const Spill = Plugin.make("sv/Spill", {
        setup: Effect.map(Commands.spawns(Blob), (commands) => {
          commands.spawn(
            // @ts-expect-error A function is not JSON.
            Blob.of({ v: () => 1 })
          );
        }),
      });
      yield* withApp(
        App.make(App.define({ plugins: [Spill], handlers: [mend] })),
        (app) =>
          Effect.gen(function* () {
            expect(
              refusal(yield* Effect.exit(Save.make(app))).message
            ).toContain('"sv/Blob.v"');
            yield* app.dispatch(Mend, {});
            expect(Exit.isSuccess(yield* Effect.exit(Save.make(app)))).toBe(
              true
            );
          })
      );
    })
  );

  it.effect("is not saved in the middle of a tick", () =>
    Effect.gen(function* () {
      let app: App.Any | undefined;
      let thrown: unknown;
      const Greedy = System.tick("Greedy", function* () {
        const saved = yield* Effect.exit(Save.make(app!));
        thrown = Exit.isFailure(saved) ? Cause.squash(saved.cause) : undefined;
      });
      yield* withApp(App.make(App.define({ systems: [Greedy] })), (made) =>
        Effect.gen(function* () {
          app = made;
          yield* made.tick(1);
        })
      );
      expect(String(thrown)).toMatch(/Save\.make\(\) was called during a tick/);
    })
  );
});

describe("a save that cannot be loaded", () => {
  const load = (save: Save.Save, game: object = Played) =>
    Effect.exit(App.make(game as typeof Played, { save, hashEvery: 1 }));

  it.effect("says how a component has changed since the save was taken", () =>
    Effect.gen(function* () {
      // The game as it was, and as a later build of it defines the component.
      const Before = Component.define("sv/Shifting", { x: Field.f32 });
      const Then = Plugin.make("sv/Then", {
        setup: Effect.map(Commands.spawns(Before), (commands) => {
          commands.spawn(Before.of({ x: 1 }));
        }),
      });
      const save = yield* withApp(
        App.make(App.define({ plugins: [Then] })),
        (app) =>
          Effect.gen(function* () {
            return unwrap(yield* Effect.exit(Save.make(app)));
          })
      );
      Component.define("sv/Shifting", { x: Field.f64 });
      const error = refusal(yield* load(save, App.define({})));
      expect(error.problem).toBe("component changed");
      expect(error.message).toContain("x: f32");
      expect(error.message).toContain("x: f64");
    })
  );

  it.effect("is refused when its world is damaged", () =>
    Effect.gen(function* () {
      const { save } = yield* record(10, 5);
      const error = refusal(
        yield* load({
          ...save,
          world: save.world.subarray(0, save.world.length - 9),
        })
      );
      expect(error).toBeInstanceOf(Save.LoadRefused);
      expect(["truncated", "corrupt"]).toContain(error.problem);
      expect(
        refusal(yield* load({ ...save, world: new Uint8Array(40) })).problem
      ).toBe("not a snapshot");
    })
  );

  it.effect(
    "is refused as bytes that are not a save, or are cut short, or damaged",
    () =>
      Effect.gen(function* () {
        const bytes = Save.encode((yield* record(10, 5)).save);
        const problem = (given: Uint8Array) =>
          refusal(Save.decode(given)).problem;
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
        const older = Uint8Array.from(bytes);
        new DataView(older.buffer).setUint32(4, 2, true);
        expect(problem(older)).toBe("older format");
        // Format 3 held the length of the log that made it, which is read past.
        const decoded = unwrap(Save.decode(bytes));
        const json = new TextEncoder().encode('{"version":0,"logLength":4}');
        const three = new Uint8Array(12 + json.length + decoded.world.length);
        three.set(bytes.subarray(0, 12));
        new DataView(three.buffer).setUint32(4, 3, true);
        new DataView(three.buffer).setUint32(8, json.length, true);
        three.set(json, 12);
        three.set(decoded.world, 12 + json.length);
        expect(Save.decode(three)).toEqual(Exit.succeed(decoded));
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
        expect(text).toBe('{"version":0}');
        negative.set(
          new TextEncoder().encode(text.replace('"version":0', '"version":-1')),
          12
        );
        expect(problem(negative)).toBe("corrupt");
        // Whole JSON that is not a save's: a member under another name.
        const reshaped = Uint8Array.from(bytes);
        reshaped.set(
          new TextEncoder().encode(text.replace('"version"', '"versiox"')),
          12
        );
        expect(problem(reshaped)).toBe("corrupt");
        const notText = Uint8Array.from(bytes);
        notText[20] = 0xff;
        expect(problem(notText)).toBe("corrupt");
        // Cut inside the world: the save's own shape is whole, and the world
        // is found short when it is loaded.
        const short = unwrap(Save.decode(bytes.subarray(0, bytes.length - 5)));
        expect(refusal(yield* load(short))).toBeInstanceOf(Save.LoadRefused);
      })
  );

  it.effect(
    "says which waiting event no longer reads, when its schema has changed, as it is loaded",
    () =>
      Effect.gen(function* () {
        const { save } = yield* record(10, 5);
        const world = readSnapshot(save.world);
        const waiting = world.stores.find((store) => store.name === Event.STORE)
          ?.data as { name: string; waiting: unknown[] }[];
        const sounded = waiting.find((events) => events.name === "sv/Sounded");
        expect(sounded).toBeDefined();
        sounded!.waiting = [{ tick: "five", at: "x" }];
        const error = refusal(
          yield* load({ ...save, world: writeSnapshot(world) })
        );
        expect(error).toBeInstanceOf(Save.LoadRefused);
        expect(error.problem).toBe("store changed");
        expect(error.message).toMatch(
          /^Can't load the "sv\/Sounded" events waiting to be read: one is in a form that is no longer taken: .*A step of `Migrate.step` renames them with `renameEvent` and `renameAction`, and changes their payloads with `mapPayloads`\.$/s
        );
      })
  );

  it.effect(
    "says a migration is what brings a save with a component this program doesn't define up to it",
    () =>
      Effect.gen(function* () {
        const { save } = yield* record(10, 5);
        const world = readSnapshot(save.world);
        world.components.push({
          name: "sv/Gone",
          storage: "table",
          fields: [],
        });
        const error = refusal(
          yield* load({ ...save, world: writeSnapshot(world) })
        );
        expect(error).toBeInstanceOf(Save.LoadRefused);
        expect(error.problem).toBe("unknown component");
        expect(error.message).toMatch(
          /"sv\/Gone", which this program doesn't define.* A step of `Migrate\.step` renames it to its definition with `renameComponent`, or removes it with `removeComponent`\.$/su
        );
      })
  );

  it.effect(
    "finds what it holds by definition, and names an event this program doesn't define",
    () =>
      Effect.gen(function* () {
        const { save } = yield* record(10, 5);
        // No plugin lists the components or the waiting events.
        const Bare = Plugin.make("sv/Bare", {
          systems: [Listen, Drift, Bot, Sounding, Echo],
          handlers: [add, double, scatter, pulse],
        });
        const world = readSnapshot(save.world);
        const waiting = world.stores.find((store) => store.name === Event.STORE)
          ?.data as { name: string; waiting: unknown[]; read: object }[];
        expect(waiting.map((events) => events.name)).toContain("sv/Sounded");
        expect(
          Exit.isSuccess(yield* load(save, App.define({ plugins: [Bare] })))
        ).toBe(true);

        waiting.push({ name: "sv/Never", waiting: [1], read: {} });
        const renamed = { ...save, world: writeSnapshot(world) };
        const error = refusal(
          yield* load(renamed, App.define({ plugins: [Bare] }))
        );
        expect(error).toBeInstanceOf(Save.LoadRefused);
        expect(error.problem).toBe("store changed");
        expect(error.message).toBe(
          'The snapshot holds an event named "sv/Never" waiting to be read, which this program doesn\'t define: it was renamed or removed since. A step of `Migrate.step` renames them with `renameEvent` and `renameAction`, and changes their payloads with `mapPayloads`.'
        );
      })
  );
});

// --- a save loaded into the app that is running -------------------------------------

/** Plays `ticks` ticks of moves from `first` on. */
const played = Effect.fnUntraced(function* (
  app: GameApp,
  first: number,
  ticks: number
) {
  for (let tick = first; tick < first + ticks; tick++) {
    yield* move(app, tick);
    yield* app.tick(1 / 60);
  }
});

describe("a save loaded in place", () => {
  it.effect(
    "is the game a new app makes from the save, and plays on to the same hashes",
    () =>
      Effect.gen(function* () {
        for (const saveAt of [0, 7, 30]) {
          yield* withApp(App.make(Played, start), (app, world) =>
            Effect.gen(function* () {
              yield* played(app, 0, saveAt);
              // Some of what was asked for is waiting when it is saved.
              yield* move(app, saveAt);
              const save = unwrap(yield* Effect.exit(Save.make(app)));
              const then = { hash: world.hash(), time: { ...app.time } };
              yield* played(app, saveAt, 20);
              expect(world.hash()).not.toBe(then.hash);

              yield* Save.load(app, save);
              expect(world.hash()).toBe(then.hash);
              expect(app.time).toEqual(then.time);
              // Its log starts again, as an app made from the save starts.
              expect(app.actionLog).toEqual([]);
              yield* withApp(
                App.make(Played, { save, hashEvery: 1 }),
                (fresh, freshWorld) =>
                  Effect.gen(function* () {
                    expect(freshWorld.hash()).toBe(then.hash);
                    for (let tick = 100; tick < 140; tick++) {
                      yield* move(app, tick);
                      yield* move(fresh, tick);
                      yield* app.tick(1 / 60);
                      yield* fresh.tick(1 / 60);
                      expect(world.hash()).toBe(freshWorld.hash());
                    }
                    expect(yield* talliesOf(app)).toEqual(
                      yield* talliesOf(fresh)
                    );
                    expect(app.actionLog).toEqual(fresh.actionLog);
                  })
              );
              // What it played since the load is recorded from the save, and
              // replays to where it is.
              const replayed = yield* Replay.verify(
                yield* Replay.record(app),
                Played,
                { hashEvery: 1 }
              );
              expect((yield* replayed.read(World)).hash()).toBe(world.hash());
            })
          );
        }
      })
  );

  it.effect(
    "goes on with the states the save holds, a move it was waiting for among them",
    () =>
      Effect.gen(function* () {
        const Phase = State.define("sv/Phase", ["menu", "playing"]);
        const Begin = Action.define("sv/Begin", Schema.Struct({}));
        // Nothing but the handler names the state: the app that loads the
        // save has never met it.
        const Phased = App.define({
          handlers: [
            Action.handler(Begin, function* () {
              (yield* Phase.sets).set("playing");
            }),
          ],
        });
        // Saved with the move to "playing" asked for, and not made yet.
        const save = yield* withApp(App.make(Phased), (app) =>
          Effect.gen(function* () {
            yield* app.dispatch(Begin, {});
            return unwrap(yield* Effect.exit(Save.make(app)));
          })
        );
        yield* withApp(App.make(Phased), (app, world) =>
          Effect.gen(function* () {
            yield* app.tick(1 / 60);
            yield* Save.load(app, save);
            const fresh = yield* App.make(Phased, { save });
            const freshWorld = yield* fresh.read(World);
            yield* app.tick(1 / 60);
            yield* fresh.tick(1 / 60);
            expect((yield* app.read(Phase)).value).toBe("playing");
            expect((yield* fresh.read(Phase)).value).toBe("playing");
            expect(world.hash()).toBe(freshWorld.hash());
          })
        );
      })
  );

  it.effect(
    "has the stages between ticks hear the loaded game, and nothing of the game it replaced",
    () =>
      Effect.gen(function* () {
        const Rang = Event.define("sv/Rang", Schema.Struct({ n: Schema.Int }));
        const Ring = Action.define("sv/Ring", Schema.Struct({ n: Schema.Int }));
        const heard: number[] = [];
        const Rings = App.define({
          systems: [
            System.frame("sv/Hear", function* () {
              for (const rang of (yield* Rang).read()) {
                heard.push(rang.n);
              }
            }),
          ],
          handlers: [
            Action.handler(Ring, function* ({ n }) {
              (yield* Rang.emits).emit({ n });
            }),
          ],
        });
        yield* withApp(App.make(Rings), (app) =>
          Effect.gen(function* () {
            yield* app.enqueue(Ring, { n: 1 });
            yield* app.tick(1 / 60);
            yield* app.frame();
            const save = unwrap(yield* Effect.exit(Save.make(app)));
            // Rung, and not heard yet when the save is loaded.
            yield* app.enqueue(Ring, { n: 2 });
            yield* app.tick(1 / 60);
            yield* Save.load(app, save);
            yield* app.frame();
            yield* app.enqueue(Ring, { n: 3 });
            yield* app.tick(1 / 60);
            yield* app.frame();
            expect(heard).toEqual([1, 3]);
          })
        );
      })
  );

  it.effect(
    "is refused as App.make refuses it, and leaves the game as it was",
    () =>
      Effect.gen(function* () {
        const { save } = yield* record(10, 5);
        const contents = readSnapshot(save.world);
        const waiting = contents.stores.find(
          (store) => store.name === Event.STORE
        )!.data as { name: string; waiting: unknown[]; read: object }[];
        waiting.push({ name: "sv/Never", waiting: [1], read: {} });
        const refused = [
          // Damaged, which is found as its world is read.
          { ...save, world: save.world.subarray(0, save.world.length - 9) },
          // An event this program doesn't define, found once the entities and
          // the singletons are read.
          { ...save, world: writeSnapshot(contents) },
          { ...save, version: 3 },
        ];
        const twin = yield* App.make(Played, start);
        const twinWorld = yield* twin.read(World);
        yield* withApp(App.make(Played, start), (app, world) =>
          Effect.gen(function* () {
            yield* played(app, 0, 20);
            yield* played(twin, 0, 20);
            const before = {
              hash: world.hash(),
              time: { ...app.time },
              log: structuredClone(app.actionLog),
            };
            const problems = [];
            for (const one of refused) {
              const error = refusal(yield* Effect.exit(Save.load(app, one)));
              expect(error).toBeInstanceOf(Save.LoadRefused);
              problems.push(error.problem);
            }
            expect(["truncated", "corrupt"]).toContain(problems[0]);
            expect(problems.slice(1)).toEqual([
              "store changed",
              "newer version",
            ]);
            expect({
              hash: world.hash(),
              time: { ...app.time },
              log: app.actionLog,
            }).toEqual(before);
            // And it plays on as the game that never tried does.
            for (let tick = 20; tick < 40; tick++) {
              yield* played(app, tick, 1);
              yield* played(twin, tick, 1);
              expect(world.hash()).toBe(twinWorld.hash());
            }
          })
        );
      })
  );

  it.effect(
    "is loaded between ticks, into an app nobody else steps, and leaves the moments of the game before it behind",
    () =>
      Effect.gen(function* () {
        const { save } = yield* record(10, 5);
        let app: App.Any | undefined;
        let inTick: unknown;
        const Greedy = System.tick("sv/Greedy", function* () {
          const loaded = yield* Effect.exit(Save.load(app!, save));
          inTick = Exit.isFailure(loaded)
            ? Cause.squash(loaded.cause)
            : undefined;
        });
        yield* withApp(App.make(App.define({ systems: [Greedy] })), (made) =>
          Effect.gen(function* () {
            app = made;
            yield* made.tick(1);
          })
        );
        expect(String(inTick)).toMatch(/load\(\) was called during a tick/);

        const steered = yield* Build.build(Played, start);
        steered.take(() => {});
        expect(yield* thrown(Save.load(steered.app, save))).toThrow(
          /load\(\) was called on an app that a session has taken over/
        );

        yield* withApp(App.make(Played, start), (made) =>
          Effect.gen(function* () {
            const before = unwrap(yield* Effect.exit(Timeline.capture(made)));
            yield* made.tick(1 / 60);
            yield* Save.load(made, save);
            expect(yield* thrown(Timeline.rewind(made, before))).toThrow(
              "Timeline.rewind() was given a moment captured before the app loaded a save, of the game the load replaced. To go back there, save that game and load the save."
            );
            const since = unwrap(yield* Effect.exit(Timeline.capture(made)));
            const loaded = yield* talliesOf(made);
            yield* played(made, 0, 3);
            yield* Timeline.rewind(made, since);
            expect(yield* talliesOf(made)).toEqual(loaded);
          })
        );
      })
  );
});

// --- a game in a page, saved to a slot and loaded from it ---------------------------

const Ball = Component.define("sv/Ball", { x: Field.f32, speed: Field.f32 });
const Rolling = Query.all(Ball).pipe(Query.writes(Ball));
const Balls = Query.all(Ball);
const Kick = Action.define("sv/Kick", Schema.Struct({ by: Schema.Number }));
const Lit = State.define("sv/Lit", ["dark", "lit"]);
const Distance = View.define("sv/Distance", 0);
const Tunes = Sound.sheet("sv/Tunes", { theme: "/theme.ogg" });
/** Where each frame drew the balls. */
const drawn: number[][] = [];

const Rolled = Plugin.make("sv/Rolls", {
  plugins: [View.plugin, Sound.plugin, Assets.plugin],
  systems: [
    System.tick("sv/Roll", function* () {
      const { delta } = yield* Time;
      (yield* Rolling).each((ball) => {
        ball.x += ball.speed * delta;
      });
    }),
    System.frame("sv/Draw", function* () {
      const xs: number[] = [];
      (yield* Balls).each((ball) => {
        xs.push(ball.x);
      });
      drawn.push(xs);
    }),
    View.publish(Distance, function* () {
      let sum = 0;
      (yield* Balls).each((ball) => {
        sum += ball.x;
      });
      return sum;
    }),
    Sound.music("sv/Theme", function* () {
      return (yield* Lit).value === "lit" ? Tunes.theme : undefined;
    }),
  ],
  handlers: [
    Action.handler(Kick, function* ({ by }) {
      (yield* Rolling).each((ball) => {
        ball.speed += by;
      });
      (yield* Lit.sets).set("lit");
    }),
  ],
  setup: Effect.map(Commands.spawns(Ball), (commands) => {
    commands.spawn(Ball.of({ x: 0, speed: 1 }));
    commands.spawn(Ball.of({ x: 10, speed: -1 }));
  }),
});
const Rolls = App.define({ plugins: [Rolled] });

describe("a game saved to a slot", () => {
  it.effect(
    "is loaded from it into the app that runs, with its frame, its view and its music going on",
    () =>
      Effect.gen(function* () {
        drawn.length = 0;
        const display = Driver.makeManualDisplay();
        const sound = Sound.makeRecorder();
        let ui: View.Bridge | undefined;
        let made:
          | Effect.Success<ReturnType<typeof App.make<[], [], [typeof Rolled]>>>
          | undefined;
        yield* Effect.forkScoped(
          Driver.run(Rolls, {
            hz: 60,
            seed: 1,
            ready: (app) =>
              Effect.sync(() => {
                made = app;
              }),
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Driver.layer(display),
                Sound.layer(sound),
                View.mount(Rolls, (bridge) => {
                  ui = bridge;
                })
              )
            )
          ),
          { startImmediately: true }
        );
        let now = 0;
        const frames = (count: number) => {
          for (let i = 0; i < count; i++) {
            display.frame(now);
            now += 1000 / 60;
          }
        };
        const app = made!;
        const world = yield* app.read(World);
        ui!.subscribe(Distance, () => {});
        frames(1);
        yield* app.enqueue(Kick, { by: 2 });
        frames(30);
        expect(Object.fromEntries(sound.playing)).toEqual({ music: "theme" });

        // A button that saves to a slot.
        yield* Save.write("slot2", yield* Save.make(app));
        const saved = { hash: world.hash(), tick: app.time.tick };
        yield* app.enqueue(Kick, { by: 5 });
        frames(30);
        expect(world.hash()).not.toBe(saved.hash);

        // And one that loads from it.
        const scored = sound.scored.length;
        const slot = yield* Save.read("slot2");
        yield* Save.load(app, Option.getOrThrow(slot));
        expect(world.hash()).toBe(saved.hash);
        expect(app.time.tick).toBe(saved.tick);

        // The same frame loop goes on with the loaded game: it draws it,
        // shows it, and the theme it was playing plays on.
        const draws = drawn.length;
        frames(10);
        expect(drawn.length).toBe(draws + 10);
        const xs: number[] = [];
        (yield* app.read(Balls)).each((ball) => {
          xs.push(ball.x);
        });
        expect(drawn.at(-1)).toEqual(xs);
        expect(ui!.get(Distance)).toBeCloseTo(xs[0]! + xs[1]!, 4);
        expect(app.time.tick).toBe(saved.tick + 10);
        expect(Object.fromEntries(sound.playing)).toEqual({ music: "theme" });
        expect(sound.scored.length).toBe(scored);
      }).pipe(Effect.scoped, Effect.provide(Save.layer(Save.makeMemory())))
  );

  it.effect("is empty until something is written to it", () =>
    Effect.gen(function* () {
      expect(Option.isNone(yield* Save.read("nothing"))).toBe(true);
      const { save } = yield* record(3, 1);
      yield* Save.write("one", save);
      yield* Save.write("two", save);
      const store = yield* Save.Store;
      expect((yield* store.slots).toSorted()).toEqual(["one", "two"]);
      yield* store.remove("one");
      expect(yield* store.slots).toEqual(["two"]);
      expect(Option.getOrThrow(yield* Save.read("two"))).toEqual(save);
    }).pipe(Effect.provide(Save.layer(Save.makeMemory())))
  );
});

// --- a save the rules ask for --------------------------------------------------------

const Coins = Singleton.define("sv/Coins", { got: Field.i32 }, { got: 0 });
const Grab = Action.define("sv/Grab", Schema.Struct({}));
const Finish = Action.define("sv/Finish", Schema.Struct({}));
const finish = Action.handler(Finish, function* () {
  (yield* Save.Asked.emits).emit({ slot: "finished" });
});
const Levels = App.define({
  systems: [
    // The level ends with the third coin, and the rules ask to keep it.
    System.tick("sv/LevelEnd", function* () {
      if ((yield* Coins).got === 3) {
        (yield* Save.Asked.emits).emit({ slot: "level" });
      }
    }),
    // And every second of the game's time.
    System.tick("sv/Every", function* () {
      (yield* Save.Asked.emits).emit({ slot: "auto" });
    }).pipe(Timer.every(1)),
  ],
  handlers: [
    Action.handler(Grab, function* () {
      (yield* Coins.writes).got++;
    }),
    finish,
  ],
});

const Finished = Save.slot("finished");
const Status = View.define<Save.SlotStatus>("sv/Status", { _tag: "Off" });
const Small = Singleton.define(
  "sv/Small",
  { tiles: Grid.tiles(2, 2) },
  { tiles: Grid.fill(2, 2) }
);
const Spoil = Action.define("sv/Spoil", Schema.Struct({}));
const Told = App.define({
  plugins: [View.plugin],
  systems: [
    View.publish(Status, function* () {
      return yield* Finished;
    }),
  ],
  handlers: [
    finish,
    // A grid of another size is a save that can't be taken.
    Action.handler(Spoil, function* () {
      (yield* Small.writes).tiles = Grid.fill(3, 3);
      (yield* Save.Asked.emits).emit({ slot: Finished.name });
    }),
  ],
});

describe("a save the rules ask for", () => {
  it.effect(
    "is taken after the tick that asked, and kept in its slot, with nothing outside watching the world",
    () => {
      const slots = Save.makeMemory();
      return Effect.gen(function* () {
        const app = yield* App.make(Levels);
        const world = yield* app.read(World);
        yield* Save.autosave(app);
        const hashes: number[] = [];
        for (let i = 0; i < 3; i++) {
          yield* app.enqueue(Grab, {});
          yield* app.tick(1 / 60);
          hashes.push(world.hash());
          expect(yield* slots.slots).toEqual(i < 2 ? [] : ["level"]);
        }
        // The game as the tick that asked left it.
        const level = Option.getOrThrow(yield* Save.read("level"));
        const loaded = yield* App.make(Levels, { save: level });
        expect((yield* loaded.read(World)).hash()).toBe(hashes[2]);
        // A handler that a dispatch runs asks as well, and the save is of
        // the game as the dispatch left it.
        yield* app.dispatch(Finish, {});
        const finished = world.hash();
        yield* app.tick(1 / 60);
        yield* Save.load(app, Option.getOrThrow(yield* Save.read("finished")));
        expect(world.hash()).toBe(finished);
      }).pipe(Effect.provide(Save.layer(slots)), Effect.scoped);
    }
  );

  it.effect(
    "is kept on the interval the rules keep, under Driver.run, and the game goes on from it after a reload",
    () =>
      Effect.gen(function* () {
        const slots = Save.makeMemory();
        const display = Driver.makeManualDisplay();
        let made: App.Any | undefined;
        const visit = (save?: Save.Save) =>
          Effect.forkScoped(
            Driver.run(Levels, {
              hz: 60,
              ...(save === undefined ? {} : { save }),
              ready: (app) =>
                Effect.andThen(
                  Effect.sync(() => {
                    made = app;
                  }),
                  Save.autosave(app)
                ),
            }).pipe(
              Effect.provide(
                Layer.merge(Driver.layer(display), Save.layer(slots))
              )
            ),
            { startImmediately: true }
          );
        let now = 0;
        const frames = (count: number) => {
          for (let i = 0; i < count; i++) {
            display.frame(now);
            now += 1000 / 60;
          }
        };
        const first = yield* visit();
        frames(1);
        frames(150);
        const world = yield* made!.read(World);
        expect(made!.time.tick).toBe(150);
        // Kept at one second, and again at two.
        const kept = Option.getOrThrow(
          yield* Save.read("auto").pipe(Effect.provide(Save.layer(slots)))
        );
        const at = yield* App.make(Levels, { save: kept });
        expect(at.time.tick).toBe(120);
        const keptHash = (yield* at.read(World)).hash();
        expect(world.hash()).not.toBe(keptHash);
        yield* Fiber.interrupt(first);

        // A reload: the game starts from the slot, where it was kept.
        yield* visit(kept);
        frames(1);
        expect(made!.time.tick).toBe(120);
        expect((yield* made!.read(World)).hash()).toBe(keptHash);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "that can't be kept is logged as an error, and the game goes on",
    () =>
      Effect.gen(function* () {
        const logged: string[] = [];
        const full: Save.StoreShape = {
          ...Save.makeMemory(),
          set: (slot) =>
            Effect.fail(new Save.StoreFailed({ slot, message: "It is full." })),
        };
        yield* Effect.gen(function* () {
          const app = yield* App.make(Levels);
          yield* Save.autosave(app);
          yield* app.dispatch(Finish, {});
          yield* app.tick(1 / 60);
          expect(app.time.tick).toBe(1);
        }).pipe(
          Effect.provide(
            Layer.merge(
              Save.layer(full),
              Logger.layer([
                Logger.make((entry) => {
                  logged.push(String(entry.message));
                }),
              ])
            )
          )
        );
        expect(logged).toEqual([
          'Save.autosave could not keep the save the game asked for in "finished": It is full.',
        ]);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "has its slot's status told to the game's UI: off, unasked, failed until a later ask keeps it, and off once nothing keeps the saves",
    () => {
      let full = true;
      const slots = Save.makeMemory();
      const store: Save.StoreShape = {
        ...slots,
        set: (slot, bytes) =>
          full
            ? Effect.fail(
                new Save.StoreFailed({ slot, message: "It is full." })
              )
            : slots.set(slot, bytes),
      };
      return Effect.gen(function* () {
        const game = yield* Test.make(Told);
        const told: Save.SlotStatus[] = [];
        game.ui.subscribe(Status, (status) => {
          told.push(status);
        });
        yield* game.step();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Save.autosave(game.app);
            yield* game.step();
            yield* game.app.dispatch(Finish, {});
            yield* game.step();
            full = false;
            yield* game.app.dispatch(Finish, {});
            yield* game.step();
          })
        );
        yield* game.step();
        expect(told).toEqual([
          { _tag: "Off" },
          { _tag: "Unasked" },
          {
            _tag: "Failed",
            error: new Save.StoreFailed({
              slot: "finished",
              message: "It is full.",
            }),
          },
          { _tag: "Saved" },
          { _tag: "Off" },
        ]);
        expect(yield* slots.slots).toEqual(["finished"]);
      }).pipe(
        Effect.provide(Layer.merge(Save.layer(store), Logger.layer([]))),
        Effect.scoped
      );
    }
  );

  it.effect("that can't be taken is told as Save.Refused", () => {
    const slots = Save.makeMemory();
    return Effect.gen(function* () {
      const game = yield* Test.make(Told);
      const told: Save.SlotStatus[] = [];
      game.ui.subscribe(Status, (status) => {
        told.push(status);
      });
      yield* Save.autosave(game.app);
      yield* game.app.dispatch(Spoil, {});
      yield* game.step();
      expect(told.at(-1)).toEqual({
        _tag: "Failed",
        error: new Save.Refused({
          message: `"sv/Small.tiles" holds a value its codec refuses: a map of 3 by 3 is in a field of 2 by 2`,
        }),
      });
      expect(yield* slots.slots).toEqual([]);
    }).pipe(
      Effect.provide(Layer.merge(Save.layer(slots), Logger.layer([]))),
      Effect.scoped
    );
  });

  it.effect(
    "that a store of the game's own throws for is told as Save.StoreFailed",
    () =>
      Effect.gen(function* () {
        const game = yield* Test.make(Told);
        const told: Save.SlotStatus[] = [];
        game.ui.subscribe(Status, (status) => {
          told.push(status);
        });
        yield* Save.autosave(game.app);
        yield* game.app.dispatch(Finish, {});
        yield* game.step();
        expect(told.at(-1)).toEqual({
          _tag: "Failed",
          error: new Save.StoreFailed({
            slot: "finished",
            message: "The quota is exceeded.",
          }),
        });
      }).pipe(
        Effect.provide(
          Layer.merge(
            Save.layer({
              ...Save.makeMemory(),
              set: () =>
                Effect.sync(() => {
                  throw new Error("The quota is exceeded.");
                }),
            }),
            Logger.layer([])
          )
        ),
        Effect.scoped
      )
  );

  it("whose slot's status is not for the code of the tick to read", () => {
    const Reads = System.tick(
      "sv/Reads",
      // @ts-expect-error what the store did is outside the world, which a tick reads
      function* () {
        yield* Finished;
      }
    );
    expect(Reads.name).toBe("sv/Reads");
  });

  it("has a status that Save.match is given every case of", () => {
    expect(
      Save.match(
        { _tag: "Saved" },
        {
          Off: () => "off",
          Unasked: () => "unasked",
          Saved: () => "saved",
          Failed: ({ error }) => error.message,
        }
      )
    ).toBe("saved");
    // @ts-expect-error a status left out is a case that doesn't compile
    Save.match({ Off: () => "", Unasked: () => "", Saved: () => "" });
  });
});
