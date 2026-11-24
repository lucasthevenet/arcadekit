import { Context, Data, Effect, Exit, Schema } from "effect";
import { assert, describe, expect, it } from "vitest";

import type { Spawned } from "../src/index";
import {
  Action,
  App,
  Commands,
  Component,
  EntityId,
  Event,
  Events,
  Field,
  Journal,
  Plugin,
  Query,
  Random,
  System,
  Time,
} from "../src/index";
import type { Entity } from "../src/index";
import type { BuiltIn } from "../src/Services";

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
const withApp = <A, T, E = never>(
  make: Effect.Effect<A, E>,
  use: (app: A) => T
): T => Effect.runSync(Effect.map(make, use));

/** The events waiting to be read, by name, as `app.inspect()` copies them. */
const waiting = (app: App.Any): unknown => app.inspect().stores[Event.STORE];

/** The applied actions of a log, without the checkpoints recorded among them. */
const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));

describe("events", () => {
  it("reach every system exactly once, whichever side of the emitter it runs on", () => {
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
    withApp(App.make(App.define({ systems })), (app) => {
      for (let i = 0; i < 4; i++) {
        app.tick(1);
      }
      // The later system sees events the tick they are emitted...
      expect(seen.After).toEqual([[10, 11], [20, 21], [], []]);
      // ...the earlier one sees the same events, once, a tick later.
      expect(seen.Before).toEqual([[], [10, 11], [20, 21], []]);
      // And then they are gone.
      expect(waiting(app)).toBeUndefined();
    });
  });

  it("reach the system that emits them on its next run, once what they name is spawned", () => {
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
    withApp(App.make(App.define({ systems: [Shoot] })), (app) => {
      for (let i = 0; i < 3; i++) {
        app.tick(1);
      }
      // Each of its own once, on the tick after, as a system listed ahead of
      // it hears them: by then the entity is spawned.
      expect(heard).toEqual([[], [{ hp: 1 }], [{ hp: 2 }]]);
    });
  });

  it("can be emitted from inside a query loop and are read in order", () => {
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
    withApp(
      App.make(App.define({ plugins: [Two], systems: [Hit, Report] })),
      (app) => {
        app.tick(1);
        expect(log).toEqual(wounded.map((entity) => `${idOf(entity)}:3`));
        expect(wounded).toHaveLength(2);
      }
    );
  });

  it("are dropped a tick after they were emitted, read or not", () => {
    const seen: Array<number>[] = [];
    const Sometimes = System.tick("Sometimes", function* () {
      const { tick } = yield* Time;
      if (tick === 1 || tick === 4) {
        seen.push([...(yield* Ping).read()]);
      }
    });
    withApp(
      App.make(App.define({ systems: [Sometimes], handlers: [say] })),
      (app) => {
        app.tick(1); // creates the reader
        app.dispatch(Say, { n: 1 });
        app.tick(1);
        app.dispatch(Say, { n: 2 });
        app.tick(1);
        app.dispatch(Say, { n: 3 });
        app.tick(1);
        // It looked at ticks 1 and 4 only: events 1 and 2 had been dropped by then.
        expect(seen).toEqual([[], [3]]);
      }
    );
  });

  it("are emitted by the simulation alone: outside it, an action emits them", () => {
    let kept: { emit(n: number): void } | undefined;
    let bus: { emit(def: typeof Ping, n: number): void } | undefined;
    const Keeper = System.tick("Keeper", function* () {
      kept = yield* Ping.emits;
      // A system of the tick that has the bus and no handle emits through it.
      const events = yield* Effect.service(Events);
      assert(events instanceof Event.EventBus);
      events.emit(Ping, 7);
      bus = events;
    });
    withApp(
      App.make(App.define({ systems: [Keeper], handlers: [say] })),
      (app) => {
        app.tick(1);
        expect(waiting(app)).toEqual({ "ru/Ping": [7] });
        const refused =
          /The event "ru\/Ping" was emitted from outside the simulation\..*Issue an action whose handler emits it/;
        // @ts-expect-error the app hands out no bus to emit through
        void app.events;
        // Through a handle and through the bus, each of which a system kept.
        expect(() => kept!.emit(1)).toThrow(refused);
        expect(() => bus!.emit(Ping, 1)).toThrow(refused);
        expect(waiting(app)).toEqual({ "ru/Ping": [7] });
        // An action's handler is the simulation's.
        app.dispatch(Say, { n: 1 });
        expect(waiting(app)).toEqual({ "ru/Ping": [7, 1] });
      }
    );
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
class NoSuchTarget extends Data.TaggedError("NoSuchTarget")<{}> {}

const Attack = Action.define(
  "Attack",
  Schema.Struct({ attacker: EntityId, target: EntityId })
);
const EndTurn = Action.define(
  "EndTurn",
  Schema.Struct({ player: Schema.Number })
);
const Summon = Action.define(
  "Summon",
  Schema.Struct({ player: Schema.Number, hp: Schema.Number })
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
    return yield* new NotYourTurn({ player: turn.player });
  }
  const energy = world.get(attacker, Energy)!.points;
  if (energy < 2) {
    return yield* new NotEnoughEnergy({ have: energy, need: 2 });
  }
  if (!world.has(target, Health)) {
    return yield* new NoSuchTarget();
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
    return yield* new NotYourTurn({ player: turn.player });
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
    return yield* new NoSuchTarget();
  }
  return entity;
});

import { idOf } from "../src/ecs/component";
// The World service, imported under another name so `world` reads naturally above.
import { World as App_World } from "../src/index";

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
const snapshot = (app: App.Any): string[] => Effect.runSync(app.read(look));

describe("actions", () => {
  it("are validated and applied by their handler, and the result comes straight back", () => {
    withApp(duel(), ({ app, world, one, two }) => {
      const exit = app.dispatch(Attack, { attacker: one, target: two });
      expect(exit).toEqual(Exit.succeed(2));
      expect(world.get(two, Health)).toEqual({ hp: 2 });
      expect(world.get(one, Energy)).toEqual({ points: 1 });
      expect(moves(app.actionLog)).toEqual([
        { tick: 0, name: "Attack", payload: { attacker: one, target: two } },
      ]);

      // The result and the failure are typed per action.
      const typed: Exit.Exit<
        number,
        NotYourTurn | NotEnoughEnergy | NoSuchTarget | Action.InvalidPayload
      > = exit;
      void typed;
      const ended: Exit.Exit<void, NotYourTurn | Action.InvalidPayload> =
        app.dispatch(EndTurn, {
          player: 1,
        });
      expect(Exit.isSuccess(ended)).toBe(true);
    });
  });

  it("refuse with a typed error and change nothing", () => {
    withApp(duel(), ({ app, world, one, two }) => {
      const before = snapshot(app);
      const notYours = app.dispatch(Attack, { attacker: two, target: one });
      expect(notYours).toEqual(Exit.fail(new NotYourTurn({ player: 1 })));

      app.dispatch(Attack, { attacker: one, target: two });
      const tired = app.dispatch(Attack, { attacker: one, target: two });
      expect(tired).toEqual(
        Exit.fail(new NotEnoughEnergy({ have: 1, need: 2 }))
      );
      expect(world.get(two, Health)).toEqual({ hp: 2 });
      expect(moves(app.actionLog)).toHaveLength(1);
      expect(before).toHaveLength(4);
    });
  });

  it("discard the commands and events of a refused action", () => {
    withApp(duel(), ({ app, world }) => {
      const entities = world.entityCount;
      const refused = app.dispatch(Summon, { player: 1, hp: 0 });
      expect(Exit.isFailure(refused)).toBe(true);
      expect(world.entityCount).toBe(entities);
      expect(waiting(app)).toBeUndefined();

      // Had the refused spawn been kept, it would be applied with this one.
      const accepted = app.dispatch(Summon, { player: 1, hp: 5 });
      assert(Exit.isSuccess(accepted));
      expect(world.entityCount).toBe(entities + 1);
      expect(waiting(app)).toEqual({ "ru/Died": [{ entity: accepted.value }] });
      // The id the refused summon had reserved was released and is reused.
      expect(world.get(accepted.value, Health)).toEqual({ hp: 5 });
    });
  });

  it("let systems react through events on the next tick", () => {
    const deaths: Entity[] = [];
    const Mourn = System.tick("Mourn", function* () {
      for (const event of (yield* Died).read()) deaths.push(event.entity);
    });
    const Mourning = App.define({
      plugins: [Board],
      systems: [Death, Recharge, Mourn],
      handlers: [attack, endTurn, summon],
    });
    withApp(duel(Mourning), ({ app, world, one, two }) => {
      app.dispatch(Attack, { attacker: one, target: two });
      app.tick(1);
      expect(world.isAlive(two)).toBe(true);
      app.tick(1); // energy is back to 3
      app.dispatch(Attack, { attacker: one, target: two });
      expect(world.get(two, Health)).toEqual({ hp: -2 });
      app.tick(1);
      expect(world.isAlive(two)).toBe(false);
      expect(deaths).toEqual([two]);
    });
  });

  it("can be queued for the next tick, where a refusal becomes an event", () => {
    const rejected: string[] = [];
    const Watch = System.tick("Watch", function* () {
      for (const event of (yield* Action.Rejected).read()) {
        rejected.push(
          `${event.action}: ${(event.error as { _tag: string })._tag}`
        );
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
    withApp(make, ({ app, world, one, two }) => {
      app.enqueue(Attack, { attacker: one, target: two });
      app.enqueue(Attack, { attacker: two, target: one });
      expect(world.get(two, Health)).toEqual({ hp: 6 });
      app.tick(1);
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
    });
  });

  it("can be issued by systems, so AI plays by the same rules as players", () => {
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
      ).toEqual(["0:EndTurn"]);
    });
  });

  it("are checked at compile time and guarded at run time", () => {
    withApp(duel(), ({ app, one, two }) => {
      // @ts-expect-error no handler was registered for this action
      expect(() => app.dispatch(Unhandled, {})).toThrow(/No handler/);
      // @ts-expect-error the payload does not match the action
      void app.dispatch(Attack, { attacker: one });
      expect(
        Exit.isFailure(
          app.dispatchByName("Attack", { attacker: two, target: one })
        )
      ).toBe(true);
    });

    const waits = Action.handler(EndTurn, function* () {
      yield* Effect.sleep("1 second");
    });
    withApp(App.make(App.define({ systems: [], handlers: [waits] })), (app) => {
      expect(() => app.dispatch(EndTurn, { player: 1 })).toThrow(
        /did not finish synchronously/
      );
    });
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
    const rolls = () =>
      withApp(App.make(App.define({ systems: [], handlers: [roll] })), (app) =>
        [1, 2, 3].map(() => app.dispatch(Unhandled, {}))
      );
    const rolled = rolls();
    expect(rolled.every(Exit.isSuccess)).toBe(true);
    // Seeded by the app, so another app of the game rolls the same.
    expect(rolls()).toEqual(rolled);
  });

  it("cannot be dispatched in the middle of a tick", () => {
    let app!: App.Any;
    const Sneaky = System.tick("Sneaky", function* () {
      yield* Effect.sync(() => app.dispatchByName("EndTurn", { player: 1 }));
    });
    withApp(
      App.make(App.define({ systems: [Sneaky], handlers: [endTurn] })),
      (made) => {
        app = made;
        expect(() => made.tick(1)).toThrow(/Use enqueue/);
      }
    );
  });
});

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
          recording: app.record(),
          state: snapshot(app),
        };
      });

    const original = play();
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

    const replayed = withApp(
      Journal.replay(original.recording, Duel),
      (app) => ({ log: [...app.actionLog], state: snapshot(app) })
    );
    expect(replayed.state).toEqual(original.state);
    expect(replayed.log).toEqual(original.recording.log);
  });
});
