# arcadekit/render-three

Three.js drawing for arcadekit games. A `Stage` is a renderer, scene and camera that fill an element and resize with it; its `"pixel"` camera (a `PixelCamera`) looks straight down and keeps sprite pixels whole. `SpriteSheet.fromUrl` loads an Aseprite sheet (PNG and JSON) as an Effect, `SpriteSheet.resolveTags` picks each tag a view draws, with its fallbacks, and `SpriteSheet.frameAt` picks a tag's frame at a time. `InstancedSprites` draws many sprites from one sheet in one draw call and grows when a frame needs more room, `TileLayer` draws a grid of cells from the same sheet, only the cells the camera shows, and a `Gait` says whether a character a view draws is walking. `MeshInstances` draws one mesh many times, each copy with a matrix, a color and the attributes its view declares, and `Camera` places a 3D stage's camera over the ground. `arcadekit/render-three/testing` has what a view's tests need, and only tests import it.

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM and WebGL.

## Install

```bash
pnpm add arcadekit three effect
pnpm add -D @types/three
```

Peer dependencies: `effect` (~4.1), and `three` (^0.187, an optional peer of the package that this entry needs). `@types/three` (^0.187, also optional) gives Three.js its types.

Loading a sheet is an Effect, with a typed error. Drawing runs none: a view draws inside the frame the browser shows, so its calls are plain, and the engine makes and disposes the view around them.

## Its modules

Each module is a namespace, written as a module of Effect is: a data type named after it, its `make`, a guard, and functions that take the value first.

| Namespace | What it holds | Guide |
| --- | --- | --- |
| [`Stage`](stage.ts) | A renderer, a scene and a camera that fill an element and resize with it | [Stages and cameras](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/stages-and-cameras.md) |
| [`PixelCamera`](pixel-camera.ts) | A camera that looks straight down and keeps sprite pixels whole, with the arithmetic of its pixel scale | [Stages and cameras](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/stages-and-cameras.md#cameras) |
| [`Camera`](camera.ts) | Where a 3D stage's camera goes: following, circling or fitting a rectangle of ground | [Stages and cameras](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/stages-and-cameras.md#cameras) |
| [`SpriteSheet`](sprite-sheet.ts) | A sheet's frames and tags, its image as a texture, its load, and the frame a tag shows at a time | [Sprites](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/sprites.md) |
| [`InstancedSprites`](instanced-sprites.ts) | A batch of sprites from one sheet, drawn in one draw call | [Sprites](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/sprites.md#a-batch-of-sprites) |
| [`TileLayer`](tile-layer.ts) | A grid of cells drawn from a sheet, only the cells on screen | [Tile layers](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/tile-layers.md) |
| [`Gait`](gait.ts) | Whether a character a view draws is walking | [Sprites](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/sprites.md#walking) |
| [`MeshInstances`](mesh-instances.ts) | Copies of one mesh, drawn in one draw call | [Mesh instances](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/mesh-instances.md) |
| `TestSpriteSheet`, `DrawnSprites`, `Png` | In `arcadekit/render-three/testing`: a sheet with no image, what a batch or a tile layer shows, and two checks of a sheet's PNG | [Testing a view](https://github.com/lucasthevenet/arcadekit/blob/main/docs/testing/views.md) |

## Example

A pixel stage that draws one coin from a sheet the app has loaded. A function of a value takes it first, and with one argument less gives the function a `pipe` applies: `InstancedSprites.setLayer(sprites, coin, 1)`, or `sprites.pipe(InstancedSprites.setLayer(coin, 1))`.

```ts
import { InstancedSprites, SpriteSheet, Stage } from "arcadekit/render-three";

const COIN_TAGS = { coin: "coin/spin" } as const;

export const drawCoin = (
  container: HTMLElement,
  sheet: SpriteSheet.SpriteSheet,
  timeSeconds: number
): Stage.Stage<"pixel"> => {
  const stage = Stage.make(container, { camera: "pixel", pixelsPerUnit: 16 });
  const sprites = InstancedSprites.make(sheet);
  stage.scene.add(sprites.mesh);
  const { tags } = SpriteSheet.resolveTags(sheet.data, COIN_TAGS);
  InstancedSprites.begin(sprites);
  const coin = InstancedSprites.push(
    sprites,
    0,
    0,
    SpriteSheet.frameAt(sheet.data, tags.coin, timeSeconds)
  );
  sprites.pipe(InstancedSprites.setLayer(coin, 1));
  InstancedSprites.end(sprites);
  Stage.render(stage);
  return stage;
};
```
