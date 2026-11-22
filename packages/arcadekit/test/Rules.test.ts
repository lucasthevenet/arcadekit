import { Context, Data, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

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
  System,
  Time,
  Timeline,
  World,
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
  (yield* Ping).emit(n);
});

// Says the number of each tick.
const Teller = System.make("ru/Teller", function* () {
  (yield* Ping).emit((yield* Time).tick);
});

/** Builds an app, hands it to `use`, then closes its scope. */
const withApp = <A, T, E = never>(
  make: Effect.Effect<A, E, Scope.Scope>,
  use: (app: A) => T
): T => Effect.runSync(Effect.scoped(Effect.map(make, use)));

/** The applied actions of a log, without the checkpoints recorded among them. */
const moves = (log: readonly Action.LogEntry[]): Action.Logged[] =>
  log.filter((entry): entry is Action.Logged => !Action.isCheckpoint(entry));

describe("events", () => {
  it("reach every system exactly once, whichever side of the emitter it runs on", () => {
    const seen: Record<string, Array<number>[]> = { Before: [], After: [] };
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
    withApp(App.make(App.define({ systems })), (app) => {
      for (let i = 0; i < 4; i++) {
        app.tick(1);
      }
      // The later system sees events the tick they are emitted...
      expect(seen.After).toEqual([[10, 11], [20, 21], [], []]);
      // ...the earlier one sees the same events, once, a tick later.
      expect(seen.Before).toEqual([[], [10, 11], [20, 21], []]);
      // And then they are gone.
      expect(app.events.pending(Ping)).toBe(0);
    });
  });

  it("can be emitted from inside a query loop and are read in order", () => {
    const Hit = System.make("Hit", function* () {
      const damaged = yield* Damaged;
      const wounded = yield* Query.all(Health).pipe(Query.writes(Health));
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
    withApp(App.make(App.define({ systems: [Hit, Report] })), (app) => {
      const a = app.world.spawn(Health.of({ hp: 10 }));
      const b = app.world.spawn(Health.of({ hp: 10 }));
      app.tick(1);
      expect(log).toEqual([`${a}:3`, `${b}:3`]);
    });
  });

  it("are dropped a tick after they were emitted, read or not", () => {
    const seen: Array<number>[] = [];
    const Sometimes = System.make("Sometimes", function* () {
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
    const Keeper = System.make("Keeper", function* () {
      kept = yield* Ping;
      // A system that has the bus and no handle emits through it.
      bus = yield* Effect.service(Events);
      bus.emit(Ping, 7);
    });
    withApp(
      App.make(App.define({ systems: [Keeper], handlers: [say] })),
      (app) => {
        app.tick(1);
        expect(app.events.pending(Ping)).toBe(1);
        const refused =
          /The event "ru\/Ping" was emitted from outside the simulation\..*Issue an action whose handler emits it/;
        // Through the bus, through a handle asked for outside, and through one
        // a system kept.
        expect(() => app.events.emit(Ping, 1)).toThrow(refused);
        expect(() => app.events.handle(Ping).emit(1)).toThrow(refused);
        expect(() => kept!.emit(1)).toThrow(refused);
        expect(() => bus!.emit(Ping, 1)).toThrow(refused);
        expect(app.events.pending(Ping)).toBe(1);
        // An action's handler is the simulation's.
        app.dispatch(Say, { n: 1 });
        expect(app.events.pending(Ping)).toBe(2);
      }
    );
  });

  it("are heard once each by code outside the simulation, which goes on from where it last read", () => {
    withApp(
      App.make(App.define({ systems: [Teller], handlers: [say] })),
      (app) => {
        // What a system writes, given the app's events.
        const hear = Effect.map(Ping, (ping) => [...ping.read()]).pipe(
          Effect.provideService(Events, app.events)
        );
        const heard: Array<number>[] = [];
        for (let n = 0; n < 3; n++) {
          app.tick(1);
          heard.push(Effect.runSync(hear));
        }
        expect(heard).toEqual([[1], [2], [3]]);
        // What a handler emits between two ticks, once it has ended.
        app.dispatch(Say, { n: 9 });
        expect(Effect.runSync(hear)).toEqual([9]);
        expect(Effect.runSync(hear)).toEqual([]);
        // Asked of the bus, it is the same handle and the same place.
        app.tick(1);
        app.tick(1);
        expect(app.events.handle(Ping)).toBe(app.events.handle(Ping));
        expect(app.events.handle(Ping).read()).toEqual([4, 5]);
        expect(Effect.runSync(hear)).toEqual([]);
      }
    );
  });

  it("are heard by code outside the simulation from the last tick on, the first time it asks", () => {
    withApp(
      App.make(App.define({ systems: [Teller], handlers: [say] })),
      (app) => {
        app.tick(1);
        app.dispatch(Say, { n: 9 });
        app.tick(1);
        app.dispatch(Say, { n: 8 });
        // The last tick, what was emitted between it and the one before,
        // and what was emitted since.
        expect(app.events.handle(Ping).read()).toEqual([9, 2, 8]);
        // Another event's place is its own.
        app.tick(1);
        expect(app.events.handle(Ping).read()).toEqual([3]);
        expect(app.events.handle(Action.Rejected).read()).toEqual([]);
      }
    );
  });

  it("are kept for code outside the simulation that stays away for 600 ticks, and no longer", () => {
    withApp(App.make(App.define({ systems: [Teller] })), (app) => {
      const ping = app.events.handle(Ping);
      expect(ping.read()).toEqual([]);
      for (let n = 0; n < 600; n++) {
        app.tick(1);
      }
      expect(ping.read()).toHaveLength(600);
      for (let n = 0; n < 601; n++) {
        app.tick(1);
      }
      // It is taken to be gone, and asks again as for the first time.
      expect(ping.read()).toEqual([1201]);
      app.tick(1);
      expect(ping.read()).toEqual([1202]);
    });
  });

  it("are heard afresh by code outside the simulation when the game goes back to play on", () => {
    withApp(App.make(App.define({ systems: [Teller] })), (app) => {
      const ping = app.events.handle(Ping);
      const moment = Timeline.capture(app);
      if (!Exit.isSuccess(moment)) {
        throw new Error("the capture was refused");
      }
      app.tick(1);
      app.tick(1);
      expect(ping.read()).toEqual([1, 2]);
      Timeline.rewind(app, moment.value);
      expect(ping.read()).toEqual([]);
      app.tick(1);
      expect(ping.read()).toEqual([1]);
    });
  });

  it("are heard once by code outside the simulation when the game goes back to run the same ticks again", () => {
    withApp(App.make(App.define({ systems: [Teller] })), (app) => {
      const ping = app.events.handle(Ping);
      const moment = Timeline.capture(app);
      if (!Exit.isSuccess(moment)) {
        throw new Error("the capture was refused");
      }
      app.tick(1);
      app.tick(1);
      expect(ping.read()).toEqual([1, 2]);
      Timeline.rewind(app, moment.value, { again: true });
      app.tick(1);
      app.tick(1);
      app.tick(1);
      // The first two it heard before the rewind; the third is new.
      expect(ping.read()).toEqual([3]);
    });
  });
});

describe("code outside the simulation", () => {
  it("is one reader of an event, of a change query and of removals, shared by every caller there", () => {
    const Hurt = Query.all(Health).pipe(Query.changed(Health));
    const Tired = Query.removed(Energy);
    const everything = Effect.gen(function* () {
      return {
        pings: [...(yield* Ping).read()],
        hurt: (yield* Hurt).entities().length,
        tired: (yield* Tired).read().length,
      };
    });
    const inside: Effect.Success<typeof everything>[] = [];
    // Each tick says its number, hurts everyone and tires one of them.
    const Wear = System.make("Wear", function* () {
      (yield* Ping).emit((yield* Time).tick);
      const commands = yield* Commands;
      let tired = false;
      (yield* Query.all(Health, Energy).pipe(Query.writes(Health))).each(
        (health, _energy, entity) => {
          health.hp -= 1;
          if (!tired) {
            commands.remove(entity, Energy);
            tired = true;
          }
        }
      );
    });
    const Watch = System.make("Watch", function* () {
      inside.push(yield* everything);
    }).pipe(System.before(Wear));
    withApp(App.make(App.define({ systems: [Watch, Wear] })), (app) => {
      for (let n = 0; n < 4; n++) {
        app.world.spawn(Health.of({ hp: 10 }), Energy.of({ points: 1 }));
      }
      const outside = everything.pipe(
        Effect.provideService(Events, app.events),
        Effect.provideService(World, app.world)
      );
      // Its first read of each: a change query visits everything.
      expect(Effect.runSync(outside)).toEqual({ pings: [], hurt: 4, tired: 0 });
      const first: unknown[] = [];
      const second: unknown[] = [];
      for (let n = 1; n <= 3; n++) {
        app.tick(1);
        first.push(Effect.runSync(outside));
        second.push(Effect.runSync(outside));
      }
      // Whoever asks first there has read it for everyone there.
      expect(first).toEqual([
        { pings: [1], hurt: 4, tired: 1 },
        { pings: [2], hurt: 3, tired: 1 },
        { pings: [3], hurt: 2, tired: 1 },
      ]);
      expect(second).toEqual([
        { pings: [], hurt: 0, tired: 0 },
        { pings: [], hurt: 0, tired: 0 },
        { pings: [], hurt: 0, tired: 0 },
      ]);
      // And has taken nothing from a system, which has a place of its own.
      app.tick(1);
      expect(inside).toEqual([
        { pings: [], hurt: 4, tired: 0 },
        { pings: [1], hurt: 4, tired: 1 },
        { pings: [2], hurt: 3, tired: 1 },
        { pings: [3], hurt: 2, tired: 1 },
      ]);
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
    (yield* Query.all(Health)).spec && (yield* Effect.service(App_World));
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
  (yield* Damaged).emit({ target, amount: 4 });
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
  const commands = yield* Commands;
  const died = yield* Died;
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
  const fighters = yield* Query.all(Energy).pipe(Query.writes(Energy));
  fighters.each((energy) => {
    energy.points += 1;
  });
});

/** How a duel begins: player one's turn, and a fighter for each player. */
const Board = Plugin.make("ru/Board", {
  setup: Effect.map(Commands, (commands) => {
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
  }),
});

/** The duel as a game, which a recording of it is replayed in. */
const duelOf = (...more: System.System<never, BuiltIn>[]) =>
  App.define({
    plugins: [Board],
    systems: [Death, Recharge, ...more],
    handlers: [attack, endTurn, summon],
  });

/** An app of the duel as it begins, with each player's fighter. */
const duel = (...more: System.System<never, BuiltIn>[]) =>
  Effect.map(App.make(duelOf(...more)), (app) => {
    const fighters = new Map<number, Entity>();
    app.world.view(Query.all(Owner)).each((owner, entity) => {
      fighters.set(owner.player, entity);
    });
    return { app, one: fighters.get(1)!, two: fighters.get(2)! };
  });

const snapshot = (app: App.Any): string[] => {
  const out: string[] = [
    `tick=${app.time.tick} entities=${app.world.entityCount}`,
  ];
  app.world.view(Query.all(Health)).each((health, entity) => {
    const energy = app.world.get(entity, Energy);
    out.push(`${entity}: hp=${health.hp} energy=${energy?.points}`);
  });
  app.world
    .view(TurnQuery)
    .each((turn) => void out.push(`turn ${turn.number} player ${turn.player}`));
  return out;
};

describe("actions", () => {
  it("are validated and applied by their handler, and the result comes straight back", () => {
    withApp(duel(), ({ app, one, two }) => {
      const exit = app.dispatch(Attack, { attacker: one, target: two });
      expect(exit).toEqual(Exit.succeed(2));
      expect(app.world.get(two, Health)).toEqual({ hp: 2 });
      expect(app.world.get(one, Energy)).toEqual({ points: 1 });
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
    withApp(duel(), ({ app, one, two }) => {
      const before = snapshot(app);
      const notYours = app.dispatch(Attack, { attacker: two, target: one });
      expect(notYours).toEqual(Exit.fail(new NotYourTurn({ player: 1 })));

      app.dispatch(Attack, { attacker: one, target: two });
      const tired = app.dispatch(Attack, { attacker: one, target: two });
      expect(tired).toEqual(
        Exit.fail(new NotEnoughEnergy({ have: 1, need: 2 }))
      );
      expect(app.world.get(two, Health)).toEqual({ hp: 2 });
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
      const summoned = Exit.match(accepted, {
        onSuccess: (entity) => app.world.get(entity, Health),
        onFailure: () => undefined,
      });
      expect(summoned).toEqual({ hp: 5 });
    });
  });

  it("let systems react through events on the next tick", () => {
    const deaths: Entity[] = [];
    const Mourn = System.make("Mourn", function* () {
      for (const event of (yield* Died).read()) deaths.push(event.entity);
    });
    withApp(duel(Mourn), ({ app, one, two }) => {
      app.dispatch(Attack, { attacker: one, target: two });
      app.tick(1);
      expect(app.world.isAlive(two)).toBe(true);
      app.tick(1); // energy is back to 3
      app.dispatch(Attack, { attacker: one, target: two });
      expect(app.world.get(two, Health)).toEqual({ hp: -2 });
      app.tick(1);
      expect(app.world.isAlive(two)).toBe(false);
      expect(deaths).toEqual([two]);
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
      App.make(App.define({ systems: [Watch], handlers: [attack, endTurn] })),
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
      expect(app.world.get(two, Health)).toEqual({ hp: 6 });
      app.tick(1);
      expect(app.world.get(two, Health)).toEqual({ hp: 2 });
      expect(app.world.get(one, Health)).toEqual({ hp: 10 });
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
    const Bot = System.make("Bot", function* () {
      const actions = yield* Action.Actions;
      const turn = yield* currentTurn;
      if (turn.player === 2) {
        actions.enqueue(EndTurn, { player: 2 });
      }
    });
    const make = Effect.map(
      App.make(App.define({ systems: [Bot], handlers: [endTurn] })),
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
    expect(() =>
      Effect.runSync(
        Effect.scoped(
          App.make(App.define({ systems: [], handlers: [endTurn, endTurn] }))
        )
      )
    ).toThrow(/Two handlers/);

    class Rng extends Context.Service<Rng, { readonly next: () => number }>()(
      "ru/Rng"
    ) {}
    const roll = Action.handler(Unhandled, function* () {
      return (yield* Rng).next();
    });
    const unprovided = withApp(
      // @ts-expect-error the handler needs Rng and nothing provides it
      App.make(App.define({ systems: [], handlers: [roll] })),
      (app) => app.dispatch(Unhandled, {})
    );
    // Forced past the compiler, it surfaces as a defect rather than a crash.
    expect(Exit.isFailure(unprovided as Exit.Exit<unknown, unknown>)).toBe(
      true
    );
    withApp(
      App.make(App.define({ systems: [], handlers: [roll] })).pipe(
        Effect.provideService(Rng, { next: () => 4 })
      ),
      (app) => expect(app.dispatch(Unhandled, {})).toEqual(Exit.succeed(4))
    );
  });

  it("cannot be dispatched in the middle of a tick", () => {
    let app!: App.Any;
    const Sneaky = System.make("Sneaky", function* () {
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
      Journal.replay(original.recording, (start) => App.make(duelOf(), start)),
      (app) => ({ log: [...app.actionLog], state: snapshot(app) })
    );
    expect(replayed.state).toEqual(original.state);
    expect(replayed.log).toEqual(original.recording.log);
  });
});
