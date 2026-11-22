/**
 * A turn-based duel on the same framework as the real-time demo.
 *
 * Players act through actions. A handler checks each action against the
 * rules and either applies it or refuses it with a typed error. Systems
 * react to the events that come out. Nothing runs until someone
 * acts: one tick per move.
 *
 * The game is two plugins: the rules, and commentary that depends on them.
 *
 *   pnpm --filter arcadekit duel
 */
import { NodeRuntime } from "@effect/platform-node";
import { Console, Context, Data, Effect, Exit, Layer, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  EntityId,
  Event,
  Field,
  Journal,
  Plugin,
  Query,
  Save,
  Singleton,
  System,
  World,
} from "../src/index";
import type { Entity } from "../src/index";

// --- state ---------------------------------------------------------------------
const Fighter = Component.define("duel/Fighter", {
  player: Field.u8,
  hp: Field.i32,
  energy: Field.i32,
});
const Name = Component.define("duel/Name", { value: Field.json<string>() });
// One per game, not one per entity: whose turn it is.
const Turn = Singleton.define("duel/Turn", { player: Field.u8 }, { player: 1 });

const Fighters = Query.all(Fighter).pipe(Query.writes(Fighter));
const Standing = Query.all(Name, Fighter);

// --- what can happen -------------------------------------------------------------
// Defined with schemas too, so that an event can be written down.
const Struck = Event.define(
  "duel/Struck",
  Schema.Struct({ target: EntityId, amount: Schema.Int })
);
const Fell = Event.define("duel/Fell", Schema.Struct({ entity: EntityId }));
const TurnEnded = Event.define(
  "duel/TurnEnded",
  Schema.Struct({ next: Schema.Literals([1, 2]) })
);

// --- what players can ask for ----------------------------------------------------
// Defined with schemas, so a move is checked however it arrives (from this
// program, a save file or the network) and the log can be written as JSON.
const Strike = Action.define(
  "Strike",
  Schema.Struct({ attacker: EntityId, target: EntityId })
);
const Pass = Action.define(
  "Pass",
  Schema.Struct({ player: Schema.Literals([1, 2]) })
);

class NotYourTurn extends Data.TaggedError("NotYourTurn")<{
  readonly waitingFor: number;
}> {}
class TooTired extends Data.TaggedError("TooTired")<{
  readonly energy: number;
  readonly cost: number;
}> {}
class NoSuchFighter extends Data.TaggedError("NoSuchFighter")<{}> {}

const STRIKE_COST = 2;
const STRIKE_DAMAGE = 4;

const strike = Action.handler(Strike, function* ({ attacker, target }) {
  const world = yield* World;
  const me = world.get(attacker, Fighter);
  const them = world.get(target, Fighter);
  if (me === undefined || them === undefined) {
    return yield* new NoSuchFighter();
  }
  const turn = yield* Turn;
  if (me.player !== turn.player) {
    return yield* new NotYourTurn({ waitingFor: turn.player });
  }
  if (me.energy < STRIKE_COST) {
    return yield* new TooTired({ energy: me.energy, cost: STRIKE_COST });
  }
  // Every check has passed. Only now does anything change.
  world.set(attacker, Fighter, { energy: me.energy - STRIKE_COST });
  world.set(target, Fighter, { hp: them.hp - STRIKE_DAMAGE });
  (yield* Struck).emit({ target, amount: STRIKE_DAMAGE });
  return them.hp - STRIKE_DAMAGE;
});

const pass = Action.handler(Pass, function* ({ player }) {
  const turn = yield* Turn;
  if (player !== turn.player) {
    return yield* new NotYourTurn({ waitingFor: turn.player });
  }
  const next = player === 1 ? 2 : 1;
  turn.player = next;
  (yield* TurnEnded).emit({ next });
});

// --- how the world reacts --------------------------------------------------------
const Casualties = System.make("Casualties", function* () {
  const world = yield* World;
  const commands = yield* Commands;
  const fell = yield* Fell;
  for (const { target } of (yield* Struck).read()) {
    const fighter = world.get(target, Fighter);
    if (fighter !== undefined && fighter.hp <= 0) {
      commands.despawn(target);
      fell.emit({ entity: target });
    }
  }
});

const Rest = System.make("Rest", function* () {
  const fighters = yield* Fighters;
  for (const { next } of (yield* TurnEnded).read()) {
    fighters.each((fighter) => {
      if (fighter.player === next) {
        fighter.energy += 2;
      }
    });
  }
});

// --- plugins -----------------------------------------------------------------------
/** The rules of the game, with nothing that talks to the outside world. */
const Rules = Plugin.make("Rules", {
  // Listed so that a saved game, which names them, can be loaded.
  systems: [Casualties, Rest],
  handlers: [strike, pass],
});

class Narrator extends Context.Service<
  Narrator,
  { readonly say: (line: string) => void }
>()("duel/Narrator") {}

/** Commentary on top of the rules. Leave it out and the game runs silently. */
const Commentary = Plugin.make("Commentary", {
  plugins: [Rules],
  layer: Layer.succeed(Narrator, {
    say: (line) => console.log(`    "${line}"`),
  }),
  systems: [
    // Ahead of the rules' own system, while the fighter that was hit still exists.
    System.make("CallHits", function* () {
      const narrator = yield* Narrator;
      const world = yield* World;
      for (const { amount, target } of (yield* Struck).read()) {
        narrator.say(`${world.get(target, Name)?.value} takes ${amount}!`);
      }
    }).pipe(System.before(Casualties)),
    // After the rules' own system, when the fighter that fell is gone.
    System.make("CallEnd", function* () {
      const narrator = yield* Narrator;
      for (const _ of (yield* Fell).read()) {
        (yield* Standing).each((name) => {
          narrator.say(`And that is the end of the fight: ${name.value} wins.`);
        });
      }
    }).pipe(System.after(Casualties)),
  ],
});

