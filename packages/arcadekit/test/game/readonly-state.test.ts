import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  EntityPool,
  Ring,
  RingReader,
  Rng,
  SpatialGrid,
  TileMap,
} from "../../src/core/index";
import type { View } from "../../src/game/browser";
import * as Game from "../../src/game/index";

const ENEMY = { x: Float32Array, hp: Float32Array } as const;
const HIT = { x: Float32Array } as const;
const LEVEL = { tile: Uint8Array } as const;

interface Hero {
  hp: number;
  readonly weapons: { level: number }[];
}

/** A run's state with one of each thing a step keeps. */
interface Arena {
  time: number;
  readonly rng: Rng.Rng;
  readonly enemies: EntityPool.EntityPool<typeof ENEMY>;
  readonly boxes: EntityPool.Identified<typeof ENEMY>;
  readonly hits: Ring.Ring<typeof HIT>;
  readonly map: TileMap.TileMap<typeof LEVEL>;
  readonly grid: SpatialGrid.SpatialGrid;
  readonly scratch: Float64Array;
  readonly heroes: Hero[];
  readonly seen: Map<string, number>;
}

const makeArena = (): Arena => {
  const arena: Arena = {
    time: 0,
    rng: Rng.make(7),
    enemies: EntityPool.make(4, ENEMY),
    boxes: EntityPool.makeIdentified(4, ENEMY),
    hits: Ring.make(4, HIT),
    map: TileMap.make(3, 2, LEVEL),
    grid: SpatialGrid.make({ halfSize: 10, cellSize: 2, capacity: 4 }),
    scratch: new Float64Array(2),
    heroes: [{ hp: 3, weapons: [{ level: 1 }] }],
    seen: new Map(),
  };
  const enemy = EntityPool.add(arena.enemies);
  arena.enemies.fields.x[enemy] = 3;
  arena.enemies.fields.hp[enemy] = 10;
  EntityPool.add(arena.boxes);
  EntityPool.add(arena.boxes);
  EntityPool.remove(arena.boxes, 0);
  for (let i = 0; i < 3; i++) {
    Ring.push(arena.hits);
  }
  SpatialGrid.build(
    arena.grid,
    new Float32Array([0, 0.5, 8]),
    new Float32Array([0, 0, 8]),
    3
  );
  return arena;
};

describe("Game.ReadonlyState", () => {
  it("is the run's own state, not a copy", () => {
    const arena = makeArena();
    const read: Game.ReadonlyState<Arena> = arena;
    expect(read).toBe(arena);
  });

  it("lets a reader call the functions that only read", () => {
    const read: Game.ReadonlyState<Arena> = makeArena();
    const visited: number[] = [];
    EntityPool.visit(read.enemies, (value) => visited.push(value));
    expect([
      visited,
      EntityPool.idOf(read.boxes, 0),
      EntityPool.indexOf(read.boxes, 0),
      Ring.slotOf(read.hits, 5),
      RingReader.take(RingReader.make(), read.hits),
      TileMap.cellAt(read.map, 1, 1),
      SpatialGrid.query(read.grid, 0, 0, 1, new Int32Array(4)),
      read.rng.state,
    ]).toStrictEqual([[1, 3, 10], 1, -1, 1, 3, 4, 2, Rng.make(7).state]);
  });

  it("refuses a write, a draw and a structure's mutation at compile time", () => {
    const read: Game.ReadonlyState<Arena> = makeArena();
    // Never run: each line is checked by the compiler, which must refuse it.
    const writes = () => {
      // @ts-expect-error -- a field of the state
      read.time = 1;
      // @ts-expect-error -- a field of an object in an array of it
      read.heroes[0]!.hp = 1;
      // @ts-expect-error -- an array of it
      read.heroes.push({ hp: 1, weapons: [] });
      // @ts-expect-error -- an element of a typed array
      read.scratch[0] = 1;
      // @ts-expect-error -- a typed array's method that writes it
      read.scratch.fill(0);
      // @ts-expect-error -- an element of a pool's field
      read.enemies.fields.hp[0] = 1;
      // @ts-expect-error -- a pool's add
      EntityPool.add(read.enemies);
      // @ts-expect-error -- a pool's remove
      EntityPool.remove(read.enemies, 0);
      // @ts-expect-error -- an identified pool's addWithId
      EntityPool.addWithId(read.boxes, 0);
      // @ts-expect-error -- a ring's push
      Ring.push(read.hits);
      // @ts-expect-error -- an element of a tile map's field
      read.map.fields.tile[0] = 1;
      // @ts-expect-error -- a grid's build
      SpatialGrid.build(read.grid, [0], [0], 1);
      // @ts-expect-error -- a draw from the run's generator
      Rng.next(read.rng);
      // @ts-expect-error -- a map of it
      read.seen.set("a", 1);
    };
    expectTypeOf(writes).toBeFunction();
  });

  it("is what a view, a sample and a state hash are given", () => {
    class Hud extends Game.Event("Hud", { time: Schema.Number }) {}
    expectTypeOf<
      Parameters<View<Arena>["render"]>[0]
    >().toEqualTypeOf<Game.ReadonlyState<Arena> | null>();
    expectTypeOf<
      Parameters<Game.Sample<Arena, typeof Hud>["read"]>[0]
    >().toEqualTypeOf<Game.ReadonlyState<Arena>>();
  });

  it("hands a sample the run's own state", () => {
    class Ticked extends Game.Event("Ticked", { steps: Schema.Int }) {}
    const sampled: unknown[] = [];
    class Ticker extends Game.Simulation("Ticker", {
      input: Schema.Null,
      create: () => ({ steps: 0 }),
      step: (state) => {
        state.steps += 1;
      },
      sample: {
        event: Ticked,
        read: (state) => {
          sampled.push(state);
          return { steps: state.steps };
        },
      },
    }) {}
    const loop = Game.makeLoop(Ticker);
    loop.start(undefined, 1, 0);
    expect(sampled).toStrictEqual([loop.state]);
    expect(sampled[0]).toBe(loop.state);
  });
});
