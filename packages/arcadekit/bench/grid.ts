/**
 * Whether what `Grid` copies and works out again costs a game enough to
 * matter, in the two cases issue #436 names: a large map dug a tile at a
 * time, and thousands of creatures asked about every tick. Each variant is a
 * tick, or a save, of a game that does the grid's work, and each is paired
 * with a baseline, the same tick or save without it, so that the difference
 * is the grid's work and can be read as a share of a 16.7 ms frame.
 *
 * `Grid.tiles` is a field that holds an immutable map: a tile changed copies
 * every tile, and the next hash and save write every tile again as text.
 * `Grid.occupants` works out who is on every tile from the world each time it
 * is called. The maps are 80 by 50, a roguelike's, and 250 by 250, a colony
 * game's.
 *
 *   pnpm --filter arcadekit bench:grid
 *
 * runs every pair, each side in a process of its own and the two sides turn
 * and turn about, and prints each side's median, the difference and its share
 * of a frame. A variant is run on its own as
 *
 *   node --import tsx bench/grid.ts <name>
 *
 * which prints the median milliseconds of a pass.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Effect } from "effect";

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
  Time,
} from "../src/index.ts";
import { measureEffect } from "./app.ts";
import { sizes } from "./core.ts";
import type { Variant } from "./core.ts";

const DT = 1 / 60;
if (DT !== sizes.step) {
  throw new Error("bench/grid.ts and bench/core.ts differ on DT.");
}
const FRAME_MS = 1000 / 60;
const WALL = 1;
const FLOOR = 0;

/** Passes of a tick, and of a save, after their warm-up. */
const TICKS = { runs: 2000, warmup: 500 } as const;
const SAVES = { runs: 300, warmup: 80 } as const;

/** A map of `width` by `height`, every tile `value`, as a game's singleton. */
const floorOf = (width: number, height: number, value: number) =>
  Singleton.define(
    `bench/Floor${width}x${height}`,
    { tiles: Grid.tiles(width, height) },
    { tiles: Grid.fill(width, height, value) }
  );

/** How many tiles of `tiles` are not walls. */
const opened = (tiles: Grid.Tiles): number => {
  let open = 0;
  for (let y = 0; y < tiles.height; y++) {
    for (let x = 0; x < tiles.width; x++) {
      open += tiles.at(x, y) === WALL ? 0 : 1;
    }
  }
  return open;
};

/**
 * How many tiles of `tiles` are open after `digs` toggles of one tile after
 * another, from any tile, going round the map.
 */
const openAfter = (digs: number, tiles: number): number =>
  Math.floor(digs / tiles) % 2 === 0 ? digs % tiles : tiles - (digs % tiles);

/** The tick of a game that does no grid work. */
const Bare = System.tick("bench/Bare", function* () {
  yield* Time;
});

type Size = readonly [width: number, height: number];

/**
 * A map of `width` by `height`, all walls, and a system that digs one of its
 * tiles each tick, walking the map in order: a wall is opened, and an open
 * tile walled again, so that every tick changes the map.
 */
const digger = ([width, height]: Size) => {
  const Floor = floorOf(width, height, WALL);
  const Dig = System.tick("bench/Dig", function* () {
    const floor = yield* Floor.writes;
    const at = (yield* Time).tick % (width * height);
    const x = at % width;
    const y = (at - x) / width;
    floor.tiles = floor.tiles.with(x, y, floor.tiles.at(x, y) ^ 1);
  });
  return { Floor, Dig };
};

/**
 * Median milliseconds of a tick that digs one tile of a map of `size`, or,
 * with no map, of `Bare`. With `hashed`, the tick ends with the world's hash,
 * as every tick of a turn-based game, and every 60th of one that keeps the
 * default, does.
 */
const digging = (size: Size | undefined, hashed: boolean): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const map = size === undefined ? undefined : digger(size);
      const app = yield* App.make(
        App.define({ systems: [map === undefined ? Bare : map.Dig] }),
        { hashEvery: hashed ? 1 : 0 }
      );
      const ms = yield* measureEffect(
        () => app.tick(DT),
        TICKS.runs,
        TICKS.warmup
      );
      const ticks = TICKS.runs + TICKS.warmup;
      const checks = app.actionLog.filter(Action.isHashCheck).length;
      if (hashed ? checks < ticks : checks > 0) {
        throw new Error(`${checks} hashes were taken in ${ticks} ticks.`);
      }
      if (map !== undefined) {
        const { tiles } = yield* app.read(map.Floor);
        if (opened(tiles) !== openAfter(ticks, tiles.width * tiles.height)) {
          throw new Error(`${ticks} ticks did not dig a tile each.`);
        }
      }
      return ms;
    })
  );

