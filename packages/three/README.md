# @arcadekit/three

Draws an [arcadekit](../arcadekit/README.md) game with [Three.js](https://threejs.org).

It is a plugin, not part of the core: a game that draws with something else leaves it out, and the game it draws does not know it is there. Everything here runs in arcadekit's [frame stage](../arcadekit/README.md#the-tick-and-the-frame), between ticks, with the world frozen, so a game that is drawn has the same hash, log and save as one that is not.

This is a first cut: see [Not done yet](#not-done-yet).

```sh
pnpm add arcadekit @arcadekit/three effect three
pnpm --filter @arcadekit/three page    # ten thousand moving objects, at http://localhost:5173
pnpm --filter @arcadekit/three bench
```

## What it looks like

```ts
// rules.ts: the game. Nothing of this package here: a server and a replay run it as it is.
import { Commands, Component, Plugin, Transform3d } from "arcadekit";

const Rock = Component.tag("game/Rock");

const Rules = Plugin.make("game/Rules", {
  plugins: [Transform3d.plugin],
  components: [Rock],
  systems: [Fall],
  setup: Effect.map(Commands, (commands) => {
    commands.spawn(Rock, Transform3d.Position.of({ x: 0, y: 4, z: 0 }));
  }),
});
```

```ts
import { Three } from "@arcadekit/three";
// main.ts: the page. How the game looks, and what draws it.
import { App, Plugin } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { IcosahedronGeometry, MeshStandardMaterial } from "three";

const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  geometry: new IcosahedronGeometry(1),
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
});

const Look = Plugin.make("game/Look", {
  plugins: [Three.plugin, Rules],
  systems: [Rocks],
});

Browser.runMain(
  App.run({ plugins: [Look] }, { hz: 60 }).pipe(
    Effect.provide(Three.layerWebGL({ canvas }))
  ),
  { target: canvas }
);
```

## Entries

```ts
import { Gltf, Three } from "@arcadekit/three"; // or
import * as Gltf from "@arcadekit/three/Gltf";
import * as Three from "@arcadekit/three/Three";
```

| Entry | What it has | Imports |
| --- | --- | --- |
| `@arcadekit/three` | The modules below, as `import { Gltf, Three } from "@arcadekit/three"` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Three` | The plugin, the scene, the renderer, `instances`, `objects` and `texture` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Gltf` | `model`, the asset that is a glTF file, and `mesh` | `arcadekit`, `effect`, `three`, and its glTF loader, `three/addons` |

- Models are a module of their own because they bring the glTF loader of Three.js with them, which a game with no models need not carry. Nothing in `Three` imports it.

- `arcadekit`, `effect` and `three` are peer dependencies: a game has one copy of each, so a component or a service of arcadekit's is the same object here as in the game.
- Only what belongs to the page imports this package: the plugin that says how the game looks, and the module that starts it. Where things are is `arcadekit/Transform3d` or `arcadekit/Transform2d`, in the game's own package.
- `pnpm lint:packages` checks what each built entry imports, and a test checks the same of the sources.

## Where a thing is

```ts
commands.spawn(
  Rock,
  Transform3d.Position.of({ x: 0, y: 4, z: 0 }),
  Transform3d.Rotation.of(Transform3d.axisAngle(0, 0, 1, Math.PI / 2)),
  Transform3d.Scale.of({ x: 2, y: 2, z: 2 })
);
```

What is drawn where comes from arcadekit's own components, [`arcadekit/Transform3d` and `arcadekit/Transform2d`](../arcadekit/README.md#where-a-thing-is): this package has none of its own, and only reads them.

- An entity is drawn where its `Transform3d.Position` says, in the units of the scene. `Transform3d.Rotation`, a quaternion of any length, and `Transform3d.Scale`, where 1 is the size of the geometry, are for the entities that turn or have a size of their own: one without them is drawn upright, at the size of its geometry, and costs less to draw.
- A `Rotation` is drawn as the turn it stands for, whatever its length: one that the game's rules let drift from length 1, or never made of it, is neither skewed nor sized by that, and an object of `Three.objects` is given a quaternion of length 1. All zeros is not turned at all. It costs an instance about 3 ns: one division.
- The plugins that hold a game's rules write them and import nothing of this package. A server and a replay that run those rules do not install it, or Three.js.
- `Three.plugin` depends on `Transform3d.plugin`, which lists them, and on `Transform2d.plugin`.
- A `Rotation` whose four fields are 0, which is what one added with no value is, draws as not turned.

**A flat game** places its things with [`arcadekit/Transform2d`](../arcadekit/README.md#where-a-thing-is), and is drawn the same way by the same systems:

```ts
commands.spawn(
  Card,
  Transform2d.Position.of({ x: 120, y: 80 }),
  Transform2d.Rotation.of({ angle: Math.PI / 6 })
);
```

- An entity with a `Transform2d.Position` is drawn in the plane of x and y, at 0 of the third axis, turned about that axis by its `Transform2d.Rotation` and sized along x and y by its `Transform2d.Scale`.
- What is in front of what is the kind's to say, not the entity's: `prepare: (mesh) => { mesh.position.z = 1 }` for instances, and where `make` puts an object for objects. An orthographic camera, `three.camera = new OrthographicCamera(...)`, sees the plane flat.
- A game can have things of both kinds, and one kind can hold both. An entity with both positions is drawn once, from the one of three dimensions; its `Transform2d` rotation and scale are then not read.

## Instances

```ts
const Rocks = Three.instances("game/Rocks", {
  of: Rock, // or several: [Rock, Lit]
  without: [Hidden],
  geometry: new IcosahedronGeometry(1),
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
  capacity: 4096,
  prepare: (mesh) => {
    mesh.castShadow = true;
  },
});
```

`Three.instances` is a system of the frame stage that draws every entity of a kind as one instance of one `InstancedMesh`. An entity is one of them while it has every component `of` names, none of `without`, and a `Position`.

- Each frame it reads the columns raw, with `eachChunk`, and writes one matrix per entity straight into the mesh's instance buffer. No object, matrix or vector is made per entity, and nothing is allocated per entity per frame; see [the benchmark](#benchmark).
- An entity's table has a rotation or it does not, and a scale or not. Each of the four is its own loop, handed exactly the columns it needs, so an entity that is only somewhere costs three reads. A flat game's entities have four loops of their own, with fewer columns: two reads for one that is only somewhere, and a sine and a cosine for one that is turned.
- The buffer has room for `capacity` instances, 256 unless told, and doubles when it runs out. That is the one time the system allocates, and it tells the renderer to drop the buffer it had made for the old one.
- Only the part of the buffer that is drawn is sent to the renderer.
- The mesh is made on the first frame, named after the system, and added to the scene. It is not culled, since its instances are wherever the entities are; `prepare` is handed the mesh once, to say otherwise or to set anything else.
- When the app's scope closes the mesh is taken out of the scene and disposed of. The geometry and the material are yours, to share between several and to dispose of.
- The entities are drawn where the last tick left them, or, with `smooth: true`, [between their last two places](#between-two-ticks).

### A colour each

```ts
// The rules: a colour is three numbers, as a place is.
const Paint = Component.define("game/Paint", {
  r: Field.f32,
  g: Field.f32,
  b: Field.f32,
});

// The page: every rock is drawn in its own.
const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  geometry,
  material: new MeshStandardMaterial({ color: "#ffffff" }),
  color: Paint,
});
```

`color` names a component of the game's that gives each instance a colour of its own. This package defines none: what colour a thing is, a team's or how hurt it is, is the game's to say, and its rules write it as they write a place.

- Any component kept in a table with the fields `r`, `g` and `b` is a colour, whatever else it has. Anything else given as one throws when the system is made, and is a type error before that.
- The material's own colour is multiplied by it, so a white material is drawn in exactly the instance's.
- The numbers are a colour as a hex code writes it: `#ff6188` is an `r` of `0xff / 255`, a `g` of `0x61 / 255` and a `b` of `0x88 / 255`, from 0 to 1 in fields of floats. A component whose three fields are whole numbers, `Field.u8`, holds the bytes themselves, 0 to 255. The three are all one or all the other, which is checked when the system is made.
- A renderer works in linear colour, so each number is converted, through a table of 4,081 entries and not with a raised power per instance: a byte exactly, and a float to a sixteenth of a byte.
- A number off either end, a 255 in a field of floats or a 300 in one of whole numbers, is no colour: the frame fails with an error that names the entity and its three numbers, where it would have drawn white or something brighter and said nothing.
- `colorSpace: "srgb-linear"` says the numbers are the renderer's own instead, what `new Color("#ff6188")` of Three.js has as its `r`, `g` and `b`, by the name Three.js gives that space. They are handed over as they are, bytes over 255, and nothing is checked: a number over 1 is brighter than white, which a renderer that blooms can show. `"srgb"`, the other name, is what is assumed.
- An entity is then one of the kind only while it has the colour too. One with no colour is not drawn by this system.
- The colours are read from the raw columns in the same pass as the places, into a buffer of their own beside the matrices, which grows with them and of which only the part that is drawn is sent. It costs about 6 ns more per entity, 2 of them the reading and the writing and the rest the conversion, and nothing is allocated.
- With `smooth: true` a colour changes evenly between two ticks, as a place does, and `snap` does not apply to it: a colour is never too far to go to. It changes in the numbers the game has, and is converted then: halfway between two hex codes is the code halfway between them.

### A look made of assets

```ts
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
  systems: [Assets.during(State.is(Level, "forest"), Forest), Trees],
});
```

A geometry and a material given to `Three.instances` are there when the system is made. A level's are not: its textures are [loaded when the game enters it and let go when it leaves](../arcadekit/README.md#assets). Such a kind says which bundle its look comes `from`, and how the `look` is made of what the bundle holds.

- The entities are drawn while the app holds the bundle loaded, and at no other time: before it is loaded, while it is loading and after it failed, no mesh of theirs is in the scene. Who keeps it loaded is not this system's business: `Assets.during`, as a rule.
- `look` is called once each time the bundle is loaded, with its assets under their names and with their types, and returns the geometry and the material. Everything else is as for any instances: `color`, `smooth`, `capacity`, `prepare`, which is handed each mesh that is made.
- When the bundle is let go the mesh is taken out of the scene and disposed of, and then `free` is handed what `look` returned, anything it returned beyond the two included, to dispose of what it made. The assets are the bundle's to let go. The same happens when the app's scope closes.
- Entered again, the level is loaded again, and the look is made again of what is loaded now. The mesh starts with the room the last one had grown to.
- Nothing is ever drawn with assets that were let go. `Three.Render` asks, just before it draws, whether what each such kind was made of is still there, and takes out what is not: so it does not matter whether the system that lets the level go runs before this one or after it in a frame.
- `Assets.during` is of the stage before a frame's own, [`"preFrame"`](../arcadekit/README.md#the-tick-and-the-frame): the instances appear in the frame the bundle is loaded and are gone in the frame it is let go, wherever the two systems are listed. The check before the draw is for a system of the game's own that lets a bundle go later in the frame than this one looked.
- It needs `Assets.plugin`, which the type of the system says: left out, the app asks for the store of assets from outside, and a program that gives it none does not compile. A kind whose look is there from the start asks nothing of it.

## Textures

```ts
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

`Three.texture(url)` is an [asset](../arcadekit/README.md#assets) that is a `Texture` of Three.js: it goes in a bundle beside the level's other files, is fetched and decoded with them, and is disposed of, with the picture it was made of, when the scope it was loaded in closes.

- It is decoded by the page's `createImageBitmap`, off the thread the game runs on.
- It is a picture of colours, in sRGB. `prepare` is handed the texture once, before it is ever sent to the renderer, to say otherwise or to set how it repeats and is filtered.
- It is the right way up for the geometries of Three.js, as a `TextureLoader` gives it. `flipY: false` leaves it as the file has it.
- Which way up is said there, where the texture is made, and not in `prepare`: a bitmap is turned over when it is decoded, and Three.js does not read `flipY` of a texture made of one. Set in `prepare` it would do nothing, so the load fails with an error that says where to say it.
- A file that is no picture fails the bundle, as any asset that cannot be made does, with `Assets.AssetFailed` naming the URL.
- A model is [`Gltf.model`](#models). A font, or anything else Three.js has a loader for, is an asset of your own, `Assets.make(url, decode)`, with `Effect.acquireRelease` for what has to be disposed of.

## Models

```ts
import * as Gltf from "@arcadekit/three/Gltf";

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

`Gltf.model(url)` is an [asset](../arcadekit/README.md#assets) that is a glTF model, `.glb` or `.gltf`: it goes in a bundle, is loaded with it, and is what the glTF loader of Three.js gives, with its `scene`, its `scenes` and its `animations`.

- The buffers and pictures a `.gltf` names beside itself are fetched here, through `Assets.Loader`, at once with each other, and handed to Three.js with the model, which then fetches nothing for itself. So a test's files in memory serve a whole model, one that is missing fails the bundle with its own URL, and a level that is left while its model is still on its way gives those requests up.
- When the scope it was loaded in closes, every geometry, material and texture of the model is disposed of, and its pictures closed.
- A model is one for the whole bundle. An object made of it with `scene.clone()` shares its geometries and materials: that is cheap, there is nothing to `free`, and what changes one copy's material changes them all.
- `Gltf.mesh(model, name)` is a mesh of the model, by the name of the node it is on, as an editor shows it, or its own where its node has none; the first when no name is given. A mesh of several materials is several meshes under that name, and the first is given. A mesh has a geometry and a material, which is what `Three.instances` takes as a `look`. It throws, naming the meshes there are, when none has the name.
- `Gltf.model(url, { prepare })` hands the loader to `prepare` before the model is read, for what a compressed model needs: `loader.setDRACOLoader(...)`, `setKTX2Loader`, `setMeshoptDecoder`.
- Its pictures are decoded by the page, as `Three.texture`'s are, so a model with pictures is for a page. One without loads anywhere.
- A file that is no model fails the bundle with `Assets.AssetFailed`, which says what was wrong with it.

## Objects

```ts
const Ships = Three.objects("game/Ships", {
  of: Ship,
  make: (entity) => new Mesh(hull, paint),
  free: (ship) => ship.clear(),
});
```

`Three.objects` is a system of the frame stage that keeps one `Object3D` per entity of a kind. It is for the few things that are more than a copy of one mesh: a model with parts, a light, something that carries the camera. A crowd is `Three.instances`.

- `make` is called the first frame an entity is one of these, and its object is added to the scene. The frame it no longer is, or is gone, the object is taken out and `free` is called with it. Whatever is left when the app's scope closes is freed then.
- Each frame every object is given its entity's `Position`, and its `Rotation` and `Scale` if the entity has them. An entity that loses one is drawn as one that never had it. What else there is to an object is the game's: set in `make`, or by a frame system of its own.
- An entity placed with `Transform2d` has its object's x and y set, its turn about the third axis, and its size along x and y, and nothing else: where the object is along the third axis, how it is tipped and how deep it is stay as `make` left them.
- An entity that takes a despawned one's slot gets an object of its own.
- Nothing of this is in the world. A game loaded from a save, or an app that starts with entities, has its objects made on the first frame.
- It finds what is new and what is gone by looking at every entity of the kind each frame, which it does anyway to place them. It watches no component for changes, so it adds nothing to what a tick costs.

Objects that are made of a level's assets, a model, say, name the bundle they come `from`, and `make` is handed its assets as well:

```ts
const Deer = Three.objects("game/Deer", {
  of: Deer,
  from: Forest,
  make: (entity, { deer }) => clone(deer),
  free: (object) => object.clear(),
});
```

- There are objects while the app holds the bundle loaded. The frame it is, every entity of the kind gets its object, made of what is loaded; when it is let go, every object is taken out of the scene and handed to `free`, before the scene is next drawn. Loaded again, each is made again.
- The rest is as above, and as for [instances made of assets](#a-look-made-of-assets): it needs `Assets.plugin`, and nothing is drawn with what was let go.

## Between two ticks

```ts
const Rocks = Three.instances("game/Rocks", {
  of: Rock,
  geometry,
  material,
  smooth: true,
  snap: 50, // further than this in one tick is not a move, it is a jump
});
```

A game ticks sixty times a second and a screen shows as many frames as it likes, so the two do not line up: some frames follow one tick, some two, some none. Drawn where the last tick left it, a thing that moves evenly is seen to stutter. With `smooth: true`, `Three.instances` and `Three.objects` draw each entity between its last two places: at [`Frame.alpha`](../arcadekit/README.md#the-tick-and-the-frame) of the way from where it was a tick ago to where it is.

- It is what a game that runs in real time wants, and it is off unless asked for, because of what it means: the picture is up to one tick behind the game. Just after a tick, at an `alpha` of 0, an entity is drawn where it was before the tick. A game that is stepped by hand and drawn with `app.frame(0)`, as a test does, would see its last tick only at the next. A game that ticks when its player moves, run with `ticks: "whenNeeded"`, is told an `alpha` of 1 while it rests, and is drawn where it is.
- Places and sizes go straight from one to the other. A turn goes by the shorter way: a quaternion towards whichever of the other and its opposite is nearer; a flat game's angle by the shorter way round.
- An entity that was not drawn in the frame before is drawn where it is: one that is new, one in a slot that was another's, one that was hidden, and every entity in the first frame, after a load, or after a frame the system did not run in.
- `snap` is how far an entity may go in one tick and still be drawn on the way. One that went further, off one edge of the world and in at the other, say, is drawn where it is. Left out, any distance is a move. It is one distance per kind, in the units of the scene.
- When several ticks ran since the last frame, an entity comes from where it was last drawn from, which is further back than a tick: for that one frame it moves faster than it did. When none ran, it is between the same two places as the frame before.
- A place changed with no tick, by an action dispatched between two or by hand, is where the entity goes to from where it was coming from.
- What it keeps, the value each component had a tick ago, is the renderer's own, by entity, and no part of the world: a game drawn this way has the same hash, log and save as one that is not drawn at all.
- It costs a frame about 18 ns more per entity for a place, and 63 ns more for a place, a turn and a size; see [the benchmark](#benchmark).

## The scene, the camera and the renderer

```ts
const Look = Plugin.make("game/Look", {
  plugins: [Three.plugin],
  // Once, when the app is made: lights, and where the camera stands.
  layer: Layer.effectDiscard(
    Effect.map(Three.Scene, ({ scene, camera }) => {
      scene.add(new AmbientLight("#ffffff", 1));
      camera.position.set(0, 20, 40);
      camera.lookAt(0, 0, 0);
    })
  ),
  systems: [Rocks, Follow],
});

// Each frame, before the scene is drawn.
const Follow = System.make("game/Follow", function* () {
  const { camera } = yield* Three.Scene;
  camera.position.x = (yield* Player).x;
}).pipe(System.inStage("frame"));
```

`Three.plugin` gives an app a scene and draws it once per frame.

- `Three.Scene` is the service: `scene`, a Three.js `Scene`, and `camera`, a perspective camera at (0, 0, 10) until it is moved or replaced (`three.camera = new OrthographicCamera(...)`). It is what draws the game and not the game: nothing in a tick reads it, and none of it is saved.
- `Three.Render` is the system that draws. It is of the stage after a frame's own, [`"postFrame"`](../arcadekit/README.md#the-tick-and-the-frame), so every system of the frame stage has run when it does, wherever each is listed and with nothing said: `Three.instances` and `Three.objects`, and a frame system of the game's that moves the camera or anything else.
- `Three.Renderer` is what draws the scene, and comes from outside the app, since it needs a canvas. A game that installs `Three.plugin` and provides none does not compile.
- `Three.layerWebGL({ canvas, antialias: true })` is a page's: a `WebGLRenderer` with the parameters Three.js takes. `Three.layerRenderer(() => new WebGPURenderer({ canvas }))` is one of your own making. Either is disposed of when the scope it is provided to closes, so it is provided to the whole program, as `App.run` is above.
- The picture follows the size the canvas has on the page: when that changes the renderer is resized, without touching the canvas's style, and a perspective camera is given the new aspect. `fit: false` leaves it alone, and a camera of another kind is the game's to fit. `pixelRatio` is the page's own, up to 2, unless given.
- A test provides a renderer that draws nothing: `Layer.succeed(Three.Renderer, { render(scene, camera) {} })`. Three.js makes its scenes and meshes under Node as in a page, so what was put in the scene can be looked at.

## Names

- The services are keyed `"arcadekit/three/Scene"` and `"arcadekit/three/Renderer"`.
- The plugin is `"arcadekit/three"`, and the system that draws `"arcadekit/three/Render"`.
- A system made by `Three.instances` or `Three.objects` has the name it was given, which is one of the app's systems' and is the name of the mesh.

## Benchmark

10,000 entities, one frame, with a renderer that draws nothing: the work this package does before Three.js takes over. Medians after warm-up, on a cloud Linux VM, Node 22; the machine is shared and noisy, so trust the ratios more than the numbers.

| Variant | ns/entity | Bytes allocated per frame |
| --- | --- | --- |
| `Three.instances`: a position | 9.8 | 6,700 |
| `Three.instances`: a position and a scale | 11.2 | 7,400 |
| `Three.instances`: a position and a rotation | 15.0 | 7,400 |
| `Three.instances`: all three | 18.2 | 7,100 |
| `Three.instances`, flat: a position | 8.0 | 7,300 |
| `Three.instances`, flat: a position and a scale | 8.3 | 7,100 |
| `Three.instances`, flat: a position and a rotation | 35.7 | 7,200 |
| `Three.instances`, flat: all three | 35.9 | 7,200 |
| `Three.instances`, smooth: a position | 26.9 | 7,300 |
| `Three.instances`, smooth: all three | 71.8 | 7,300 |
| `Three.instances`, smooth, flat: a position | 23.1 | 7,300 |
| `Three.instances`, smooth, flat: all three | 82.5 | 7,300 |
| `Three.instances`, a colour each: a position | 14.7 | 7,400 |
| `Three.instances`, a colour each, as the renderer has it: a position | 10.9 | 7,400 |
| `Three.instances`, a colour each, smooth: a position | 44.7 | 7,800 |
| `Three.instances`, a look made of assets: a position | 8.7 | 8,000 |
| `Three.objects`: an Object3D each, all three copied | 163.0 | 5,700 |
| `Three.objects`, flat: an Object3D each, all three copied | 167.8 | 5,700 |
| By hand: `world.get` and `setMatrixAt`, per entity | 361.6 | 2,480,000 |

- Ten thousand moving objects, drawn where the last tick left them, cost 0.08 to 0.36 ms of a frame. The seven kilobytes are the frame itself, the same for one entity as for ten thousand: under one byte per object. They were five before a flat game's four loops were added: eight queries are asked for each frame where there were four.
- A flat entity that is not turned costs a little less than one in three dimensions. One that is turned costs twice as much, 36 ns: a sine and a cosine each, where a quaternion is a few multiplications. A flat game with a crowd that spins pays 0.36 ms for ten thousand.
- Drawn between two ticks, an entity costs about three times as much for a place, 27 ns, and four times for all three, 72 ns: each value is read, kept, and blended with the one before, in a pass of its own before the matrix is written. Ten thousand of them cost 0.27 to 0.83 ms of a frame, and still nothing is allocated per entity.
- A colour each costs about 6 ns more per entity: three more reads, three looks in the table that converts it, one test that it is a colour, and three writes. As the renderer has it, with `colorSpace: "srgb-linear"`, it costs 2 ns: the reads and the writes. Blended between two ticks it costs 22 ns more, as much as blending the place does, since it is the same pass over three other numbers.
- A look that is made of assets costs an entity nothing: the loops are the same. What it costs is asked once a frame, by the system and again before the scene is drawn, whether the assets are still there, and with the system that keeps the bundle that is under a kilobyte and too little time to measure here.
- A test holds the system to that, with and without `smooth` and with a colour each: 10,000 moving objects, of all eight kinds, may grow the heap by less than 4 bytes each per tick and frame, where one number allocated per object would be 12.
- An object each costs ten to twenty times an instance, most of it Three.js keeping an object's Euler angles in step with its quaternion. That is the price of an object, and why a crowd is instances.
- The example page, with 10,000 lit cubes in headless Chromium, grew its heap by 7 to 58 KB a frame, the renderer's own allocations included, and by 17 KB with a hundred cubes: what a frame allocates does not grow with what it draws. That browser draws in software, at 3 to 6 frames a second for 10,000 cubes and 60 for a hundred, so it says nothing of how fast a graphics card draws them.

## Not done yet

- Drawing between two ticks is one setting and one distance per kind. An entity cannot say for itself that it jumped, a kind cannot be drawn ahead of the game in place of behind it, and the blending is a pass of its own that costs more than it has to: one check per entity per component, where one per entity would do.
- An instance has a place and a colour and nothing else: no opacity of its own, since a colour is three numbers, and no other attribute per instance, a frame of a sheet of sprites, say.
- A colour is for instances. `Three.objects` reads none: an object's colour is its material's, which is the game's to set in a frame system of its own.
- A flat game's entities are all at 0 of the third axis. What is in front is said per kind, by its mesh or its objects; an entity has no depth or layer of its own, and nothing sorts them.
- The two transforms do not mix: an entity placed in the plane is not turned by a quaternion, and one placed in three dimensions is not turned by an angle.
- One kind of entity is one geometry and one material: given when the system is made, or made of one bundle's assets while that bundle is loaded. A look does not change for any other reason, a setting of the player's, say, and an entity cannot say for itself which of several looks it has: that is a kind per look.
- While a kind's bundle is loading nothing of the kind is drawn: there is no look to stand in for the one that is on its way.
- A model is drawn as it stands. Its animations are loaded and not played: there is no mixer here, and one that is skinned needs more than `scene.clone()` to be copied, which is the game's to bring (`SkeletonUtils.clone` of Three.js).
- A compressed model, with Draco, meshopt or KTX2 pictures, needs its decoder given to the loader in `prepare`, and that decoder fetches its own files, which do not come through `Assets.Loader`.
- An asset of the game's own made around another loader of Three.js, an FBX's, say, fetches what that loader fetches for itself: only a glTF model's files are brought through `Assets.Loader` here.
- Instances are in no order, so a material that needs its instances sorted back to front is not served.
- A mesh of instances is never culled as a whole unless `prepare` says how.
- Nothing is a child of anything: an entity's place is its place in the scene. An object that hangs from another is the game's to arrange in `make`.
- `Three.layerRenderer` takes a renderer that is ready to draw. `WebGPURenderer` has to be initialised first, which is the game's to wait for.
- No test in CI opens a page: `Three.layerWebGL` itself, the one line that makes a `WebGLRenderer`, is tried by hand in headless Chromium with the example page.
