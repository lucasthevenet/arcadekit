import { Cause, Context, Data, Effect, Exit, Result, Schema } from "effect";
import { assert, describe, expect, it } from "vitest";

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
  Save,
  Singleton,
  State,
  System,
  Time,
  World,
} from "../src/index";
import type { BuiltIn } from "../src/Services";

const Phase = State.define("st/Phase", ["menu", "playing", "paused"]);
const Weather = State.define("st/Weather", ["dry", "wet"], "wet");

const Ball = Component.define("st/Ball", { x: Field.f32 });
const Balls = Query.all(Ball).pipe(Query.writes(Ball));

/** A system that notes its name every time it runs. */
const noting = <const N extends string>(name: N, into: string[]) =>
  System.tick(name, function* () {
    into.push(name);
  });
const drawing = (name: string, into: string[]) =>
  System.frame(name, function* () {
    into.push(name);
  });

const Go = Action.define(
  "st/Go",
  Schema.Struct({
    to: Schema.Literals(["menu", "playing", "paused"]),
    refuse: Schema.Boolean,
  })
);
class Refused extends Data.TaggedError("Refused")<{}> {}
const go = Action.handler(Go, function* ({ refuse, to }) {
  const phase = yield* Phase.sets;
  const from = phase.value;
  phase.set(to);
  if (refuse) {
    return yield* new Refused();
  }
  return from;
});
describe("a state", () => {
  it("starts in its first value, or the one it is given, and is asked for by name", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ handlers: [go] }));
        const read = yield* app.read(
          Effect.gen(function* () {
            const phase = yield* Phase;
            const weather = yield* Weather;
            return [phase.value, phase.next, weather.value, weather.is("wet")];
          })
        );
        expect(read).toEqual(["menu", undefined, "wet", true]);
        expect(Phase.values).toEqual(["menu", "playing", "paused"]);
        expect(Phase.name).toBe("st/Phase");
      })
    );
    expect(() => State.define("st/Bad", ["a", "b"], "c" as never)).toThrow(
      /cannot start in "c".*Its values are: a, b/
    );
    // @ts-expect-error not one of the state's values
    const _flying = State.is(Phase, "flying");
    // @ts-expect-error a hook for a value the state does not have
    State.onEnter(Phase, "flying");
  });

  it("is entered at the start of the tick after it was asked for", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const seen: string[] = [];
        const asked: unknown[] = [];
        const Watch = System.tick("Watch", function* () {
          const phase = yield* Phase.sets;
          seen.push(`${phase.value}${phase.next ? `>${phase.next}` : ""}`);
          const { tick } = yield* Time;
          if (tick === 2) {
            phase.set("playing");
            asked.push([phase.value, phase.next]);
          }
          if (tick === 4) {
            const flying = Result.try(() =>
              // @ts-expect-error not one of the state's values
              phase.set("flying")
            );
            asked.push(Result.isFailure(flying) ? flying.failure : "set");
            phase.set("paused");
            asked.push(phase.next);
            phase.set("playing");
            asked.push(phase.next);
          }
        });
        const app = yield* App.make(
          App.define({ systems: [Watch], handlers: [go] })
        );
        for (let tick = 0; tick < 5; tick++) {
          app.tick(1);
        }
        expect(asked).toEqual([
          // Asked for, and not entered yet.
          ["menu", "playing"],
          new Error(
            'The state "st/Phase" has no value "flying". Its values are: menu, playing, paused.'
          ),
          // Asking for where the game is takes an earlier ask back.
          "paused",
          undefined,
        ]);
        expect(seen).toEqual(["menu", "menu", "playing", "playing", "playing"]);
        // From outside, an action asks; the next tick enters.
        expect(app.dispatch(Go, { to: "paused", refuse: false })).toEqual(
          Exit.succeed("playing")
        );
        app.tick(1);
        expect(seen.at(-1)).toBe("paused");
      })
    );
  });

  it("is as it was after a refused action", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const ran: string[] = [];
        const app = yield* App.make(
          App.define({
            systems: [
              State.onEnter(Phase, "playing", "Entered", function* () {
                ran.push("Entered");
              }),
            ],
            handlers: [go],
          })
        );
        const world = yield* app.read(World);
        // Asking for the state a game is in already changes nothing at all.
        const untouched = world.hash();
        app.dispatch(Go, { to: "menu", refuse: false });
        expect(world.hash()).toBe(untouched);
        app.tick(1);
        const before = world.hash();
        expect(
          Exit.isFailure(app.dispatch(Go, { to: "playing", refuse: true }))
        ).toBe(true);
        expect(world.hash()).toBe(before);
        app.dispatch(Go, { to: "menu", refuse: false });
        expect(world.hash()).toBe(before);
        app.tick(1);
        expect(ran).toEqual([]);
        app.dispatch(Go, { to: "playing", refuse: false });
        expect(world.hash()).not.toBe(before);
        app.tick(1);
        expect(ran).toEqual(["Entered"]);
      })
    );
  });
});

