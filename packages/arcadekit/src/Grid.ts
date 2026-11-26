/**
 * A game on a grid: its map in a field of the world, and who is on a tile.
 *
 *   const Floor = Singleton.define(
 *     "rogue/Floor",
 *     { tiles: Grid.tiles(80, 50) },
 *     { tiles: Grid.fill(80, 50, WALL) }
 *   )
 *
 *   const floor = yield* Floor
 *   floor.tiles.at(3, 4)                                  // WALL
 *   (yield* Floor.writes).tiles = floor.tiles.with(3, 4, DOOR)
 *
 *   const here = Grid.occupants(floor.tiles, yield* Creatures)
 *   here.first(3, 4)                                      // who stands there
 *
 * A map is a `Grid.Tiles`: a number from 0 to 255 for each tile, in a field
 * of a singleton or a component, so a save holds it, the hash covers it, and a
 * rewind and a refused action put it back. It never changes in place: `with`
 * returns a new map, which the game writes to the field.
 *
 * Who is on a tile is worked out from the world when it is asked, by
 * `Grid.occupants`, and kept nowhere, so it is true after a move, a rewind, a
 * refused action and a load alike.
 */
import { Field } from "./ecs/component.ts";
import type { ComponentDef, Entity, FieldDef } from "./ecs/component.ts";
import type { QueryView } from "./ecs/query.ts";

const HEX = "0123456789abcdef";

/**
 * A map of tiles, a number from 0 to 255 for each, which `Grid.fill` and
 * `with` make. A tile is at a column `x` from 0 to `width - 1` and a row `y`
 * from 0 to `height - 1`.
 *
 * @category Models
 */
export interface Tiles {
  readonly width: number;
  readonly height: number;
  /** Returns whether `(x, y)` is a tile of the map. */
  inside(x: number, y: number): boolean;
  /** Returns the tile at `(x, y)`, and throws for a place off the map. */
  at(x: number, y: number): number;
  /**
   * Returns a map with the tile at `(x, y)` set to `value`, and the others as
   * they are. It throws for a place off the map, and for a value that is not
   * a whole number from 0 to 255.
   */
  with(x: number, y: number, value: number): Tiles;
}

class TileMap implements Tiles {
  readonly #cells: Uint8Array;
  #text: string | undefined;

  constructor(
    readonly width: number,
    readonly height: number,
    cells: Uint8Array
  ) {
    this.#cells = cells;
  }

  inside(x: number, y: number): boolean {
    return within(x, y, this.width, this.height);
  }

  at(x: number, y: number): number {
    return this.#cells[this.#index(x, y)]!;
  }

  with(x: number, y: number, value: number): Tiles {
    const index = this.#index(x, y);
    refuseValue(value);
    if (this.#cells[index] === value) {
      return this;
    }
    const cells = this.#cells.slice();
    cells[index] = value;
    return new TileMap(this.width, this.height, cells);
  }

  /** Two hex digits a tile, row by row: how a save holds it. Made once. */
  get text(): string {
    if (this.#text === undefined) {
      let text = "";
      for (const cell of this.#cells) {
        text += HEX[cell >> 4]! + HEX[cell & 15]!;
      }
      this.#text = text;
    }
    return this.#text;
  }

  #index(x: number, y: number): number {
    if (!this.inside(x, y)) {
      throw new Error(
        `(${x}, ${y}) is off a map of ${this.width} by ${this.height}. Ask tiles.inside(x, y) first.`
      );
    }
    return y * this.width + x;
  }
}

const within = (x: number, y: number, width: number, height: number) =>
  Number.isInteger(x) &&
  Number.isInteger(y) &&
  x >= 0 &&
  y >= 0 &&
  x < width &&
  y < height;