// --- the game --------------------------------------------------------------------
const seat = (app: App.Any) => ({
  knight: app.world.spawn(
    Name.of({ value: "Knight" }),
    Fighter.of({ player: 1, hp: 10, energy: 4 })
  ),
  rogue: app.world.spawn(
    Name.of({ value: "Rogue" }),
    Fighter.of({ player: 2, hp: 11, energy: 3 })
  ),
});

const standing = (app: App.Any): string => {
  const out: string[] = [];
  app.world.view(Standing).each((name, fighter) => {
    out.push(`${name.value} hp=${fighter.hp} energy=${fighter.energy}`);
  });
  return out.join(", ");
};

const program = Effect.gen(function* () {
  // One tick per move, so a checkpoint of the world's hash after every tick
  // costs nothing and lets a replay say exactly where it went another way.
  const app = yield* App.make(App.define({ plugins: [Commentary] }), {
    checkpointEvery: 1,
  });
  const { knight, rogue } = seat(app);

  // One move: dispatch, report, then let the world react for one tick.
  const strikeWith = Effect.fnUntraced(function* (
    who: string,
    attacker: Entity,
    target: Entity
  ) {
    // The outcome of a dispatch is an Exit, and an Exit is an Effect.
    const outcome = yield* Effect.match(
      app.dispatch(Strike, { attacker, target }),
      {
        // The failure type is exactly what can go wrong: the three errors the
        // handler raises, plus a payload the schema rejects.
        onFailure: (error) => {
          switch (error._tag) {
            case "NotYourTurn": {
              return `refused, it is player ${error.waitingFor}'s turn`;
            }
            case "TooTired": {
              return `refused, needs ${error.cost} energy and has ${error.energy}`;
            }
            case "NoSuchFighter": {
              return "refused, that fighter is not in the game";
            }
            case "InvalidPayload": {
              return `refused, malformed move (${error.message})`;
            }
          }
        },
        onSuccess: (hpLeft) => `hits, target is left with ${hpLeft} hp`,
      }
    );
    yield* Console.log(`${who} strikes: ${outcome}`);
    app.tick(1);
  });
  const passTurn = (player: 1 | 2) => {
    app.dispatch(Pass, { player });
    app.tick(1);
    console.log(`player ${player} passes -> ${standing(app)}`);
  };

  yield* Console.log(`start -> ${standing(app)}`);
  yield* strikeWith("Rogue", rogue, knight); // out of turn
  yield* strikeWith("Knight", knight, rogue);
  yield* strikeWith("Knight", knight, rogue);
  yield* strikeWith("Knight", knight, rogue); // out of energy
  passTurn(1);
  yield* strikeWith("Rogue", rogue, knight);
  passTurn(2);
  yield* strikeWith("Knight", knight, rogue); // the Rogue falls
  yield* strikeWith("Knight", knight, rogue); // nobody left to hit
  yield* Console.log(`end -> ${standing(app)}`);

  // The recording holds the moves that were accepted, the world's hash after
  // every tick, and how long each tick was. Written out as text and read
  // back, it reproduces this game in a fresh one, which checks itself against
  // those hashes as it goes. The replay installs only the rules, so it is
  // silent.
  const saved = Journal.encode(app.record());
  yield* Console.log(`saved: ${saved}`);
  // A fresh app in a scope of its own, closed when the replay is over.
  const replay = Effect.fnUntraced(function* (text: string) {
    const loaded = Journal.decode(text);
    if (Exit.isFailure(loaded)) {
      return "not a save file";
    }
    const headless = yield* App.make(App.define({ plugins: [Rules] }), {
      checkpointEvery: 1,
    });
    seat(headless);
    // A replay that goes another way throws, and says where.
    return yield* Effect.try({
      try: () => {
        Journal.replay(headless, loaded.value);
        return `${standing(headless)} (${standing(headless) === standing(app) ? "identical" : "DIFFERENT"})`;
      },
      catch: (error) => (error instanceof Error ? error.message : "it threw"),
    }).pipe(Effect.catch((why) => Effect.succeed(`stopped: ${why}`)));
  }, Effect.scoped);
  yield* Console.log(`replayed -> ${yield* replay(saved)}`);
  // Someone edits the save so that a player who does not exist passes.
  yield* Console.log(
    `edited save -> ${yield* replay(saved.replace('"player":1', '"player":3'))}`
  );
  // Someone edits it so that the Knight's first strike lands on the Knight.
  // The rules allow that move, so nothing is refused: the hash gives it away.
  yield* Console.log(
    `legal but altered -> ${yield* replay(saved.replace('"target":1', '"target":0'))}`
  );
  yield* Console.log(`garbage -> ${yield* replay("<html>")}`);

  // A save is the game as it stands, as bytes. Loaded into the rules alone,
  // it is the same fight at the same point: no replay, and no setup run.
  const save = app.save();
  if (Exit.isSuccess(save)) {
    const file = Save.encode(save.value);
    const read = Save.decode(file);
    if (Exit.isSuccess(read)) {
      const loaded = yield* App.make(App.define({ plugins: [Rules] }), {
        save: read.value,
      });
      yield* Console.log(
        `saved (${file.length} bytes) and loaded -> ${standing(loaded)} at tick ${loaded.time.tick} (${standing(loaded) === standing(app) ? "identical" : "DIFFERENT"})`
      );
    }
  }
});

// The entry point: runMain runs the program, reports a failure, and
// interrupts it (closing the app's scope) when the process is told to stop.
NodeRuntime.runMain(Effect.scoped(program));
