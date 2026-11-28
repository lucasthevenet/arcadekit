---
title: "Grids"
description: "A game on a grid keeps its map in a field of the world with Grid.tiles, and asks who is on a tile with Grid.occupants."
---

A **grid** is a game played on tiles, such as a roguelike or a puzzle. `Grid` gives it two things: a map of tiles kept in the world, and an answer to who is on a tile, worked out from the world when it is asked. A save holds the map, the hash covers it, and a rewind and a refused action put it back. Nothing of who is where is kept apart from the world, so it can't go stale.

## Keep a map

```ts
import { Action, Field, Grid, Singleton } from "arcadekit";
import { Schema } from "effect";

const WALL = 1;
const FLOOR = 0;

export const Floor = Singleton.define(
  "rogue/Floor",
  { tiles: Grid.tiles(80, 50) },
  { tiles: Grid.fill(80, 50, WALL) }
);

const Dig = Action.define(
  "rogue/Dig",
  Schema.Struct({ x: Schema.Int, y: Schema.Int })
);

export const dig = Action.handler(Dig, function* ({ x, y }) {
  const floor = yield* Singleton.Write(Floor);
  if (floor.tiles.inside(x, y)) {
    floor.tiles = floor.tiles.with(x, y, FLOOR);
  }
});

export const Explored = Singleton.define(
  "rogue/Explored",
  { seen: Grid.tiles(80, 50), turn: Field.u32 },
  { seen: Grid.fill(80, 50), turn: 0 }
);
```

`Grid.tiles(width, height)` is a field that holds a `Grid.Tiles`: a number from 0 to 255 for each tile, a column `x` from 0 to `width - 1` and a row `y` from 0 to `height - 1`. Give it to a singleton or a component, beside any other fields. `Grid.fill(width, height, value)` makes a map with every tile the same.

| Of a map | Does |
| --- | --- |
| `tiles.at(x, y)` | Returns the tile, and throws off the map |
| `tiles.inside(x, y)` | Returns whether `(x, y)` is a tile of the map |
| `tiles.with(x, y, value)` | Returns a new map with that tile changed |
| `Grid.sides` | The steps to the four tiles beside one, `[dx, dy]` |

A map never changes in place. `with` returns a new one, and the game writes it to the field, so a refused action leaves the old map where it was. A change makes a copy of every tile, so change a few tiles at a time, not the whole map one tile at a time.

## Ask who is on a tile

```ts
import { Action, Component, Field, Grid, Query, Singleton } from "arcadekit";
import { Schema } from "effect";

const Floor = Singleton.define(
  "rogue/Floor",
  { tiles: Grid.tiles(80, 50) },
  { tiles: Grid.fill(80, 50) }
);
const Pos = Component.define("rogue/Pos", { x: Field.i32, y: Field.i32 });
const Player = Component.tag("rogue/Player");

const Creatures = Query.all(Pos);
const Players = Query.all(Pos).pipe(Query.with(Player), Query.writes(Pos));

class Blocked extends Schema.TaggedError<Blocked>()("RogueBlocked", {}) {}

const Step = Action.define(
  "rogue/Step",
  Schema.Struct({ dx: Schema.Int, dy: Schema.Int }),
  { error: Blocked }
);

export const step = Action.handler(Step, function* ({ dx, dy }) {
  const { tiles } = yield* Singleton.Read(Floor);
  const here = Grid.occupants(tiles, yield* Query.View(Creatures));
  const [pos] = (yield* Query.View(Players)).single();
  if (here.first(pos.x + dx, pos.y + dy) !== undefined) {
    return yield* Blocked.make({});
  }
  pos.x += dx;
  pos.y += dy;
});
```

`Grid.occupants(tiles, view)` finds who is on each tile of the map: the entities of a query, by the `x` and `y` of its first term, which can be `Transform2d.Position` or a component of the game's own. `here.first(x, y)` returns the first of them on a tile, and `here.at(x, y)` all of them, in the order of the query. An entity whose `x` and `y` aren't a tile of the map is on none.

- It reads where every entity is when it is called, and keeps nothing. A move after it isn't in what it returned: ask again, in the same system or the next, and it says where the entity is now.
- A rewind, a refused action and a load leave nothing behind to go stale, since there is nothing to keep up to date.
- It costs about 30 ns for each entity of the query, every call: about 30 µs for a thousand creatures on a map of 80 by 50. Ask once per system, and pass the answer around.
- A change query throws, since it would visit only what changed.
