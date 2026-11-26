import { assert, describe, expect, it } from "@effect/vitest";
import { Context, Data, Effect, Exit, Schema } from "effect";

import type { Spawned } from "../src/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  EntityId,
  Event,
  Events,
  Field,
  Plugin,
  Query,
  Random,
  Replay,
  System,
  Time,
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";
import type { BuiltIn } from "../src/Services.ts";

const Health = Component.define("ru/Health", { hp: Field.i32 });
const Energy = Component.define("ru/Energy", { points: Field.i32 });
const Owner = Component.define("ru/Owner", { player: Field.u8 });
const Turn = Component.define("ru/Turn", {
  player: Field.u8,
  number: Field.i32,
});

const Damaged = Event.define(
  "ru/Damaged",
  Schema.Struct({ target: EntityId, amount: Schema.Number })
);
const Died = Event.define("ru/Died", Schema.Struct({ entity: EntityId }));
const Ping = Event.define("ru/Ping", Schema.Number);
// Says a number: how code outside the simulation has an event emitted.
const Say = Action.define("ru/Say", Schema.Struct({ n: Schema.Number }));
const say = Action.handler(Say, function* ({ n }) {
  (yield* Ping.emits).emit(n);
});

/** Builds an app, and hands it to `use`. */
const withApp = <A, T, E = never, E2 = never>(
  make: Effect.Effect<A, E>,
  use: (app: A) => Effect.Effect<T, E2>
) => Effect.flatMap(make, use);

/** The events waiting to be read, by name, as `app.inspect()` copies them. */
const waiting = Effect.fnUntraced(function* (app: App.Any) {
  return (yield* app.inspect()).stores[Event.STORE];
});

/** The applied actions of a log, without the hash checks recorded among them. */
const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isHashCheck(entry));