describe("a run condition", () => {
  it("runs a system only on the ticks when it holds", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const ran: string[] = [];
        const app = yield* App.make(
          App.define({
            systems: [
              noting("Always", ran),
              noting("Playing", ran).pipe(
                System.runIf(State.is(Phase, "playing"))
              ),
              noting("NotMenu", ran).pipe(
                System.runIf(State.is(Phase, "playing", "paused"))
              ),
            ],
            handlers: [go],
          })
        );
        const tick = (): string[] => {
          ran.length = 0;
          app.tick(1);
          return [...ran];
        };
        expect(tick()).toEqual(["Always"]);
        app.dispatch(Go, { to: "playing", refuse: false });
        expect(tick()).toEqual(["Always", "Playing", "NotMenu"]);
        expect(tick()).toEqual(["Always", "Playing", "NotMenu"]);
        app.dispatch(Go, { to: "paused", refuse: false });
        expect(tick()).toEqual(["Always", "NotMenu"]);
        app.dispatch(Go, { to: "menu", refuse: false });
        expect(tick()).toEqual(["Always"]);
        // The order systems run in is not the conditions' business.
        expect(app.systemOrder).toEqual(["Always", "Playing", "NotMenu"]);
      })
    );
  });

  it("can be any Effect that gives a boolean, and several have all to hold", () => {
    const Switch = Singleton.define("st/Switch", { on: Field.u8 }, { on: 1 });
    const Flip = Action.define("st/Flip", Schema.Struct({}));
    const flip = Action.handler(Flip, function* () {
      const held = yield* Switch.writes;
      held.on = held.on === 1 ? 0 : 1;
    });
    class Broken extends Data.TaggedError("Broken")<{}> {}
    const evenTick = Effect.map(Time, (time) => time.tick % 2 === 0);
    let asked = 0;
    const switchedOn = Effect.gen(function* () {
      asked++;
      if (asked > 100) {
        return yield* new Broken();
      }
      return (yield* Switch).on === 1;
    });
    Effect.runSync(
      Effect.gen(function* () {
        const ran: number[] = [];
        const Both = System.tick("Both", function* () {
          ran.push((yield* Time).tick);
        }).pipe(System.runIf(evenTick), System.runIf(switchedOn));
        const Either = System.runIf(
          System.tick("Other", function* () {}),
          switchedOn
        );
        const app = yield* App.make(
          App.define({ systems: [Both, Either], handlers: [flip] })
        );
        for (let tick = 0; tick < 6; tick++) {
          app.tick(1);
        }
        expect(ran).toEqual([2, 4, 6]);
        // The second condition is asked only when the first held; the
        // other system asks every tick.
        expect(asked).toBe(3 + 6);
        app.dispatch(Flip, {});
        app.tick(1);
        app.tick(1);
        expect(ran).toEqual([2, 4, 6]);
        // What a condition can fail with is what the tick can fail with.
        asked = 100;
        const exit = app.tickExit(1);
        expect(
          Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        ).toBeInstanceOf(Broken);
        const failure: Exit.Exit<void, Broken> = exit;
        void failure;
      })
    );
    // What it needs is the system's: in the tick, a service of the game's
    // own does not compile, and in the frame it has to be provided.
    class Lever extends Context.Service<Lever, { readonly on: boolean }>()(
      "st/Lever"
    ) {}
    const pulled = Effect.map(Lever, (lever) => lever.on);
    System.tick("Pulled", function* () {}).pipe(
      // @ts-expect-error a tick's condition requires no service of the game's own
      System.runIf(pulled)
    );
    System.runIf(
      // @ts-expect-error nor given first
      System.tick("PulledFirst", function* () {}),
      pulled
    );
    const needs: Effect.Effect<unknown, never, Lever> = App.make(
      App.define({
        systems: [
          System.frame("Needy", function* () {}).pipe(System.runIf(pulled)),
        ],
      })
    );
    void needs;
  });

  it("lets a system say what it does in place of running, each time it does not hold", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const ran: string[] = [];
        const say = (what: string) =>
          Effect.sync(() => {
            ran.push(what);
          });
        const app = yield* App.make(
          App.define({
            systems: [
              noting("Hud", ran).pipe(
                System.runIf(State.is(Phase, "playing")),
                System.otherwise(say("Hud hidden"))
              ),
              // Given twice, both, in the order given; and before its
              // condition or after it, the same.
              System.otherwise(noting("Music", ran), say("Music off")).pipe(
                System.runIf(State.is(Phase, "playing", "paused")),
                System.otherwise(say("Music gone"))
              ),
              // In a tick it is the system in every way: what it asks of
              // the commands is done when it is.
              noting("Spawner", ran).pipe(
                System.runIf(State.is(Phase, "playing")),
                System.otherwise(
                  Effect.map(Commands.spawns(Ball), (commands) => {
                    commands.spawn(Ball.of({ x: 1 }));
                  })
                )
              ),
              System.tick("Count", function* () {
                ran.push(`${(yield* Balls).count()} balls`);
              }),
              // With no condition there is no time it is not run, and
              // nothing is done in its place.
              noting("Always", ran).pipe(System.otherwise(say("Never"))),
              // In the frame it is held to what a frame system is: what
              // would change the game throws.
              drawing("Draw", ran).pipe(
                System.runIf(State.is(Phase, "playing")),
                System.otherwise(say("Draw nothing"))
              ),
            ],
            handlers: [go],
          })
        );
        const tick = (): string[] => {
          ran.length = 0;
          app.tick(1);
          app.frame();
          return [...ran];
        };
        expect(tick()).toEqual([
          "Hud hidden",
          "Music off",
          "Music gone",
          "1 balls",
          "Always",
          "Draw nothing",
        ]);
        app.dispatch(Go, { to: "playing", refuse: false });
        expect(tick()).toEqual([
          "Hud",
          "Music",
          "Spawner",
          "1 balls",
          "Always",
          "Draw",
        ]);
        app.dispatch(Go, { to: "paused", refuse: false });
        expect(tick()).toEqual([
          "Hud hidden",
          "Music",
          "2 balls",
          "Always",
          "Draw nothing",
        ]);
        // It is asked for every time, not once.
        expect(tick()).toEqual([
          "Hud hidden",
          "Music",
          "3 balls",
          "Always",
          "Draw nothing",
        ]);
      })
    );
    // What a frame system does in place of running may not change the
    // game either.
    System.frame("Vandal", function* () {}).pipe(
      System.runIf(Effect.succeed(false)),
      // @ts-expect-error a frame system cannot set a state
      System.otherwise(Effect.map(Phase.sets, (phase) => phase.set("paused")))
    );
    // And what it needs and can fail with are the system's: a frame
    // system's, since a tick's may need no service of the game's own.
    class Lamp extends Context.Service<Lamp, { lit: boolean }>()("st/Lamp") {}
    class Burnt extends Data.TaggedError("Burnt")<{}> {}
    const Lit = System.frame("Lit", function* () {}).pipe(
      System.runIf(Effect.succeed(false)),
      System.otherwise(
        Effect.flatMap(Lamp, (lamp) =>
          lamp.lit ? Effect.void : Effect.fail(new Burnt())
        )
      )
    );
    const typed: System.System<Burnt, Lamp> = Lit;
    // @ts-expect-error it can fail, and needs a lamp
    const untyped: System.System<never, never> = Lit;
    expect([typed.name, untyped.name]).toEqual(["Lit", "Lit"]);
    expect(Lit.idle).toBeDefined();
    expect(noting("Plain", []).idle).toBeUndefined();
    System.tick("Unlit", function* () {}).pipe(
      System.runIf(Effect.succeed(false)),
      // @ts-expect-error a tick's otherwise requires no service of the game's own
      System.otherwise(Effect.asVoid(Lamp))
    );
    State.onEnter(
      Phase,
      "playing",
      "st/LampHook",
      // @ts-expect-error a hook is a system of the tick
      function* () {
        void (yield* Lamp).lit;
      }
    );
  });

  it("lets a hook say the same of the time it is set off and its condition does not hold", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const ran: string[] = [];
        const app = yield* App.make(
          App.define({
            systems: [
              State.onEnter(Phase, "playing", "Fanfare", function* () {
                ran.push("Fanfare");
              }).pipe(
                System.runIf(State.is(Weather, "dry")),
                System.otherwise(
                  Effect.sync(() => {
                    ran.push("Too wet for a fanfare");
                  })
                )
              ),
            ],
            handlers: [go],
          })
        );
        app.tick(1);
        expect(ran).toEqual([]);
        app.dispatch(Go, { to: "playing", refuse: false });
        app.tick(1);
        app.tick(1);
        // Once, when it was set off, and not every tick after.
        expect(ran).toEqual(["Too wet for a fanfare"]);
      })
    );
  });

  it("keeps a system that did not run out of what happened while it was off, events and changes alike", () => {
    const Bounced = Event.define(
      "st/Bounced",
      Schema.Struct({ at: Schema.Int })
    );
    Effect.runSync(
      Effect.gen(function* () {
        const heard: number[] = [];
        const moved: number[] = [];
        const Emit = System.tick("Emit", function* () {
          const { tick } = yield* Time;
          (yield* Bounced.emits).emit({ at: tick });
          (yield* Balls).each((ball, entity) => {
            if (entity === tick % 3) {
              ball.x = tick;
            }
          });
        });
        const Listen = System.tick("Listen", function* () {
          for (const { at } of (yield* Bounced).read()) {
            heard.push(at);
          }
          moved.push(
            (yield* Balls.pipe(Query.changed(Ball))).entities().length
          );
        }).pipe(System.runIf(State.is(Phase, "playing")));
        // The same, drawn between ticks.
        const drawn: number[] = [];
        const Look = System.frame("Look", function* () {
          drawn.push(
            (yield* Query.all(Ball).pipe(Query.changed(Ball))).entities().length
          );
        }).pipe(System.runIf(State.is(Phase, "playing")));
        // Typed as any systems, which is the one way to list a watcher ahead
        // of what it watches: the compiler refuses that order where it can see
        // it.
        const systems: readonly System.System<never, BuiltIn>[] = [
          Listen,
          Emit,
          Look,
        ];
        const Three = Plugin.make("st/Three", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(Ball);
            for (let n = 0; n < 3; n++) {
              commands.spawn(Ball.of({ x: 0 }));
            }
          }),
        });
        const app = yield* App.make(
          App.define({ plugins: [Three], systems, handlers: [go] })
        );
        const tick = () => {
          app.tick(1);
          app.frame();
        };
        app.dispatch(Go, { to: "playing", refuse: false });
        tick();
        tick();
        app.dispatch(Go, { to: "paused", refuse: false });
        for (let n = 0; n < 6; n++) {
          tick();
        }
        app.dispatch(Go, { to: "playing", refuse: false });
        tick();
        // It hears the event of the tick before it came back, which came
        // after its turn, and none of the six it sat out before that.
        expect(heard).toEqual([1, 8]);
        // And of the balls, only the one that moved after its turn in that
        // tick: all three moved while it was away.
        expect(moved).toEqual([3, 1, 1]);
        // Drawn after each tick: the one ball the tick it came back moved.
        expect(drawn).toEqual([3, 1, 1]);
      })
    );
  });
});

