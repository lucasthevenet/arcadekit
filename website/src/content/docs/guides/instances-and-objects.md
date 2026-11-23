---
title: "Instances and objects"
description: "@arcadekit/three draws each kind of entity with one of two systems: Three.instances draws a crowd as one mesh, and Three.objects keeps one Object3D per entity."
---

[`@arcadekit/three`](drawing-with-three.md) draws each kind of entity with one of two frame-stage systems. **`Three.instances`** draws every entity of a kind as an instance of one mesh, for crowds. **`Three.objects`** keeps one `Object3D` per entity, for the few entities that are more than a copy of one mesh.

Both decide what to draw from the components an entity has, and where from the [`Transform3d` or `Transform2d`](drawing-with-three.md#position-rotation-and-scale) the kind names. The rules say what an entity is, never how it looks.

## Instances

```ts title="look.ts"
import { Three } from "@arcadekit/three";
import { Color, Component, Field, Transform3d } from "arcadekit";
import { IcosahedronGeometry, MeshStandardMaterial } from "three";

const Rock = Component.tag("game/Rock");
const Lit = Component.tag("game/Lit");
const Hidden = Component.tag("game/Hidden");

const geometry = new IcosahedronGeometry(1);

const Rocks = Three.instances("game/Rocks", {
  of: [Rock, Lit], // or a single component: Rock
  transform: Transform3d, // or Transform2d, for a flat game
  without: [Hidden],
  geometry,
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
  capacity: 4096,
  prepare: (mesh) => {
    mesh.castShadow = true;
  },
});
```

`Three.instances` draws every entity of a kind as an instance of one `InstancedMesh`. An entity belongs to the kind while it has every component in `of`, none in `without`, and the `Position` of the kind's `transform`.

- `transform` names the module whose components place the kind's entities: `Transform3d`, or `Transform2d`, whose entities are drawn in the x–y plane. It has no default, so a kind that leaves it out doesn't compile. A kind reads nothing of the other module: an entity with both positions is drawn by a kind of each, each from its own.

- Each frame, it reads the columns raw and writes one matrix per entity straight into the mesh's instance buffer. It creates no object, matrix or vector per entity, and allocates nothing per entity per frame. Ten thousand moving objects cost 0.1 to 0.4 ms of a frame before Three.js takes over.
- The buffer has room for `capacity` instances, 256 by default, and doubles when it fills up. That is the only time the system allocates.
- The mesh is created on the first frame, named after the system, and added to the scene. It isn't frustum-culled, since its instances can be anywhere; `prepare` receives the mesh once, to change that or set anything else. Instances are drawn in no particular order.
- Entities are drawn where the last tick left them or, with `smooth: true`, [interpolated between their last two positions](between-two-ticks.md).
- A geometry and material passed this way exist when the system is created. A level's are [built from its assets](textures-and-models.md) while its bundle is loaded.

When the app's scope closes, the mesh is removed from the scene and disposed. So are its geometry and material, once no other system draws with them: share them between kinds freely.

## Per-instance colour

```ts title="look.ts"
// Every rock is drawn in the colour its entity has.
const Painted = Three.instances("game/Painted", {
  of: Rock,
  transform: Transform3d,
  geometry,
  material: new MeshStandardMaterial({ color: "#ffffff" }),
  color: Color.Srgb,
});
```

`color` gives each instance the colour its entity has, from one of arcadekit's two colour components, [`Color.Srgb`](/reference/arcadekit/Color#srgb) or [`Color.Linear`](/reference/arcadekit/Color#linear). Like `Transform3d`, they are arcadekit's and not this package's, since what colour an entity is, such as its team's or how damaged it is, is up to your game. Its rules write it as they write a position, `commands.spawn(Rock, Transform3d.Position, Color.Srgb.of({ r: 1, g: 0.5, b: 0 }))`. A component of your game's own doesn't compile as `color`, whatever its fields.

- An entity without the colour is drawn in the material's own colour, as if its colour were white. Giving some entities a colour changes how those look, and hides none. An entity that has the other of the two is one without.
- The material's colour is multiplied by it, so a white material is drawn in exactly the instance's colour. Added bare, either is white.
- `Color.Srgb` holds a colour as a hex code writes it, each number from 0 to 1: `#ff6188` is an `r` of `0xff / 255`, a `g` of `0x61 / 255` and a `b` of `0x88 / 255`. Renderers work in linear colour, so each number is converted: a hex code's byte exactly, and any other number to within a sixteenth of a byte.
- A number below 0 or over 1 in a `Color.Srgb`, such as a byte that wasn't divided by 255, isn't a colour: the frame fails with an error naming the entity and its three numbers.
- `Color.Linear` holds the renderer's own numbers, what `new Color("#ff6188")` of Three.js holds as its `r`, `g` and `b`. They are passed through as they are, whatever they are: a number over 1 is brighter than white, which a renderer with bloom can show.
- It costs about 6 ns more per entity for a `Color.Srgb`, mostly the conversion, and 2 ns for a `Color.Linear`. It allocates nothing.
- With `smooth: true`, a colour is interpolated between two ticks like a position, and `snap` doesn't apply to it: a colour change is never too large to interpolate. It is interpolated in your game's numbers and then converted, so halfway between two hex codes is the hex code halfway between them.

## Objects

```ts title="look.ts"
import { BoxGeometry, Mesh } from "three";

const Ship = Component.tag("game/Ship");

const hull = new BoxGeometry(1, 1, 3);
const paint = new MeshStandardMaterial({ color: "#d0d4dc" });

const Ships = Three.objects("game/Ships", {
  of: Ship,
  transform: Transform3d,
  make: (entity) => new Mesh(hull, paint),
  free: (ship) => ship.clear(),
});
```

`Three.objects` keeps one `Object3D` per entity of a kind: a model with parts, a light, something that carries the camera. It accepts `of`, `transform`, `without`, `smooth` and `snap`, like instances.

- `make` is called on the first frame an entity belongs to the kind, and its object is added to the scene. On the frame it no longer belongs, or is despawned, the object is removed and passed to `free`. Anything left when the app's scope closes is freed then.
- Each frame, every object receives its entity's `Position`, and its `Rotation` and `Scale` if the entity has them. A rotation of any length is applied as a unit quaternion. An entity that loses one is drawn as if it never had it.
- Everything else about an object is up to your game: set it in `make`, or in a frame system of your own, including its colour, which is its material's.
- For a kind of `Transform2d`, an object gets x and y, its rotation about the third axis, and its scale along x and y. Its position on the third axis, its tilt and its depth stay as `make` left them.
- Objects are flat in the scene: an entity's position is its position in the scene, not relative to a parent. Attach child objects to an object in `make`.
- An entity that reuses a despawned entity's slot gets its own object.
- None of this is stored in the world. A game loaded from a save, or an app that starts with entities, creates its objects on the first frame.
- It finds new and removed entities by visiting every entity of the kind each frame, which it does anyway to place them. It watches no component for changes, so it adds nothing to the cost of a tick.

The geometries and materials of what `make` creates are disposed of when the app's scope closes, or the bundle they were made from is released, once no other system draws with them. Use `free` to dispose of what one entity's object alone uses as soon as the entity goes, such as a material made for it, and of anything else `make` created, such as a texture.

Objects built from a level's assets, such as a model, name the bundle they come `from`: see [textures and models](textures-and-models.md).

## Read more

- [`Three.instances`](/reference/three/Three#instances) and [`Three.objects`](/reference/three/Three#objects) in the API reference.
- [`packages/three/examples/page`](../../../../../packages/three/examples/page): ten thousand moving objects.
