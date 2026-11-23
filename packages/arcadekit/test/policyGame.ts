/**
 * A small game that goes through every way a loop reads and writes
 * component data, for `Policy.test.ts`: it is played once as it is and
 * once in a process that may not make code from text, which is what a
 * page under a strict Content Security Policy is, and has to give the
 * same answer in both.
 */
import { Data, DateTime, Effect, Exit, Schema } from "effect";

import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Query,
  Save,
  Singleton,
  System,
  Time,
} from "../src/index";
import type { Entity } from "../src/index";

const Position = Component.define("policy/Position", {
  x: Field.f32,
  y: Field.f32,
});
const Velocity = Component.define("policy/Velocity", {
  x: Field.f64,
  y: Field.f64,
});
// One field of every kind a column can be.
const Sheet = Component.define("policy/Sheet", {
  hp: Field.i32,
  gold: Field.u32,
  level: Field.u16,
  flags: Field.u8,
  rival: Field.entity,
  name: Field.json<string>(),
  born: Field.schema(Schema.Date),
  cache: Field.transient<{ readonly seen: number }>(),
});
const Burning = Component.define(
  "policy/Burning",
  { seconds: Field.f32 },
  { storage: "sparse" }
);
const Follows = Component.relation("policy/Follows", {
  onTargetDespawn: "remove",
  fields: { since: Field.u32 },
});
const Stats = Singleton.define(
  "policy/Stats",
  { moved: Field.u32, burnt: Field.u32 },
  { moved: 0, burnt: 0 }
);

const Moving = Query.all(Position, Velocity).pipe(Query.writes(Position));
const Sheets = Query.all(Sheet).pipe(Query.writes(Sheet));
const OnFire = Query.all(Position, Burning).pipe(
  Query.writes(Position, Burning)
);
const Followers = Query.all(Follows, Position, Velocity, Sheet).pipe(
  Query.writes(Follows, Position, Sheet)
);
const Moved = Query.all(Position, Sheet).pipe(
  Query.changed(Position),
  Query.writes(Sheet)
);
// It says it writes, so that the frame stage is what refuses the write.
const Drawn = Query.all(Position);

/** Why the game refused what it refused, each reason once. */
const refusals: string[] = [];
const refused = (attempt: () => void): void => {
  let reason = "it was not refused";
  try {
    attempt();
  } catch (error) {
    reason = (error as Error).message;
  }
  if (!refusals.includes(reason)) {
    refusals.push(reason);
  }
};

const Movement = System.tick("policy/Movement", function* () {
  const { delta } = yield* Time;
  const stats = yield* Stats.writes;
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
    position.y += velocity.y * delta;
    stats.moved += 1;
  });
});

const Ageing = System.tick("policy/Ageing", function* () {
  (yield* Sheets).each((sheet, entity) => {
    sheet.hp -= 1;
    sheet.gold += 3;
    sheet.level += 1;
    sheet.flags ^= 1;
    sheet.rival = entity;
    sheet.name = `${sheet.name}!`;
    sheet.born = new Date(sheet.born.getTime() + 1000);
    sheet.cache = { seen: (sheet.cache?.seen ?? 0) + 1 };
  });
});

const Fire = System.tick("policy/Fire", function* () {
  const { delta, tick } = yield* Time;
  const stats = yield* Stats.writes;
  const commands = yield* Commands;
  (yield* OnFire).each((position, burning, entity) => {
    burning.seconds -= delta;
    position.y -= 1;
    stats.burnt += 1;
    if (burning.seconds <= 0) {
      commands.remove(entity, Burning);
    }
  });
  if (tick === 2) {
    // A query that only reads refuses a write, and says which field.
    (yield* Moving).each((_, velocity) => {
      refused(() => {
        (velocity as { x: number }).x = 9;
      });
    });
  }
});

const Following = System.tick("policy/Following", function* () {
  const { tick } = yield* Time;
  // Four terms: the loop that hands out any number of them.
  (yield* Followers).each((follows, position, velocity, sheet) => {
    follows.since += 1;
    position.x += sheet.level;
    sheet.gold += velocity.x > 0 ? 1 : 0;
    if (tick === 2) {
      // A relation's target is the world's to change.
      refused(() => {
        follows.target = 0 as Entity;
      });
    }
  });
});

