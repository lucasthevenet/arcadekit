import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { World as EcsWorld } from "../src/ecs/index.ts";
import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Grid,
  Plugin,
  Query,
  Random,
  Save,
  Singleton,
  System,
  Timeline,
  World,
} from "../src/index.ts";
import type { Entity } from "../src/index.ts";

describe("a map", () => {
  it("is filled, read, and changed into a new map", () => {
    const map = Grid.fill(4, 3, 1);
    const dug = map.with(2, 1, 0);
    expect(map.at(2, 1)).toBe(1);
    expect(dug.at(2, 1)).toBe(0);
    expect(dug.at(1, 1)).toBe(1);
    expect(dug.with(2, 1, 0)).toBe(dug);
    expect(map.inside(3, 2)).toBe(true);
    expect(map.inside(4, 0)).toBe(false);
    expect(map.inside(0.5, 0)).toBe(false);
    expect(() => map.at(-1, 0)).toThrow("(-1, 0) is off a map of 4 by 3");
    expect(() => map.with(0, 0, 256)).toThrow(
      "A tile is a whole number from 0 to 255, and 256 is not one."
    );
    expect(() => Grid.fill(0, 3)).toThrow("0 by 3 is not");
  });
});

// --- a roguelike: walls, a player and monsters that wander and die ----------

const WALL = 1;
const FLOOR = 0;
const W = 12;
const H = 8;

const Floor = Singleton.define(
  "gr/Floor",
  { tiles: Grid.tiles(W, H) },
  { tiles: Grid.fill(W, H, WALL) }
);
const Pos = Component.define("gr/Pos", { x: Field.i32, y: Field.i32 });
const Player = Component.tag("gr/Player");
const Monster = Component.define("gr/Monster", { hp: Field.i32 });

const Creatures = Query.all(Pos);
const Wandering = Query.all(Pos, Monster).pipe(Query.writes(Pos, Monster));
const Walkers = Query.all(Pos).pipe(Query.with(Player), Query.writes(Pos));

class Blocked extends Schema.TaggedError<Blocked>()("GridTestBlocked", {
  by: Schema.String,
}) {}

const Step = Action.define(
  "gr/Step",
  Schema.Struct({ dx: Schema.Int, dy: Schema.Int }),
  { error: Blocked }
);
const Dig = Action.define(
  "gr/Dig",
  Schema.Struct({ x: Schema.Int, y: Schema.Int, refuse: Schema.Boolean }),
  { error: Blocked }
);

// It moves first and looks after, so that a refusal has a move to undo.
const step = Action.handler(Step, function* ({ dx, dy }) {
  const { tiles } = yield* Floor;
  let refused: string | undefined;
  (yield* Walkers).each((pos) => {
    pos.x += dx;
    pos.y += dy;
    if (!tiles.inside(pos.x, pos.y) || tiles.at(pos.x, pos.y) === WALL) {
      refused = "a wall";
    }
  });
  if (refused === undefined) {
    const here = Grid.occupants(tiles, yield* Creatures);
    (yield* Walkers).each((pos) => {
      if (here.at(pos.x, pos.y).length > 1) {
        refused = "a monster";
      }
    });
  }
  if (refused !== undefined) {
    return yield* Blocked.make({ by: refused });
  }
});

const dig = Action.handler(Dig, function* ({ x, y, refuse }) {
  const floor = yield* Floor.writes;
  floor.tiles = floor.tiles.with(x, y, FLOOR);
  if (refuse) {
    return yield* Blocked.make({ by: "the rule" });
  }
});

const Wander = System.tick("gr/Wander", function* () {
  const random = yield* Random;
  const { tiles } = yield* Floor;
  const commands = yield* Commands;
  (yield* Wandering).each((pos, monster, entity) => {
    const [dx, dy] = Grid.sides[Math.floor(random.next() * 4)]!;
    const x = pos.x + dx;
    const y = pos.y + dy;
    if (tiles.inside(x, y) && tiles.at(x, y) === FLOOR) {
      pos.x = x;
      pos.y = y;
    }
    monster.hp -= random.next() < 0.05 ? 1 : 0;
    if (monster.hp <= 0) {
      commands.despawn(entity);
    }
  });
});

const Level = Plugin.make("gr/Level", {
  setup: Effect.gen(function* () {
    const floor = yield* Floor.writes;
    let tiles = floor.tiles;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        tiles = tiles.with(x, y, FLOOR);
      }
    }
    floor.tiles = tiles;
    const random = yield* Random;
    const commands = yield* Commands.spawns(Pos, Player, Monster);
    commands.spawn(Pos.of({ x: 1, y: 1 }), Player);
    for (let i = 0; i < 25; i++) {
      commands.spawn(
        Pos.of({
          x: 1 + Math.floor(random.next() * (W - 2)),
          y: 1 + Math.floor(random.next() * (H - 2)),
        }),
        Monster.of({ hp: 1 + Math.floor(random.next() * 3) })
      );
    }
  }),
});

const Rogue = App.define({
  plugins: [Level],
  systems: [Wander],
  handlers: [step, dig],
});

/** Who is on each tile, worked out by hand: every creature, in query order. */
const byHand = (app: Pick<App.Any, "read">) =>
  Effect.gen(function* () {
    const world = yield* app.read(World);
    const all = new Map<string, Entity[]>();
    for (const entity of (yield* app.read(Creatures)).entities()) {
      const { x, y } = world.get(entity, Pos)!;
      const key = `${x},${y}`;
      all.set(key, [...(all.get(key) ?? []), entity]);
    }
    return all;
  });