const refuseValue = (value: number): void => {
  if (!(Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new Error(
      `A tile is a whole number from 0 to 255, and ${value} is not one.`
    );
  }
};

const refuseSize = (width: number, height: number): void => {
  if (
    !(Number.isInteger(width) && width > 0) ||
    !(Number.isInteger(height) && height > 0)
  ) {
    throw new Error(
      `A map is a whole number of tiles wide and high, at least one each, and ${width} by ${height} is not.`
    );
  }
};

/**
 * Returns a map of `width` by `height` tiles, each `value`.
 *
 * @category Constructors
 */
export const fill = (width: number, height: number, value = 0): Tiles => {
  refuseSize(width, height);
  refuseValue(value);
  return new TileMap(width, height, new Uint8Array(width * height).fill(value));
};

/**
 * A field that holds a map of `width` by `height` tiles. A save holds it as
 * text, two hex digits a tile, and the hash covers it.
 *
 *   const Floor = Singleton.define(
 *     "rogue/Floor",
 *     { tiles: Grid.tiles(80, 50) },
 *     { tiles: Grid.fill(80, 50) }
 *   )
 *
 * **Gotchas**
 *
 * - A map of another size can be written to it, and a save of it is refused,
 *   naming the field.
 * - A change to one tile makes a new map, a copy of every tile, so change a
 *   few tiles at a time rather than many.
 *
 * @category Fields
 */
export const tiles = (width: number, height: number) => {
  refuseSize(width, height);
  return Field.ref<Tiles>({
    encode: (map) => {
      if (!(map instanceof TileMap)) {
        throw new Error("a map is made by Grid.fill, and changed by its with");
      }
      if (map.width !== width || map.height !== height) {
        throw new Error(
          `a map of ${map.width} by ${map.height} is in a field of ${width} by ${height}`
        );
      }
      return map.text;
    },
    decode: (data) => {
      if (
        typeof data !== "string" ||
        data.length !== width * height * 2 ||
        !/^[0-9a-f]*$/.test(data)
      ) {
        throw new Error(
          `a map of ${width} by ${height} is ${width * height * 2} hex digits`
        );
      }
      const cells = new Uint8Array(width * height);
      for (let i = 0; i < cells.length; i++) {
        cells[i] = Number.parseInt(data.slice(i * 2, i * 2 + 2), 16);
      }
      return new TileMap(width, height, cells);
    },
  });
};

/**
 * The four steps to the tiles beside one, as `[dx, dy]`: right, down, left
 * and up.
 *
 *   for (const [dx, dy] of Grid.sides) {
 *     if (tiles.inside(x + dx, y + dy)) ...
 *   }
 *
 * @category Constants
 */
export const sides: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * The terms of a query `Grid.occupants` takes: a component with an `x` and a
 * `y`, such as `Transform2d.Position` or a game's own, then any others.
 *
 * @category Type-level
 */
export type Located = readonly [
  ComponentDef<{
    readonly x: FieldDef<number, unknown>;
    readonly y: FieldDef<number, unknown>;
  }>,
  ...ComponentDef[],
];

/**
 * Who is on each tile of a map, as `Grid.occupants` found them.
 *
 * @category Models
 */
export interface Occupants {
  /** Returns the first entity on `(x, y)`, or undefined when there is none. */
  first(x: number, y: number): Entity | undefined;
  /** Returns the entities on `(x, y)`, in the order of the query, as a new array. */
  at(x: number, y: number): Entity[];
}

class Found implements Occupants {
  constructor(
    private readonly width: number,
    private readonly height: number,
    /** The first entity on each tile, as an index into `ids`, or -1. */
    private readonly heads: Int32Array,
    /** The next entity on the same tile, or -1. */
    private readonly next: Int32Array,
    private readonly ids: readonly Entity[]
  ) {}

  #head(x: number, y: number): number {
    return within(x, y, this.width, this.height)
      ? this.heads[y * this.width + x]!
      : -1;
  }

  first(x: number, y: number): Entity | undefined {
    const head = this.#head(x, y);
    return head === -1 ? undefined : this.ids[head];
  }

  at(x: number, y: number): Entity[] {
    const found: Entity[] = [];
    for (let i = this.#head(x, y); i !== -1; i = this.next[i]!) {
      found.push(this.ids[i]!);
    }
    return found;
  }
}

const read: (
  location: { readonly x: number; readonly y: number },
  ...rest: unknown[]
) => void = (location) => {
  places.push(location.x, location.y);
};
let places: number[] = [];

/**
 * Returns who is on each tile of `map`: the entities of `view`, by the `x`
 * and `y` of the query's first term.
 *
 *   const here = Grid.occupants(floor.tiles, yield* Creatures)
 *   const blocker = here.first(player.x + 1, player.y)
 *
 * **Details**
 *
 * - It reads where every entity is when it is called, and keeps nothing:
 *   ask again after a move, in the same system or the next, and it says
 *   where the entity is then. A rewind, a refused action and a load leave
 *   nothing behind to go stale.
 * - An entity whose `x` and `y` are not a tile of the map is on none.
 * - It costs about 30 ns for each entity of the query, so a move costs the
 *   next call that: about 30 µs for a thousand on a map of 80 by 50. It
 *   allocates for each call, and not for each lookup of `first`.
 *
 * **Gotchas**
 *
 * - A change query throws: it would visit only what changed.
 *
 * @category Utilities
 */
export const occupants = (
  map: { readonly width: number; readonly height: number },
  view: QueryView<Located>
): Occupants => {
  const { spec } = view;
  if ((spec.changedDefs?.length ?? 0) + (spec.addedDefs?.length ?? 0) > 0) {
    throw new Error(
      "Grid.occupants was given a change query, which would visit only what changed. Give it a query of every entity on the map."
    );
  }
  const { width, height } = map;
  const ids = view.entities();
  places = [];
  view.each(read);
  const heads = new Int32Array(width * height).fill(-1);
  const next = new Int32Array(ids.length);
  // From the last, so that each tile lists its entities in the query's order.
  for (let i = ids.length - 1; i >= 0; i--) {
    const x = places[i * 2]!;
    const y = places[i * 2 + 1]!;
    if (within(x, y, width, height)) {
      const tile = y * width + x;
      next[i] = heads[tile]!;
      heads[tile] = i;
    } else {
      next[i] = -1;
    }
  }
  return new Found(width, height, heads, next, ids);
};
