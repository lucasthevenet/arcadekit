# arcadekit

`arcadekit` is one package of reusable primitives for building browser games with **Effect 4**, **Foldkit** and **Three.js**. This repository holds it, plus two genre packages and two demo games built on it: a survivors-like and a push-puzzle (Sokoban-like).

**Status: alpha.** Interfaces, stored data and the package's entries change whenever that improves the code, with no compatibility layers or migrations. Each release's changelog says what broke.

**Docs:** [arcadekit.dev](https://arcadekit.dev) has a page for each entry of the package, the glossary and the decisions behind the kit.

```bash
pnpm install
pnpm dev         # play the survivors demo, co-op included, under `alchemy dev` (http://localhost:1337)
pnpm dev:puzzle  # play the push-puzzle demo
pnpm dev:docs    # read the docs site as you write it (VitePress's dev server)
pnpm test        # all tests
pnpm test:browsers  # the long determinism run in Chromium, Firefox and WebKit
pnpm typecheck   # every package, each against its own rules
pnpm check       # lint + format check (Ultracite: Oxlint + Oxfmt)
pnpm fix         # apply lint fixes and formatting
pnpm build       # typecheck + production build of both demos and the docs site
pnpm build:docs  # build the docs site alone; it fails on a dead link in a README
pnpm build:packages  # build the arcadekit package to dist/ (dev, test and typecheck don't need it)
pnpm lint:packages   # publint and arethetypeswrong on the packed arcadekit package
pnpm smoke       # build, pack and install the kit outside the workspace, then typecheck and build a game with it
```

`pnpm fix` applies Oxlint's autofixes. Run the tests afterwards: a few rules that don't fit this codebase are turned off in `oxlint.config.ts`, each with the reason.

## Install

The kit publishes to npm as one package, `arcadekit`, whose entries you import by subpath (`arcadekit/core`, `arcadekit/game/browser`, ...). The genre packages and the demo apps don't publish: copy from them. Install it with the peer libraries the entries you use need:

```bash
pnpm add arcadekit effect three foldkit @effect/platform-browser
pnpm add -D @types/three
```

- Peer libraries: `effect` (~4.1) is required. The rest are optional: `three` (^0.187) and `@types/three` for `arcadekit/render-three`, `foldkit` (~0.170) for `arcadekit/foldkit`, `@effect/platform-browser` (~4.1) for `arcadekit/save/browser` and Foldkit, and `@cloudflare/workers-types` (^5) for `arcadekit/net/worker`'s types. They are peers so your app has one copy of each: Effect services and Three.js `instanceof` checks need that.
- The package is ESM only, with no root export. It needs TypeScript 5.4 or later, and Node 22 or later for tooling. TypeScript 5.4 to 5.6 need `skipLibCheck`, since Effect 4.1's own type files need 5.7.
- Each entry's README (linked in the table below) has an example, and [the package's README](packages/arcadekit/README.md) lists all twenty entries.

**Versions.** While below 1.0, a minor version (0.3 to 0.4) may break the interface, and its changelog says how; a patch doesn't. Use a `~` range to take only patches.

**Before 0.3.0** the kit was nine packages, `@arcadekit/core` to `@arcadekit/foldkit`. In 0.3.0 each became the entry of the same name, with the same exports: `@arcadekit/net/browser` became `arcadekit/net/browser` ([ADR-0018](docs/adr/0018-one-package-with-entries.md)). One of them has no entry any more: `@arcadekit/runtime`. What a declared game still uses of it is `arcadekit/game`'s, and [the changelog](packages/arcadekit/CHANGELOG.md) has the table from each of its names.

## Entries, genres and apps

The first nine rows are the entries of the `arcadekit` package ([`packages/arcadekit`](packages/arcadekit)); each also has the `./browser` and other subpaths its row names. Lower layers have fewer dependencies, and nothing depends on a layer above it: `oxlint.config.ts` lists which entry may import which, and lint enforces it.