/** Every tile's occupants, as `Grid.occupants` says. */
const listed = (here: Grid.Occupants) => {
  const all = new Map<string, Entity[]>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const on = here.at(x, y);
      expect(here.first(x, y)).toBe(on[0]);
      if (on.length > 0) {
        all.set(`${x},${y}`, on);
      }
    }
  }
  return all;
};

const occupantsOf = (app: Pick<App.Any, "read">) =>
  Effect.gen(function* () {
    const { tiles } = yield* app.read(Floor);
    return listed(Grid.occupants(tiles, yield* app.read(Creatures)));
  });

describe("who is on a tile", () => {
  it.effect("is where the world says, as monsters move and die", () =>
    Effect.gen(function* () {
      for (const seed of [1, 2, 3]) {
        const app = yield* App.make(Rogue, { seed });
        let stacked = 0;
        for (let i = 0; i < 200; i++) {
          yield* app.tick(1);
          const found = yield* occupantsOf(app);
          expect(found).toEqual(yield* byHand(app));
          stacked += [...found.values()].filter((on) => on.length > 1).length;
        }
        // The test saw tiles with more than one, and monsters die.
        expect(stacked).toBeGreaterThan(0);
        expect((yield* app.read(Query.all(Monster))).count()).toBeLessThan(25);
      }
    })
  );

  it.effect("is true again after a refused action moved someone", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Rogue, { seed: 4 });
      const before = yield* occupantsOf(app);
      // Into the wall above: moved, then refused.
      const refused = yield* Effect.exit(app.dispatch(Step, { dx: 0, dy: -1 }));
      expect(Exit.isFailure(refused)).toBe(true);
      expect(yield* occupantsOf(app)).toEqual(before);
      // A step that is allowed shows where the player is now.
      const stepped = yield* Effect.exit(app.dispatch(Step, { dx: 1, dy: 0 }));
      expect(yield* occupantsOf(app)).toEqual(yield* byHand(app));
      if (Exit.isSuccess(stepped)) {
        expect(yield* occupantsOf(app)).not.toEqual(before);
      }
    })
  );

  it.effect("is true after a rewind and after a load", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Rogue, { seed: 5 });
      for (let i = 0; i < 30; i++) {
        yield* app.tick(1);
      }
      const then = yield* occupantsOf(app);
      const moment = yield* Timeline.capture(app);
      const save = yield* Save.make(app);
      for (let i = 0; i < 30; i++) {
        yield* app.tick(1);
      }
      expect(yield* occupantsOf(app)).not.toEqual(then);
      yield* Timeline.rewind(app, moment);
      expect(yield* occupantsOf(app)).toEqual(then);
      const loaded = yield* App.make(Rogue, { save });
      expect(yield* occupantsOf(loaded)).toEqual(then);
    })
  );

  it("refuses a change query", () => {
    const world = new EcsWorld();
    const moved = world.view(Query.all(Pos).pipe(Query.changed(Pos)));
    expect(() => Grid.occupants(Grid.fill(2, 2), moved)).toThrow(
      "Grid.occupants was given a change query"
    );
  });

  it("does not compile with a query whose first term has no x and y", () => {
    const world = new EcsWorld();
    const unplaced = world.view(Query.all(Monster, Pos));
    // @ts-expect-error the first term is where an entity is
    expect(Grid.occupants(Grid.fill(2, 2), unplaced).first(0, 0)).toBe(
      undefined
    );
  });
});

describe("a map in the world", () => {
  it.effect("is saved, hashed, and put back by a refused action", () =>
    Effect.gen(function* () {
      const app = yield* App.make(Rogue, { seed: 6 });
      const world = yield* app.read(World);
      const before = world.hash();
      expect(
        yield* Effect.exit(app.dispatch(Dig, { x: 0, y: 0, refuse: true }))
      ).toEqual(Exit.fail(Blocked.make({ by: "the rule" })));
      expect(world.hash()).toBe(before);
      expect((yield* app.read(Floor)).tiles.at(0, 0)).toBe(WALL);
      yield* app.dispatch(Dig, { x: 0, y: 0, refuse: false });
      expect(world.hash()).not.toBe(before);
      const save = yield* Save.make(app);
      const bytes = Save.encode(save);
      const loaded = yield* App.make(Rogue, {
        save: yield* Save.decode(bytes),
      });
      expect((yield* loaded.read(Floor)).tiles.at(0, 0)).toBe(FLOOR);
      expect((yield* loaded.read(World)).hash()).toBe(world.hash());
    })
  );

  it.effect("of another size is refused when saved, by its field", () =>
    Effect.gen(function* () {
      const Small = Singleton.define(
        "gr/Small",
        { tiles: Grid.tiles(2, 2) },
        { tiles: Grid.fill(2, 2) }
      );
      const Wrong = Action.define("gr/Wrong", Schema.Struct({}));
      const wrong = Action.handler(Wrong, function* () {
        (yield* Small.writes).tiles = Grid.fill(3, 3);
      });
      const app = yield* App.make(App.define({ handlers: [wrong] }));
      yield* app.dispatch(Wrong, {});
      expect(yield* Effect.exit(Save.make(app))).toEqual(
        Exit.fail(
          new Save.Refused({
            message: `"gr/Small.tiles" holds a value its codec did not turn into plain data (an object).`,
          })
        )
      );
    })
  );
});
