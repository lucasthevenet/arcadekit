---
"arcadekit": minor
---

The engine loader and the content loader are gone. A game's engine, its assets and its content are declarations ([ADR-0020](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0020-a-game-is-declared.md)), and no game used the loaders any more.

**Breaking**

`arcadekit/runtime/browser` no longer exports `makeEngineLoader`, `EngineLoader`, `LoadedEngine` or `engineOf`, and `arcadekit/content` no longer exports `makeContentLoader` or `ContentLoader`. What to write in place of each, as `@arcadekit/push-puzzle` does in [`src/browser/game.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/browser/game.ts) and [`src/content.ts`](https://github.com/lucasthevenet/arcadekit/blob/main/packages/push-puzzle/src/content.ts):

- `makeEngineLoader({ assets, game, release })`: declare what it loaded as an `Asset` (`arcadekit/content`), with its `release`, and the engine as a `Game.Engine` (`arcadekit/game/browser`) over the game's `Game.Simulation`, with the asset's load in `uses`. The app gives the asset's layer the load it passed as `assets`. The engine exists before its assets: each attach loads them, or takes what is already loaded.

  ```ts
  export class MySheet extends Asset<SpriteSheet, SpriteSheetError>()(
    "MySheet",
    { release: (sheet) => sheet.dispose() }
  ) {}

  export class MyEngine extends Game.Engine("MyEngine", {
    simulation: MyGame,
    uses: { sheet: MySheet.load },
    view: (container, { sheet }) => new MyView(container, sheet),
    input: myInput,
  }) {}

  // The app provides both. Building the layers loads nothing.
  const resources = Layer.mergeAll(
    MyEngine.layer,
    MySheet.layer(loadSpriteSheet("/sprites/my-game.json"))
  );
  ```

  Its `frames` option is the `Game.Frames` reference: `Layer.succeed(Game.Frames, manualFrames())`.

- `EngineLoader`: the class `Game.Engine` returns is the engine service's key, and its `layer` provides the service. A genre writes no service and no layer maker for it.
- `LoadedEngine`: `yield* MyEngine` is the engine, and `yield* MySheet.load` the asset.
- `engineOf(MyEngine)`: `MyEngine` itself, in `engineEntry({ engine: MyEngine, ... })` and in a Command (`yield* MyEngine`). Reaching the engine loads nothing and can't fail. A sheet that can't be loaded is `attach`'s failure, which `engineEntry`'s `onError` gets, and the app's loading screen runs the same `MySheet.load` to show it and retry.
- `makeContentLoader({ schema, files, validate, source })`: declare the content with `Content`, and give its layer the source.

  ```ts
  export class MyContent extends Content("MyContent", {
    schema: MyGameContent,
    files: { levels: "levels.json" },
  }) {}

  // The app says where the files are. Building the layer reads nothing.
  MyContent.layer(fetchJsonSource("/content/"));
  ```

  `MyContent.load` is the loader's `load`: it keeps the first success, and a failed load can be run again.

- `ContentLoader<A>`: the class `Content` returns is the content service's key, so `MyContent` is the requirement and `MyContent.load` the load. The shape of the service is `Loaded<A, ContentError>`.

`loadContent` stays: a `Content` declaration loads with it, and `MyContent.read(source)` is that call for a test.