describe("hooks", () => {
  const game = (ran: string[], extra: System.System<never, World>[] = []) =>
    App.make(
      App.define({
        systems: [
          noting("Tick", ran),
          State.onEnter(Phase, "menu", "EnterMenu", function* () {
            ran.push("EnterMenu");
          }),
          State.onExit(Phase, "menu", "ExitMenu", function* () {
            ran.push("ExitMenu");
          }),
          State.onEnter(Phase, "playing", "EnterPlaying", function* () {
            ran.push("EnterPlaying");
          }),
          State.onExit(Phase, "playing", "ExitPlaying", function* () {
            ran.push("ExitPlaying");
          }),
          State.onEnter(Phase, "paused", "EnterPaused", function* () {
            ran.push("EnterPaused");
          }),
          ...extra,
        ],
        handlers: [go],
      }),
      { checkpointEvery: 1 }
    );

  it("run once when a state is left and entered, before the tick's systems", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const ran: string[] = [];
        const app = yield* game(ran);
        const tick = (): string[] => {
          ran.length = 0;
          app.tick(1);
          return [...ran];
        };
        // The state a game starts in is entered on its first tick.
        expect(ran).toEqual([]);
        expect(tick()).toEqual(["EnterMenu", "Tick"]);
        // A move asked for before the first tick follows it at once.
        const eager = yield* game([]);
        const early: string[] = [];
        const hasty = yield* game(early);
        hasty.dispatch(Go, { to: "playing", refuse: false });
        hasty.tick(1);
        expect(early).toEqual([
          "EnterMenu",
          "ExitMenu",
          "EnterPlaying",
          "Tick",
        ]);
        void eager;
        expect(tick()).toEqual(["Tick"]);
        app.dispatch(Go, { to: "playing", refuse: false });
        // Nothing runs until the tick.
        expect(ran).toEqual(["Tick"]);
        expect(tick()).toEqual(["ExitMenu", "EnterPlaying", "Tick"]);
        expect(tick()).toEqual(["Tick"]);
        // Asking for the state the game is in is not a move.
        app.dispatch(Go, { to: "playing", refuse: false });
        expect(tick()).toEqual(["Tick"]);
        app.dispatch(Go, { to: "paused", refuse: false });
        expect(tick()).toEqual(["ExitPlaying", "EnterPaused", "Tick"]);
        // Only the last ask before a tick counts.
        app.dispatch(Go, { to: "playing", refuse: false });
        app.dispatch(Go, { to: "menu", refuse: false });
        expect(tick()).toEqual(["EnterMenu", "Tick"]);
        // Hooks are not among the systems that run every tick.
        expect(app.systemOrder).toEqual(["Tick"]);
      })
    );
  });

  it("see the state being left, then the state being entered, and can change the world", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const seen: string[] = [];
        const Leaving = State.onExit(Phase, "menu", "Leaving", function* () {
          seen.push(`leaving ${(yield* Phase).value}`);
          (yield* Commands.spawns(Ball)).spawn(Ball.of({ x: 1 }));
        });
        const Entering = State.onEnter(
          Phase,
          "playing",
          "Entering",
          function* () {
            // What the hook before it queued has been applied.
            seen.push(
              `entering ${(yield* Phase).value} with ${(yield* Balls).count()}`
            );
            (yield* Commands.spawns(Ball)).spawn(Ball.of({ x: 2 }));
          }
        );
        const Count = System.tick("Count", function* () {
          seen.push(`tick with ${(yield* Balls).count()}`);
        });
        const app = yield* App.make(
          App.define({ systems: [Count, Entering, Leaving], handlers: [go] })
        );
        app.tick(1);
        app.dispatch(Go, { to: "playing", refuse: false });
        app.tick(1);
        expect(seen).toEqual([
          "tick with 0",
          "leaving menu",
          "entering playing with 1",
          "tick with 2",
        ]);
      })
    );
  });

  it("run in the order they are listed, and only if their condition holds", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const ran: string[] = [];
        const First = State.onEnter(Phase, "playing", "First", function* () {
          ran.push("First");
        });
        const Last = State.onEnter(Phase, "playing", "Last", function* () {
          ran.push("Last");
        });
        const app = yield* App.make(
          App.define({
            systems: [
              State.onEnter(Phase, "playing", "Zeroth", function* () {
                ran.push("Zeroth");
              }),
              First,
              Last,
              State.onEnter(Phase, "playing", "Third", function* () {
                ran.push("Third");
              }),
              State.onEnter(Phase, "playing", "InTheRain", function* () {
                ran.push("InTheRain");
              }).pipe(System.runIf(State.is(Weather, "dry"))),
              State.onEnter(Phase, "playing", "InTheDry", function* () {
                ran.push("InTheDry");
              }).pipe(System.runIf(State.is(Weather, "dry"))),
            ],
            handlers: [go],
          })
        );
        app.tick(1);
        app.dispatch(Go, { to: "playing", refuse: false });
        app.tick(1);
        expect(ran).toEqual(["Zeroth", "First", "Last", "Third"]);
      })
    );
  });

  it("let a hook ask for another state, which is entered a tick later", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const ran: string[] = [];
        const SkipIntro = State.onEnter(
          Phase,
          "menu",
          "SkipIntro",
          function* () {
            ran.push("SkipIntro");
            (yield* Phase.sets).set("playing");
          }
        );
        const Bail = State.onExit(Phase, "menu", "Bail", function* () {
          ran.push("Bail");
          (yield* Phase.sets).set("paused");
        });
        const app = yield* game(ran, [SkipIntro, Bail]);
        app.tick(1);
        expect(ran).toEqual(["EnterMenu", "SkipIntro", "Tick"]);
        ran.length = 0;
        app.tick(1);
        // The move that was under way is made; what the leaving hook asked
        // for waits its turn.
        expect(ran).toEqual(["ExitMenu", "Bail", "EnterPlaying", "Tick"]);
        ran.length = 0;
        app.tick(1);
        expect(ran).toEqual(["ExitPlaying", "EnterPaused", "Tick"]);
      })
    );
  });

  it("let a first hook overrule what was asked for before the first tick", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const ran: string[] = [];
        const Overrule = State.onEnter(Phase, "menu", "Overrule", function* () {
          ran.push("Overrule");
          (yield* Phase.sets).set("paused");
        });
        const app = yield* game(ran, [Overrule]);
        app.dispatch(Go, { to: "playing", refuse: false });
        app.tick(1);
        // The hook asked last, and what a hook asks for waits a tick.
        expect(ran).toEqual(["EnterMenu", "Overrule", "Tick"]);
        ran.length = 0;
        app.tick(1);
        expect(ran).toEqual(["ExitMenu", "EnterPaused", "Tick"]);
      })
    );
  });

  it("leave a state alone that no hook waits for, wherever it is looked at from, until a value is asked for", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const Late = System.tick("Late", function* () {
          const phase = yield* Phase.sets;
          if ((yield* Time).tick === 3) {
            phase.set("playing");
          }
        });
        const Draw = System.frame("Draw", function* () {
          void (yield* Phase).value;
        });
        const looked = yield* App.make(App.define({ systems: [Late] }));
        const drawn = yield* App.make(App.define({ systems: [Draw] }));
        const unseen = yield* App.make(App.define({ systems: [] }));
        const [lookedWorld, drawnWorld, unseenWorld] = [
          yield* looked.read(World),
          yield* drawn.read(World),
          yield* unseen.read(World),
        ];
        for (let tick = 1; tick <= 5; tick++) {
          looked.tick(1);
          drawn.tick(1);
          drawn.frame();
          unseen.tick(1);
          // A look changes nothing from the frame, which a replay doesn't
          // run.
          expect(drawnWorld.hash()).toBe(unseenWorld.hash());
          // And from the tick, until a value is asked for in tick 3.
          expect(lookedWorld.hash() === unseenWorld.hash()).toBe(tick < 3);
        }
        // Asked for in tick 3: entered, and moved, at the start of tick 4.
        expect({ ...lookedWorld.singleton(Phase) }).toEqual({
          value: "playing",
          next: null,
          entered: 1,
        });
      })
    );
  });

  it("enter two states in order of name, whatever order they were asked for in", () => {
    for (const weatherFirst of [true, false]) {
      Effect.runSync(
        Effect.gen(function* () {
          const ran: string[] = [];
          const hooks = [
            State.onEnter(Weather, "wet", "Rain", function* () {
              ran.push("Rain");
            }),
            State.onEnter(Weather, "dry", "Sun", function* () {
              ran.push("Sun");
            }),
            State.onEnter(Phase, "menu", "Menu", function* () {
              ran.push("Menu");
            }),
            State.onEnter(Phase, "playing", "Play", function* () {
              ran.push("Play");
            }),
          ];
          const Change = System.tick("Change", function* () {
            if ((yield* Time).tick !== 1) {
              return;
            }
            if (weatherFirst) {
              (yield* Weather.sets).set("dry");
              (yield* Phase.sets).set("playing");
            } else {
              (yield* Phase.sets).set("playing");
              (yield* Weather.sets).set("dry");
            }
          });
          const app = yield* App.make(
            App.define({
              systems: [...(weatherFirst ? hooks : hooks.toReversed()), Change],
            })
          );
          app.tick(1);
          app.tick(1);
          // "st/Phase" before "st/Weather".
          expect(ran).toEqual(["Menu", "Rain", "Play", "Sun"]);
        })
      );
    }
  });

  it("are refused for a value the state does not have, and for a name twice", () => {
    const Flying = System.triggered(noting("Flying", []), {
      state: Phase,
      on: "enter",
      value: "flying",
    });
    expect(() =>
      Effect.runSync(App.make(App.define({ systems: [Flying] })))
    ).toThrow(
      /System "Flying" is a hook for "flying", which is not a value of the state "st\/Phase"/
    );
    App.define(
      // @ts-expect-error duplicate system name
      {
        systems: [
          noting("Twice", []),
          State.onEnter(Phase, "menu", "Twice", function* () {}),
        ],
      }
    );
  });
});

