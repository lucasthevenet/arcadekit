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
 *   pnpm --filter arcadekit duel
 */
import { NodeRuntime } from "@effect/platform-node";
import { Context, Data, Effect, Exit, Layer, Match, Schema } from "effect";

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

const Fighters = Query.all(Fighter);

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

class NoSuchFighter extends Data.TaggedError("NoSuchFighter") {}

const STRIKE_COST = 2;
const STRIKE_DAMAGE = 4;

const strike = Action.handler(Strike, function* ({ attacker, target }) {
  const world = yield* World;
  const me = world.get(attacker, Fighter);
  const them = world.get(target, Fighter);

  if (me === undefined || them === undefined) {
    return yield* Effect.fail(new NoSuchFighter());
  }

  const turn = yield* Turn;

  if (me.player !== turn.player) {
    return yield* Effect.fail(new NotYourTurn({ waitingFor: turn.player }));
  }

  if (me.energy < STRIKE_COST) {
    return yield* Effect.fail(
      new TooTired({ energy: me.energy, cost: STRIKE_COST })
    );
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
    return yield* Effect.fail(new NotYourTurn({ waitingFor: turn.player }));
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
  components: [Fighter, Name, Turn],
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
  // One tick per move, so a checkpoint of the world's hash after every tick
  // costs nothing and lets a replay say exactly where it went another way.
  const app = yield* App.make({ plugins: [Commentary], checkpointEvery: 1 });
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
        onFailure: (error) =>
          Match.valueTags(error, {
            NotYourTurn: ({ waitingFor }) =>
              `refused, it is player ${waitingFor}'s turn`,
            TooTired: ({ cost, energy }) =>
              `refused, needs ${cost} energy and has ${energy}`,
            NoSuchFighter: () => "refused, that fighter is not in the game",
            InvalidPayload: ({ message }) =>
              `refused, malformed move (${message})`,
          }),
        onSuccess: (hpLeft) => `hits, target is left with ${hpLeft} hp`,
      }
    );

    console.log(`${who} strikes: ${outcome}`);
    app.tick(1);
  });

  const passTurn = (player: 1 | 2) => {
    app.dispatch(Pass, { player });
    app.tick(1);
    console.log(`player ${player} passes -> ${standing(app)}`);
  };

  console.log(`start -> ${standing(app)}`);
  // Out of turn.
  yield* strikeWith("Rogue", rogue, knight);
  yield* strikeWith("Knight", knight, rogue);
  yield* strikeWith("Knight", knight, rogue);
  // Out of energy.
  yield* strikeWith("Knight", knight, rogue);
  passTurn(1);
  yield* strikeWith("Rogue", rogue, knight);
  passTurn(2);
  // The Rogue falls.
  yield* strikeWith("Knight", knight, rogue);
  // Nobody left to hit.
  yield* strikeWith("Knight", knight, rogue);
  console.log(`end -> ${standing(app)}; referee: ${referee.pollUnsafe()}`);

  // The log holds the moves that were accepted, and the world's hash after
  // every tick. Written out as text and read back, it reproduces this game in
  // a fresh one, which checks itself against those hashes as it goes. The
  // replay installs only the rules, so it is silent.
  const saved = Action.encodeLog(app.actionLog);
  console.log(`saved: ${saved}`);

  // A fresh app in a scope of its own, closed when the replay is over.
  const replay = Effect.fnUntraced(function* (text: string) {
    const loaded = Action.decodeLog(text);

    if (Exit.isFailure(loaded)) {
      return "not a save file";
    }

    const headless = yield* App.make({ plugins: [Rules], checkpointEvery: 1 });
    seat(headless);

    try {
      App.replay(headless, loaded.value, { delta: 1, ticks: app.time.tick });

      return `${standing(headless)} (${standing(headless) === standing(app) ? "identical" : "DIFFERENT"})`;
    } catch (error) {
      return `stopped: ${(error as Error).message}`;
    }
  }, Effect.scoped);

  console.log(`replayed -> ${yield* replay(saved)}`);
  // Someone edits the save so that a player who does not exist passes.
  console.log(
    `edited save -> ${yield* replay(saved.replace('"player":1', '"player":3'))}`
  );
  // Someone edits it so that the Knight's first strike lands on the Knight.
  // The rules allow that move, so nothing is refused: the hash gives it away.
  console.log(
    `legal but altered -> ${yield* replay(saved.replace('"target":1', '"target":0'))}`
  );
  console.log(`garbage -> ${yield* replay("<html>")}`);

  // A save is the game as it stands, as bytes. Loaded into the rules alone,
  // it is the same fight at the same point: no replay, and no setup run.
  const save = app.save();

  if (Exit.isSuccess(save)) {
    const file = Save.encode(save.value);
    const read = Save.decode(file);

    if (Exit.isSuccess(read)) {
      const loaded = yield* App.load(read.value, { plugins: [Rules] });
      console.log(
        `saved (${file.length} bytes) and loaded -> ${standing(loaded)} at tick ${loaded.time.tick} (${standing(loaded) === standing(app) ? "identical" : "DIFFERENT"})`
      );
    }
  }
});

// The entry point: runMain runs the program, reports a failure, and
// interrupts it (closing the app's scope) when the process is told to stop.
NodeRuntime.runMain(Effect.scoped(program));