/**
 * Median milliseconds of a save of the game of `digging`, made and encoded
 * as bytes, after a tick that dug a tile and took no hash, so that the map's
 * text is not made yet. The tick is not timed.
 */
const saving = (size: Size | undefined): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const map = size === undefined ? undefined : digger(size);
      const app = yield* App.make(
        App.define({ systems: [map === undefined ? Bare : map.Dig] }),
        { hashEvery: 0 }
      );
      let bytes = 0;
      const ms = yield* measureEffect(
        () =>
          Effect.map(Save.make(app), (save) => {
            bytes = Save.encode(save).length;
          }),
        SAVES.runs,
        SAVES.warmup,
        () => app.tick(DT)
      );
      if (size !== undefined && bytes < size[0] * size[1] * 2) {
        throw new Error(`A save of ${bytes} bytes cannot hold the map.`);
      }
      return ms;
    })
  );

const Spot = Component.define("bench/Spot", { x: Field.i32, y: Field.i32 });
const Creatures = Query.all(Spot);
const Walkers = Query.all(Spot).pipe(Query.writes(Spot));
/** How many steps the creatures took, and how many someone stood in the way of. */
const Walked = Singleton.define(
  "bench/Walked",
  { steps: Field.u32, blocked: Field.u32 },
  { steps: 0, blocked: 0 }
);

/**
 * Median milliseconds of a tick in which each of `count` creatures, placed at
 * random on an open map of `width` by `height`, steps to a tile beside it
 * that is on the map and not a wall. With `ask`, the tick first calls
 * `Grid.occupants` once, as the guide says to, and a creature steps only
 * where nobody stands.
 */
const asking = (
  count: number,
  width: number,
  height: number,
  ask: boolean
): number =>
  Effect.runSync(
    Effect.gen(function* () {
      const Floor = floorOf(width, height, FLOOR);
      const Crowd = Plugin.make("bench/Crowd", {
        setup: Effect.gen(function* () {
          const random = yield* Random;
          const commands = yield* Commands.spawns(Spot);
          for (let i = 0; i < count; i++) {
            commands.spawn(
              Spot.of({
                x: Math.floor(random.next() * width),
                y: Math.floor(random.next() * height),
              })
            );
          }
        }),
      });
      const Walk = System.tick("bench/Walk", function* () {
        const { tiles } = yield* Floor;
        let steps = 0;
        let blocked = 0;
        const here = ask ? Grid.occupants(tiles, yield* Creatures) : undefined;
        let side = (yield* Time).tick;
        (yield* Walkers).each((spot) => {
          const [dx, dy] = Grid.sides[side++ & 3]!;
          const x = spot.x + dx;
          const y = spot.y + dy;
          if (!tiles.inside(x, y) || tiles.at(x, y) === WALL) {
            return;
          }
          if (here !== undefined && here.first(x, y) !== undefined) {
            blocked++;
            return;
          }
          spot.x = x;
          spot.y = y;
          steps++;
        });
        const walked = yield* Walked.writes;
        walked.steps += steps;
        walked.blocked += blocked;
      });
      const app = yield* App.make(
        App.define({ plugins: [Crowd], systems: [Walk] }),
        { hashEvery: 0 }
      );
      const ms = yield* measureEffect(
        () => app.tick(DT),
        TICKS.runs,
        TICKS.warmup
      );
      const { steps, blocked } = yield* app.read(Walked);
      if (steps === 0 || (ask && blocked === 0)) {
        throw new Error(
          `${steps} steps and ${blocked} blocked: nobody walked.`
        );
      }
      return ms;
    })
  );

const ROGUE: Size = [80, 50];
const COLONY: Size = [250, 250];

