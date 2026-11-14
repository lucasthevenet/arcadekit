---
"arcadekit": minor
---

`arcadekit/render-three` and `arcadekit/render-three/testing` are written as Effect's modules are ([ADR-0024](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0024-the-kit-is-written-as-effect-modules.md)). Each module is a namespace: `Stage`, `PixelCamera`, `Camera`, `SpriteSheet`, `InstancedSprites`, `TileLayer`, `Gait` and `MeshInstances`, and in the testing entry `TestSpriteSheet`, `DrawnSprites` and `Png`. A stage, a pixel camera, a sheet, a batch, a tile layer, a gait and mesh instances are values on a prototype, with a `TypeId`, an `isX` guard, `pipe` and a printed form, made with their module's `make` and changed by functions that take them first. **Breaking**: every export is renamed or reshaped, and a pixel stage's camera is no Three.js camera.

Loading a sheet is an Effect, as it was, and drawing is plain, as it was: a view draws inside the frame the browser shows. What changed besides the names:

- **A pixel camera holds the Three.js camera it places.** `PixelCamera.PixelCamera` is no `THREE.OrthographicCamera`: its `camera` field is, and only `PixelCamera`'s functions move it (`follow`, `fit`, `setViewHeight`, `setBufferSize`). `Camera.fit` and a Three.js `lookAt`, which undo its snapping, no longer take it. A stage made with `camera: "pixel"` renders with it, and its `viewHeight` is a field.
- **Sprite loading is one module with the sheet.** `SpriteSheet.fromUrl` loads, `SpriteSheet.decode` decodes a sheet's JSON, and `SpriteSheet.dispose` frees a sheet, which was a closure on it: a game's asset writes `release: SpriteSheet.dispose`. The sheet's decoded JSON is `SpriteSheet.Data`, its frames and tags `SpriteSheet.Frame` and `SpriteSheet.Tag`.
- **A response that isn't a success fails the load with a `SpriteSheetError`, not a throw caught as one.** Its message is as it was. A load is traced as `SpriteSheet.fromUrl`, and a decode as `SpriteSheet.decode`.
- **An interrupted load closes the image it was decoding.** A decode can't be stopped, so the bitmap it makes after the load was interrupted is closed when it arrives; it was dropped open.
- **`SpriteSheetError` is a `Schema.TaggedError`**, with the same tag, `file`, `message` and `cause`: `SpriteSheet.SpriteSheetError`. An app's `Effect.catchTag("SpriteSheetError", ...)` is as it was.
- **A refusal names the function**: `InstancedSprites.make: a capacity of NaN is no number of sprites...`, `MeshInstances.make: the attribute "position"...`, `Png.framesWithSoftAlpha reads an 8-bit RGBA PNG...`.

```ts
import { Asset } from "arcadekit/content";
import {
  InstancedSprites,
  PixelCamera,
  SpriteSheet,
  Stage,
} from "arcadekit/render-three";

// Before: Asset<SpriteSheet, SpriteSheetError>, and `release: (sheet) => sheet.dispose()`.
export class RaceSheet extends Asset<
  SpriteSheet.SpriteSheet,
  SpriteSheet.SpriteSheetError
>()("RaceSheet", { release: SpriteSheet.dispose }) {}

// Before: RaceSheet.layer(loadSpriteSheet("/sprites/race.json")).
export const sheetLayer = RaceSheet.layer(
  SpriteSheet.fromUrl("/sprites/race.json")
);

export const drawCar = (
  container: HTMLElement,
  sheet: SpriteSheet.SpriteSheet
) => {
  // Before: new Stage(...) and new InstancedSprites(sheet).
  const stage = Stage.make(container, { camera: "pixel", pixelsPerUnit: 16 });
  const sprites = InstancedSprites.make(sheet);
  stage.scene.add(sprites.mesh);
  const { tags } = SpriteSheet.resolveTags(sheet.data, { car: "car/drive" });
  return (x: number, z: number, time: number) => {
    // Before: sprites.begin(), sprites.push(...), sprites.end(), stage.camera.follow(...)
    // and stage.render().
    InstancedSprites.begin(sprites);
    InstancedSprites.push(
      sprites,
      x,
      z,
      SpriteSheet.frameAt(sheet.data, tags.car, time)
    );
    InstancedSprites.end(sprites);
    PixelCamera.follow(stage.camera, x, z);
    Stage.render(stage);
  };
};
```

**Breaking**

Every export of `arcadekit/render-three` and `arcadekit/render-three/testing` before, and what a game writes now. A function of a value takes it first, and with one argument less gives the function a `pipe` applies.

