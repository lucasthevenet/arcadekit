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
import { Three } from "@arcadekit/three"; // or
import * as Three from "@arcadekit/three/Three";
```

| Entry | What it has | Imports |
| --- | --- | --- |
| `@arcadekit/three` | The module below, as `import { Three } from "@arcadekit/three"` | `arcadekit`, `effect`, `three` |
| `@arcadekit/three/Three` | The plugin, the scene, the renderer, `instances` and `objects` | `arcadekit`, `effect`, `three` |

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

- An entity is drawn where its `Transform3d.Position` says, in the units of the scene. `Transform3d.Rotation`, a unit quaternion, and `Transform3d.Scale`, where 1 is the size of the geometry, are for the entities that turn or have a size of their own: one without them is drawn upright, at the size of its geometry, and costs less to draw.
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
- The entities are drawn where the last tick left them. See [Not done yet](#not-done-yet).

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
}).pipe(System.inStage("frame"), System.before(Three.Render));
```

`Three.plugin` gives an app a scene and draws it once per frame.

- `Three.Scene` is the service: `scene`, a Three.js `Scene`, and `camera`, a perspective camera at (0, 0, 10) until it is moved or replaced (`three.camera = new OrthographicCamera(...)`). It is what draws the game and not the game: nothing in a tick reads it, and none of it is saved.
- `Three.Render` is the system that draws. `Three.instances` and `Three.objects` run before it, wherever they are listed. A frame system of the game's that moves the camera or anything else says `System.before(Three.Render)`.
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
| `Three.instances`: a position and a rotation | 12.8 | 7,400 |
| `Three.instances`: all three | 18.2 | 7,100 |
| `Three.instances`, flat: a position | 8.0 | 7,300 |
| `Three.instances`, flat: a position and a scale | 8.3 | 7,100 |
| `Three.instances`, flat: a position and a rotation | 35.7 | 7,200 |
| `Three.instances`, flat: all three | 35.9 | 7,200 |
| `Three.objects`: an Object3D each, all three copied | 163.0 | 5,700 |
| `Three.objects`, flat: an Object3D each, all three copied | 167.8 | 5,700 |
| By hand: `world.get` and `setMatrixAt`, per entity | 361.6 | 2,480,000 |

- Ten thousand moving objects cost 0.08 to 0.36 ms of a frame. The seven kilobytes are the frame itself, the same for one entity as for ten thousand: under one byte per object. They were five before a flat game's four loops were added: eight queries are asked for each frame where there were four.
- A flat entity that is not turned costs a little less than one in three dimensions. One that is turned costs twice as much, 36 ns: a sine and a cosine each, where a quaternion is a few multiplications. A flat game with a crowd that spins pays 0.36 ms for ten thousand.
- A test holds the system to that: 10,000 moving objects, of all eight kinds, may grow the heap by less than 4 bytes each per tick and frame, where one number allocated per object would be 12.
- An object each costs ten to twenty times an instance, most of it Three.js keeping an object's Euler angles in step with its quaternion. That is the price of an object, and why a crowd is instances.
- The example page, with 10,000 lit cubes in headless Chromium, grew its heap by 7 to 58 KB a frame, the renderer's own allocations included, and by 17 KB with a hundred cubes: what a frame allocates does not grow with what it draws. That browser draws in software, at 3 to 6 frames a second for 10,000 cubes and 60 for a hundred, so it says nothing of how fast a graphics card draws them.

## Not done yet

- The entities are drawn where the last tick left them. A game whose ticks and frames do not line up sees that as a stutter; drawing each thing between its last two places needs the place before, which nothing keeps yet.
- An instance has a place and nothing else: no colour of its own, and no other attribute per instance.
- A flat game's entities are all at 0 of the third axis. What is in front is said per kind, by its mesh or its objects; an entity has no depth or layer of its own, and nothing sorts them.
- The two transforms do not mix: an entity placed in the plane is not turned by a quaternion, and one placed in three dimensions is not turned by an angle.
- One kind of entity is one geometry and one material, fixed when the system is made. A kind whose look comes from an asset that is loaded later has no helper.
- Instances are in no order, so a material that needs its instances sorted back to front is not served.
- A mesh of instances is never culled as a whole unless `prepare` says how.
- Nothing is a child of anything: an entity's place is its place in the scene. An object that hangs from another is the game's to arrange in `make`.
- A `Rotation` has to be a unit quaternion. One that is not draws skewed, and nothing checks.
- `Three.layerRenderer` takes a renderer that is ready to draw. `WebGPURenderer` has to be initialised first, which is the game's to wait for.
- No test in CI opens a page: `Three.layerWebGL` itself, the one line that makes a `WebGLRenderer`, is tried by hand in headless Chromium with the example page.
