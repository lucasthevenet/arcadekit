# Testing a view

`arcadekit/render-three/testing` runs a view's drawing in Node, with no WebGL. `TestSpriteSheet.fromTags(tags)` is a sheet with the tags a test names, each with its number of 16 px frames of 100 ms, and an image that is only a size. `DrawnSprites.read(batch)` is every sprite a batch shows, in the order pushed: its position as pushed, its frame and the tag that holds it, its flip, tint, flash, lift and layer. Given a tile layer, it is every tile of the layer's last fill, each at its cell's centre. So a test draws a frame with its view and reads what the view's batches and layers show, and knows nothing of how a batch stores it. The rounding of a position is the shader's, so a test holds which one a batch was made with by its `snap`.

Two more check the sheet a game ships, from the bytes of its PNG: `Png.size(png)` is its width and height, which the sheet's JSON must match, and `Png.framesWithSoftAlpha(png, data, blended?)` names every frame with a pixel that is neither clear nor opaque. A batch draws opaque unless it is made `transparent`, cutting out pixels below half alpha, so such a frame will not look as it was painted; the tags a view draws blended, such as a soft shadow, go in `blended`. It reads an 8-bit RGBA PNG without interlacing, and throws for any other. `arcadekit/render-three/testing` imports `node:zlib` for it, so only a test or a script can import it.

```ts
import { InstancedSprites, SpriteSheet } from "arcadekit/render-three";
import {
  DrawnSprites,
  Png,
  TestSpriteSheet,
} from "arcadekit/render-three/testing";

const BOARD_TAGS = {
  floor: "floor",
  idle: "player/idle",
  shadow: "shadow",
} as const;

/** A view's drawing, cut down to a floor tile and the player on it. */
class BoardSprites {
  readonly batch: InstancedSprites.InstancedSprites;
  private readonly sheet: SpriteSheet.SpriteSheet;
  private readonly tags: SpriteSheet.ResolvedTags<typeof BOARD_TAGS>["tags"];

  constructor(sheet: SpriteSheet.SpriteSheet) {
    this.sheet = sheet;
    this.tags = SpriteSheet.resolveTags(sheet.data, BOARD_TAGS).tags;
    this.batch = InstancedSprites.make(sheet);
  }

  draw(playerX: number, time: number): void {
    const { batch, tags } = this;
    const idle = SpriteSheet.frameAt(this.sheet.data, tags.idle, time);
    InstancedSprites.begin(batch);
    InstancedSprites.push(batch, playerX, 0, tags.floor.from);
    InstancedSprites.push(batch, playerX, 0, idle, true);
    InstancedSprites.end(batch);
  }
}

// A sheet with these tags and numbers of frames. No image, no WebGL.
const view = new BoardSprites(
  TestSpriteSheet.fromTags({ floor: 3, "player/idle": 2, shadow: 1 })
);
view.draw(2, 0.15);

// In a test: `expect(drawn).toStrictEqual(["floor at 2", "player/idle at 2, flipped"])`.
export const drawn = DrawnSprites.read(view.batch).map(
  (sprite) => `${sprite.tag} at ${sprite.x}${sprite.flipX ? ", flipped" : ""}`
);

// The sheet the game ships, from its files: `data` is its decoded JSON, and `png` the bytes
// of its image, as `readFileSync` gives them. In a test, each is `toStrictEqual` the value
// beside it.
export const checkSheet = (data: SpriteSheet.Data, png: Uint8Array) => ({
  // Every tag the view draws: []
  missing: SpriteSheet.resolveTags(data, BOARD_TAGS).missing,
  // { width: data.width, height: data.height }
  size: Png.size(png),
  // The shadow is drawn blended, so its soft edge is meant: []
  soft: Png.framesWithSoftAlpha(png, data, ["shadow"]),
});
```
