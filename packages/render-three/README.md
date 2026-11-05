# @arcadekit/render-three

Three.js drawing for arcadekit games. `Stage` is a renderer, scene and camera that fill an element and resize with it; its `"pixel"` camera (`PixelCamera`) looks straight down and keeps sprite pixels whole. `loadSpriteSheet` loads an Aseprite sheet (PNG and JSON) as an Effect, `InstancedSprites` draws many sprites from one sheet in one draw call, and `frameAt` picks a tag's frame at a time.

Part of [arcadekit](https://github.com/lucasthevenet/arcadekit#readme). Needs the DOM and WebGL.

## Install

```bash
pnpm add @arcadekit/render-three three effect
pnpm add -D @types/three
```

Peer dependencies: `three` (^0.187) and `effect` (~4.1). `@types/three` (^0.187, an optional peer) gives Three.js its types.

## Example

A view that draws every enemy with its tag's animation, following the hero (a cut-down version of the genres' views). The app loads the sheet with `loadSpriteSheet("/sprites/game.json")` and owns it: the view never frees it.

```ts
import { InstancedSprites, Stage, frameAt } from "@arcadekit/render-three";
import type { SpriteSheet } from "@arcadekit/render-three";

interface World {
  readonly heroX: number;
  readonly heroZ: number;
  readonly enemies: {
    readonly count: number;
    readonly x: Float32Array;
    readonly z: Float32Array;
  };
}

export class WorldView {
  private readonly stage: Stage<"pixel">;
  private readonly enemies: InstancedSprites;
  private readonly sheet: SpriteSheet;

  constructor(container: HTMLElement, sheet: SpriteSheet) {
    this.sheet = sheet;
    this.stage = new Stage(container, {
      camera: "pixel",
      pixelsPerUnit: 16,
      background: "#17151f",
    });
    this.enemies = new InstancedSprites(sheet, {
      capacity: 1000,
      unitsPerPixel: 1 / 16,
    });
    this.stage.scene.add(this.enemies.mesh);
  }

  render(world: World | null, timeSeconds: number): void {
    const walk = this.sheet.data.tags.get("slime/move");
    if (world !== null && walk !== undefined) {
      const frame = frameAt(this.sheet.data, walk, timeSeconds);
      for (let i = 0; i < world.enemies.count; i++) {
        this.enemies.set(i, world.enemies.x[i]!, world.enemies.z[i]!, frame);
      }
      this.enemies.commit(world.enemies.count);
      this.stage.camera.follow(world.heroX, world.heroZ);
    }
    this.stage.render();
  }

  dispose(): void {
    // Frees everything in the scene except the sheet's texture, which the app frees.
    this.stage.dispose();
  }
}
```

See [ADR-0015](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md) (pixel-art sprites loaded by the app).
