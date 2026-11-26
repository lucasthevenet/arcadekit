---
title: "Textures and models"
description: "Build a level's look from its files: Three.texture and Gltf.model are bundle assets, and instances and objects built from them are drawn while the bundle is loaded."
---

A level's **textures** and **models** are [assets](assets.md) of its bundle. They load when the game enters the level and are released when it leaves. A kind whose look is built from them is made with `Three.instancesFrom` or `Three.objectsFrom`, and names the bundle it comes `from`. A geometry and a material passed to [`Three.instances`](instances-and-objects.md) directly exist from when the system is made, and need no bundle.

## Build a look from a bundle

```ts
import { Three } from "@arcadekit/three";
import { Assets, Component, Plugin, State, Transform3d } from "arcadekit";
import { CylinderGeometry, MeshStandardMaterial } from "three";

const Tree = Component.tag("game/Tree", { requires: [Transform3d.Position] });
const Level = State.define("game/Level", ["menu", "forest"]);

const Forest = Assets.bundle("game/Forest", {
  bark: Three.texture("/bark.png"),
});

const Trees = Three.instancesFrom("game/Trees", {
  of: Tree,
  transform: Transform3d,
  from: Forest,
  look: ({ bark }) => ({
    geometry: new CylinderGeometry(1, 1, 8),
    material: new MeshStandardMaterial({ map: bark }),
  }),
});

const Look = Plugin.make("game/Look", {
  plugins: [Three.plugin, Assets.plugin],
  systems: [Assets.during(State.is(Level, "forest"), Forest), Trees],
});
```

- The entities are drawn while the app has the bundle loaded, and at no other time. Before the bundle loads, while it is loading, and after it fails, none of their meshes are in the scene. Another system keeps the bundle loaded, usually `Assets.during`.
- The system calls `look` once each time the bundle loads, with the bundle's assets under their names and with their types. `look` returns the geometry and the material. Everything else works as for any instances: `color`, `smooth`, `capacity`, and `prepare`, which receives each mesh created.
- When the bundle is released, the system removes the mesh from the scene and disposes of it. It disposes of the geometry and the material too, once no other system draws with them. Then `free`, if given, receives everything `look` returned, so you can dispose of anything else you created. The bundle releases the assets themselves. The same happens when the app is closed.
- When the game enters the level again, the bundle loads again and the system rebuilds the look from the new assets. The new mesh starts with the capacity that the previous one had grown to.
- The system requires `Assets.plugin`, as its type shows. Without the plugin, the app requires the asset store from outside, and a program that doesn't provide one doesn't compile. A kind whose look exists from the start has no such requirement.

Nothing is ever drawn with released assets. `Assets.during` runs in `"preFrame"`, before the frame's own stage. Instances appear in the frame the bundle loads and disappear in the frame it is released, wherever the two systems are listed. A system of your own may release a bundle later in the frame. For that case, `Three.Render` checks just before drawing that each such kind's assets are still loaded, and removes the kinds whose assets aren't.

## Load a texture

```ts
import { Three } from "@arcadekit/three";
import { Assets } from "arcadekit";
import { NoColorSpace, RepeatWrapping } from "three";

const Forest = Assets.bundle("game/Forest", {
  bark: Three.texture("/bark.png"),
  bumps: Three.texture("/bark-normals.png", {
    prepare: (texture) => {
      texture.colorSpace = NoColorSpace; // not colours
      texture.wrapS = texture.wrapT = RepeatWrapping;
    },
  }),
  // As the file stores it, which a model's own UVs expect.
  skin: Three.texture("/skin.png", { flipY: false }),
});
```

`Three.texture(url)` is an asset that produces a Three.js `Texture`. It goes in a bundle beside the level's other files, and is downloaded and decoded with them. The texture and its image are disposed of when the scope it was loaded in closes.

| Option | Default | Description |
| --- | --- | --- |
| `prepare` | None | Receives the texture once, before it is uploaded to the renderer, to mark it as non-colour data or to set its wrapping and filtering |
| `flipY` | `true` | Flips the image on decode, so its first row is at the top of a Three.js geometry, as `TextureLoader` does. `false` keeps the file's orientation |

- The texture is a colour image, in sRGB, unless `prepare` says otherwise.
- Set the orientation with `flipY`, not in `prepare`. A bitmap is flipped while it is decoded, and Three.js ignores `flipY` on a texture made from a bitmap. `prepare` receives the texture without its `flipY`, so setting it there doesn't compile.
- The page's `createImageBitmap` decodes the texture, off the page's main thread. Node has no `createImageBitmap`, so textures are for pages.
- A file that isn't an image fails the bundle, like any asset that can't be created, with an `Assets.Failed` that names the URL.

## Load a glTF model