describe("events", () => {
  it.effect(
    "reach every system exactly once, whichever side of the emitter it runs on",
    () =>
      Effect.gen(function* () {
        const seen: Record<string, Array<number>[]> = { Before: [], After: [] };
        const reader = (name: string) =>
          System.tick(name, function* () {
            const ping = yield* Ping.emits;
            seen[name]!.push([...ping.read()]);
          });
        const Emitter = System.tick("Emitter", function* () {
          const ping = yield* Ping.emits;
          const { tick } = yield* Time;
          if (tick <= 2) {
            ping.emit(tick * 10);
            ping.emit(tick * 10 + 1);
          }
        });
        const systems = [reader("Before"), Emitter, reader("After")] as const;
        yield* withApp(App.make(App.define({ systems })), (app) =>
          Effect.gen(function* () {
            for (let i = 0; i < 4; i++) {
              yield* app.tick(1);
            }
            // The later system sees events the tick they are emitted...
            expect(seen.After).toEqual([[10, 11], [20, 21], [], []]);
            // ...the earlier one sees the same events, once, a tick later.
            expect(seen.Before).toEqual([[], [10, 11], [20, 21], []]);
            // And then they are gone.
            expect(yield* waiting(app)).toBeUndefined();
          })
        );
      })
  );

  it.effect(
    "reach the system that emits them on its next run, once what they name is spawned",
    () =>
      Effect.gen(function* () {
        const Shot = Event.define("ru/Shot", Schema.Struct({ shot: EntityId }));
        const heard: (Readonly<{ hp: number }> | undefined)[][] = [];
        const Shoot = System.tick("Shoot", function* () {
          const { tick } = yield* Time;
          const commands = yield* Commands.spawns(Health);
          const world = yield* App_World;
          const shots = yield* Shot.emits;
          shots.emit({ shot: commands.spawn(Health.of({ hp: tick })) });
          heard.push(shots.read().map(({ shot }) => world.get(shot, Health)));
        });
        yield* withApp(App.make(App.define({ systems: [Shoot] })), (app) =>
          Effect.gen(function* () {
            for (let i = 0; i < 3; i++) {
              yield* app.tick(1);
            }
            // Each of its own once, on the tick after, as a system listed ahead of
            // it hears them: by then the entity is spawned.
            expect(heard).toEqual([[], [{ hp: 1 }], [{ hp: 2 }]]);
          })
        );
      })
  );

  it.effect(
    "can be emitted from inside a query loop and are read in order",
    () =>
      Effect.gen(function* () {
        const Hit = System.tick("Hit", function* () {
          const damaged = yield* Damaged.emits;
          const wounded = yield* Query.all(Health).pipe(Query.writes(Health));
          wounded.each((health, entity) => {
            health.hp -= 3;
            damaged.emit({ target: entity, amount: 3 });
          });
        });
        const log: string[] = [];
        const Report = System.tick("Report", function* () {
          const damaged = yield* Damaged.emits;
          for (const event of damaged.read()) {
            log.push(`${idOf(event.target)}:${event.amount}`);
          }
        });
        const wounded: Spawned[] = [];
        const Two = Plugin.make("ru/Two", {
          setup: Effect.gen(function* () {
            const commands = yield* Commands.spawns(Health);
            wounded.push(
              commands.spawn(Health.of({ hp: 10 })),
              commands.spawn(Health.of({ hp: 10 }))
            );
          }),
        });
        yield* withApp(
          App.make(App.define({ plugins: [Two], systems: [Hit, Report] })),
          (app) =>
            Effect.gen(function* () {
              yield* app.tick(1);
              expect(log).toEqual(wounded.map((entity) => `${idOf(entity)}:3`));
              expect(wounded).toHaveLength(2);
            })
        );
      })
  );

  it.effect("are dropped a tick after they were emitted, read or not", () =>
    Effect.gen(function* () {
      const seen: Array<number>[] = [];
      const Sometimes = System.tick("Sometimes", function* () {
        const { tick } = yield* Time;
        if (tick === 1 || tick === 4) {
          seen.push([...(yield* Ping).read()]);
        }
      });
      yield* withApp(
        App.make(App.define({ systems: [Sometimes], handlers: [say] })),
        (app) =>
          Effect.gen(function* () {
            yield* app.tick(1); // creates the reader
            yield* app.dispatch(Say, { n: 1 });
            yield* app.tick(1);
            yield* app.dispatch(Say, { n: 2 });
            yield* app.tick(1);
            yield* app.dispatch(Say, { n: 3 });
            yield* app.tick(1);
            // It looked at ticks 1 and 4 only: events 1 and 2 had been dropped by then.
            expect(seen).toEqual([[], [3]]);
          })
      );
    })
  );

  it.effect(
    "are emitted by the simulation alone: outside it, an action emits them",
    () =>
      Effect.gen(function* () {
        let kept: { emit(n: number): void } | undefined;
        let bus: { emit(def: typeof Ping, n: number): void } | undefined;
        const Keeper = System.tick("Keeper", function* () {
          kept = yield* Ping.emits;
          // A system of the tick that has the bus and no handle emits through it.
          const events = yield* Effect.service(Events);
          assert(events instanceof EventBus);
          events.emit(Ping, 7);
          bus = events;
        });
        yield* withApp(
          App.make(App.define({ systems: [Keeper], handlers: [say] })),
          (app) =>
            Effect.gen(function* () {
              yield* app.tick(1);
              expect(yield* waiting(app)).toEqual({ "ru/Ping": [7] });
              const refused =
                /The event "ru\/Ping" was emitted from outside the simulation\..*Issue an action whose handler emits it/;
              // @ts-expect-error the app hands out no bus to emit through
              void app.events;
              // Through a handle and through the bus, each of which a system kept.
              expect(() => kept!.emit(1)).toThrow(refused);
              expect(() => bus!.emit(Ping, 1)).toThrow(refused);
              expect(yield* waiting(app)).toEqual({ "ru/Ping": [7] });
              // An action's handler is the simulation's.
              yield* app.dispatch(Say, { n: 1 });
              expect(yield* waiting(app)).toEqual({ "ru/Ping": [7, 1] });
            })
        );
      })
  );
});

// --- a tiny turn-based duel, used by the action tests -------------------------

class NotYourTurn extends Schema.TaggedError<NotYourTurn>()("NotYourTurn", {
  player: Schema.Number,
}) {}
class NotEnoughEnergy extends Schema.TaggedError<NotEnoughEnergy>()(
  "NotEnoughEnergy",
  { have: Schema.Number, need: Schema.Number }
) {}
class NoSuchTarget extends Schema.TaggedError<NoSuchTarget>()(
  "NoSuchTarget",
  {}
) {}

