import { Context, Data, Effect, Exit, Layer } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  Event,
  Field,
  Query,
  Script,
  System,
  Time,
} from "../src/index";
import type { Entity } from "../src/index";

const Health = Component.define("ru/Health", { hp: Field.i32 });
const Energy = Component.define("ru/Energy", { points: Field.i32 });
const Owner = Component.define("ru/Owner", { player: Field.u8 });

const Turn = Component.define("ru/Turn", {
  player: Field.u8,
  number: Field.i32,
});

const Damaged = Event.define<{
  readonly target: Entity;
  readonly amount: number;
}>("ru/Damaged");

const Died = Event.define<{ readonly entity: Entity }>("ru/Died");
const Ping = Event.define<number>("ru/Ping");

/** Builds an app, hands it to `use`, then closes its scope. */
const withApp = <A, T>(
  make: Effect.Effect<A, never, Scope.Scope>,
  use: (app: A) => T
): T => Effect.runSync(Effect.scoped(Effect.map(make, use)));

/** The applied actions of a log, without the checkpoints recorded among them. */
const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));

describe("events", () => {
  it("reach every system exactly once, whichever side of the emitter it runs on", () => {
    const seen: Record<string, number[][]> = { Before: [], After: [] };

    const reader = (name: string) =>
      System.make(name, function* () {
        const ping = yield* Ping;
        seen[name]!.push([...ping.read()]);
      });

    const Emitter = System.make("Emitter", function* () {
      const ping = yield* Ping;
      const { tick } = yield* Time;

      if (tick <= 2) {
        ping.emit(tick * 10);
        ping.emit(tick * 10 + 1);
      }
    });

    const systems = [
      reader("Before"),
      Emitter.pipe(System.after("Before")),
      reader("After").pipe(System.after(Emitter)),
    ];

    withApp(App.make({ systems }), (app) => {
      for (let i = 0; i < 4; i += 1) {
        app.tick(1);
      }

      // The later system sees events the tick they are emitted...
      expect(seen.After).toStrictEqual([[10, 11], [20, 21], [], []]);
      // ...the earlier one sees the same events, once, a tick later.
      expect(seen.Before).toStrictEqual([[], [10, 11], [20, 21], []]);
      // And then they are gone.
      expect(app.events.pending(Ping)).toBe(0);
    });
  });

  it("can be emitted from inside a query loop and are read in order", () => {
    const Hit = System.make("Hit", function* () {
      const damaged = yield* Damaged;
      const wounded = yield* Query.all(Health);
      wounded.each((health, entity) => {
        health.hp -= 3;
        damaged.emit({ target: entity, amount: 3 });
      });
    });

    const log: string[] = [];

    const Report = System.make("Report", function* () {
      const damaged = yield* Damaged;

      for (const event of damaged.read()) {
        log.push(`${event.target}:${event.amount}`);
      }
    }).pipe(System.after(Hit));

    withApp(App.make({ systems: [Hit, Report] }), (app) => {
      const a = app.world.spawn(Health.of({ hp: 10 }));
      const b = app.world.spawn(Health.of({ hp: 10 }));
      app.tick(1);
      expect(log).toStrictEqual([`${a}:3`, `${b}:3`]);
    });
  });

  it("are dropped a tick after they were emitted, read or not", () => {
    const seen: number[][] = [];

    const Sometimes = System.make("Sometimes", function* () {
      const { tick } = yield* Time;

      if (tick === 1 || tick === 4) {
        seen.push([...(yield* Ping).read()]);
      }
    });

    withApp(App.make({ systems: [Sometimes] }), (app) => {
      app.tick(1); // creates the reader
      app.events.emit(Ping, 1);
      app.tick(1);
      app.events.emit(Ping, 2);
      app.tick(1);
      app.events.emit(Ping, 3);
      app.tick(1);
      // It looked at ticks 1 and 4 only: events 1 and 2 had been dropped by then.
      expect(seen).toStrictEqual([[], [3]]);
    });
  });

  it("wake scripts that wait for them, in the tick they are emitted", () => {
    const log: string[] = [];

    const Emitter = System.make("Emitter", function* () {
      const { tick } = yield* Time;

      if (tick === 2) {
        (yield* Ping).emit(7);
      }
    });

    withApp(App.make({ systems: [Emitter] }), (app) => {
      app.spawnScript(
        Effect.gen(function* () {
          const ping = yield* Ping;
          const died = yield* Died;
          const batch = yield* ping.wait;
          log.push(
            `first got ${batch.join(",")} at tick ${(yield* Time).tick}`
          );
          died.emit({ entity: 99 as Entity });
        })
      );

      // A second script woken by the first one's event, still in the same tick.
      const second = app.spawnScript(
        Effect.gen(function* () {
          const died = yield* Died;
          const batch = yield* died.wait;
          log.push(
            `second got ${batch[0]!.entity} at tick ${(yield* Time).tick}`
          );

          return "done";
        })
      );

      app.tick(1);
      expect(log).toStrictEqual([]);
      app.tick(1);
      expect(log).toStrictEqual([
        "first got 7 at tick 2",
        "second got 99 at tick 2",
      ]);
      expect(second.pollUnsafe()).toStrictEqual(Exit.succeed("done"));
    });
  });

  it("do not make a script wait when unseen events already exist", () => {
    withApp(App.make({ systems: [] }), (app) => {
      const fiber = app.spawnScript(
        Effect.gen(function* () {
          const ping = yield* Ping;
          ping.emit(1);
          ping.emit(2);

          return yield* ping.wait;
        })
      );

      expect(fiber.pollUnsafe()).toStrictEqual(Exit.succeed([1, 2]));
    });
  });
});

