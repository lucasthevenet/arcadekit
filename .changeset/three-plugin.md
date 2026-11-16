---
"@arcadekit/three": minor
---

A new package: draws an arcadekit game with Three.js.

- It draws from arcadekit's own components for where a thing is, `arcadekit/Transform`, and has none of its own: the plugins that hold a game's rules, a server and a replay import nothing of this package and install no renderer.
- `Three.instances(name, { of, geometry, material })` draws every entity of a kind, where its `Transform.Position` says and turned and sized by its `Transform.Rotation` and `Transform.Scale`, as one instance of one mesh: a system of the frame stage that reads the columns raw and writes one matrix per entity straight into the mesh's buffer. Nothing is allocated per entity per frame: ten thousand moving objects cost about 0.1 to 0.2 ms a frame before Three.js takes over.
- `Three.objects(name, { of, make, free })` keeps one Object3D per entity, made when the entity first matches and let go when it no longer does, and copies the entity's place into it each frame.
- `Three.plugin` gives an app a scene and a camera, `Three.Scene`, and draws them once per frame with `Three.Render`, through `Three.Renderer`, which comes from outside: `Three.layerWebGL({ canvas })` in a page, fitted to the size the canvas has there, or `Three.layerRenderer(make)` for a renderer of your own.
- All of it runs in the frame stage and reads the world: a game that is drawn has the same hash, log and save as one that is not.

Nothing breaks: the package is new. It needs `arcadekit`, `effect` and `three` as peers.
