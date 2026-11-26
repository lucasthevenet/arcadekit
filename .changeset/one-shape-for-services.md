---
"arcadekit": minor
"@arcadekit/three": minor
---

Every service a program provides from outside an app has one shape: its key is the entry it is imported from and its name, `X.layer(implementation)` provides it, and its module makes the stand-in a test provides in its place. A new module, `arcadekit/Test`, makes a game's app with those stand-ins and hands them back beside it:

```ts
Effect.gen(function* () {
  const game = yield* Test.make(Rogue, {
    seed: 7,
    files: { "/one.json": level },
  });
  game.input.press("KeyW");
  yield* game.step(); // the input stage, one tick, the frame stage
  yield* game.rest(); // steps until the app is settled
  game.sound.played;
  game.ui.get(Hud);
});
```

`Driver.layer(display)`, `Assets.layer(loader)` with `Assets.makeMemory(files)`, and `Three.layer(renderer)` with `Three.makeRecorder()` are new. The entries' tests of both packages hold every service to the shape.

**Breaking**

- `Assets.layerMemory(files)` is `Assets.layer(Assets.makeMemory(files))`.
- `View.layer(game, mount)` is `View.mount(game, mount)`: it provides nothing a system asks for.
- A hub has no `layer`: `hub.layer(peer)` is `Transport.layer(hub.port(peer))`.
- A renderer made by hand is `Three.layer({ render(scene, camera) {} })`, where it was `Layer.succeed(Three.Renderer, ...)`, and a test records what is drawn with `Three.makeRecorder()`.
- The keys of the services are their entries and names, so a service of a game's own never takes one: `"arcadekit/World"` is `"arcadekit/Services.World"`, and so for `Sim`, `Time`, `Frame`, `Commands`, `Events` and `Random`; `"arcadekit/Actions"` is `"arcadekit/Action.Actions"`, `"arcadekit/Display"` is `"arcadekit/Driver.Display"`, `"arcadekit/Transport"` is `"arcadekit/net/Transport.Transport"`, and `"arcadekit/three/Scene"` and `"arcadekit/three/Renderer"` are `"@arcadekit/three/Scene.Scene"` and `"@arcadekit/three/Renderer.Renderer"`.
