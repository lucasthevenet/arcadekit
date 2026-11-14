---
"arcadekit": minor
---

`arcadekit/core` gains `TileMap`, a grid of cells in typed arrays with `TileMap.neighbor` and `TileMap.flood` (0.7.0's names: see the changeset that gives core Effect's module shape); `arcadekit/render-three` gains `TileLayer`, which draws the cells on screen from a function of the cell, and `PixelCamera.groundOnScreen` (0.7.0's names: see the changeset that gives render-three Effect's module shape). Nothing breaks.

Two games kept a grid of cells in typed arrays for their rules, and each wrote the same neighbour lookup and flood fill. Two views drew a floor of tiles around the camera, and each read the camera's edges, worked out which cells show and filled a sprite batch with them. Both are the kit's now, as plain code: no Effect, and nothing allocated in a step or in a frame.

- **`TileMap.make(cols, rows, layout)`.** A level's static cells, stored as a pool's entities are: one typed array per field, `cells` long, with cell (col, row) at `row * cols + col`. `TileMap.cellAt(map, col, row)` gives the cell or -1 off the map, and `TileMap.colOf` and `TileMap.rowOf` give them back. `TileMap.neighbor(map, cell, side)` gives the cell on a `TileMap.Side` (`west`, `east`, `north`, `south`, numbered 0 to 3, north the row above), or -1 off the map, and the neighbour of a cell off the map is -1. `TileMap.flood(map, start, passes, reached)` marks `start` in `reached` with 1, then every cell joined to it by sides through cells `passes` accepts, and returns how many it marked. It does not enter a cell already marked, so two floods share a mask. The map keeps the queue a flood walks, so `TileMap.neighbor` and `TileMap.flood` allocate nothing and a step may call them. A number of columns or of rows that is not a whole number of 1 or more is a `RangeError`, and so is a `reached` mask shorter than the map.
- **`PixelCamera.groundOnScreen(camera, out)`.** Writes the rectangle of ground the camera shows into a `Camera.MutableGroundBounds` the view keeps, and returns it as a `Camera.GroundBounds`. Call it after `follow` or `fit`.
- **`TileLayer`.** A grid of cells drawn from a sheet's frames in one draw call. `TileLayer.draw(layer, seen, frameOf)` shows the cells that touch `seen`: cell (col, row) is the square of ground from (col, row) to (col + 1, row + 1), drawn at its centre with the frame `frameOf(col, row)` gives, and left empty for a negative one. It fills a batch of its own, which grows with the window, and fills it again only when `seen` touches other cells or after `TileLayer.invalidate(layer)`. `tint` multiplies every tile's colours, `count` is the tiles of the last fill, and `mesh` goes in the scene. Its options are a batch's `unitsPerPixel` and `layer`. It imports nothing of the rules: a game with a tile map reads it in `frameOf`.
- **`DrawnSprites.read`** (`arcadekit/render-three/testing`) takes a `TileLayer` as well as a batch, and gives the tiles of its last fill.

```ts
import { TileMap } from "arcadekit/core";
import { PixelCamera, TileLayer } from "arcadekit/render-three";
import type { Camera, SpriteSheet } from "arcadekit/render-three";

const WALL = 1;
const map = TileMap.make(16, 9, { tile: Uint8Array });
const { tile } = map.fields;

// In the rules. Before: the column and the row worked out from the cell, and four bounds.
export const canMove = (cell: number, side: TileMap.Side): boolean => {
  const target = TileMap.neighbor(map, cell, side);
  return target !== -1 && tile[target] !== WALL;
};

// Before: a stack, a `reached` array and a loop over four offsets. The mask is cleared first:
// a flood enters no cell already marked, so one from a cell an earlier flood marked marks none.
const reached = new Uint8Array(map.cells);
const open = (cell: number): boolean => tile[cell] !== WALL;
export const roomFrom = (cell: number): number => {
  reached.fill(0);
  return TileMap.flood(map, cell, open, reached);
};

// In the view. Before: the camera's four edges, floored, a loop over the cells between them
// and a compare with the window last filled.
export const makeGround = (
  sheet: SpriteSheet.SpriteSheet,
  camera: PixelCamera.PixelCamera
) => {
  const ground = TileLayer.make(sheet);
  const seen: Camera.MutableGroundBounds = {
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
  };
  const frameOf = (col: number, row: number): number => {
    const cell = TileMap.cellAt(map, col, row);
    return cell === -1 ? -1 : tile[cell]!;
  };
  return {
    mesh: ground.mesh,
    draw: (x: number, z: number): void => {
      PixelCamera.follow(camera, x, z);
      TileLayer.draw(ground, PixelCamera.groundOnScreen(camera, seen), frameOf);
    },
  };
};
```

Both genres use them. Push-puzzle's level is a tile map: its rules ask `TileMap.neighbor` for the cell a move goes to, and its parser floods from the player to find what is outside the walls. Its view draws the board and the menu's floor with one `TileLayer`, dimmed for the menu with `tint`. Survivors' ground is a `TileLayer` that asks which of the arena's tiles a cell shows, and its dirt patches, which are no cells, are a small batch of their own.

**Breaking**

- Nothing in the published package: every export is new, and `DrawnSprites.read` takes what it took.
- Not in the published package: `@arcadekit/push-puzzle`'s exported `World.Puzzle` has `map` in place of `cols`, `rows`, `tiles` and `goals` (`map.fields.tile` and `map.fields.goal`), and its view draws the board with its corner at the origin, a cell's centre at (col + 0.5, row + 0.5), where the board was centred on the origin. It lands on the same pixels: the camera fits the board where it now is.

No recorded hash moved: survivors' rules are untouched, and push-puzzle's replay ends in the state it recorded.
