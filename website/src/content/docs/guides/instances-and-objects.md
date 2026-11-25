---
title: "Instances and objects"
description: "@arcadekit/three draws each kind of entity with one of two systems: Three.instances draws a crowd as one mesh, and Three.objects keeps one Object3D per entity."
---

[`@arcadekit/three`](drawing-with-three.md) draws each kind of entity with one of two frame-stage systems. **`Three.instances`** draws every entity of a kind as an instance of one mesh, for crowds. **`Three.objects`** keeps one `Object3D` per entity, for the few entities that are more than a copy of one mesh.

Both decide what to draw from the components an entity has, and where to draw it from the [`Transform3d` or `Transform2d`](drawing-with-three.md#place-rotate-and-scale-an-entity) that the kind names. The rules say what an entity is, never how it looks.

## Draw a crowd as instances

```ts title="look.ts"
import { Three } from "@arcadekit/three";
import { Color, Component, Field, Transform3d } from "arcadekit";
import { IcosahedronGeometry, MeshStandardMaterial } from "three";

const Rock = Component.tag("game/Rock", { requires: [Transform3d.Position] });
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

- A component in `of` [requires](components.md#require-other-components) that `Position`, so that every entity spawned with it has one. A kind whose `of` doesn't require it doesn't compile.
- `transform` names the module whose components place the kind's entities: `Transform3d`, or `Transform2d` for entities drawn in the x-y plane. It has no default, so a kind that leaves it out doesn't compile. A kind reads nothing of the other module. An entity with both positions is drawn by a kind of each, from that kind's own position.
- Each frame, the system reads the columns raw and writes one matrix per entity into the mesh's instance buffer. It creates no object, matrix, or vector per entity, and allocates nothing per entity per frame. Ten thousand moving objects cost 0.1 to 0.4 ms of a frame, not counting Three.js's own drawing. See [drawing performance](drawing-performance.md).
- The buffer has room for `capacity` instances, 256 by default, and doubles when it fills up. The system allocates only then.
- The system creates the mesh on the first frame, names it after itself, and adds it to the scene. The mesh isn't frustum-culled, because its instances can be anywhere. `prepare` receives the mesh once, to change that setting or any other. Instances are drawn in no particular order.
- Entities are drawn where the last tick left them or, with `smooth: true`, [interpolated between their last two positions](between-two-ticks.md).
- A geometry and a material passed this way exist when the system is made. A level's geometry and material are [built from its assets](textures-and-models.md) while its bundle is loaded.

When the app is closed, the mesh is removed from the scene and disposed of. So are its geometry and material, once no other system draws with them, so you can share them between kinds.

## Colour each instance

```ts title="look.ts"
// Every rock is drawn in the colour its entity has.
const Painted = Three.instances("game/Painted", {
  of: Rock,
  transform: Transform3d,
  geometry,
  material: new MeshStandardMaterial({ color: "#ffffff" }),
  color: Color.Rgb,
});
```

`color` gives each instance the colour its entity has, from arcadekit's colour component, [`Color.Rgb`](/reference/arcadekit/Color#rgb). Like `Transform3d`, it belongs to arcadekit and not to this package, because an entity's colour, such as its team's or how damaged it is, is part of your game. The rules write it as they write a position: `commands.spawn(Rock, Transform3d.Position, Color.Rgb.of({ r: 1, g: 0.5, b: 0, space: Color.Srgb }))`. A component of your game's own doesn't compile as `color`, whatever its fields.

A colour's `space` says how its numbers are drawn, [`Color.Srgb`](/reference/arcadekit/Color#srgb) or [`Color.Linear`](/reference/arcadekit/Color#linear). Each entity's colour is drawn in its own space, so entities of one kind can have either.

- An entity without the colour is drawn in the material's own colour, as if its colour were white. Giving some entities a colour changes how those look, and hides none.
- The system multiplies the material's colour by the instance's, so a white material is drawn in exactly the instance's colour. The colour is white when added bare.
- A colour in `Color.Srgb` is written as a hex code writes it, each number from 0 to 1. `#ff6188` is an `r` of `0xff / 255`, a `g` of `0x61 / 255`, and a `b` of `0x88 / 255`. Renderers work in linear colour, so the system converts each number. It converts a hex code's byte exactly, and any other number to within a sixteenth of a byte.
- A number below 0 in `Color.Srgb` is drawn as 0, and one over 1 as 1, as CSS clamps an sRGB colour. A byte that wasn't divided by 255 is drawn as 1.
- NaN or an infinity in `Color.Srgb`, such as a division by zero leaves, isn't a colour. `Three.instances` fails the frame with an error that names the entity and its three numbers.
- A colour in `Color.Linear` is the renderer's own numbers, which Three.js's `new Color("#ff6188")` holds as its `r`, `g`, and `b`. The system passes them through unchanged, whatever they are. A number over 1 is brighter than white, which a renderer with bloom can show.
- A colour costs about 9 ns more per entity in `Color.Srgb`, mostly the conversion, and 5 ns more in `Color.Linear`. It allocates nothing.
- With `smooth: true`, a colour is interpolated between two ticks like a position. `snap` doesn't apply to it, so no colour change is too large to interpolate. The system interpolates in your game's numbers and then converts them by the space the colour has at the later tick, so halfway between two hex codes is the hex code halfway between them.

## Keep one object per entity

```ts title="look.ts"
import { BoxGeometry, Mesh } from "three";

const Ship = Component.tag("game/Ship", { requires: [Transform3d.Position] });

const hull = new BoxGeometry(1, 1, 3);
const paint = new MeshStandardMaterial({ color: "#d0d4dc" });

const Ships = Three.objects("game/Ships", {
  of: Ship,
  transform: Transform3d,
  make: (entity) => new Mesh(hull, paint),
  free: (ship) => ship.clear(),
});
```

`Three.objects` keeps one `Object3D` per entity of a kind, such as a model with parts, a light, or something that carries the camera. Like `Three.instances`, it accepts `of`, `transform`, `without`, `smooth`, and `snap`.

- The system calls `make` on the first frame an entity belongs to the kind, and adds its object to the scene. On the frame the entity no longer belongs or is despawned, the system removes the object and passes it to `free`. Anything left when the app is closed is freed then.
- Each frame, every object receives its entity's `Position`, and its `Rotation` and `Scale` if the entity has them. A rotation of any length is applied as a unit quaternion. An entity that loses one is drawn as if it never had it.
- Set everything else about an object, its colour included, in `make` or in a frame system of your own. An object's colour is its material's.
- For a kind of `Transform2d`, an object gets x and y, its rotation about the z axis, and its scale along x and y. Its z position, its tilt, and its scale along z stay as `make` left them.
- Objects aren't nested in the scene. An entity's position is its position in the scene, not relative to a parent. Attach child objects to an object in `make`.
- An entity that reuses a despawned entity's slot gets its own object.
- None of this is stored in the world. A game loaded from a save, or an app that starts with entities, creates its objects on the first frame.
- The system finds new and removed entities by visiting every entity of the kind each frame, as it does anyway to place them. It watches no component for changes, so it adds nothing to the cost of a tick.

The system disposes of the geometries and materials of what `make` creates when the app is closed or the bundle they were made from is released, once no other system draws with them. Use `free` to dispose of what one entity's object alone uses as soon as the entity goes, such as a material made for it. Use it also for anything else that `make` created, such as a texture.

Objects built from a level's assets, such as a model, name the bundle they come `from`. See [textures and models](textures-and-models.md).

## Read more

- [`Three.instances`](/reference/three/Three#instances) and [`Three.objects`](/reference/three/Three#objects) in the API reference.
- [`packages/three/examples/page`](../../../../../packages/three/examples/page): ten thousand moving objects.
