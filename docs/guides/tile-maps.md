# Tile maps

A level's static cells, such as wall, floor and hole, are a **tile map**: `TileMap.make(cols, rows, layout)` makes a grid with one typed array per field, as a pool's entities have, and cell (col, row) is at `row * cols + col` in each. A tile is a number in a field, not an object. The map says what the level is, not where entities are: those are in pools, and a spatial grid finds them.

| Field or function | What it gives |
| --- | --- |
| `map.cols`, `map.rows`, `map.cells` | The map's size, and `cols * rows`: the length of every field |
| `map.fields` | One typed array per field of the layout, every cell 0 when made |
| `TileMap.cellAt(map, col, row)` | The cell at a column and a row, or -1 off the map |
| `TileMap.colOf(map, cell)`, `TileMap.rowOf(map, cell)` | A cell's column and its row |
| `TileMap.neighbor(map, cell, side)` | The cell next to `cell` on a `TileMap.Side`, or -1 off the map |
| `TileMap.flood(map, start, passes, reached)` | Marks in `reached` the cells joined to `start` through cells `passes` accepts, and returns how many |

```ts
import { TileMap } from "arcadekit/core";

/** What a cell of the track is. */
const Tile = { grass: 0, road: 1, barrier: 2 } as const;

const TRACK_LAYOUT = {
  /** A `Tile`. */
  tile: Uint8Array,
  /** 1 where a coin lies. */
  coin: Uint8Array,
};

interface Race {
  readonly track: TileMap.TileMap<typeof TRACK_LAYOUT>;
  /** The cell the car is on. */
  car: number;
  coins: number;
  /** How many cells of road the car can still drive to. */
  open: number;
  /** Scratch the step owns: 1 for each of those cells, and the test a flood asks of a cell. */
  readonly reached: Uint8Array;
  readonly isRoad: (cell: number) => boolean;
}

/** A track of grass, for the level to lay its road and its coins on. */
const createRace = (cols: number, rows: number): Race => {
  const track = TileMap.make(cols, rows, TRACK_LAYOUT);
  const { tile } = track.fields;
  return {
    track,
    car: 0,
    coins: 0,
    open: 0,
    reached: new Uint8Array(track.cells),
    // Made once, with the mask: a flood in a step makes no closure.
    isRoad: (cell) => tile[cell] === Tile.road,
  };
};

/** In the step: drives the car one cell to `side` if that cell is road, and takes its coin. */
const drive = (race: Race, side: TileMap.Side) => {
  const { track } = race;
  const { tile, coin } = track.fields;
  const target = TileMap.neighbor(track, race.car, side);
  // -1 past the edge of the track.
  if (target === -1 || tile[target] !== Tile.road) {
    return;
  }
  race.car = target;
  race.coins += coin[target]!;
  coin[target] = 0;
};

/** In the step: a barrier falls on a cell, and the race counts the road the car has left. */
const dropBarrier = (race: Race, col: number, row: number) => {
  const { track, reached } = race;
  const cell = TileMap.cellAt(track, col, row);
  if (cell === -1) {
    return;
  }
  track.fields.tile[cell] = Tile.barrier;
  reached.fill(0);
  race.open = TileMap.flood(track, race.car, race.isRoad, reached);
};

const race = createRace(12, 8);
drive(race, TileMap.Side.east);
dropBarrier(race, 5, 3);
```

- **A `TileMap.Side` is `TileMap.Side.west`, `east`, `north` or `south`**, numbered 0 to 3 in that order, and north is the row above. `neighbor` gives -1 at the map's edge, and the neighbour of -1, or of any other cell off the map, is -1, so one lookup can follow another.
- **A column, a row and a cell are whole numbers.** A position on the ground is floored before `cellAt` is asked: given a fraction, it gives no cell and not -1 either.
- **`flood` marks `start` with 1, then every cell joined to it by sides through cells `passes` accepts**, and returns how many it marked. It does not enter a cell already marked, so two floods share a mask, and a flood from a marked cell marks nothing. Nor does one from a cell off the map. `start` itself is marked whatever `passes` says of it.
- **`neighbor` and `flood` allocate nothing**, so a step may call them: the map keeps the queue a flood walks, made once, and the step keeps `passes` as it keeps `reached`, which is `cells` long or longer. `passes` must not flood the same map.
- **A field the rules write is state**, as push-puzzle's tiles are: a box fills a hole, and the cell is floor from then on. A game with a state hash lists such a field. A field written once, when the level is read, changes no run, and no hash needs it.
- **A view draws one with a tile layer** ([`arcadekit/render-three`](tile-layers.md)), which asks a function of the cell and never names the map.
- **It refuses what it can't index**, with a `RangeError`: a number of columns or of rows that is not a whole number of 1 or more, and a `reached` mask shorter than the map's `cells`, whose missing cells a flood could neither read nor mark.