| Before | Now |
| --- | --- |
| `new Stage(container, options)`, `Stage<K>`, `stage.render()`, `stage.dispose()` | `Stage.make(container, options)`, `Stage.Stage<K>`, `Stage.render(stage)`, `Stage.dispose(stage)`, and `Stage.isStage` |
| `StageOptions<K>`, `StageCameraKind`, `StageCamera<K>` | `Stage.Options<K>`, `Stage.CameraKind`, `Stage.CameraOf<K>` |
| `disposeObject`, `keepTexture`, `isKeptTexture` | `Stage.disposeObject`, `Stage.keepTexture`, `Stage.isKeptTexture` |
| `new PixelCamera(options)`, `PixelCamera`, a `THREE.OrthographicCamera` | `PixelCamera.make(options)`, `PixelCamera.PixelCamera`, which holds the Three.js camera as `camera`, and `PixelCamera.isPixelCamera` |
| `camera.follow(x, z)`, `fit(bounds, margin?)`, `setViewHeight(h)`, `setBufferSize(w, h)`, `groundOnScreen(out)` | `PixelCamera.follow(camera, x, z)`, `PixelCamera.fit(camera, bounds, margin?)` and so on |
| `camera.position`, `camera.left` and the camera's other Three.js fields | `camera.camera.position`, `camera.camera.left` |
| `camera instanceof PixelCamera`, `camera.isPixelCamera` | `PixelCamera.isPixelCamera(camera)` |
| `PixelCameraOptions`, `pixelScale`, `fitPixelScale`, `snapToPixel`, `pixelFrustum` | `PixelCamera.Options`, `PixelCamera.pixelScale`, `PixelCamera.fitPixelScale`, `PixelCamera.snapToPixel`, `PixelCamera.pixelFrustum` |
| `followTarget`, `orbitAround`, `fitCamera`, `FitCameraOptions` | `Camera.follow`, `Camera.orbit`, `Camera.fit`, `Camera.FitOptions` |
| `GroundBounds`, `MutableGroundBounds` | `Camera.GroundBounds`, `Camera.MutableGroundBounds` |
| `loadSpriteSheet(url)` | `SpriteSheet.fromUrl(url)` |
| `makeSpriteSheet(data, image)`, `SpriteSheet` with a `dispose` field, `sheet.dispose()` | `SpriteSheet.make(data, image)`, `SpriteSheet.SpriteSheet` with no `dispose` field, `SpriteSheet.dispose(sheet)`, and `SpriteSheet.isSpriteSheet` |
| `decodeSpriteSheet(file, json)` | `SpriteSheet.decode(file, json)` |
| `SpriteSheetError`, a `Data.TaggedError` | `SpriteSheet.SpriteSheetError`, a `Schema.TaggedError` with the same tag and fields |
| `SpriteSheetData`, `SpriteFrame`, `SpriteTag`, `SpriteTagDirection` | `SpriteSheet.Data`, `SpriteSheet.Frame`, `SpriteSheet.Tag`, `SpriteSheet.TagDirection` |
| `WantedTags`, `ResolvedTags<W>`, `resolveTags(data, wanted)`, `frameAt(data, tag, seconds)` | `SpriteSheet.WantedTags`, `SpriteSheet.ResolvedTags<W>`, `SpriteSheet.resolveTags(data, wanted)`, `SpriteSheet.frameAt(data, tag, seconds)` |
| `new InstancedSprites(sheet, options)`, `InstancedSprites`, `InstancedSpritesOptions`, `SpriteSnap` | `InstancedSprites.make(sheet, options)`, `InstancedSprites.InstancedSprites`, `InstancedSprites.Options`, `InstancedSprites.Snap`, and `InstancedSprites.isInstancedSprites` |
| `sprites.begin()`, `push(x, z, frame, flipX?)`, `setTint`, `setAlpha`, `setFlash`, `setLift`, `setLayer`, `end()`, `dispose()` | `InstancedSprites.begin(sprites)`, `InstancedSprites.push(sprites, x, z, frame, flipX?)` and so on; `capacity` and `count` are fields |
| `new TileLayer(sheet, options)`, `TileLayer`, `TileLayerOptions` | `TileLayer.make(sheet, options)`, `TileLayer.TileLayer`, `TileLayer.Options`, and `TileLayer.isTileLayer` |
| `layer.draw(seen, frameOf)`, `invalidate()`, `dispose()` | `TileLayer.draw(layer, seen, frameOf)`, `TileLayer.invalidate(layer)`, `TileLayer.dispose(layer)` |
| `new Gait(options)`, `gait.update(x, z, time)`, `gait.reset()` | `Gait.make(options)`, `Gait.update(gait, x, z, time)`, `Gait.reset(gait)`, `Gait.Gait` with `linger` a field, and `Gait.isGait` |
| `new MeshInstances(geometry, material, options)`, `MeshInstances<A>`, `InstanceAttributes`, `MeshInstancesOptions<A>` | `MeshInstances.make(geometry, material, options)`, `MeshInstances.MeshInstances<A>` with `attributes` a field, `MeshInstances.Attributes`, `MeshInstances.Options<A>`, and `MeshInstances.isMeshInstances` |
| `instances.set(...)`, `setMatrix`, `setColor`, `setAttribute`, `commit(count)`, `dispose()` | `MeshInstances.set(instances, ...)` and so on |
| `testSheet(tags)` (`arcadekit/render-three/testing`) | `TestSpriteSheet.fromTags(tags)` |
| `drawnSprites(shown)`, `DrawnSprite` | `DrawnSprites.read(shown)`, `DrawnSprites.DrawnSprite` |
| `pngSize(png)`, `framesWithSoftAlpha(data, png, blended?)` | `Png.size(png)`, `Png.framesWithSoftAlpha(png, data, blended?)`: the PNG first |

Not in the published package: push-puzzle's and survivors' views, their tests and both demos are moved, with no change to what they draw. A test that spied on a batch's or a layer's method spies on its module's function (`vi.spyOn(TileLayer, "invalidate")`).

No recorded hash moved: no simulation file changed.
