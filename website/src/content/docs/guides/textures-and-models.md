---
title: "Textures and models"
description: "A level's look is made of its files: Three.texture and Gltf.model are assets of a bundle, and the instances and objects made of them are drawn while the bundle is loaded."
---

A geometry and a material given to [`Three.instances`](instances-and-objects.md) are there when the system is made. A level's are not: its textures and models are [assets](assets.md) of its bundle, loaded when the game enters it and let go when it leaves. A kind whose look is made of them says which bundle it comes `from`.

## A look made of assets

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
  free: ({ geometry, material }) => {
    geometry.dispose();
    material.dispose();
  },
});

const Look = Plugin.make("game/Look", {
  plugins: [Three.plugin, Assets.plugin],
  components: [Tree, Level],
  systems: [Assets.during(State.is(Level, "forest"), Forest), Trees],
});
```

- The entities are drawn while the app holds the bundle loaded, and at no other time: before it is loaded, while it is loading and after it failed, no mesh of theirs is in the scene. Who keeps it loaded is not this system's business: `Assets.during`, as a rule.
- `look` is called once each time the bundle is loaded, with its assets under their names and with their types, and returns the geometry and the material. Everything else is as for any instances: `color`, `smooth`, `capacity`, `prepare`, which is handed each mesh that is made.
- When the bundle is let go the mesh is taken out of the scene and disposed of, and then `free` is handed what `look` returned, anything it returned beyond the two included, to dispose of what it made. The assets are the bundle's to let go. The same happens when the app's scope closes.
- Entered again, the level is loaded again, and the look is made again of what is loaded now. The mesh starts with the room the last one had grown to.
- It needs `Assets.plugin`, which the type of the system says: left out, the app asks for the store of assets from outside, and a program that gives it none does not compile. A kind whose look is there from the start asks nothing of it.

Nothing is ever drawn with assets that were let go. `Assets.during` is of the stage before a frame's own, `"preFrame"`: the instances appear in the frame the bundle is loaded and are gone in the frame it is let go, wherever the two systems are listed. For a system of the game's own that lets a bundle go later in the frame, `Three.Render` asks, just before it draws, whether what each such kind was made of is still there, and takes out what is not.

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
  // As the file has it, which a model's own coordinates expect.
  skin: Three.texture("/skin.png", { flipY: false }),
});
```

`Three.texture(url)` is an asset that is a `Texture` of Three.js: it goes in a bundle beside the level's other files, is fetched and decoded with them, and is disposed of, with the picture it was made of, when the scope it was loaded in closes.

- It is decoded by the page's `createImageBitmap`, off the thread the game runs on. Node has none, so a texture is for a page.
- It is a picture of colours, in sRGB. `prepare` is handed the texture once, before it is ever sent to the renderer, to say otherwise or to set how it repeats and is filtered.
- It is the right way up for the geometries of Three.js, as a `TextureLoader` gives it. `flipY: false` leaves it as the file has it.
- Which way up is said there, where the texture is made, and not in `prepare`: a bitmap is turned over when it is decoded, and Three.js does not read `flipY` of a texture made of one. Set in `prepare` it would do nothing, so the load fails with an error that says where to say it.
- A file that is no picture fails the bundle, as any asset that cannot be made does, with `Assets.AssetFailed` naming the URL.

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

// An object each, a copy of the model's scene.
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

`Gltf.model(url)` is an asset that is a glTF model, `.glb` or `.gltf`: it goes in a bundle, is loaded with it, and is what the glTF loader of Three.js gives, with its `scene`, its `scenes` and its `animations`.

- The buffers and pictures a `.gltf` names beside itself are fetched through `Assets.Loader`, at once with each other, and handed to Three.js with the model, which then fetches nothing for itself. So a test's files in memory serve a whole model, one that is missing fails the bundle with its own URL, and a level that is left while its model is still on its way gives those requests up.
- When the scope it was loaded in closes, every geometry, material and texture of the model is disposed of, and its pictures closed.
- A model is one for the whole bundle. An object made of it with `scene.clone()` shares its geometries and materials: that is cheap, there is nothing to `free`, and what changes one copy's material changes them all.
- `Gltf.mesh(model, name)` is a mesh of the model, by the name of the node it is on, as an editor shows it, or its own where its node has none; the first when no name is given. A mesh of several materials is several meshes under that name, and the first is given. A mesh has a geometry and a material, which is what `Three.instances` takes as a `look`. It throws, naming the meshes there are, when none has the name.
- `Gltf.model(url, { prepare })` hands the loader to `prepare` before the model is read, for what a compressed model needs: `loader.setDRACOLoader(...)`, `setKTX2Loader`, `setMeshoptDecoder`.
- Its pictures are decoded by the page, as `Three.texture`'s are, so a model with pictures is for a page. One without loads anywhere.
- A file that is no model fails the bundle with `Assets.AssetFailed`, which says what was wrong with it.

## Objects made of assets

Objects name the bundle they come `from` as instances do, and `make` is handed its assets as well as the entity, as `Ships` is above.

- There are objects while the app holds the bundle loaded. The frame it is, every entity of the kind gets its object, made of what is loaded; when it is let go, every object is taken out of the scene and handed to `free`, before the scene is next drawn. Loaded again, each is made again.
- The rest is as for [objects](instances-and-objects.md#objects) and as for instances made of assets: it needs `Assets.plugin`, and nothing is drawn with what was let go.

## Another loader's files

A font, or anything else Three.js has a loader for, is an asset of your own, `Assets.make(url, decode)`, with `Effect.acquireRelease` for what has to be disposed of.

A loader of Three.js that fetches for itself does not go through `Assets.Loader`: a test's files in memory do not serve it, and a load that is given up does not give those requests up. A glTF model's own files are brought through it here. What is left is the decoder a compressed model is given in `prepare`, which fetches its own files, and an asset of the game's own made around another loader, an FBX's, say.

## Read more

- [Assets](assets.md), for bundles and what keeps them loaded.
- [`Three.texture`](/reference/three/Three#texture) and [`Gltf`](/reference/three/Gltf) in the API reference.