```ts
import { Three } from "@arcadekit/three";
import * as Gltf from "@arcadekit/three/Gltf";
import { Assets, Component, Transform3d } from "arcadekit";

const Ship = Component.tag("game/Ship", { requires: [Transform3d.Position] });
const Rock = Component.tag("game/Rock", { requires: [Transform3d.Position] });

const Fleet = Assets.bundle("game/Fleet", {
  ship: Gltf.model("/ship.glb"),
  rock: Gltf.model("/rocks/rock.gltf"), // with rock.bin and rock.png beside it
});

// One object each: a copy of the model's scene.
const Ships = Three.objectsFrom("game/Ships", {
  of: Ship,
  transform: Transform3d,
  from: Fleet,
  make: (entity, { ship }) => ship.scene.clone(),
});

// Or a crowd, each an instance of one of its meshes.
const Rocks = Three.instancesFrom("game/Rocks", {
  of: Rock,
  transform: Transform3d,
  from: Fleet,
  look: ({ rock }) => Gltf.mesh(rock, "Boulder"),
});
```

`Gltf.model(url)` is an asset that produces a glTF model, from a `.glb` or `.gltf` file. It goes in a bundle and loads with it. It produces what Three.js's glTF loader returns, with its `scene`, `scenes`, and `animations`.

- `Assets.Loader` fetches the buffers and images that a `.gltf` file references, in parallel, and hands them to Three.js with the model. Three.js fetches nothing itself. A test's in-memory files therefore serve a whole model, and a missing file fails the bundle with its own URL. Leaving a level while its model is downloading cancels those requests.
- When the scope it was loaded in closes, every geometry, material, and texture of the model is disposed of, and its images are closed.
- A model is shared across the whole bundle. An object made with `scene.clone()` shares the model's geometries and materials. A clone is cheap and leaves nothing to `free`, but changing one copy's material changes them all.
- `Gltf.mesh(model, name)` returns one of the model's meshes. It finds the mesh by the name of its node, as an editor shows it, or by the mesh's own name when its node has none. Without a name, it returns the first mesh. A mesh with several materials is several meshes under that name, and `Gltf.mesh` returns the first.
- A mesh has a geometry and a material, which is exactly what `Three.instancesFrom` accepts from `look`. When no mesh has the name, `Gltf.mesh` throws an error that lists the meshes the model has.
- `Gltf.model(url, { files, prepare })` passes the loader to `prepare` before the model is parsed, for what compressed models need: `loader.setDRACOLoader(...)`, `setKTX2Loader`, or `setMeshoptDecoder`. A DRACO or KTX2 loader fetches files of its own, so make it in `prepare` with the manager `prepare` receives, and list its files in `files`. `Assets.Loader` fetches them, and the decoder is disposed of once the model is parsed. A decoder made without that manager fails the bundle, and a file missing from `files` fails it with that file's URL.

- A model's animations are loaded but not played. `scene.clone()` doesn't copy a skinned model correctly, so clone one with Three.js's `SkeletonUtils.clone`.
- The page decodes a model's images, as it does for `Three.texture`, so a model with images is for pages. A model without images loads anywhere.
- A file that isn't a model fails the bundle with an `Assets.Failed` that says what was wrong with it.

A model compressed with DRACO, with the decoder's files in `/draco/`:

```ts
import * as Gltf from "@arcadekit/three/Gltf";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

export const ship = Gltf.model("/ship.glb", {
  files: ["/draco/draco_decoder.wasm", "/draco/draco_wasm_wrapper.js"],
  prepare: (loader, manager) => {
    loader.setDRACOLoader(new DRACOLoader(manager).setDecoderPath("/draco/"));
  },
});
```

## Build objects from a bundle

`Three.objectsFrom` names the bundle its objects come `from`, as `Three.instancesFrom` does. `make` receives the bundle's assets as well as the entity, as in `Ships` above.

- Objects exist while the app has the bundle loaded. On the frame the bundle loads, every entity of the kind gets an object built from the loaded assets. When the bundle is released, every object is removed from the scene and passed to `free` before the scene is next drawn. When the bundle loads again, each object is rebuilt.
- Everything else works as for [objects](instances-and-objects.md#keep-one-object-per-entity) and for instances built from assets. The system requires `Assets.plugin`, and nothing is drawn with released assets.

## Load other file types

Make a font, or any file that Three.js has a loader for, an asset of your own with `Assets.make(url, decode)`. Use `Effect.acquireRelease` for anything that needs disposing of.

A Three.js loader that fetches files itself, such as the FBX loader for its textures, fetches them through `Assets.Loader` when it is made with `Three.manager(files)`. The manager serves the files listed, and refuses any other URL with an error that names it, which the loader passes on. A test's in-memory files then serve the loader, and leaving a level while it loads cancels its requests.

```ts
import { Three } from "@arcadekit/three";
import { Assets } from "arcadekit";
import { Effect } from "effect";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

export const fbx = (url: string, textures: ReadonlyArray<string>) =>
  Assets.make(url, (data) =>
    Effect.map(Three.manager(textures), (manager) =>
      new FBXLoader(manager).parse(data.slice().buffer, "")
    )
  );
```

## Read more

- [Assets](assets.md), for bundles and how they stay loaded.
- [`Three.texture`](/reference/three/Three#texture) and [`Gltf`](/reference/three/Gltf) in the API reference.
