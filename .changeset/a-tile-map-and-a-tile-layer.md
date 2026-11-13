---
"arcadekit": minor
---

`arcadekit/core` gains `createTileMap`, a grid of cells in typed arrays with `neighbor` and `flood`; `arcadekit/render-three` gains `TileLayer`, which draws the cells on screen from a function of the cell, and `PixelCamera.groundOnScreen`. Nothing breaks.

Two games kept a grid of cells in typed arrays for their rules, and each wrote the same neighbour lookup and flood fill. Two views drew a floor of tiles around the camera, and each read the camera's edges, worked out which cells show and filled a sprite batch with them. Both are the kit's now, as plain code: no Effect, and nothing allocated in a step or in a frame.

- **`createTileMap(cols, rows, layout)`.** A level's static cells, stored as a pool's entities are: one typed array per field, `cells` long, with cell (col, row) at `row * cols + col`. `cellAt(col, row)` gives the cell or -1 off the map, and `colOf` and `rowOf` give them back. `neighbor(cell, side)` gives the cell on a `Side` (`west`, `east`, `north`, `south`, numbered 0 to 3, north the row above), or -1 off the map, and the neighbour of a cell off the map is -1. `flood(start, passes, reached)` marks `start` in `reached` with 1, then every cell joined to it by sides through cells `passes` accepts, and returns how many it marked. It does not enter a cell already marked, so two floods share a mask. The map keeps the queue a flood walks, so `neighbor` and `flood` allocate nothing and a step may call them. A number of columns or of rows that is not a whole number of 1 or more is a `RangeError`, and so is a `reached` mask shorter than the map.
- **`PixelCamera.groundOnScreen(out)`.** Writes the rectangle of ground the camera shows into a `MutableGroundBounds` the view keeps, and returns it as a `GroundBounds`. Call it after `follow` or `fit`.
- **`TileLayer`.** A grid of cells drawn from a sheet's frames in one draw call. `draw(seen, frameOf)` shows the cells that touch `seen`: cell (col, row) is the square of ground from (col, row) to (col + 1, row + 1), drawn at its centre with the frame `frameOf(col, row)` gives, and left empty for a negative one. It fills a batch of its own, which grows with the window, and fills it again only when `seen` touches other cells or after `invalidate()`. `tint` multiplies every tile's colours, `count` is the tiles of the last fill, and `mesh` goes in the scene. Its options are a batch's `unitsPerPixel` and `layer`. It imports nothing of the rules: a game with a tile map reads it in `frameOf`.
- **`drawnSprites`** (`arcadekit/render-three/testing`) takes a `TileLayer` as well as a batch, and gives the tiles of its last fill.

```ts
import { Side, createTileMap } from "arcadekit/core";
import { TileLayer } from "arcadekit/render-three";
import type {
  MutableGroundBounds,
  PixelCamera,
  SpriteSheet,
} from "arcadekit/render-three";

const WALL = 1;
const map = createTileMap(16, 9, { tile: Uint8Array });
const { tile } = map.fields;

// In the rules. Before: the column and the row worked out from the cell, and four bounds.
export const canMove = (cell: number, side: Side): boolean => {
  const target = map.neighbor(cell, side);
  return target !== -1 && tile[target] !== WALL;
};

// Before: a stack, a `reached` array and a loop over four offsets. The mask is cleared first:
// a flood enters no cell already marked, so one from a cell an earlier flood marked marks none.
const reached = new Uint8Array(map.cells);
const open = (cell: number): boolean => tile[cell] !== WALL;
export const roomFrom = (cell: number): number => {
  reached.fill(0);
  return map.flood(cell, open, reached);
};

// In the view. Before: the camera's four edges, floored, a loop over the cells between them
// and a compare with the window last filled.
export const makeGround = (sheet: SpriteSheet, camera: PixelCamera) => {
  const ground = new TileLayer(sheet);
  const seen: MutableGroundBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  const frameOf = (col: number, row: number): number => {
    const cell = map.cellAt(col, row);
    return cell === -1 ? -1 : tile[cell]!;
  };
  return {
    mesh: ground.mesh,
    draw: (x: number, z: number): void => {
      camera.follow(x, z);
      ground.draw(camera.groundOnScreen(seen), frameOf);
    },
  };
};
```

Both genres use them. Push-puzzle's level is a tile map: its rules ask `neighbor` for the cell a move goes to, and its parser floods from the player to find what is outside the walls. Its view draws the board and the menu's floor with one `TileLayer`, dimmed for the menu with `tint`. Survivors' ground is a `TileLayer` that asks which of the arena's tiles a cell shows, and its dirt patches, which are no cells, are a small batch of their own.

**Breaking**

- Nothing in the published package: every export is new, and `drawnSprites` takes what it took.
- Not in the published package: `@arcadekit/push-puzzle`'s exported `Puzzle` has `map` in place of `cols`, `rows`, `tiles` and `goals` (`map.fields.tile` and `map.fields.goal`), and its view draws the board with its corner at the origin, a cell's centre at (col + 0.5, row + 0.5), where the board was centred on the origin. It lands on the same pixels: the camera fits the board where it now is.

No recorded hash moved: survivors' rules are untouched, and push-puzzle's replay ends in the state it recorded.