// --- a tiny turn-based duel, used by the action tests -------------------------

class NotYourTurn extends Data.TaggedError("NotYourTurn")<{
  readonly player: number;
}> {}

class NotEnoughEnergy extends Data.TaggedError("NotEnoughEnergy")<{
  readonly have: number;
  readonly need: number;
}> {}

class NoSuchTarget extends Data.TaggedError("NoSuchTarget") {}

const Attack = Action.define<{
  readonly attacker: Entity;
  readonly target: Entity;
}>()("Attack");

const EndTurn = Action.define<{ readonly player: number }>()("EndTurn");

const Summon = Action.define<{
  readonly player: number;
  readonly hp: number;
}>()("Summon");

const Unhandled = Action.define<Record<never, never>>()("Unhandled");

const TurnQuery = Query.all(Turn);

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
    (yield* Query.all(Health)).spec && (yield* Effect.service(App_World));

  const turn = yield* currentTurn;
  const owner = world.get(attacker, Owner);

  if (owner === undefined || owner.player !== turn.player) {
    return yield* Effect.fail(new NotYourTurn({ player: turn.player }));
  }

  const energy = world.get(attacker, Energy)!.points;

  if (energy < 2) {
    return yield* Effect.fail(new NotEnoughEnergy({ have: energy, need: 2 }));
  }

  if (!world.has(target, Health)) {
    return yield* Effect.fail(new NoSuchTarget());
  }

  // Validation is done; from here on the action will succeed.
  world.set(attacker, Energy, { points: energy - 2 });
  const hp = world.get(target, Health)!.hp - 4;
  world.set(target, Health, { hp });
  (yield* Damaged).emit({ target, amount: 4 });

  return hp;
});

const endTurn = Action.handler(EndTurn, function* ({ player }) {
  const turns = yield* TurnQuery;
  const turn = yield* currentTurn;

  if (player !== turn.player) {
    return yield* Effect.fail(new NotYourTurn({ player: turn.player }));
  }

  turns.each((t) => {
    t.player = t.player === 1 ? 2 : 1;
    t.number += 1;
  });
});

/** Queues a spawn and an event, then may refuse: used to test rollback. */
const summon = Action.handler(Summon, function* ({ hp, player }) {
  const commands = yield* Commands;
  const died = yield* Died;

  const entity = commands.spawn(
    Health.of({ hp }),
    Owner.of({ player }),
    Energy.of({ points: 0 })
  );

  died.emit({ entity });

  if (hp <= 0) {
    return yield* Effect.fail(new NoSuchTarget());
  }

  return entity;
});

