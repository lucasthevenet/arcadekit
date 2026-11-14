# Tile layers

A floor of tiles is a grid of cells, and a view draws only the ones on screen. A tile layer does it in one draw call: each frame the view gives `TileLayer.draw` the rectangle of ground its camera shows and a function that says which frame a cell shows. `PixelCamera.groundOnScreen(camera, out)` writes that rectangle into an object the view keeps, after `follow` or `fit`.

Cell (col, row) is the square of ground from (col, row) to (col + 1, row + 1), and its tile is drawn at its centre. `frameOf(col, row)` gives a frame's index, as `SpriteSheet.frameAt` does, or a negative number for a cell with no tile. The layer imports nothing of the rules: a game whose level is a [tile map](tile-maps.md) reads it in that function, where `TileMap.cellAt` gives -1 for a cell off the map, and a game whose ground is a rule of the cell alone, such as an arena's wall, works the frame out there.

```ts
import { TileMap } from "arcadekit/core";
import {
  PixelCamera,
  SpriteSheet,
  Stage,
  TileLayer,
} from "arcadekit/render-three";
import type { Camera } from "arcadekit/render-three";

/** The track as the rules hold it. */
const TRACK_LAYOUT = {
  /** 1 where a cell is road, and 0 where it is grass. */
  tile: Uint8Array,
};
type Track = TileMap.TileMap<typeof TRACK_LAYOUT>;

interface Race {
  readonly track: Track;
  readonly carX: number;
  readonly carZ: number;
}

const TRACK_TAGS = { grass: "track/grass", road: "track/road" } as const;

export class TrackView {
  private readonly stage: Stage.Stage<"pixel">;
  private readonly ground: TileLayer.TileLayer;
  private readonly tags: SpriteSheet.ResolvedTags<typeof TRACK_TAGS>["tags"];
  /** The ground the camera shows: one object, filled each frame. */
  private readonly seen: Camera.MutableGroundBounds = {
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
  };
  /** The track being drawn. */
  private track: Track | null = null;

  /**
   * Which frame a cell shows, or -1 for none. Kept as a field: an arrow written in the call
   * to `draw` would be a new closure on every frame.
   */
  private readonly frameOf = (col: number, row: number): number => {
    const { tags, track } = this;
    if (track === null) {
      return -1;
    }
    const cell = TileMap.cellAt(track, col, row);
    // Off the track: no tile, and the stage's background shows.
    if (cell === -1) {
      return -1;
    }
    return track.fields.tile[cell] === 1 ? tags.road.from : tags.grass.from;
  };

  constructor(container: HTMLElement, sheet: SpriteSheet.SpriteSheet) {
    this.tags = SpriteSheet.resolveTags(sheet.data, TRACK_TAGS).tags;
    this.stage = Stage.make(container, {
      camera: "pixel",
      pixelsPerUnit: 16,
      background: "#17151f",
    });
    // 16 px frames, one to a cell, under everything else.
    this.ground = TileLayer.make(sheet);
    this.stage.scene.add(this.ground.mesh);
  }

  render(race: Race | null): void {
    if (race !== null) {
      const { camera } = this.stage;
      if (this.track !== race.track) {
        // Another run's track: what `frameOf` gives has changed.
        this.track = race.track;
        TileLayer.invalidate(this.ground);
      }
      PixelCamera.follow(camera, race.carX, race.carZ);
      TileLayer.draw(
        this.ground,
        PixelCamera.groundOnScreen(camera, this.seen),
        this.frameOf
      );
    }
    Stage.render(this.stage);
  }

  dispose(): void {
    // Frees the layer with the rest of the scene, and never the sheet's texture.
    Stage.dispose(this.stage);
  }
}
```

- **A fill asks `frameOf` once for each cell that touches the rectangle**, row by row, and pushes a tile for each frame that is not negative into a batch of the layer's own, which grows with the window. A cell that shares only an edge with the rectangle is left out.
- **It fills only when the rectangle touches other cells than at the last fill**: when an edge of it crosses into another cell. A camera whose edges stay within the same cells costs the layer nothing, and its batch keeps showing its last fill. A rectangle that is not a whole number of cells wide has edges that cross at different places, so a camera moving one cell east can fill twice on the way.
- **`TileLayer.invalidate(layer)` makes the next `draw` fill again**, for when what `frameOf` gives has changed: another level, a tile the rules changed, an animated tile's next frame, or another function handed to `draw`. The layer is told of none of them, and compares no functions. A board small enough to fill on every frame, as push-puzzle's is, invalidates before each `draw`.
- **`tint` multiplies every tile's colours**, as a batch's `setTint` does one sprite's: a dimmed floor behind a menu. It is white when the layer is made, and a change shows from the next fill, so invalidate after it.
- **`count` is the tiles the last fill drew**, and `mesh` is what goes in the scene. The options are a batch's `unitsPerPixel` (1/16 unless told: a 16 px frame fills a cell) and `layer` (0 unless told), and a layer rounds to sprite pixels, as the ground of every other batch does.
- **What is no cell is no tile.** Something larger than a cell or between two, such as a patch of dirt three cells wide, goes in a batch of sprites of its own in a layer above.