const Attack = Action.define(
  "Attack",
  Schema.Struct({ attacker: EntityId, target: EntityId }),
  { error: Schema.Union([NotYourTurn, NotEnoughEnergy, NoSuchTarget]) }
);
const EndTurn = Action.define(
  "EndTurn",
  Schema.Struct({ player: Schema.Number }),
  { error: NotYourTurn }
);
const Summon = Action.define(
  "Summon",
  Schema.Struct({ player: Schema.Number, hp: Schema.Number }),
  { error: NoSuchTarget }
);
const Unhandled = Action.define("Unhandled", Schema.Struct({}));

const TurnQuery = Query.all(Turn).pipe(Query.writes(Turn));
const currentTurn = Effect.gen(function* () {
  const turns = yield* TurnQuery;
  let player = 0;
  let number = 0;
  turns.each((turn) => {
    player = turn.player;
    number = turn.number;
  });
  return { player, number };
});

const attack = Action.handler(Attack, function* ({ attacker, target }) {
  const world =
    (yield* Query.all(Health)).spec &&
    (yield* App_World.writes(Energy, Health));
  const turn = yield* currentTurn;
  const owner = world.get(attacker, Owner);
  if (owner === undefined || owner.player !== turn.player) {
    return yield* NotYourTurn.make({ player: turn.player });
  }
  const energy = world.get(attacker, Energy)!.points;
  if (energy < 2) {
    return yield* NotEnoughEnergy.make({ have: energy, need: 2 });
  }
  if (!world.has(target, Health)) {
    return yield* NoSuchTarget.make({});
  }
  // Validation is done; from here on the action will succeed.
  world.set(attacker, Energy, { points: energy - 2 });
  const hp = world.get(target, Health)!.hp - 4;
  world.set(target, Health, { hp });
  (yield* Damaged.emits).emit({ target, amount: 4 });
  return hp;
});

const endTurn = Action.handler(EndTurn, function* ({ player }) {
  const turns = yield* TurnQuery;
  const turn = yield* currentTurn;
  if (player !== turn.player) {
    return yield* NotYourTurn.make({ player: turn.player });
  }
  turns.each((t) => {
    t.player = t.player === 1 ? 2 : 1;
    t.number += 1;
  });
});

/** Queues a spawn and an event, then may refuse: used to test rollback. */
const summon = Action.handler(Summon, function* ({ hp, player }) {
  const commands = yield* Commands.spawns(Health, Owner, Energy);
  const died = yield* Died.emits;
  const entity = commands.spawn(
    Health.of({ hp }),
    Owner.of({ player }),
    Energy.of({ points: 0 })
  );
  died.emit({ entity });
  if (hp <= 0) {
    return yield* NoSuchTarget.make({});
  }
  return entity;
});

import { idOf } from "../src/ecs/component.ts";
// The World service, imported under another name so `world` reads naturally above.
import { World as App_World } from "../src/index.ts";
import { EventBus } from "../src/internal/eventBus.ts";
import { thrown } from "./checks.ts";

const Death = System.tick("Death", function* () {
  const damaged = yield* Damaged.emits;
  const died = yield* Died.emits;
  const commands = yield* Commands;
  const world = yield* App_World;
  for (const { target } of damaged.read()) {
    const health = world.get(target, Health);
    if (health !== undefined && health.hp <= 0) {
      commands.despawn(target);
      died.emit({ entity: target });
    }
  }
});

const Recharge = System.tick("Recharge", function* () {
  const fighters = yield* Query.all(Energy).pipe(Query.writes(Energy));
  fighters.each((energy) => {
    energy.points += 1;
  });
});

/** How a duel begins: player one's turn, and a fighter for each player. */
const Board = Plugin.make("ru/Board", {
  setup: Effect.map(
    Commands.spawns(Turn, Health, Energy, Owner),
    (commands) => {
      commands.spawn(Turn.of({ player: 1, number: 1 }));
      commands.spawn(
        Health.of({ hp: 10 }),
        Energy.of({ points: 3 }),
        Owner.of({ player: 1 })
      );
      commands.spawn(
        Health.of({ hp: 6 }),
        Energy.of({ points: 3 }),
        Owner.of({ player: 2 })
      );
    }
  ),
});

/** The duel as a game, which a recording of it is replayed in. */
const Duel = App.define({
  plugins: [Board],
  systems: [Death, Recharge],
  handlers: [attack, endTurn, summon],
});