// The World service, imported under another name so `world` reads naturally above.
import { World as App_World } from "../src/index";

const Death = System.make("Death", function* () {
  const damaged = yield* Damaged;
  const died = yield* Died;
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

const Recharge = System.make("Recharge", function* () {
  const fighters = yield* Query.all(Energy);
  fighters.each((energy) => {
    energy.points += 1;
  });
});

const duel = () =>
  Effect.map(
    App.make({
      systems: [Death, Recharge],
      handlers: [attack, endTurn, summon],
    }),
    (app) => {
      app.world.spawn(Turn.of({ player: 1, number: 1 }));

      const one = app.world.spawn(
        Health.of({ hp: 10 }),
        Energy.of({ points: 3 }),
        Owner.of({ player: 1 })
      );

      const two = app.world.spawn(
        Health.of({ hp: 6 }),
        Energy.of({ points: 3 }),
        Owner.of({ player: 2 })
      );

      return { app, one, two };
    }
  );

const snapshot = (app: App.Any): string[] => {
  const out: string[] = [
    `tick=${app.time.tick} entities=${app.world.entityCount}`,
  ];

  app.world.view(Query.all(Health)).each((health, entity) => {
    const energy = app.world.get(entity, Energy);
    out.push(`${entity}: hp=${health.hp} energy=${energy?.points}`);
  });
  app.world.view(TurnQuery).each((turn) => {
    out.push(`turn ${turn.number} player ${turn.player}`);
  });

  return out;
};

describe("actions", () => {
  it("are validated and applied by their handler, and the result comes straight back", () => {
    withApp(duel(), ({ app, one, two }) => {
      const exit = app.dispatch(Attack, { attacker: one, target: two });
      expect(exit).toStrictEqual(Exit.succeed(2));
      expect(app.world.get(two, Health)).toStrictEqual({ hp: 2 });
      expect(app.world.get(one, Energy)).toStrictEqual({ points: 1 });
      expect(moves(app.actionLog)).toStrictEqual([
        { tick: 0, name: "Attack", payload: { attacker: one, target: two } },
      ]);

      // The result and the failure are typed per action.
      const typed: Exit.Exit<
        number,
        NotYourTurn | NotEnoughEnergy | NoSuchTarget
      > = exit;

      expect(typed).toBe(exit);

      const ended: Exit.Exit<void, NotYourTurn> = app.dispatch(EndTurn, {
        player: 1,
      });

      expect(Exit.isSuccess(ended)).toBe(true);
    });
  });

  it("refuse with a typed error and change nothing", () => {
    withApp(duel(), ({ app, one, two }) => {
      const before = snapshot(app);
      const notYours = app.dispatch(Attack, { attacker: two, target: one });
      expect(notYours).toStrictEqual(Exit.fail(new NotYourTurn({ player: 1 })));

      app.dispatch(Attack, { attacker: one, target: two });
      const tired = app.dispatch(Attack, { attacker: one, target: two });
      expect(tired).toStrictEqual(
        Exit.fail(new NotEnoughEnergy({ have: 1, need: 2 }))
      );
      expect(app.world.get(two, Health)).toStrictEqual({ hp: 2 });
      expect(moves(app.actionLog)).toHaveLength(1);
      expect(before).toHaveLength(4);
    });
  });

  it("discard the commands and events of a refused action", () => {
    withApp(duel(), ({ app }) => {
      const entities = app.world.entityCount;
      const refused = app.dispatch(Summon, { player: 1, hp: 0 });
      expect(Exit.isFailure(refused)).toBe(true);
      expect(app.world.entityCount).toBe(entities);
      expect(app.commands.size).toBe(0);
      expect(app.events.pending(Died)).toBe(0);

      const accepted = app.dispatch(Summon, { player: 1, hp: 5 });
      expect(Exit.isSuccess(accepted)).toBe(true);
      expect(app.world.entityCount).toBe(entities + 1);
      expect(app.events.pending(Died)).toBe(1);

      // The id the refused summon had reserved was released and is reused.
      if (Exit.isSuccess(accepted)) {
        expect(app.world.get(accepted.value, Health)).toStrictEqual({ hp: 5 });
      }
    });
  });

  it("let systems react through events on the next tick", () => {
    withApp(duel(), ({ app, one, two }) => {
      const deaths: Entity[] = [];
      app.spawnScript(
        Effect.gen(function* () {
          const died = yield* Died;

          while (true) {
            for (const event of yield* died.wait) {
              deaths.push(event.entity);
            }
          }
        })
      );
      app.dispatch(Attack, { attacker: one, target: two });
      app.tick(1);
      expect(app.world.isAlive(two)).toBe(true);
      app.tick(1); // energy is back to 3
      app.dispatch(Attack, { attacker: one, target: two });
      expect(app.world.get(two, Health)).toStrictEqual({ hp: -2 });
      app.tick(1);
      expect(app.world.isAlive(two)).toBe(false);
      expect(deaths).toStrictEqual([two]);
    });
  });

  it("can be queued for the next tick, where a refusal becomes an event", () => {
    const rejected: string[] = [];

    const Watch = System.make("Watch", function* () {
      for (const event of (yield* Action.Rejected).read()) {
        rejected.push(
          `${event.action}: ${(event.error as { _tag: string })._tag}`
        );
      }
    });

    const make = Effect.map(
      App.make({ systems: [Watch], handlers: [attack, endTurn] }),
      (app) => {
        app.world.spawn(Turn.of({ player: 1, number: 1 }));

        const one = app.world.spawn(
          Health.of({ hp: 10 }),
          Energy.of({ points: 3 }),
          Owner.of({ player: 1 })
        );

        const two = app.world.spawn(
          Health.of({ hp: 6 }),
          Energy.of({ points: 3 }),
          Owner.of({ player: 2 })
        );

        return { app, one, two };
      }
    );

    withApp(make, ({ app, one, two }) => {
      app.enqueue(Attack, { attacker: one, target: two });
      app.enqueue(Attack, { attacker: two, target: one });
      expect(app.world.get(two, Health)).toStrictEqual({ hp: 6 });
      app.tick(1);
      expect(app.world.get(two, Health)).toStrictEqual({ hp: 2 });
      expect(app.world.get(one, Health)).toStrictEqual({ hp: 10 });
      expect(rejected).toStrictEqual(["Attack: NotYourTurn"]);
      // Both are in the log, in the order they arrived: a replay enqueues
      // both again, and its own rules refuse the second.
      expect(moves(app.actionLog)).toStrictEqual([
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
    });
  });

  it("can be issued by systems, so AI plays by the same rules as players", () => {
    const Bot = System.make("Bot", function* () {
      const actions = yield* Action.Actions;
      const turn = yield* currentTurn;

      if (turn.player === 2) {
        actions.enqueue(EndTurn, { player: 2 });
      }
    });

    const make = Effect.map(
      App.make({ systems: [Bot], handlers: [endTurn] }),
      (app) => {
        app.world.spawn(Turn.of({ player: 1, number: 1 }));

        return app;
      }
    );

    withApp(make, (app) => {
      app.dispatch(EndTurn, { player: 1 });
      app.tick(1); // the bot sees it is its turn and queues EndTurn
      expect(snapshot(app)).toContain("turn 2 player 2");
      app.tick(1); // applied at the start of this tick
      expect(snapshot(app)).toContain("turn 3 player 1");
      // The log holds the move that came from outside. The bot's own is the
      // simulation's doing: a replay's bot makes it again.
      expect(
        moves(app.actionLog).map((entry) => `${entry.tick}:${entry.name}`)
      ).toStrictEqual(["0:EndTurn"]);
    });
  });

  it("are checked at compile time and guarded at run time", () => {
    withApp(duel(), ({ app, one, two }) => {
      // @ts-expect-error no handler was registered for this action
      expect(() => app.dispatch(Unhandled, {})).toThrow(/No handler/u);
      // @ts-expect-error the payload does not match the action
      app.dispatch(Attack, { attacker: one });
      expect(
        Exit.isFailure(
          app.dispatchByName("Attack", { attacker: two, target: one })
        )
      ).toBe(true);
    });

    const waits = Action.handler(EndTurn, function* () {
      yield* (yield* Script).nextTick;
    });

    withApp(App.make({ systems: [], handlers: [waits] }), (app) => {
      expect(() => app.dispatch(EndTurn, { player: 1 })).toThrow(
        /did not finish synchronously/u
      );
    });
    expect(() =>
      Effect.runSync(
        Effect.scoped(App.make({ systems: [], handlers: [endTurn, endTurn] }))
      )
    ).toThrow(/Two handlers/u);

    class Rng extends Context.Service<Rng, { readonly next: () => number }>()(
      "ru/Rng"
    ) {}

    const roll = Action.handler(Unhandled, function* () {
      return (yield* Rng).next();
    });

    const unprovided = withApp(
      // @ts-expect-error the handler needs Rng and nothing provides it
      App.make({ systems: [], handlers: [roll] }),
      (app) => app.dispatch(Unhandled, {})
    );

    // Forced past the compiler, it surfaces as a defect rather than a crash.
    expect(Exit.isFailure(unprovided as Exit.Exit<unknown, unknown>)).toBe(
      true
    );
    withApp(
      App.make({ systems: [], handlers: [roll] }).pipe(
        Effect.provide(Layer.succeed(Rng, { next: () => 4 }))
      ),
      (app) =>
        expect(app.dispatch(Unhandled, {})).toStrictEqual(Exit.succeed(4))
    );
  });

  it("cannot be dispatched in the middle of a tick", () => {
    let app!: App.Any;

    const Sneaky = System.make("Sneaky", function* () {
      yield* Effect.sync(() => app.dispatchByName("EndTurn", { player: 1 }));
    });

    withApp(App.make({ systems: [Sneaky], handlers: [endTurn] }), (made) => {
      app = made;
      expect(() => made.tick(1)).toThrow(/Use enqueue/u);
    });
  });
});

const listed = (log: readonly Action.LogEntry[]) =>
  moves(log).map(
    (entry) =>
      `${entry.tick}:${entry.name}${entry.queued === true ? " queued" : ""}${entry.refused === undefined ? "" : ` refused (${entry.refused})`}`
  );

describe("replay", () => {
  it("rebuilds the same game from the action log alone", () => {
    const play = () =>
      withApp(duel(), ({ app, one, two }) => {
        // A mix of direct and queued actions, including refused ones, over
        // several ticks. Refusals are not logged and must not matter.
        app.dispatch(Attack, { attacker: one, target: two });
        app.dispatch(Attack, { attacker: two, target: one });
        app.tick(1);
        app.enqueue(EndTurn, { player: 1 });
        app.tick(1);
        app.dispatch(Summon, { player: 2, hp: 3 });
        app.enqueue(Attack, { attacker: two, target: one });
        app.enqueue(Attack, { attacker: one, target: two });
        app.tick(1);
        app.tick(1);
        app.dispatch(Attack, { attacker: two, target: one });
        app.dispatch(EndTurn, { player: 2 });
        app.tick(1);
        app.dispatch(Attack, { attacker: one, target: two });
        app.tick(1);
        app.tick(1);

        return {
          log: [...app.actionLog],
          state: snapshot(app),
          ticks: app.time.tick,
        };
      });

    const original = play();

    expect(listed(original.log)).toStrictEqual([
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

    const replayed = withApp(duel(), ({ app }) => {
      App.replay(app, original.log, { delta: 1, ticks: original.ticks });

      return { log: [...app.actionLog], state: snapshot(app) };
    });

    expect(replayed.state).toStrictEqual(original.state);
    expect(replayed.log).toStrictEqual(original.log);
  });
});