export const variants: Record<string, Variant> = {
  // Digging: one tile a tick, the most a game digs.
  tickBare: {
    unit: "matches",
    label: "app.tick: no map, no hash",
    run: () => digging(undefined, false),
  },
  dig80x50: {
    unit: "matches",
    label: "app.tick: one tile dug of 80 by 50, no hash",
    run: () => digging(ROGUE, false),
  },
  dig250x250: {
    unit: "matches",
    label: "app.tick: one tile dug of 250 by 250, no hash",
    run: () => digging(COLONY, false),
  },
  tickBareHashed: {
    unit: "matches",
    label: "app.tick: no map, hashed",
    run: () => digging(undefined, true),
  },
  digHashed80x50: {
    unit: "matches",
    label: "app.tick: one tile dug of 80 by 50, hashed",
    run: () => digging(ROGUE, true),
  },
  digHashed250x250: {
    unit: "matches",
    label: "app.tick: one tile dug of 250 by 250, hashed",
    run: () => digging(COLONY, true),
  },

  // A save, which a game makes now and then: one frame's hitch.
  saveBare: {
    unit: "matches",
    label: "Save.make and encode: no map",
    run: () => saving(undefined),
  },
  save80x50: {
    unit: "matches",
    label: "Save.make and encode: a map of 80 by 50, just dug",
    run: () => saving(ROGUE),
  },
  save250x250: {
    unit: "matches",
    label: "Save.make and encode: a map of 250 by 250, just dug",
    run: () => saving(COLONY),
  },

  // Asking: every creature looks at a tile beside it, every tick.
  walk1k80x50: {
    unit: "matches",
    label: "app.tick: 1,000 creatures step on 80 by 50",
    run: () => asking(1000, ...ROGUE, false),
  },
  ask1k80x50: {
    unit: "matches",
    label: "app.tick: 1,000 creatures ask, then step, on 80 by 50",
    run: () => asking(1000, ...ROGUE, true),
  },
  walk1k250x250: {
    unit: "matches",
    label: "app.tick: 1,000 creatures step on 250 by 250",
    run: () => asking(1000, ...COLONY, false),
  },
  ask1k250x250: {
    unit: "matches",
    label: "app.tick: 1,000 creatures ask, then step, on 250 by 250",
    run: () => asking(1000, ...COLONY, true),
  },
  walk10k250x250: {
    unit: "matches",
    label: "app.tick: 10,000 creatures step on 250 by 250",
    run: () => asking(10_000, ...COLONY, false),
  },
  ask10k250x250: {
    unit: "matches",
    label: "app.tick: 10,000 creatures ask, then step, on 250 by 250",
    run: () => asking(10_000, ...COLONY, true),
  },
};

/** Each variant that does the grid's work, and its baseline. */
const pairs: readonly (readonly [string, string])[] = [
  ["dig80x50", "tickBare"],
  ["dig250x250", "tickBare"],
  ["digHashed80x50", "tickBareHashed"],
  ["digHashed250x250", "tickBareHashed"],
  ["save80x50", "saveBare"],
  ["save250x250", "saveBare"],
  ["ask1k80x50", "walk1k80x50"],
  ["ask1k250x250", "walk1k250x250"],
  ["ask10k250x250", "walk10k250x250"],
];

/** Processes of each side of a pair. */
const PROCESSES = 5;

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[values.length >> 1]!;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const name = process.argv[2];
  if (name !== undefined) {
    const variant = variants[name];
    if (variant === undefined) {
      throw new Error(
        `bench/grid.ts is given the name of a variant, one of: ${Object.keys(variants).join(", ")}.`
      );
    }
    console.log(JSON.stringify(variant.run()));
  } else {
    const self = fileURLToPath(import.meta.url);
    const runOnce = (variant: string): number =>
      JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", self, variant], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .pop()!
      ) as number;
    const micros = (ms: number) => `${(ms * 1000).toFixed(1).padStart(8)} µs`;
    console.log(
      `Each side ${PROCESSES} processes, turn and turn about: the median of their medians, and their range.\n`
    );
    for (const [work, base] of pairs) {
      const runs = new Map<string, number[]>([
        [base, []],
        [work, []],
      ]);
      for (let i = 0; i < PROCESSES; i++) {
        for (const name of i % 2 === 0 ? [base, work] : [work, base]) {
          runs.get(name)!.push(runOnce(name));
        }
      }
      const without = runs.get(base)!;
      const withGrid = runs.get(work)!;
      const extra = median(withGrid) - median(without);
      const range = (values: readonly number[]) =>
        `${(Math.min(...values) * 1000).toFixed(1)} to ${(Math.max(...values) * 1000).toFixed(1)}`;
      console.log(variants[work]!.label);
      console.log(
        `  without ${micros(median(without))}  (${range(without)})  ${base}`
      );
      console.log(
        `  with    ${micros(median(withGrid))}  (${range(withGrid)})  ${work}`
      );
      console.log(
        `  grid    ${micros(extra)}  ${((extra / FRAME_MS) * 100).toFixed(2)}% of a 16.7 ms frame\n`
      );
    }
  }
}
