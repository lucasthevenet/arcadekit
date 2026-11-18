---
title: "Instances and objects"
description: "The two systems of @arcadekit/three that draw a kind of thing: Three.instances draws a crowd as one mesh, and Three.objects keeps one Object3D per entity."
---

[`@arcadekit/three`](drawing-with-three.md) draws a kind of thing with one of two systems of the frame stage. `Three.instances` draws every entity of a kind as one instance of one mesh: it is for a crowd. `Three.objects` keeps one `Object3D` per entity: it is for the few things that are more than a copy of one mesh.

Both tell what to draw from the components an entity has, and where from its [`Transform3d` or `Transform2d`](drawing-with-three.md#where-a-thing-is). The rules say what a thing is, never how it looks.

## Instances

```ts title="look.ts"
import { Three } from "@arcadekit/three";
import { Component, Field } from "arcadekit";
import { IcosahedronGeometry, MeshStandardMaterial } from "three";

const Rock = Component.tag("game/Rock");
const Lit = Component.tag("game/Lit");
const Hidden = Component.tag("game/Hidden");

const geometry = new IcosahedronGeometry(1);

const Rocks = Three.instances("game/Rocks", {
  of: [Rock, Lit], // or one: Rock
  without: [Hidden],
  geometry,
  material: new MeshStandardMaterial({ color: "#8a8f98" }),
  capacity: 4096,
  prepare: (mesh) => {
    mesh.castShadow = true;
  },
});
```

`Three.instances` draws every entity of a kind as one instance of one `InstancedMesh`. An entity is one of them while it has every component `of` names, none of `without`, and a `Position`.

- Each frame it reads the columns raw and writes one matrix per entity straight into the mesh's instance buffer. No object, matrix or vector is made per entity, and nothing is allocated per entity per frame. Ten thousand moving objects cost 0.1 to 0.4 ms of a frame before Three.js takes over.
- The buffer has room for `capacity` instances, 256 unless told, and doubles when it runs out. That is the one time the system allocates.
- The mesh is made on the first frame, named after the system, and added to the scene. It is not culled, since its instances are wherever the entities are. `prepare` is handed the mesh once, to say otherwise or to set anything else.
- The entities are drawn where the last tick left them, or, with `smooth: true`, [between their last two places](between-two-ticks.md).
- A geometry and a material given this way are there when the system is made. A level's are [made of its assets](textures-and-models.md), while its bundle is loaded.

When the app's scope closes the mesh is taken out of the scene and disposed of. The geometry and the material are yours, to share between several kinds and to dispose of. Nothing here does, and nothing says when one was forgotten.

## A colour each

```ts title="look.ts"
// The rules: a colour is three numbers, as a place is.
const Paint = Component.define("game/Paint", {
  r: Field.f32,
  g: Field.f32,
  b: Field.f32,
});

// The page: every rock is drawn in its own.
const Painted = Three.instances("game/Painted", {
  of: Rock,
  geometry,
  material: new MeshStandardMaterial({ color: "#ffffff" }),
  color: Paint,
});
```

`color` names a component of the game's that gives each instance a colour of its own. `@arcadekit/three` defines none: what colour a thing is, a team's or how hurt it is, is the game's to say, and its rules write it as they write a place.

- Any component kept in a table with the fields `r`, `g` and `b` is a colour, whatever else it has. Anything else given as one throws when the system is made, and is a type error before that.
- An entity is then one of the kind only while it has the colour too. One with no colour is not drawn by this system.
- The material's own colour is multiplied by it, so a white material is drawn in exactly the instance's.
- The numbers are a colour as a hex code writes it: `#ff6188` is an `r` of `0xff / 255`, a `g` of `0x61 / 255` and a `b` of `0x88 / 255`, from 0 to 1 in fields of floats. A component whose three fields are whole numbers, `Field.u8`, holds the bytes themselves, 0 to 255. The three are all one or all the other, which is checked when the system is made.
- A renderer works in linear colour, so each number is converted: a byte exactly, and a float to a sixteenth of a byte.
- A number off either end, a 255 in a field of floats or a 300 in one of whole numbers, is no colour: the frame fails with an error that names the entity and its three numbers.
- `colorSpace: "srgb-linear"` says the numbers are the renderer's own instead, what `new Color("#ff6188")` of Three.js has as its `r`, `g` and `b`. They are handed over as they are, bytes over 255, and nothing is checked: a number over 1 is brighter than white, which a renderer that blooms can show. `"srgb"`, the other name Three.js gives, is what is assumed.
- It costs about 6 ns more per entity, most of it the conversion, and nothing is allocated.
- With `smooth: true` a colour changes evenly between two ticks, as a place does, and `snap` does not apply to it: a colour is never too far to go to. It changes in the numbers the game has, and is converted then: halfway between two hex codes is the code halfway between them.

## Objects

```ts title="look.ts"
import { BoxGeometry, Mesh } from "three";

const Ship = Component.tag("game/Ship");

const hull = new BoxGeometry(1, 1, 3);
const paint = new MeshStandardMaterial({ color: "#d0d4dc" });

const Ships = Three.objects("game/Ships", {
  of: Ship,
  make: (entity) => new Mesh(hull, paint),
  free: (ship) => ship.clear(),
});
```

`Three.objects` keeps one `Object3D` per entity of a kind: a model with parts, a light, something that carries the camera. It takes `of`, `without`, `smooth` and `snap` as instances do.

- `make` is called the first frame an entity is one of these, and its object is added to the scene. The frame it no longer is, or is gone, the object is taken out and `free` is called with it. Whatever is left when the app's scope closes is freed then.
- Each frame every object is given its entity's `Position`, and its `Rotation` and `Scale` if the entity has them. A rotation of any length is given as a quaternion of length 1. An entity that loses one is drawn as one that never had it.
- What else there is to an object is the game's: set in `make`, or by a frame system of its own.
- An entity placed with `Transform2d` has its object's x and y set, its turn about the third axis, and its size along x and y, and nothing else: where the object is along the third axis, how it is tipped and how deep it is stay as `make` left them.
- An entity that takes a despawned one's slot gets an object of its own.
- Nothing of this is in the world. A game loaded from a save, or an app that starts with entities, has its objects made on the first frame.
- It finds what is new and what is gone by looking at every entity of the kind each frame, which it does anyway to place them. It watches no component for changes, so it adds nothing to what a tick costs.

What `make` made is the game's to dispose of, through `free`. Nothing here does, and nothing says when one was forgotten.

Objects made of a level's assets, a model, say, name the bundle they come `from`: see [textures and models](textures-and-models.md).

## Read more

- [`Three.instances`](/reference/three/Three#instances) and [`Three.objects`](/reference/three/Three#objects) in the API reference.
- [`packages/three/examples/page`](../../../../../packages/three/examples/page): ten thousand moving objects.