/** An app of a game the board begins, its world, and each player's fighter. */
const begin = <A extends App.Any, E>(make: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const app = yield* make;
    const fighters = new Map<number, Entity>();
    (yield* app.read(Query.all(Owner))).each((owner, entity) => {
      fighters.set(owner.player, entity);
    });
    const one = fighters.get(1);
    const two = fighters.get(2);
    assert(
      one !== undefined && two !== undefined,
      "the board has two fighters"
    );
    return { app, world: yield* app.read(App_World), one, two };
  });

/** An app of the duel as it begins, with each player's fighter. */
const duel = (
  game: App.Game<
    readonly System.System<never, BuiltIn>[],
    typeof Duel.handlers,
    typeof Duel.plugins
  > = Duel
) => begin(App.make(game));

const Turns = Query.all(Turn);
const look = Effect.gen(function* () {
  const world = yield* App_World;
  const out: string[] = [
    `tick=${(yield* Time).tick} entities=${world.entityCount}`,
  ];
  (yield* Query.all(Health)).each((health, entity) => {
    const energy = world.get(entity, Energy);
    out.push(`${idOf(entity)}: hp=${health.hp} energy=${energy?.points}`);
  });
  (yield* Turns).each(
    (turn) => void out.push(`turn ${turn.number} player ${turn.player}`)
  );
  return out;
});
const snapshot = (app: App.Any) => app.read(look);