let noticed = 0;
const Watching = System.tick("policy/Watching", function* () {
  (yield* Moved).each((position, sheet) => {
    noticed += 1;
    sheet.hp += position.x > 1000 ? 1 : 0;
  });
});

let drawn = 0;
const Draw = System.frame("policy/Draw", function* () {
  (yield* Drawn).each((position) => {
    drawn += position.x;
    // The frame stage reads, and a write there is refused where it is made.
    refused(() => {
      // @ts-expect-error a frame system reads
      position.x = 0;
    });
  });
});

class TooPoor extends Data.TaggedError("policy/TooPoor")<{}> {}
const Tax = Action.define("policy/Tax", Schema.Struct({ amount: Schema.Int }));
const tax = Action.handler(Tax, function* ({ amount }) {
  let poorest = Infinity;
  (yield* Sheets).each((sheet) => {
    sheet.gold -= amount;
    poorest = Math.min(poorest, sheet.gold);
  });
  // A u32 wraps: a sheet that could not pay holds a huge number.
  if (poorest > 1_000_000) {
    return yield* new TooPoor();
  }
});

const Game = App.define({
  systems: [Movement, Ageing, Fire, Following, Watching, Draw],
  handlers: [tax],
});

/** Whether this process may make code from text. */
export const generates = (): boolean => {
  try {
    // oxlint-disable-next-line no-implied-eval
    return new Function("return true")() === true;
  } catch {
    return false;
  }
};

/** Plays the game and says how it went, as plain data. */
export const play = (): Record<string, unknown> =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        refusals.length = 0;
        noticed = 0;
        drawn = 0;
        const app = yield* App.make(Game, { seed: 7, checkpointEvery: 1 });
        const { world } = app;
        let leader: Entity | undefined;
        for (let i = 0; i < 40; i++) {
          const entity = world.spawn(
            Position.of({ x: i, y: 2 * i }),
            ...(i % 2 === 0 ? [Velocity.of({ x: 1 + i, y: -i })] : []),
            ...(i % 3 === 0
              ? [
                  Sheet.of({
                    hp: 10 + i,
                    gold: 2,
                    level: i,
                    flags: i & 255,
                    rival: 0 as Entity,
                    name: `hero ${i}`,
                    born: DateTime.toDateUtc(
                      DateTime.makeUnsafe(1_000_000 * i)
                    ),
                    cache: undefined,
                  }),
                ]
              : []),
            ...(i % 5 === 0 ? [Burning.of({ seconds: 0.03 + i / 1000 })] : []),
            ...(leader !== undefined && i % 6 === 0
              ? [Follows.of({ target: leader, since: i })]
              : [])
          );
          leader ??= entity;
        }
        const outcomes: string[] = [];
        for (let tick = 0; tick < 6; tick++) {
          app.tick(1 / 60);
          app.frame(0.5);
          if (tick === 1 || tick === 3) {
            // The first is paid; the second cannot be, and is taken back.
            const exit = app.dispatch(Tax, { amount: tick === 1 ? 1 : 1000 });
            outcomes.push(Exit.isSuccess(exit) ? "paid" : "refused");
          }
        }
        const saved = app.save();
        if (Exit.isFailure(saved)) {
          return { failed: "save" };
        }
        const bytes = Save.encode(saved.value);
        const read = Save.decode(bytes);
        if (Exit.isFailure(read)) {
          return { failed: "decode" };
        }
        const again = yield* App.make(Game, {
          save: read.value,
          checkpointEvery: 1,
        });
        again.tick(1 / 60);
        app.tick(1 / 60);
        return {
          hash: world.hash(),
          loaded: again.world.hash(),
          bytes: bytes.length,
          stats: { ...world.singleton(Stats) },
          sheets: world
            .view(Sheets)
            .entities()
            .map((entity) => {
              const sheet = world.get(entity, Sheet)!;
              return [sheet.hp, sheet.gold, sheet.name, sheet.born.getTime()];
            }),
          noticed,
          drawn,
          outcomes,
          refusals,
        };
      })
    )
  );
