---
"@arcadekit/three": minor
---

A flat game draws with `Three` alone. `Three.camera2d(name, { height, follow, within, smooth, snap })` is a frame-stage system that views the game's plane through an orthographic camera whose unit is the game's, fitted to the canvas's shape each frame and held inside a level's bounds. With `smooth`, it follows its entity through `Transform2d.smooth`, the store a kind drawn with `smooth` draws from, so the two agree; its camera is a `System.local`, each app its own. `Three.toPlane(point)` returns the place of the plane under a point of the canvas, such as the pointer, through the camera the scene was last drawn with, for an input-stage system to put in an action. `Three.sprite(texture, { width, height })` makes the look of a picture on a quad. `Three.Scene` holds the canvas's `size`, which `Three.plugin` reads at the start of each frame from `Three.Renderer`'s new optional `size`, and `Three.makeRecorder(canvas)` stands for a canvas of a given size. The modules `@arcadekit/three/Camera` and `@arcadekit/three/Sprite` give the same exports.

**Breaking**

- `Gltf.instances(name, { from, look, … })` is now `Three.instancesFrom(name, { from, look, … })`, and `Gltf.objects(name, { from, make, … })` is now `Three.objectsFrom(name, { from, make, … })`. The options are the same. A game whose bundles hold textures alone no longer imports `Gltf`, nor Three.js's glTF loader with it. `Gltf` keeps `model` and `mesh`.
- Their option types `Gltf.InstancesOptions` and `Gltf.ObjectsOptions` are now `Three.InstancesFromOptions` and `Three.ObjectsFromOptions`.
- `Three.SceneShape` has a `size` field. Code that builds a `SceneShape` of its own gives it one, such as `size: { width: 0, height: 0 }`.