describe("actions", () => {
  it.effect(
    "are validated and applied by their handler, and the result comes straight back",
    () =>
      withApp(duel(), ({ app, world, one, two }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            app.dispatch(Attack, { attacker: one, target: two })
          );
          expect(exit).toEqual(Exit.succeed(2));
          expect(world.get(two, Health)).toEqual({ hp: 2 });
          expect(world.get(one, Energy)).toEqual({ points: 1 });
          expect(moves(app.actionLog)).toEqual([
            {
              tick: 0,
              name: "Attack",
              payload: { attacker: one, target: two },
            },
          ]);

          // The result and the failure are typed per action.
          const typed: Exit.Exit<
            number,
            NotYourTurn | NotEnoughEnergy | NoSuchTarget | Action.InvalidPayload
          > = exit;
          void typed;
          const ended: Exit.Exit<void, NotYourTurn | Action.InvalidPayload> =
            yield* Effect.exit(
              app.dispatch(EndTurn, {
                player: 1,
              })
            );
          expect(Exit.isSuccess(ended)).toBe(true);
        })
      )
  );

  it.effect("refuse with a typed error and change nothing", () =>
    withApp(duel(), ({ app, world, one, two }) =>
      Effect.gen(function* () {
        const before = yield* snapshot(app);
        const notYours = yield* Effect.exit(
          app.dispatch(Attack, { attacker: two, target: one })
        );
        expect(notYours).toEqual(Exit.fail(NotYourTurn.make({ player: 1 })));

        yield* app.dispatch(Attack, { attacker: one, target: two });
        const tired = yield* Effect.exit(
          app.dispatch(Attack, { attacker: one, target: two })
        );
        expect(tired).toEqual(
          Exit.fail(NotEnoughEnergy.make({ have: 1, need: 2 }))
        );
        expect(world.get(two, Health)).toEqual({ hp: 2 });
        expect(moves(app.actionLog)).toHaveLength(1);
        expect(before).toHaveLength(4);
      })
    )
  );

  it.effect("discard the commands and events of a refused action", () =>
    withApp(duel(), ({ app, world }) =>
      Effect.gen(function* () {
        const entities = world.entityCount;
        const refused = yield* Effect.exit(
          app.dispatch(Summon, { player: 1, hp: 0 })
        );
        expect(Exit.isFailure(refused)).toBe(true);
        expect(world.entityCount).toBe(entities);
        expect(yield* waiting(app)).toBeUndefined();

        // Had the refused spawn been kept, it would be applied with this one.
        const accepted = yield* Effect.exit(
          app.dispatch(Summon, { player: 1, hp: 5 })
        );
        assert(Exit.isSuccess(accepted));
        expect(world.entityCount).toBe(entities + 1);
        expect(yield* waiting(app)).toEqual({
          "ru/Died": [{ entity: accepted.value }],
        });
        // The id the refused summon had reserved was released and is reused.
        expect(world.get(accepted.value, Health)).toEqual({ hp: 5 });
      })
    )
  );

  it.effect("let systems react through events on the next tick", () =>
    Effect.gen(function* () {
      const deaths: Entity[] = [];
      const Mourn = System.tick("Mourn", function* () {
        for (const event of (yield* Died).read()) deaths.push(event.entity);
      });
      const Mourning = App.define({
        plugins: [Board],
        systems: [Death, Recharge, Mourn],
        handlers: [attack, endTurn, summon],
      });
      yield* withApp(duel(Mourning), ({ app, world, one, two }) =>
        Effect.gen(function* () {
          yield* app.dispatch(Attack, { attacker: one, target: two });
          yield* app.tick(1);
          expect(world.isAlive(two)).toBe(true);
          yield* app.tick(1); // energy is back to 3
          yield* app.dispatch(Attack, { attacker: one, target: two });
          expect(world.get(two, Health)).toEqual({ hp: -2 });
          yield* app.tick(1);
          expect(world.isAlive(two)).toBe(false);
          expect(deaths).toEqual([two]);
        })
      );
    })
  );

  it.effect(
    "can be queued for the next tick, where a refusal becomes an event",
    () =>
      Effect.gen(function* () {
        const rejected: string[] = [];
        const Watch = System.tick("Watch", function* () {
          for (const event of (yield* Action.Rejected).read()) {
            rejected.push(`${event.action}: ${event.error._tag}`);
          }
        });
        const make = begin(
          App.make(
            App.define({
              plugins: [Board],
              systems: [Watch],
              handlers: [attack, endTurn],
            })
          )
        );
        yield* withApp(make, ({ app, world, one, two }) =>
          Effect.gen(function* () {
            yield* app.enqueue(Attack, { attacker: one, target: two });
            yield* app.enqueue(Attack, { attacker: two, target: one });
            expect(world.get(two, Health)).toEqual({ hp: 6 });
            yield* app.tick(1);
            expect(world.get(two, Health)).toEqual({ hp: 2 });
            expect(world.get(one, Health)).toEqual({ hp: 10 });
            expect(rejected).toEqual(["Attack: NotYourTurn"]);
            // Both are in the log, in the order they arrived: a replay enqueues
            // both again, and its own rules refuse the second.
            expect(moves(app.actionLog)).toEqual([
              {
                tick: 0,
                name: "Attack",
                payload: { attacker: one, target: two },
                queued: true,
              },
              {
                tick: 0,
                name: "Attack",
                payload: { attacker: two, target: one },
                queued: true,
                refused: "NotYourTurn",
              },
            ]);
          })
        );
      })
  );

  it.effect(
    "can be issued by systems, so AI plays by the same rules as players",
    () =>
      Effect.gen(function* () {
        const Bot = System.tick("Bot", function* () {
          const actions = yield* Action.Actions;
          const turn = yield* currentTurn;
          if (turn.player === 2) {
            actions.enqueue(EndTurn, { player: 2 });
          }
        });
        const make = App.make(
          App.define({ plugins: [Board], systems: [Bot], handlers: [endTurn] })
        );
        yield* withApp(make, (app) =>
          Effect.gen(function* () {
            yield* app.dispatch(EndTurn, { player: 1 });
            yield* app.tick(1); // the bot sees it is its turn and queues EndTurn
            expect(yield* snapshot(app)).toContain("turn 2 player 2");
            yield* app.tick(1); // applied at the start of this tick
            expect(yield* snapshot(app)).toContain("turn 3 player 1");
            // The log holds the move that came from outside. The bot's own is the
            // simulation's doing: a replay's bot makes it again.
            expect(
              moves(app.actionLog).map((entry) => `${entry.tick}:${entry.name}`)
            ).toEqual(["0:EndTurn"]);
          })
        );
      })
  );

  it.effect("are checked at compile time and guarded at run time", () =>
    Effect.gen(function* () {
      yield* withApp(duel(), ({ app, one, two }) =>
        Effect.gen(function* () {
          // @ts-expect-error no handler was registered for this action
          expect(yield* thrown(app.dispatch(Unhandled, {}))).toThrow(
            /No handler/
          );
          expect(
            yield* Effect.exit(
              // @ts-expect-error the payload does not match the action
              app.dispatch(Attack, { attacker: one })
            )
          ).toEqual(
            Exit.fail(
              Action.InvalidPayload.make({
                action: "Attack",
                message: 'Missing key\n  at ["target"]',
              })
            )
          );
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                app.dispatchByName("Attack", { attacker: two, target: one })
              )
            )
          ).toBe(true);
        })
      );

      const waits = Action.handler(EndTurn, function* () {
        yield* Effect.sleep("1 second");
      });
      yield* withApp(
        App.make(App.define({ systems: [], handlers: [waits] })),
        (app) =>
          Effect.gen(function* () {
            expect(yield* thrown(app.dispatch(EndTurn, { player: 1 }))).toThrow(
              /did not finish synchronously/
            );
          })
      );
      App.define(
        // @ts-expect-error duplicate handler
        { systems: [], handlers: [endTurn, endTurn] }
      );

      // A handler runs as the tick does: a service of the game's own, which
      // keeps what a refused action does not take back, does not compile, and
      // its randomness is the built-in Random.
      class Rng extends Context.Service<Rng, { readonly next: () => number }>()(
        "ru/Rng"
      ) {}
      Action.handler(
        Unhandled,
        // @ts-expect-error the handler needs Rng, which is no part of the world
        function* () {
          return (yield* Rng).next();
        }
      );
      const roll = Action.handler(Unhandled, function* () {
        return (yield* Random).int(1, 6);
      });
      const rolls = Effect.fnUntraced(function* () {
        return yield* withApp(
          App.make(App.define({ systems: [], handlers: [roll] })),
          (app) =>
            Effect.forEach([1, 2, 3], () =>
              Effect.exit(app.dispatch(Unhandled, {}))
            )
        );
      });
      const rolled = yield* rolls();
      expect(rolled.every(Exit.isSuccess)).toBe(true);
      // Seeded by the app, so another app of the game rolls the same.
      expect(yield* rolls()).toEqual(rolled);
    })
  );

  it.effect(
    "fail only with the error their action declares, a tagged schema",
    () =>
      Effect.gen(function* () {
        class Undeclared extends Schema.TaggedError<Undeclared>()(
          "ru/Undeclared",
          {}
        ) {}
        class Plain extends Data.TaggedError("ru/Plain")<{}> {}
        Action.handler(
          EndTurn,
          // @ts-expect-error EndTurn's error schema does not take Undeclared
          function* () {
            return yield* Undeclared.make({});
          }
        );
        Action.handler(
          Unhandled,
          // @ts-expect-error an action that declares no refusal is never refused
          function* () {
            return yield* NotYourTurn.make({ player: 1 });
          }
        );
        expect(() =>
          Action.define("ru/Plain", Schema.Void, {
            // @ts-expect-error a Data.TaggedError has no schema to encode it with
            error: Plain,
          })
        ).toThrow(TypeError);
        Action.define("ru/Untagged", Schema.Void, {
          // @ts-expect-error a refusal has a _tag, which Action.Rejected reads
          error: Schema.String,
        });
        const Offside = Schema.TaggedStruct("ru/Offside", {
          by: Schema.Number,
        });
        const Kick = Action.define(
          "ru/Kick",
          Schema.Struct({ by: Schema.Number }),
          {
            error: Offside,
          }
        );
        const kick = Action.handler(Kick, function* ({ by }) {
          return yield* Effect.fail(Offside.make({ by }));
        });
        yield* withApp(
          App.make(App.define({ systems: [], handlers: [kick] })),
          (app) =>
            Effect.gen(function* () {
              expect(yield* Effect.exit(app.dispatch(Kick, { by: 3 }))).toEqual(
                Exit.fail({ _tag: "ru/Offside", by: 3 })
              );
            })
        );
        const ended: Exit.Exit<void, NotYourTurn | Action.InvalidPayload> =
          yield* withApp(duel(), ({ app }) =>
            Effect.exit(app.dispatch(EndTurn, { player: 2 }))
          );
        expect(ended).toEqual(Exit.fail(NotYourTurn.make({ player: 1 })));
      })
  );

  it.effect(
    "fail the tick when a queued action's handler dies, and leave the game as it was",
    () =>
      Effect.gen(function* () {
        const Crash = Action.define("ru/Crash", Schema.Struct({}));
        const crash = Action.handler(Crash, function* () {
          (yield* Turns.pipe(Query.writes(Turn))).each((turn) => {
            turn.number += 100;
          });
          return yield* Effect.die(new Error("a bug in the handler"));
        });
        const heard: string[] = [];
        const Watch = System.tick("Watch", function* () {
          for (const event of (yield* Action.Rejected).read()) {
            heard.push(event.action);
          }
        });
        const make = begin(
          App.make(
            App.define({
              plugins: [Board],
              systems: [Watch],
              handlers: [crash, endTurn],
            })
          )
        );
        yield* withApp(make, ({ app }) =>
          Effect.gen(function* () {
            const before = yield* snapshot(app);
            yield* app.enqueue(Crash, {});
            yield* app.enqueue(EndTurn, { player: 2 });
            expect(yield* thrown(app.tick(1))).toThrow(/a bug in the handler/);
            expect(heard).toEqual(["EndTurn"]);
            expect(yield* snapshot(app)).toEqual(
              before.map((line) => line.replace("tick=0", "tick=1"))
            );
          })
        );
      })
  );

  it.effect("cannot be dispatched in the middle of a tick", () =>
    Effect.gen(function* () {
      let app!: App.App;
      const Sneaky = System.tick("Sneaky", function* () {
        yield* Effect.orDie(app.dispatchByName("EndTurn", { player: 1 }));
      });
      yield* withApp(
        App.make(App.define({ systems: [Sneaky], handlers: [endTurn] })),
        (made) =>
          Effect.gen(function* () {
            app = made;
            expect(yield* thrown(made.tick(1))).toThrow(/Use enqueue/);
          })
      );
    })
  );
});

