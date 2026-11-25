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
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";

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
  Schema.Struct({ target: EntityId, name: Schema.String, amount: Schema.Int })
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
  const world = yield* World.writes(Fighter);
  const name = world.get(target, Name)?.value ?? "nobody";
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
  (yield* Struck.emits).emit({ target, name, amount: STRIKE_DAMAGE });
  return them.hp - STRIKE_DAMAGE;
});

const pass = Action.handler(Pass, function* ({ player }) {
  const turn = yield* Turn.writes;
  if (player !== turn.player) {
    return yield* new NotYourTurn({ waitingFor: turn.player });
  }
  const next = player === 1 ? 2 : 1;
  turn.player = next;
  (yield* TurnEnded.emits).emit({ next });
});

// --- how the world reacts --------------------------------------------------------
const Casualties = System.tick("Casualties", function* () {
  const world = yield* World;
  const commands = yield* Commands;
  for (const { target } of (yield* Struck).read()) {
    const fighter = world.get(target, Fighter);
    if (fighter !== undefined && fighter.hp <= 0) {
      commands.despawn(target);
      (yield* Fell.emits).emit({ entity: target });
    }
  }
});

const Rest = System.tick("Rest", function* () {
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
  // Seats the two fighters. A replay runs it too, and a load doesn't: the
  // save holds them.
  setup: Effect.gen(function* () {
    const commands = yield* Commands.spawns(Name, Fighter);
    commands.spawn(
      Name.of({ value: "Knight" }),
      Fighter.of({ player: 1, hp: 10, energy: 4 })
    );
    commands.spawn(
      Name.of({ value: "Rogue" }),
      Fighter.of({ player: 2, hp: 11, energy: 3 })
    );
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
  // Commentary is said, not played: it is of the frame, which hears what the
  // ticks did and changes nothing.
  systems: [
    System.frame("CallHits", function* () {
      const narrator = yield* Narrator;
      for (const { amount, name } of (yield* Struck).read()) {
        narrator.say(`${name} takes ${amount}!`);
      }
    }),
    System.frame("CallEnd", function* () {
      const narrator = yield* Narrator;
      for (const _ of (yield* Fell).read()) {
        (yield* Standing).each((name) => {
          narrator.say(`And that is the end of the fight: ${name.value} wins.`);
        });
      }
    }),
  ],
});

// --- the game --------------------------------------------------------------------
// Outside the game, it is read with app.read, and changed with actions alone.
const standing = (app: App.Any): Effect.Effect<string> =>
  Effect.map(app.read(Standing), (fighters) => {
    const out: string[] = [];
    fighters.each((name, fighter) => {
      out.push(`${name.value} hp=${fighter.hp} energy=${fighter.energy}`);
    });
    return out.join(", ");
  });

/** The fighter of this name. */
const fighter = (app: App.Any, name: string): Effect.Effect<Entity> =>
  Effect.gen(function* () {
    const world = yield* app.read(World);
    const found = (yield* app.read(Standing))
      .entities()
      .find((entity) => world.get(entity, Name)?.value === name);
    if (found === undefined) {
      return yield* Effect.die(`no fighter is named ${name}`);
    }
    return found;
  });

const program = Effect.gen(function* () {
  // One tick per move, so a checkpoint of the world's hash after every tick
  // costs nothing and lets a replay say exactly where it went another way.
  // Held in the program's scope, which closes it when the program ends.
  const app = yield* Effect.acquireRelease(
    App.make(App.define({ plugins: [Commentary] }), { checkpointEvery: 1 }),
    (made) => made.close
  );
  const knight = yield* fighter(app, "Knight");
  const rogue = yield* fighter(app, "Rogue");

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
    app.frame();
  });
  const passTurn = Effect.fnUntraced(function* (player: 1 | 2) {
    app.dispatch(Pass, { player });
    app.tick(1);
    app.frame();
    yield* Console.log(`player ${player} passes -> ${yield* standing(app)}`);
  });

  yield* Console.log(`start -> ${yield* standing(app)}`);
  yield* strikeWith("Rogue", rogue, knight); // out of turn
  yield* strikeWith("Knight", knight, rogue);
  yield* strikeWith("Knight", knight, rogue);
  yield* strikeWith("Knight", knight, rogue); // out of energy
  yield* passTurn(1);
  yield* strikeWith("Rogue", rogue, knight);
  yield* passTurn(2);
  yield* strikeWith("Knight", knight, rogue); // the Rogue falls
  yield* strikeWith("Knight", knight, rogue); // nobody left to hit
  const end = yield* standing(app);
  yield* Console.log(`end -> ${end}`);

  // The recording holds the moves that were accepted, the world's hash after
  // every tick, and how long each tick was. Written out as bytes and read
  // back, it reproduces this game in a fresh one, which checks itself against
  // those hashes as it goes. The replay installs only the rules, so it is
  // silent.
  const saved = Journal.encode(app.record());
  yield* Console.log(`saved: ${saved.byteLength} bytes`);
  // A fresh app, held in a scope that closes it when the replay is over.
  const replay = Effect.fnUntraced(function* (bytes: Uint8Array) {
    const loaded = Journal.decode(bytes);
    if (Exit.isFailure(loaded)) {
      return "not a save file";
    }
    // The replay makes its app from how the game began, its seed, and that
    // app seats the fighters as the game did, in its setup. A replay that
    // goes another way fails, and says where.
    return yield* Effect.acquireRelease(
      Journal.replay(loaded.value, App.define({ plugins: [Rules] }), {
        checkpointEvery: 1,
      }),
      (replayed) => replayed.close
    ).pipe(
      Effect.flatMap(standing),
      Effect.map(
        (replayed) =>
          `${replayed} (${replayed === end ? "identical" : "DIFFERENT"})`
      ),
      Effect.catch((why) => Effect.succeed(`stopped: ${why.message}`))
    );
  }, Effect.scoped);
  yield* Console.log(`replayed -> ${yield* replay(saved)}`);
  // A payload is in its JSON form among the bytes, which someone edits in
  // place.
  const edited = (from: string, to: string): Uint8Array => {
    const bytes = Buffer.from(saved);
    bytes.write(to, bytes.indexOf(from));
    return bytes;
  };
  // Someone edits the save so that a player who does not exist passes.
  yield* Console.log(
    `edited save -> ${yield* replay(edited('"player":1', '"player":3'))}`
  );
  // Someone edits it so that the Knight's first strike lands on the Knight.
  // The rules allow that move, so nothing is refused: the hash gives it away.
  yield* Console.log(
    `legal but altered -> ${yield* replay(edited('"target":1', '"target":0'))}`
  );
  yield* Console.log(
    `garbage -> ${yield* replay(new TextEncoder().encode("<html>"))}`
  );

  // A save is the game as it stands, as bytes. Loaded into the rules alone,
  // it is the same fight at the same point: no replay, and no setup run.
  const save = app.save();
  if (Exit.isSuccess(save)) {
    const file = Save.encode(save.value);
    const read = Save.decode(file);
    if (Exit.isSuccess(read)) {
      const loaded = yield* Effect.acquireRelease(
        App.make(App.define({ plugins: [Rules] }), { save: read.value }),
        (made) => made.close
      );
      const held = yield* standing(loaded);
      yield* Console.log(
        `saved (${file.length} bytes) and loaded -> ${held} at tick ${loaded.time.tick} (${held === end ? "identical" : "DIFFERENT"})`
      );
    }
  }
});

// The entry point: runMain runs the program, reports a failure, and
// interrupts it (closing its scope, and the apps it holds) when the process
// is told to stop.
NodeRuntime.runMain(Effect.scoped(program));