describe("a state in a save", () => {
  const Level = State.define("st/Level", ["one", "two", "three"]);
  const Next = Action.define("st/Next", Schema.Struct({}));
  const next = Action.handler(Next, function* () {
    const level = yield* Level.sets;
    level.set(level.value === "one" ? "two" : "three");
  });
  const Built = Component.define("st/Built", { level: Field.json<string>() });
  const build = <const L extends "one" | "two" | "three">(level: L) =>
    State.onEnter(Level, level, `Build ${level}`, function* () {
      (yield* Commands.spawns(Built)).spawn(Built.of({ level }));
    });
  const Rules = Plugin.make("st/Rules", {
    systems: [
      build("one"),
      build("two"),
      build("three"),
      System.tick("Roll", function* () {
        (yield* Balls).each((ball) => {
          ball.x += 1;
        });
      }).pipe(System.runIf(State.is(Level, "two", "three"))),
    ],
    handlers: [next],
    setup: Effect.gen(function* () {
      (yield* Commands.spawns(Ball)).spawn(Ball.of({ x: 0 }));
    }),
  });
  const built = (app: App.Any) =>
    Effect.map(app.read(Query.all(Built)), (view) => {
      const out: string[] = [];
      view.each((row) => {
        out.push(row.level);
      });
      return out;
    });

  it("is saved with what was asked for, and its first hooks do not run again", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Rules] }), {
          checkpointEvery: 1,
        });
        // Before the first tick nothing has been entered or written.
        const fresh = yield* App.make(App.define({ plugins: [Rules] }), {
          checkpointEvery: 1,
        });
        const world = yield* app.read(World);
        expect((yield* fresh.read(World)).hash()).toBe(world.hash());
        app.tick(1);
        expect(yield* built(app)).toEqual(["one"]);
        expect(world.hash()).not.toBe((yield* fresh.read(World)).hash());
        // Saved with a move asked for and not made yet.
        app.dispatch(Next, {});
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
        for (const each of [app, loaded]) {
          each.tick(1);
          each.tick(1);
          each.dispatch(Next, {});
          each.tick(1);
        }
        // Level one was not built again; two and three were built once.
        expect(yield* built(loaded)).toEqual(["one", "two", "three"]);
        expect(loadedWorld.hash()).toBe(world.hash());
        let x = 0;
        (yield* loaded.read(Query.all(Ball))).each((ball) => {
          x = ball.x;
        });
        expect(x).toBe(3);

        // And the whole game replays, hooks and conditions with it.
        const played = app.record();
        const again = yield* Journal.replay(
          played,
          App.define({ plugins: [Rules] }),
          { checkpointEvery: 1 }
        );
        expect((yield* again.read(World)).hash()).toBe(world.hash());
      })
    );
  });

  it("refuses to give a value it no longer has, which a save from before could hold", () => {
    const Before = State.define("st/Door", ["open", "shut", "ajar"]);
    const After = State.define("st/Door", ["open", "shut"]);
    const Prop = Action.define("st/Prop", Schema.Struct({}));
    const prop = Action.handler(Prop, function* () {
      (yield* Before.sets).set("ajar");
    });
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ handlers: [prop] }));
        expect(app.dispatch(Prop, {})).toEqual(Exit.void);
        app.tick(1);
        const save = app.save();
        assert(Exit.isSuccess(save));
        const loaded = yield* App.make(App.define({}), { save: save.value });
        const exit = yield* Effect.exit(
          loaded.read(Effect.map(After, (door) => door.value))
        );
        assert(Exit.isFailure(exit));
        expect(String(Cause.squash(exit.cause))).toContain(
          'The state "st/Door" holds "ajar", which is not one of its values: open, shut.'
        );
      })
    );
  });

  it("goes on after a load into a game that never looks at it, with what was asked for", () => {
    Effect.runSync(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Rules] }));
        app.tick(1);
        expect(Exit.isSuccess(app.dispatch(Next, {}))).toBe(true);
        const save = app.save();
        if (Exit.isFailure(save)) {
          throw new Error("the save was refused");
        }
        // Nothing in this game looks at the level, and no list names it.
        const loaded = yield* App.make(App.define({ handlers: [] }), {
          save: save.value,
        });
        loaded.tick(1);
        expect({ ...(yield* loaded.read(World)).singleton(Level) }).toEqual({
          value: "two",
          next: null,
          entered: 1,
        });
      })
    );
  });
});
