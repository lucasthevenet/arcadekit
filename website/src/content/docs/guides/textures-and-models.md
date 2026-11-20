---
title: "Textures and models"
description: "Build a level's look from its files: Three.texture and Gltf.model are bundle assets, and instances and objects built from them are drawn while the bundle is loaded."
---

A geometry and material passed to [`Three.instances`](instances-and-objects.md) exist when the system is created. A level's look is different: its textures and models are [assets](assets.md) of its bundle, loaded when the game enters the level and released when it leaves. A kind whose look is built from them names the bundle it comes `from`.

## Looks built from assets

```ts
import { Three } from "@arcadekit/three";
import { Assets, Component, Plugin, State } from "arcadekit";
import { CylinderGeometry, MeshStandardMaterial } from "three";

const Tree = Component.tag("game/Tree");
const Level = State.define("game/Level", ["menu", "forest"]);

const Forest = Assets.bundle("game/Forest", {
  bark: Three.texture("/bark.png"),
});

const Trees = Three.instances("game/Trees", {
  of: Tree,
  from: Forest,
  look: ({ bark }) => ({
    geometry: new CylinderGeometry(1, 1, 8),
    material: new MeshStandardMaterial({ map: bark }),
  }),
});

const Look = Plugin.make("game/Look", {
  plugins: [Three.plugin, Assets.plugin],
  components: [Tree, Level],
  systems: [Assets.during(State.is(Level, "forest"), Forest), Trees],
});
```

- The entities are drawn while the app has the bundle loaded, and at no other time: before it loads, while it is loading, and after it fails, none of their meshes are in the scene. Keeping it loaded is another system's job, usually `Assets.during`.
- `look` is called once each time the bundle loads, with its assets under their names and with their types, and returns the geometry and material. Everything else works as for any instances: `color`, `smooth`, `capacity`, and `prepare`, which receives each mesh created.
- When the bundle is released, the mesh is removed from the scene and disposed, with the geometry and material once no other system draws with them. Then `free`, if given, receives everything `look` returned, so you can dispose of anything else you created. The assets themselves are released by the bundle. The same happens when the app's scope closes.
- When the level is entered again, the bundle loads again and the look is rebuilt from the new assets. The new mesh starts with the capacity the previous one had grown to.
- It requires `Assets.plugin`, as the system's type shows: without it, the app requires the asset store from outside, and a program that doesn't provide one doesn't compile. A kind whose look exists from the start has no such requirement.
- Nothing of the kind is drawn while its bundle is loading.

Nothing is ever drawn with released assets. `Assets.during` runs in `"preFrame"`, before the frame's own stage, so instances appear in the frame the bundle loads and disappear in the frame it is released, wherever the two systems are listed. For a system of your own that releases a bundle later in the frame, `Three.Render` checks just before rendering that each such kind's assets are still loaded, and removes those that aren't.

## Textures

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

`Three.texture(url)` is an asset that produces a Three.js `Texture`: it goes in a bundle alongside the level's other files, is downloaded and decoded with them, and is disposed, along with its image, when the scope it was loaded in closes.

- It is decoded with the page's `createImageBitmap`, off the game's thread. Node has no `createImageBitmap`, so textures are for pages.
- It is treated as a colour image, in sRGB. `prepare` receives the texture once, before it is uploaded to the renderer, to change that or to set wrapping and filtering.
- It is oriented the right way up for Three.js geometries, as `TextureLoader` would give it. `flipY: false` keeps the file's orientation.
- Orientation is set here, where the texture is created, not in `prepare`: an `ImageBitmap` is flipped while it is decoded, and Three.js ignores `flipY` on textures made from one. Setting it in `prepare` would do nothing, so the load fails with an error explaining where to set it.
- A file that isn't an image fails the bundle, like any asset that can't be created, with `Assets.AssetFailed` naming the URL.

## Models

```ts
import { Three } from "@arcadekit/three";
import * as Gltf from "@arcadekit/three/Gltf";
import { Assets, Component } from "arcadekit";

const Ship = Component.tag("game/Ship");
const Rock = Component.tag("game/Rock");

const Fleet = Assets.bundle("game/Fleet", {
  ship: Gltf.model("/ship.glb"),
  rock: Gltf.model("/rocks/rock.gltf"), // with rock.bin and rock.png beside it
});

// One object each: a copy of the model's scene.
const Ships = Three.objects("game/Ships", {
  of: Ship,
  from: Fleet,
  make: (entity, { ship }) => ship.scene.clone(),
});

// Or a crowd, each an instance of one of its meshes.
const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  from: Fleet,
  look: ({ rock }) => Gltf.mesh(rock, "Boulder"),
});
```

`Gltf.model(url)` is an asset that produces a glTF model, from a `.glb` or `.gltf` file: it goes in a bundle, loads with it, and produces what Three.js's glTF loader returns, with its `scene`, `scenes` and `animations`.

- The buffers and images a `.gltf` file references are fetched through `Assets.Loader`, in parallel, and handed to Three.js with the model, so Three.js fetches nothing itself. A test's in-memory files therefore serve a whole model, a missing file fails the bundle with its own URL, and leaving a level while its model is downloading cancels those requests.
- When the scope it was loaded in closes, every geometry, material and texture of the model is disposed, and its images closed.
- A model is shared across the whole bundle. An object made with `scene.clone()` shares its geometries and materials: that is cheap, there is nothing to `free`, and changing one copy's material changes them all.
- `Gltf.mesh(model, name)` returns one of the model's meshes, by the name of its node, as an editor shows it, or by its own name when its node has none; without a name, the first mesh. A mesh with several materials is several meshes under that name, and the first is returned. A mesh has a geometry and a material, which is exactly what `Three.instances` accepts from `look`. It throws, listing the available meshes, when no mesh has the name.
- `Gltf.model(url, { prepare })` passes the loader to `prepare` before the model is parsed, for what compressed models need: `loader.setDRACOLoader(...)`, `setKTX2Loader`, `setMeshoptDecoder`. Those decoders fetch their own files, outside `Assets.Loader`.
- A model's animations are loaded but not played, and `scene.clone()` doesn't copy a skinned model correctly: use `SkeletonUtils.clone` from Three.js for that.
- Its images are decoded by the page, as with `Three.texture`, so a model with images is for pages. A model without images loads anywhere.
- A file that isn't a model fails the bundle with `Assets.AssetFailed`, explaining what was wrong with it.

## Objects built from assets

Objects name the bundle they come `from` just as instances do, and `make` receives its assets as well as the entity, as `Ships` does above.

- Objects exist while the app has the bundle loaded. On the frame it loads, every entity of the kind gets an object built from the loaded assets; when it is released, every object is removed from the scene and passed to `free` before the scene is next rendered. When it loads again, each object is rebuilt.
- Everything else works as for [objects](instances-and-objects.md#objects) and for instances built from assets: it requires `Assets.plugin`, and nothing is drawn with released assets.

## Other file types

A font, or any file Three.js has a loader for, is an asset of your own, `Assets.make(url, decode)`, with `Effect.acquireRelease` for anything that needs disposing.

A Three.js loader that fetches files itself bypasses `Assets.Loader`: a test's in-memory files don't serve it, and cancelling a load doesn't cancel its requests. This applies to an asset you build around another loader, such as the FBX loader.

## Read more

- [Assets](assets.md), for bundles and how they stay loaded.
- [`Three.texture`](/reference/three/Three#texture) and [`Gltf`](/reference/three/Gltf) in the API reference.