| Package or entry | What it gives you | Depends on |
| --- | --- | --- |
| [`arcadekit/core`](packages/arcadekit/src/core) | The data a step keeps and the arithmetic it calls, each module a namespace in Effect's shape ([ADR-0024](docs/adr/0024-the-kit-is-written-as-effect-modules.md)). `FixedStepClock`, the seeded `Rng` (with `Rng.pickDistinct`, several items without repeats), `EntityPool` (struct-of-arrays entities, and `EntityPool.makeIdentified`, whose entities keep stable ids, with `EntityPool.visit` over a pool's live fields), `SpatialGrid`, `EventBuffer`. `Ring`, a fixed ring of records in typed arrays that a step pushes to, and `RingReader`, with which a view takes the records written since it last looked. `TileMap`, a level's grid of static cells in typed arrays, with a cell's neighbour on each `TileMap.Side` and a flood fill. `Layout`, what each record of those holds. `StateHash`, which folds the numbers a game lists from its state into 32 bits. `ExactMath`, the exact math a step calls ([ADR-0011](docs/adr/0011-a-step-uses-only-exact-math.md)): `hypot2`, `sin`, `cos` and `powInt` in place of the `Math` functions each engine approximates, with `clamp`, `lerp` and `hashCell` (two whole numbers to an unsigned 32-bit one); `Point2`, which `clampLength` and `moveToward` write into. `Timer`, timers as numbers in the state (`countDown`, `takeWhole`), and `Tween`, tweens as functions of time (`progress` and the eases `easeIn`, `easeOut`, `easeOutCubic` and `smoothstep`) | Effect, for its module shape (not the DOM) |
| [`arcadekit/input`](packages/arcadekit/src/input) | `InputController`, a namespace in Effect's shape: keyboard, gamepad, touch-drag and swipes read as a game's named axes and buttons (`InputController.make`, `axis`, `isDown`, `wasPressed`), with `InputController.moveAxes`, a pair of movement axes on every device | DOM, Effect for its module shape |
| [`arcadekit/content`](packages/arcadekit/src/content) | `Content` and `Asset`: a game's content files, checked by an Effect Schema, and what the app loads once for it, such as a sprite sheet, each declared as a class that keys its own service (`.layer`, `.load`); the first success is kept and a failed load can be retried. A content's `read(source)` reads and checks the files once and keeps nothing, for a test. `ContentSource`, a namespace in Effect's shape: where a content's files come from (`ContentSource.fromRecord` for a test's files, `ContentSource.make` for a source of the app's own), and the `ContentSource.ContentError` every source and load fails with. `FetchContentSource.fromUrl` is in `arcadekit/content/browser` | Effect |
| [`arcadekit/save`](packages/arcadekit/src/save) | `Save`, a declaration: a game's records by id under one versioned key, merged with the stored save on each write, with a corrupt save backed up and storage failures logged rather than raised. `Setting`, a declaration: one value kept apart from the save under its own key, where the last write wins, such as the audio settings. What both services give is `Stored`, a namespace in Effect's shape: a `read` and a `write`, each traced under the declared name. `BrowserSaveStorage.layer` (localStorage, or memory if the browser refuses) is in `arcadekit/save/browser` | Effect |
| [`arcadekit/audio`](packages/arcadekit/src/audio) | `AudioSystem`, the sound a game's views and app play ([ADR-0014](docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md)): one-shots with pitch and volume jitter, a voice cap and minimum gap per sound, `setLoop` for a loop held from state, music with crossfades, master, sfx and music buses, mute and ducking. Silent until the first gesture and while the tab is hidden. The `Audio` service with `SilentAudioLayer`. `CueTable`, a declaration: a genre's cues, for the app to say which of its sounds each plays. The audio settings' Schema and default (`AudioSettings`: volumes and mute, which an app keeps with a `Setting`). `BrowserAudioLayer` (Web Audio) is in `arcadekit/audio/browser` | Effect |
| [`arcadekit/render-three`](packages/arcadekit/src/render-three) | `Stage` (renderer + scene + perspective, orthographic or pixel camera that resize with their container), `MeshInstances` (copies of one mesh in one draw call, each with a matrix, a color and the attributes its view declares for a shader of its own), `followTarget`, `orbitAround`, `fitCamera`. Pixel-art sprites ([ADR-0015](docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md)): `loadSpriteSheet` (an Aseprite PNG + JSON as an Effect, failing with `SpriteSheetError`), `resolveTags` (each tag a view draws, with its fallbacks, and the ones the sheet lacks), `frameAt` (a tag's frame at a time), `InstancedSprites` (many sprites from one sheet in one draw call, pushed each frame into a batch that grows, each with frame, flip, tint, flash, lift and layer, rounded to sprite pixels or to screen pixels; lower on screen draws in front), `TileLayer` (a grid of cells drawn from a sheet's frames in one draw call, only the cells on screen, from a function of the cell), `Gait` (whether a character a view draws is walking, from the positions it is shown at), `PixelCamera` (straight down, whole screen pixels per sprite pixel, snapped; `groundOnScreen` gives the rectangle of ground it shows). `disposeObject` and `Stage.dispose` skip textures marked with `keepTexture`, such as a sheet's. In `arcadekit/render-three/testing`, for a view's tests: `testSheet` (a sheet with no image), `drawnSprites` (what a batch or a tile layer shows), and `pngSize` and `framesWithSoftAlpha`, which check a sheet's PNG | Three.js, Effect (Node for `render-three/testing`) |
| [`arcadekit/game`](packages/arcadekit/src/game) | A game as declarations ([ADR-0020](docs/adr/0020-a-game-is-declared.md)): `Game.Event` (what a run reports), `Game.Command` (what a player decides; applied at the start of the next step), `Game.Rejection` (why the rules may refuse one) and `Game.Simulation` (the DOM-free rules: `create`, `step`, `apply`, `sample`), with `Game.Loop`, which steps one anywhere. `Game.PlayerInputs` declares the step input of a simulation several players can play (each player's input by slot, plus the slots leaving), and `Game.soloInput` fills it for one player. In `arcadekit/game/browser`: `Game.Engine`, a simulation with the `view` and `input` that draw it and read its input and what they `uses`; the class is the engine service's key and its `layer` provides it, and its `attach` steps and draws the run on animation frames (`Game.Frames`). `Game.combineViews` makes one view of several, such as a drawing view and a sound view. In `arcadekit/game/scenario`: scenarios that check a simulation (given a run, after these steps, it reported these events). In `arcadekit/game/testing`: `manualFrames`, the frames a test drives an engine on | Effect, core |
| [`arcadekit/foldkit`](packages/arcadekit/src/foldkit) | `gameViewport` (the element an engine draws into), `engineEntry` (the Subscription that runs the engine there and turns its events into Messages; with `onError`, the Message sent if the engine fails to load or to attach, or crashes), `keyPresses`, `shortcutPresses` (a key that works on any screen, ignoring modifiers and text fields) | Effect, Foldkit, game |
| [`arcadekit/net`](packages/arcadekit/src/net) | Lockstep multiplayer (ADR-0012): `hostLockstep` / `joinLockstep` run one declared `Game.Simulation` on 2 to 4 peers, stepping each step once the host has confirmed every player's input for it, comparing state hashes and removing a player who stalls the run. The simulation's step input is a `Game.PlayerInputs`: the session sends each player's own input, as its one-player Schema encodes it, and puts each at its slot. A player's command (`session.send`) rides that player's next step, so every peer's rules take or refuse it at one step, and its sender hears which. `arcadekit/net/browser` has the `Coop` declaration, a game's engine played by several players from a lobby ([ADR-0021](docs/adr/0021-co-op-is-declared-from-the-games-engine.md)): its class is the key of the Co-op client, which runs the lobby, the run and its drawing for one player, over the app's rooms (`CoopRooms`, from `browserCoopRoomsLayer`), and its `match` turns what a seat reports into an app's Messages. `arcadekit/net/testing` has what a game's own tests need: `fakeCoopRooms`, `manualTicker`, `onFakeTimers` (an Effect on the timers a test fakes) and a small test game. `hostLockstepScoped` / `joinLockstepScoped` make the same session owned by a scope, run on Effect's `Clock` or a `Ticker` until it fails with its `LockstepError`. They talk through a `Transport`; `createMemoryNetwork` is the in-memory one for tests, with seeded latency, jitter and loss. In `arcadekit/net/browser`: `hostRoom` / `joinRoom`, the signalling client that turns a join code into WebRTC links (host to each guest), and `linksTransport`, the WebRTC `Transport` over them. `arcadekit/net/signalling` is the protocol they speak with a signalling worker, as Effect Schemas. [`arcadekit/net/worker`](packages/arcadekit/src/net/worker) is that signalling worker, for Cloudflare: `signallingRoom` (the Durable Object class of a room, with its room size) and `signallingWorker` (the Worker's `fetch`), so an app's Worker is a few lines | Effect, core, game (Workers types for `net/worker`) |
| [`@arcadekit/survivors`](packages/survivors) | The survivors-like genre, as declarations: its events (`Hud`, `LeveledUp`, `HeroLeft`, `RunEnded`), its upgrade pick (the command `ChooseUpgrade`, refused with `OfferClosed` or `NoSuchChoice`), its co-op pause (`HoldPause`, refused with `NotPlaying`), its rules (`Survivors`, for one hero or several), its content (`SurvivorsContent`) and, in `./browser`, its engine for one player (`SurvivorsEngine`: a pixel-art sprite view, a sound view and its input), which uses the app's sheet (`SurvivorsSheet`, [ADR-0015](docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md)), its sounds for the genre's cue table (`SurvivorsCueTable`) and its audio. Cue counters for sound in `World.cues` ([ADR-0014](docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md)), played by `SurvivorsSoundView`. Co-op for 2 to 4 players ([ADR-0013](docs/adr/0013-survivors-co-op-shares-the-run-and-splits-the-heroes.md)): one hero per player, shared team XP, a level-up that waits for every player's pick. It is declared in `./browser` as `SurvivorsCoop`, a `Coop` made from `SurvivorsEngine`, which `arcadekit/net/browser`'s Co-op client runs in lockstep: the run steps the same `Survivors`, whose step input is `SurvivorsInput`, a `Game.PlayerInputs` of `HeroInput` (`Game.soloInput` fills it for one player, and a lockstep session from each confirmed step). A co-op pick is the same `ChooseUpgrade` one player sends, and the pause a player holds for everyone is `HoldPause`: each rides its sender's step to every peer. The HUD says which heroes are choosing and which hold the pause; the engine's view reads the local player's slot on every frame, for one player and in co-op, and draws from the same sheet | all of the above except foldkit |
| [`@arcadekit/push-puzzle`](packages/push-puzzle) | The push-puzzle genre, as declarations: its events (`Hud`, `LevelSolved`), its rules (`PushPuzzle`: a turn-based simulation with undo, holes and cue counters), its levels (`PushPuzzleContent`) and, in `./browser`, its engine (`PushPuzzleEngine`: a pixel-art sprite view, a sound view and its input), which uses the app's sheet (`PushPuzzleSheet`, [ADR-0015](docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md)), its sounds for the genre's cue table (`PushPuzzleCueTable`) and its audio | game, content, audio, input, render-three, core |
| [`apps/survivor-demo`](apps/survivor-demo) | The survivors demo: JSON content, Foldkit screens, a save of each hero's best run, sound and music with a volume panel, and co-op for 2 to 4 players: a lobby by join code, then a lockstep run over WebRTC. Deployed with Alchemy as one Cloudflare Worker that serves the site and is the kit's [signalling worker](packages/arcadekit/src/net/worker) (a Durable Object per join code) | survivors, audio, content, save, foldkit, net, render-three (Alchemy and Workers types to run, deploy and check its Worker) |
| [`apps/push-puzzle-demo`](apps/push-puzzle-demo) | The push-puzzle demo: three levels, level select, HUD, solved screen, a save of solved levels, sound with a volume panel, and pixel art from a sprite sheet it loads at startup | push-puzzle, audio, content, save, foldkit, render-three |
| [`apps/docs`](apps/docs) | The docs site, [arcadekit.dev](https://arcadekit.dev): each entry's README, the glossary and the decisions as pages, read where they are, so nothing is copied. A new entry's README is a page as soon as it exists, and a dead link in one fails `pnpm build`. Deployed with Alchemy as static files on Cloudflare | VitePress (Alchemy to deploy) |

The typecheck sets which environment each entry may use. `packages/arcadekit/tsconfig.root.json` compiles `core` and the root entries of `content`, `save`, `audio`, `game` (with `game/scenario`) and `net` (and `net/signalling`) without DOM types, so browser code there fails the typecheck; only their `./browser` entries may use the DOM. `tsconfig.worker.json` compiles `net/worker` with Cloudflare's Workers types and no DOM, and `tsconfig.json` leaves it out, so Workers globals reach no other entry. `tsconfig.node.json` compiles `render-three/testing`, which only a test or a script imports, with Node's types beside the DOM's, and `tsconfig.json` leaves it out too, so Node's built-ins reach no other entry. Both genre packages check their root entry the same way. That keeps the simulation runnable in a Web Worker or on a game server.

## Making a new game

### In an existing genre

Copy the demo app closest to your game (`apps/survivor-demo` or `apps/push-puzzle-demo`), then change the JSON in `public/content/` and the screens in `src/app/`.

### In a new genre

Write a genre package (or start inside your app) in two halves, as declarations ([`arcadekit/game`](packages/arcadekit/src/game/README.md)). Push-puzzle is the example to copy. Its root entry declares the rules, with no DOM:

```ts
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

Its `./browser` entry declares the engine: the view, the input, and what they are made from. A sprite sheet the app loads is an `Asset` the genre declares ([ADR-0015](docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md)):

```ts
import { Asset } from "arcadekit/content";
import * as Game from "arcadekit/game/browser";

export class MySheet extends Asset<SpriteSheet, SpriteSheetError>()("MySheet", { release: (sheet) => sheet.dispose() }) {}

export class MyEngine extends Game.Engine("MyEngine", {
  simulation: MyGame,
  uses: { sheet: MySheet.load, audio: Audio },     // Effects run on each attach
  view: (container, { sheet, audio }) => /* a view using Stage, InstancedSprites or MeshInstances… */,
  input: (surface) => /* wrap an InputController.make(surface, bindings); `endStep: () => InputController.consumePresses(controller)` if one press must make one turn */,
}) {}
```

The app provides them, `MyEngine.layer`, `MyContent.layer(FetchContentSource.fromUrl(url))` and `MySheet.layer(loadSpriteSheet(url))`, and drives the engine: `const engine = yield* MyEngine`, then `engine.start(config)`, `engine.send(command)`, `engine.setPaused(paused)`, `engine.stop`. A command the rules may refuse declares how (`Game.Rejection`), and `engine.send` then fails with it.

Tests state the rules as scenarios, with no browser ([`arcadekit/game/scenario`](packages/arcadekit/src/game/README.md)), stepping the simulation in the same step order as the demo:

```ts
const scenario = Scenario.make(MyGame);

it("reports the solve on the move that fills the last goal", () =>
  scenario(
    Scenario.given({ content, levelId: "one-push" }),
    Scenario.step({ held: "right", pressed: "right", undo: false }),
    Scenario.reported(new LevelSolved({ moves: 1 }))
  ));
```

A replay steps a `Game.Loop` itself: `const loop = new Game.Loop(MyGame)`, `loop.start(config, seed, 0)`, then `loop.frame({ read: (step) => inputs[step] }, { steps: 1 }, nowMs)` per step (`packages/push-puzzle/src/world.test.ts` does this).

Then connect it to a Foldkit app with `arcadekit/foldkit`, as `apps/push-puzzle-demo/src/app/` does:

1. The view renders `gameViewport(h, { mounted, unmounted })`; the Model keeps those Messages as a Boolean, and the Subscription `engineEntry` runs the engine while it is true, turning its events into Messages with the simulation's `match` (`toMessage: MyGame.match({ Hud: (hud) => Message.GotHud({ hud }), ... })`). `engineEntry` takes `onError`, the Message sent if the engine can't attach (its sheet can't be loaded, or there is no WebGL) or crashes (a step or a render threw). The Messages and the Model use the genre's event classes, which are their own Schemas, so a field the genre adds reaches the app.
2. **Commands** call the engine: `start`, `send` (a player's decision, such as picking an upgrade, which waits for the rules to take or refuse it), `setPaused`, `stop`. The app's loading Command runs `MyContent.load` and `MySheet.load` side by side, so a failure of either shows on the loading screen and "Try again" loads again only what failed.

Survivors' single-player path is written this way too, with a command: `packages/survivors` declares the upgrade pick (`ChooseUpgrade`, with the rejections `OfferClosed` and `NoSuchChoice`), and `apps/survivor-demo/src/app/` sends it. Its co-op is declared too: `SurvivorsCoop` is a `Coop` made from the same engine ([`arcadekit/net`](packages/arcadekit/src/net/README.md#co-op)), its lockstep run steps `Survivors` through `Game.Loop`, a co-op pick is the same command, sent through the Co-op client's `send`, as the co-op pause is (`HoldPause`), and the app hears a co-op run through `SurvivorsCoop.match` as it hears the engine through `Survivors.match`.

Rules of thumb for the simulation (see `packages/push-puzzle/src/world.ts` for a turn-based genre and `packages/survivors/src/world.ts` for a real-time one):

- Keep large collections in an `EntityPool`, and don't allocate per entity inside `step`.
- Write the step as plain code: it runs no Effect and reads no clock of its own, so its time comes in as an argument. Effect is for what has a lifecycle: loading, the engine, connections. `AGENTS.md` ("Effect and plain code") and [ADR-0024](docs/adr/0024-the-kit-is-written-as-effect-modules.md) say where the line is.
- Use the run's `Rng` (`Rng.make(seed)`) for every random choice, so the same seed and inputs give the same run.
- Report rare, meaningful facts with `report`. Never send per-entity data to the UI.

`docs/push-puzzle-findings.md` lists what building the second genre showed about the kit: which primitives are known to fit one genre, and the issues filed for them. `docs/co-op-findings.md` lists what moving co-op into the kit left in the apps. `docs/architecture-review.md` records the #27 survey of the kit and the demo apps, and where each verdict landed. `docs/adr/` holds the kit's decisions the follow-ups build on. `docs/code-style.md` is how a module of the kit is written, and what checks it. `CONTEXT.md` is the glossary (step vs turn, SpatialGrid vs tile map).

## The survivors demo

Content lives in `apps/survivor-demo/public/content/`: rules, heroes, enemies, weapons (`bolt` or `aura`, with an optional `sound`: the id of a bolt's shot sound), passive upgrades and the wave schedule. Heroes, enemies and weapons have an optional `sprite`: an enemy's or bolt's tag in the sprite sheet (`slime/move`, `bolt/arc`), or a hero's tag prefix (`spark` for `spark/walk`, `spark/idle` and `spark/down`); without one, or if the sheet lacks it, a generic sprite is drawn in the content's `color`. It's checked against `packages/survivors/src/schema.ts` at load and by `apps/survivor-demo/src/content.test.ts`.

Hero select shows each hero's best time and most kills. The save keeps them in localStorage under `arcadekit/survivors/save`. `src/app/save.ts` says what a hero's record holds and how two merge; `arcadekit/save` does the rest.

Sound: `src/app/sound.ts` lists the sounds in `public/sounds/` (each id is its file name) and which one each cue plays; the genre's sound view plays them as its cue counters rise, and the aura hums while a hero carries it and the run is moving. The menus have one music loop and a run another, crossfading as a run starts and ends; pausing turns the music down. The menu and pause screens have volume sliders and a mute button, kept in localStorage under `arcadekit/survivors/settings`, apart from the save; M mutes on any screen. Nothing plays until the first click or key press. In co-op every player hears the whole fight, their own hero's hurt and down loudest.

Art: one sprite sheet, `public/sprites/survivors.png` and `.json` (Aseprite's export format), made by `pnpm sprites`. `src/app/main.ts` provides it as the genre's `SurvivorsSheet` asset, and `LoadContent` loads it beside the content; if it can't be loaded, the loading screen shows the error and a "Try again" button, which loads again only what failed and goes to the menu. The engine and the co-op client draw from the same loaded sheet. The view draws pixel art seen straight down: a 24 px hero standing on a ring in its player slot's colour (how co-op players tell their heroes apart), 16 px enemies, gems by value, bright projectiles with a trail, the aura in whole pixels, and a calm arena with a stone wall. `public/sprites/README.md` lists the tags and how to replace the art; `src/app/sprites.test.ts` checks the sheet has every tag the content names.

With about 750 enemies, three maxed weapons and 480 XP gems on screen, one simulation step takes about 0.3 ms.

### Co-op

2 to 4 players, each in their own browser, play one run in lockstep ([ADR-0012](docs/adr/0012-delay-based-lockstep-over-a-host-star.md), [ADR-0013](docs/adr/0013-survivors-co-op-shares-the-run-and-splits-the-heroes.md), [ADR-0019](docs/adr/0019-the-kit-owns-co-op-and-the-app-keeps-the-screens.md)). `pnpm dev` runs the demo under `alchemy dev`, which serves the site and the signalling worker together, with no Cloudflare account ([the demo's README](apps/survivor-demo/README.md) has the details, and how to deploy). Pick **Co-op** in two windows. One player hosts and reads out the join code; the others join with it. Everyone picks a hero, and the host starts. The host sends the run's seed and content hash at the start; a player whose content differs refuses to start, with a message naming both hashes, and the host's run goes on without them. The view follows your own hero. A level-up freezes the run until every player has picked; Escape pauses it for everyone until you resume, while your hero is playing: a hero that is down holds no pause. If a player's input stops arriving, everyone sees "Waiting for …", and the host removes that player after about 10 s. A desync, being removed or losing the host stops the run with a message saying which. Co-op runs aren't saved as records.

The kit's Co-op client ([`arcadekit/net/browser`](packages/arcadekit/src/net/README.md#co-op)) runs co-op: the lobby over the signalling worker, then a lockstep session it ticks on a worker's timer and draws on animation frames. The genre declares it: `SurvivorsCoop` in `@arcadekit/survivors/browser` is a `Coop` made from `SurvivorsEngine` (a lobby pick is a hero id), so the engine's view follows the local player's hero in both. The app keeps the screens and the Foldkit glue: `SurvivorsCoop.layer` provides the client over the app's rooms (`src/app/coop.ts`, `src/app/main.ts`), Commands call it, and a Subscription turns what it reports into Messages with `SurvivorsCoop.match`. The banner over a frozen run names who it waits on from the HUD's flags: who is choosing an upgrade, and who holds the pause. A player's pick and pause are the genre's commands, `ChooseUpgrade` and `HoldPause`, sent with the client's `send`: each rides the player's next step, and every peer's rules take or refuse it there. Escape opens the run's menu, which asks the run for the pause and follows the rules' answer: it says the run is paused only while they hold the pause for this player, and it stays up either way, since it is the way to leave the run (a player whose hero is down gets it without a pause). A guest whose game lacks a hero the host started with refuses the start, with a message. The app's rooms are on the signalling worker at the page's own origin, since one Worker serves both (`src/coop/config.ts`); `VITE_STUN_URLS` sets the STUN servers (default `stun:stun.l.google.com:19302`; comma-separated, or empty for none).

`pnpm test:e2e` checks co-op end to end: it starts the demo under `alchemy dev` (in a stage of its own, `e2e`), opens two Chromium pages that host and join, plays with different inputs on each until both have picked an upgrade, has each hold the co-op pause in turn (the other page says who paused, and the run's clock stands on both), and checks that both report the same state hashes at the same steps with no error. Then it hides the guest's tab for real (a Chromium of its own, with a second tab in front, so its main-thread timers drop to about once a second) and checks that the run keeps stepping at full rate past the host's 10 s drop-out, with no one removed. It isn't part of `pnpm test`, since it needs Chromium and workerd and takes about a minute. It skips itself when Playwright or Chromium is missing, or when `alchemy dev` doesn't start.

`pnpm test:browsers` checks that every browser engine computes the same run ([ADR-0011](docs/adr/0011-a-step-uses-only-exact-math.md)). It bundles survivors' simulation, `Game.Loop` and the long run that `packages/survivors/src/determinism.test.ts` pins in Node (`src/long-run.ts`: three seeds, 20,000 steps each, a full horde under an analog stick), serves the bundle to Chromium, Firefox and WebKit through Playwright with no network, and checks that each gives the recorded final hash and the same trace hash after every step. On a mismatch it names the first step whose state differs from Node's. It takes about 15 s with Chromium alone. A browser Playwright can't launch is skipped with a message; with `CI` set it fails instead. Install the browsers with `pnpm exec playwright install --with-deps chromium firefox webkit`. CI runs it in all three browsers through `.github/workflows/cross-browser.yml`, which caches the browsers by Playwright version.

## The push-puzzle demo

Levels live in `apps/push-puzzle-demo/public/content/levels.json`, as rows of standard Sokoban text plus `^` for a hole: `#` wall, space floor, `@` player, `+` player on goal, `$` box, `*` box on goal, `.` goal. A box pushed into a hole fills it. They're checked against `packages/push-puzzle/src/schema.ts` at load, and `apps/push-puzzle-demo/src/content.test.ts` plays a known solution for each level, as a scenario.

Arrows, WASD or the d-pad move one cell per press (hold to repeat), and so does a swipe on a touch screen; Z, Backspace or B undo; R restarts; Escape goes back to level select; M mutes on any screen.

Level select marks each solved level with its best move count, and the Solved screen says when a solve is a new best. The save keeps them in localStorage under `arcadekit/push-puzzle/save`. `src/app/save.ts` says what a level's record holds and how two merge; `arcadekit/save` does the rest.

Sound: `src/app/audio.ts` lists the sounds in `public/sounds/` (each id is its file name) and which one each cue plays (`move`, `push`, `hole`, `undo`, `solved`); the genre's sound view plays them as its cue counters rise. One music loop starts with the app and is heard after the first click or key press. Level select has volume sliders and a mute switch, kept in localStorage under `arcadekit/push-puzzle/settings`, apart from the save.

Art: one sprite sheet, `public/sprites/push-puzzle.png` and `.json` (Aseprite's export format), made by `pnpm sprites`. `src/app/main.ts` says where the genre's sheet comes from (`PushPuzzleSheet.layer`, with `SHEET_URL` in `src/app/sprites.ts`), and `LoadContent` loads it beside the levels; if it can't be loaded, the loading screen shows the error, as for levels that can't be loaded, and a "Try again" button, which loads again only what failed and goes to level select. The view draws the board at the largest whole pixel scale that fits, and needs the tags in `PUSH_PUZZLE_TAGS` (the first of each name; the ones after are what it draws without it); `public/sprites/README.md` lists them and how to replace the art.

## Releasing

The `arcadekit` package releases with [Changesets](https://github.com/changesets/changesets) ([ADR-0018](docs/adr/0018-one-package-with-entries.md), which keeps the release decisions of [ADR-0016](docs/adr/0016-publish-the-kit-as-arcadekit.md)).

- A PR that changes the package adds a changeset: `pnpm changeset` ([.changeset/README.md](.changeset/README.md)). Below 1.0, a breaking change is a minor bump, and its changeset says how it breaks.
- On `main`, the release workflow (`release.yml`) opens a "Version packages" PR. Merging it publishes to npm with trusted publishing (OIDC from GitHub Actions, with provenance), so no npm token is stored.
- `package-checks.yml` runs `pnpm build:packages`, `pnpm lint:packages` and `pnpm smoke` on every PR. `pnpm release` builds and lints before it publishes.
- npm can only trust a workflow for a package that exists, so the name `arcadekit` is claimed once from the maintainer's machine with a placeholder `0.0.0`. `bash scripts/npm-setup.sh` walks through it step by step: the placeholder, the trusted publisher, the first real release (`0.3.0`, from CI), and deprecating the nine `@arcadekit/*` packages it replaces.

## Not done yet

- **The one-package release.** `arcadekit` 0.3.0 isn't on npm until `scripts/npm-setup.sh` has been walked through: see [Releasing](#releasing). Until then npm has the nine `@arcadekit/*` packages at 0.2.3.
- **The docs site's deployment.** `pnpm build` builds arcadekit.dev, but nothing deploys it until the workflow in `apps/docs/deploy.workflow.example.yml` is moved to `.github/workflows/`: see [its README](apps/docs/README.md#deploying).
- Real art and sounds: the demos draw generated pixel art and play generated placeholders.
- A public deployment, and TURN. `alchemy deploy` puts the demo and its signalling worker on Cloudflare, but none is public yet (the worker needs rate limits first: see its README), and two peers behind symmetric NATs can't connect without TURN.
- Cross-browser lockstep: the end-to-end co-op test runs in Chromium only. `pnpm test:browsers` checks the simulation itself in Chromium, Firefox and WebKit, but Linux WebKit isn't Safari (whose JavaScriptCore uses Apple's libm), and nothing runs on Windows or macOS yet.
- More in the save. A `Save` holds records by id only: no unlocks and no run in progress. A `Setting` holds one value beside it. Every save is at version 1, so there is no migration API yet ([ADR-0009](docs/adr/0009-a-save-package-is-earned.md)).
- Foldkit's Vite plugin for keeping UI state across live reloads. It's left out because engine state isn't preserved, so a reload mid-run would show a "Playing" UI with no run.
- Browsers pause `requestAnimationFrame` in hidden tabs, so a single-player run pauses when you switch tabs. A co-op run keeps going: it steps on a timer in a Web Worker, which a hidden tab doesn't throttle, and only stops drawing. A player whose game really stalls (closed, or frozen by the browser) holds the others up until the host removes them after about 10 s ([ADR-0012](docs/adr/0012-delay-based-lockstep-over-a-host-star.md)).
