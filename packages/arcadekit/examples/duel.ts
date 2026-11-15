/**
 * A turn-based duel on the same framework as the real-time demo.
 *
 * Players act through actions. A handler checks each action against the
 * rules and either applies it or refuses it with a typed error. Systems and
 * a script react to the events that come out. Nothing runs until someone
 * acts: one tick per move.
 *
 * The game is two plugins: the rules, and commentary that depends on them.
 *
 *   npm run duel
 */
import { Context, Data, Effect, Exit, Layer, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  EntityId,
  Event,
  Field,
  Plugin,
  Query,
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
const Name = Component.define("duel/Name", { value: Field.ref<string>() });
const Turn = Component.define("duel/Turn", { player: Field.u8 });

const Fighters = Query.all(Fighter);
const whoseTurn = Effect.map(Query.all(Turn), (turns) => {
  let player = 0;
  turns.each((turn) => {
    player = turn.player;
  });
  return player;
});

// --- what can happen -------------------------------------------------------------
const Struck = Event.define<{
  readonly target: Entity;
  readonly amount: number;
}>("duel/Struck");
const Fell = Event.define<{ readonly entity: Entity }>("duel/Fell");
const TurnEnded = Event.define<{ readonly next: number }>("duel/TurnEnded");

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
  const player = yield* whoseTurn;
  if (me.player !== player) {
    return yield* new NotYourTurn({ waitingFor: player });
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
  const current = yield* whoseTurn;
  if (player !== current) {
    return yield* new NotYourTurn({ waitingFor: current });
  }
  const next = current === 1 ? 2 : 1;
  (yield* Query.all(Turn)).each((turn) => {
    turn.player = next;
  });
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
  systems: [Casualties, Rest],
  handlers: [strike, pass],
  setup: Effect.gen(function* () {
    (yield* Commands).spawn(Turn.of({ player: 1 }));
  }),
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
    System.make("CallEnd", function* () {
      const narrator = yield* Narrator;
      for (const _ of (yield* Fell).read()) {
        narrator.say("And that is the end of the fight.");
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
  app.world.view(Query.all(Name, Fighter)).each((name, fighter) => {
    out.push(`${name.value} hp=${fighter.hp} energy=${fighter.energy}`);
  });
  return out.join(", ");
};

const program = Effect.gen(function* () {
  const app = yield* App.make({ plugins: [Commentary] });
  const { knight, rogue } = seat(app);

  // A script: ordinary sequential code that waits for something to happen.
  const referee = app.spawnScript(
    Effect.gen(function* () {
      const fell = yield* Fell;
      const world = yield* World;
      yield* fell.wait;
      let winner = "";
      world.view(Query.all(Name, Fighter)).each((name) => {
        winner = name.value;
      });
      return `${winner} wins`;
    })
  );

  // One move: dispatch, report, then let the world react for one tick.
  const strikeWith = (who: string, attacker: Entity, target: Entity) => {
    const outcome = Effect.runSync(
      Effect.match(app.dispatch(Strike, { attacker, target }), {
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
      })
    );
    console.log(`${who} strikes: ${outcome}`);
    app.tick(1);
  };
  const passTurn = (player: 1 | 2) => {
    app.dispatch(Pass, { player });
    app.tick(1);
    console.log(`player ${player} passes -> ${standing(app)}`);
  };

  console.log(`start -> ${standing(app)}`);
  strikeWith("Rogue", rogue, knight); // out of turn
  strikeWith("Knight", knight, rogue);
  strikeWith("Knight", knight, rogue);
  strikeWith("Knight", knight, rogue); // out of energy
  passTurn(1);
  strikeWith("Rogue", rogue, knight);
  passTurn(2);
  strikeWith("Knight", knight, rogue); // the Rogue falls
  strikeWith("Knight", knight, rogue); // nobody left to hit
  console.log(`end -> ${standing(app)}; referee: ${referee.pollUnsafe()}`);

  // The log holds only the moves that were accepted. Written out as text and
  // read back, it reproduces this game in a fresh one. The replay installs
  // only the rules, so it is silent.
  const saved = Action.encodeLog(app.actionLog);
  console.log(`saved: ${saved}`);
  const replay = (text: string): string => {
    const loaded = Action.decodeLog(text);
    if (Exit.isFailure(loaded)) {
      return "not a save file";
    }
    return Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const headless = yield* App.make({ plugins: [Rules] });
          seat(headless);
          try {
            App.replay(headless, loaded.value, {
              delta: 1,
              ticks: app.time.tick,
            });
            return `${standing(headless)} (${standing(headless) === standing(app) ? "identical" : "DIFFERENT"})`;
          } catch (error) {
            return `stopped: ${(error as Error).message}`;
          }
        })
      )
    );
  };
  console.log(`replayed -> ${replay(saved)}`);
  // Someone edits the save so that a player who does not exist passes.
  console.log(
    `edited save -> ${replay(saved.replace('"player":1', '"player":3'))}`
  );
  console.log(`garbage -> ${replay("<html>")}`);
});

Effect.runSync(Effect.scoped(program));
