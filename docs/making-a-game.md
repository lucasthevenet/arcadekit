# Making a game

A game is a genre's declarations and an app around them. This page walks through both, as the two demo games write them, from the rules to the screens; each part has a guide of its own. The code below is a sketch: `/* … */` stands where your game's own code goes.

## In an existing genre

Copy the demo app closest to your game (`examples/survivor-demo` or `examples/push-puzzle-demo`), then change the JSON in `public/content/` and the screens in `src/app/`.

## In a new genre

Write the genre inside your app, in a folder of its own beside the Foldkit app (`src/<genre>/`, which the app imports by relative path to its public files, `../<genre>/index` and `../<genre>/browser/index`), in [two halves, as declarations](concepts/declarations.md). The push-puzzle demo is the example to copy: its genre's declarations are exported bare, and its other modules are namespaces.

### The rules

The genre's public file, `src/push-puzzle/index.ts` in the demo, declares the rules, with no DOM ([The simulation](guides/simulation.md), [Content and assets](guides/content.md)):

```ts sketch
import { Content } from "arcadekit/content";
import * as Game from "arcadekit/game";

export class LevelSolved extends Game.Event("LevelSolved", { moves: Schema.Int }) {}
export class Hud extends Game.Event("Hud", { moves: Schema.Int }) {}

export class MyGame extends Game.Simulation("MyGame", {
  input: MyInput,                                  // one step's input, as a Schema
  events: [LevelSolved],
  create: (config: MyConfig, { seed }) => /* new State */,
  step: (state, input, { dt, report }) => /* advance; deterministic */,
  sample: { event: Hud, every: "100 millis", read: (state) => /* the HUD */ },   // or `version: (state) => state.turns` for a turn-based HUD
}) {}

export class MyContent extends Content("MyContent", { schema: MyContentSchema, files: { levels: "levels.json" } }) {}
```

### The engine

Its `browser/` public file declares the engine: the view, the input, and what they are made from ([The engine](guides/engine.md)). A sprite sheet the app loads is an `Asset` the genre declares ([Sprites](guides/sprites.md#a-sheet-is-an-asset)):

```ts sketch
import { AudioSystem } from "arcadekit/audio";
import { Asset } from "arcadekit/content";
import * as Game from "arcadekit/game/browser";
import { SpriteSheet } from "arcadekit/render-three";

export class MySheet extends Asset<SpriteSheet.SpriteSheet, SpriteSheet.SpriteSheetError>()("MySheet", { release: SpriteSheet.dispose }) {}

export class MyEngine extends Game.Engine("MyEngine", {
  simulation: MyGame,
  uses: { sheet: MySheet.load, audio: AudioSystem.AudioSystem },     // Effects run on each attach
  view: (container, { sheet, audio }) => /* a view using Stage, InstancedSprites or MeshInstances… */,
  input: (surface) => /* wrap an InputController.make(surface, bindings); `endStep: () => InputController.consumePresses(controller)` if one press must make one turn */,
}) {}
```

The app provides them, `MyEngine.layer`, `MyContent.layer(FetchContentSource.fromUrl(url))` and `MySheet.layer(SpriteSheet.fromUrl(url))`, and drives the engine: `const engine = yield* MyEngine`, then `engine.start(config)`, `engine.send(command)`, `engine.setPaused(paused)`, `engine.stop`. A command the rules may refuse declares how (`Game.Rejection`), and `engine.send` then fails with it ([Commands and refusals](guides/commands.md)).

### Tests

Tests state the rules as [scenarios](testing/scenarios.md), with no browser, stepping the simulation in the same step order as the demo:

```ts sketch
const scenario = Scenario.make(MyGame);

it("reports the solve on the move that fills the last goal", () =>
  scenario(
    Scenario.given({ content, levelId: "one-push" }),
    Scenario.step({ held: "right", pressed: "right", undo: false }),
    Scenario.reported(new LevelSolved({ moves: 1 }))
  ));
```

A replay steps a `Game.Loop` itself: `const loop = Game.makeLoop(MyGame)`, `loop.start(config, seed, 0)`, then `loop.frame({ read: (step) => inputs[step] }, { steps: 1 }, nowMs)` per step (`examples/push-puzzle-demo/test/push-puzzle/world.test.ts` does this).

### The app

Then connect it to a Foldkit app with `arcadekit/foldkit`, as `examples/push-puzzle-demo/src/app/` does ([A Foldkit app](guides/foldkit.md)):

1. The view renders `Viewport.make(h, { mounted, unmounted })`; the Model keeps those Messages as a Boolean, and the Subscription entry `EngineEntry.make` runs the engine while it is true, turning its events into Messages with the simulation's `match` (`toMessage: MyGame.match({ Hud: (hud) => Message.GotHud({ hud }), ... })`). It takes `onError`, the Message sent if the engine can't attach (its sheet can't be loaded, or there is no WebGL) or crashes (a step or a render threw). The Messages and the Model use the genre's event classes, which are their own Schemas, so a field the genre adds reaches the app.
2. **Commands** call the engine: `start`, `send` (a player's decision, such as picking an upgrade, which waits for the rules to take or refuse it), `setPaused`, `stop`. The app's loading Command runs `MyContent.load` and `MySheet.load` side by side, so a failure of either shows on the loading screen and "Try again" loads again only what failed.

### Co-op

Survivors' single-player path is written this way too, with a command: its genre (`examples/survivor-demo/src/survivors/`) declares the upgrade pick (`ChooseUpgrade`, with the rejections `OfferClosed` and `NoSuchChoice`), and `examples/survivor-demo/src/app/` sends it. Its co-op is declared too: `SurvivorsCoop` is a `Coop` made from the same engine ([A Co-op game](guides/coop.md)), its lockstep run steps `Survivors` through `Game.Loop`, a co-op pick is the same command, sent through the Co-op client's `send`, as the co-op pause is (`HoldPause`), and the app hears a co-op run through `SurvivorsCoop.match` as it hears the engine through `Survivors.match`.

## Rules of thumb

For the simulation (see `examples/push-puzzle-demo/src/push-puzzle/world.ts` for a turn-based genre and `examples/survivor-demo/src/survivors/world.ts` for a real-time one):

- Keep large collections in an `EntityPool`, and don't allocate per entity inside `step`.
- Write the step as plain code: it runs no Effect and reads no clock of its own, so its time comes in as an argument. Effect is for what has a lifecycle: loading, the engine, connections. The effect-or-plain skill (`.agents/skills/effect-or-plain/SKILL.md`) says where the line is.
- Use the run's `Rng` (`Rng.make(seed)`) for every random choice, so the same seed and inputs give the same run ([Determinism](concepts/determinism.md)).
- Report rare, meaningful facts with `report`. Never send per-entity data to the UI.

[The glossary](../CONTEXT.md) says what each word means (step vs turn, spatial grid vs tile map). To change the kit itself, `.agents/AGENTS.md` and the skills beside it in `.agents/skills/` say how a change to the kit is written and checked.
