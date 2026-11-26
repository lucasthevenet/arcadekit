import { assert, describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import {
  World as EcsWorld,
  readSnapshot,
  writeSnapshot,
} from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Event,
  Field,
  Journal,
  Plugin,
  Query,
  Random,
  Save,
  System,
  Time,
  World,
} from "../src/index.ts";
import type { JsonValue } from "../src/index.ts";
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
  name: Field.json<string>(),
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
const Sound = System.tick("Sound", function* () {
  const { tick } = yield* Time;
  (yield* Sounded.emits).emit({ tick, at: new Date(tick * 1000) });
});
/**
 * Reads what Sound emits on the tick it is emitted, and Listen on the next:
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
  systems: [Listen, Drift, Bot, Sound, Echo, Pulsing],
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
const start = { seed: 21, checkpointEvery: 1 } as const;

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
          save = unwrap(yield* Effect.exit(app.save()));
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
        tail: yield* app.record(save!),
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
        yield* withApp(App.make(Played, { save, checkpointEvery: 1 }), (app) =>
          Effect.gen(function* () {
            // The world holds the game's time, so the save brings it back.
            expect(app.time).toEqual(saved);
            // The log starts again.
            expect(app.actionLog).toEqual([]);
          })
        );
        // What the game logged after the save is replayed from the save, which
        // the recording holds, against the checkpoints it took after every tick.
        const resumed = yield* withApp(
          Journal.replay(recorded.tail, Played, { checkpointEvery: 1 }),
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
        // Its first entry is the checkpoint of the state it was loaded in.
        expect(Action.isCheckpoint(resumed.log[0]!)).toBe(true);
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
    "holds the actions that were waiting, the simulation's own among them, and applies them in order",
    () =>
      withApp(
        App.make(Played, { seed: 21, checkpointEvery: 0 }),
        (app, world) =>
          Effect.gen(function* () {
            for (let i = 0; i < 12; i++) {
              yield* app.tick(1);
            }
            // Tick 12 divides by 3 and by 4: the bot has enqueued an Add and a
            // Double. Then two more arrive from outside.
            yield* app.enqueue(Add, { by: 100 });
            yield* app.enqueueByName("sv/Double", {});
            const save = unwrap(yield* Effect.exit(app.save()));
            expect(queuedIn(save)).toEqual([
              { name: "sv/Add", payload: { by: 7 } },
              { name: "sv/Double", payload: {} },
              { name: "sv/Add", payload: { by: 100 } },
              { name: "sv/Double", payload: {} },
            ]);
            yield* app.tick(1);
            const expected = world.hash();
            const loaded = yield* withApp(
              App.make(Played, { save, checkpointEvery: 1 }),
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
            const taken = unwrap(yield* Effect.exit(app.save()));
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
      withApp(
        App.make(Played, { seed: 21, checkpointEvery: 0 }),
        (app, world) =>
          Effect.gen(function* () {
            for (let i = 0; i < 4; i++) {
              yield* app.tick(1);
            }
            const save = unwrap(yield* Effect.exit(app.save()));
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
              App.make(Played, { save, checkpointEvery: 1 }),
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
          return unwrap(yield* Effect.exit(app.save()));
        })
      );
      yield* withApp(App.make(Played, { save, checkpointEvery: 1 }), (app) =>
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
            Journal.replay(recorded.tail, Played, { checkpointEvery: 1 }),
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
        Journal.replay({ ...tail, save: decoded }, Played, {
          checkpointEvery: 1,
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
  const Blob = Component.define("sv/Blob", { v: Field.json<JsonValue>() });

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
              expect(refusal(yield* Effect.exit(app.save())).message).toMatch(
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
            expect(refusal(yield* Effect.exit(app.save())).message).toContain(
              '"sv/Blob.v"'
            );
            yield* app.dispatch(Mend, {});
            expect(Exit.isSuccess(yield* Effect.exit(app.save()))).toBe(true);
          })
      );
    })
  );

  it.effect("is not saved in the middle of a tick", () =>
    Effect.gen(function* () {
      let app: App.Any | undefined;
      let thrown: unknown;
      const Greedy = System.tick("Greedy", function* () {
        const saved = yield* Effect.exit(app!.save());
        thrown = Exit.isFailure(saved) ? Cause.squash(saved.cause) : undefined;
      });
      yield* withApp(App.make(App.define({ systems: [Greedy] })), (made) =>
        Effect.gen(function* () {
          app = made;
          yield* made.tick(1);
        })
      );
      expect(String(thrown)).toMatch(/save\(\) was called during a tick/);
    })
  );
});

describe("a save that cannot be loaded", () => {
  const load = (save: Save.Save, game: object = Played) =>
    Effect.exit(App.make(game as typeof Played, { save, checkpointEvery: 1 }));

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
            return unwrap(yield* Effect.exit(app.save()));
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
          new TextEncoder().encode(
            text.replace('"logLength":1', '"logLength":-1')
          ),
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
          /^Can't load the "sv\/Sounded" events waiting to be read: one is in a form that is no longer taken: .*A migration changes the events and the queued actions of a save in `world.stores`\.$/s
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
          /"sv\/Gone", which this program doesn't define.* A migration renames or removes a component in a save\.$/su
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
          systems: [Listen, Drift, Bot, Sound, Echo],
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
          'The snapshot holds an event named "sv/Never" waiting to be read, which this program doesn\'t define: it was renamed or removed since. A migration changes the events and the queued actions of a save in `world.stores`.'
        );
      })
  );
});