describe("replay", () => {
  it.effect("rebuilds the same game from the action log alone", () =>
    Effect.gen(function* () {
      const play = Effect.fnUntraced(function* () {
        return yield* withApp(duel(), ({ app, one, two }) =>
          Effect.gen(function* () {
            // A mix of direct and queued actions, including refused ones, over
            // several ticks. Refusals are not logged and must not matter.
            yield* app.dispatch(Attack, { attacker: one, target: two });
            expect(
              yield* Effect.exit(
                app.dispatch(Attack, { attacker: two, target: one })
              )
            ).toEqual(Exit.fail(NotYourTurn.make({ player: 1 })));
            yield* app.tick(1);
            yield* app.enqueue(EndTurn, { player: 1 });
            yield* app.tick(1);
            yield* app.dispatch(Summon, { player: 2, hp: 3 });
            yield* app.enqueue(Attack, { attacker: two, target: one });
            yield* app.enqueue(Attack, { attacker: one, target: two });
            yield* app.tick(1);
            yield* app.tick(1);
            yield* app.dispatch(Attack, { attacker: two, target: one });
            yield* app.dispatch(EndTurn, { player: 2 });
            yield* app.tick(1);
            yield* app.dispatch(Attack, { attacker: one, target: two });
            yield* app.tick(1);
            yield* app.tick(1);
            return {
              recording: yield* Replay.record(app),
              state: yield* snapshot(app),
            };
          })
        );
      });

      const original = yield* play();
      const listed = (log: readonly Action.LogEntry[]) =>
        moves(log).map(
          (entry) =>
            `${entry.tick}:${entry.name}${entry.queued === true ? " queued" : ""}${entry.refused === undefined ? "" : ` refused (${entry.refused})`}`
        );
      expect(listed(original.recording.log)).toEqual([
        "0:Attack",
        "1:EndTurn queued",
        "2:Summon",
        "2:Attack queued",
        "2:Attack queued refused (NotYourTurn)",
        "4:Attack",
        "4:EndTurn",
        "5:Attack",
      ]);
      expect(original.state).toContain("turn 3 player 1");
      // Player two's first fighter was killed along the way.
      expect(original.state[0]).toBe("tick=7 entities=3");

      const replayed = yield* withApp(
        Replay.verify(original.recording, Duel),
        (app) =>
          Effect.gen(function* () {
            return { log: [...app.actionLog], state: yield* snapshot(app) };
          })
      );
      expect(replayed.state).toEqual(original.state);
      expect(replayed.log).toEqual(original.recording.log);
    })
  );
});
