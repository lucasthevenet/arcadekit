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
pnpm test:browsers  # the long-run determinism scenario in Chromium, Firefox and WebKit
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

The kit publishes to npm as one package, `arcadekit`, whose entries you import by subpath (`arcadekit/core`, `arcadekit/runtime/browser`, ...). The genre packages and the demo apps don't publish: copy from them. Install it with the peer libraries the entries you use need:

```bash
pnpm add arcadekit effect three foldkit @effect/platform-browser
pnpm add -D @types/three
```

- Peer libraries: `effect` (~4.1) is required. The rest are optional: `three` (^0.187) and `@types/three` for `arcadekit/render-three`, `foldkit` (~0.170) for `arcadekit/foldkit`, `@effect/platform-browser` (~4.1) for `arcadekit/save/browser` and Foldkit, and `@cloudflare/workers-types` (^5) for `arcadekit/net/worker`'s types. They are peers so your app has one copy of each: Effect services and Three.js `instanceof` checks need that.
- `arcadekit/core` and `arcadekit/input` import no Effect, so a game can use them without running any.
- The package is ESM only, with no root export. It needs TypeScript 5.4 or later, and Node 22 or later for tooling. TypeScript 5.4 to 5.6 need `skipLibCheck`, since Effect 4.1's own type files need 5.7.
- Each entry's README (linked in the table below) has an example, and [the package's README](packages/arcadekit/README.md) lists all eighteen entries.

**Versions.** While below 1.0, a minor version (0.3 to 0.4) may break the interface, and its changelog says how; a patch doesn't. Use a `~` range to take only patches.

**Before 0.3.0** the kit was nine packages, `@arcadekit/core` to `@arcadekit/foldkit`. Each is now the entry of the same name: `@arcadekit/net/browser` is `arcadekit/net/browser`, with the same exports ([ADR-0018](docs/adr/0018-one-package-with-entries.md)).

## Entries, genres and apps

The first nine rows are the entries of the `arcadekit` package ([`packages/arcadekit`](packages/arcadekit)); each also has the `./browser` and other subpaths its row names. Lower layers have fewer dependencies, and nothing depends on a layer above it: `oxlint.config.ts` lists which entry may import which, and lint enforces it.

| Package or entry | What it gives you | Depends on |
| --- | --- | --- |
| [`arcadekit/core`](packages/arcadekit/src/core) | `FixedStepClock`, seeded `makeRng`, struct-of-arrays `createPool` (and `createIdentifiedPool`, whose entities keep stable ids), `SpatialGrid`, `EventBuffer`, `clamp` | nothing (not even the DOM) |
| [`arcadekit/input`](packages/arcadekit/src/input) | `InputController`: keyboard, gamepad, touch-drag and swipes mapped to named axes and buttons; `MOVE_AXES` preset | DOM |
| [`arcadekit/content`](packages/arcadekit/src/content) | `loadContent` / `makeContentLoader`: load files, validate with an Effect Schema, cache the first success; `memorySource`. `fetchJsonSource` is in `arcadekit/content/browser` | Effect |
| [`arcadekit/save`](packages/arcadekit/src/save) | `makeSaveStore`: a game's records by id under one versioned key, merged with the stored save on each write, with a corrupt save backed up and storage failures logged rather than raised; `mergeRecords`. `BrowserSaveStorage` (localStorage, or memory if the browser refuses) is in `arcadekit/save/browser` | Effect |
| [`arcadekit/audio`](packages/arcadekit/src/audio) | `AudioSystem`, the sound a game's views and app play ([ADR-0014](docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md)): one-shots with pitch and volume jitter, a voice cap and minimum gap per sound, `setLoop` for a loop held from state, music with crossfades, master, sfx and music buses, mute and ducking. Silent until the first gesture and while the tab is hidden. The `Audio` service with `SilentAudioLayer`, and `makeAudioSettingsStore` (volumes and mute under their own key, last write wins). `BrowserAudioLayer` (Web Audio) is in `arcadekit/audio/browser` | Effect |
| [`arcadekit/render-three`](packages/arcadekit/src/render-three) | `Stage` (renderer + scene + perspective, orthographic or pixel camera that resize with their container), `MeshInstances`, `followTarget`, `orbitAround`, `fitCamera`. Pixel-art sprites ([ADR-0015](docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md)): `loadSpriteSheet` (an Aseprite PNG + JSON as an Effect, failing with `SpriteSheetError`), `frameAt` (a tag's frame at a time), `InstancedSprites` (many sprites from one sheet in one draw call, each with frame, flip, tint, flash, lift and layer; lower on screen draws in front), `PixelCamera` (straight down, whole screen pixels per sprite pixel, snapped). `disposeObject` and `Stage.dispose` skip textures marked with `keepTexture`, such as a sheet's | Three.js, Effect |
| [`arcadekit/runtime`](packages/arcadekit/src/runtime) | `GameSimulation` (the DOM-free half a game implements) and `GameLoop`, which steps one anywhere: browser, Worker, server or test. `PlayerInputs` is the step input of a game with several players (each player's input by slot, plus the slots leaving), and `soloInput` fills it for one player. In `arcadekit/runtime/browser`: `GameDefinition` (simulation plus input and view), `makeGameEngine` (Effect API; its `attach` runs the `requestAnimationFrame` loop over `GameLoop`), `makeEngineLoader` and `engineOf` (an engine made once from assets the app loads, such as a sprite sheet; there is no engine before them), `combineViews` (several views as one, such as a drawing view and a sound view) | Effect, core |
| [`arcadekit/foldkit`](packages/arcadekit/src/foldkit) | `gameViewport` (the element an engine draws into), `engineEntry` (the Subscription that runs the engine there and turns its events into Messages; with `onError`, the Message sent if the engine fails to load or to attach, or crashes), `keyPresses`, `shortcutPresses` (a key that works on any screen, ignoring modifiers and text fields) | Effect, Foldkit, runtime |
| [`arcadekit/net`](packages/arcadekit/src/net) | Lockstep multiplayer (ADR-0012): `hostLockstep` / `joinLockstep` run one `GameSimulation` on 2 to 4 peers, stepping each step once the host has confirmed every player's input for it, comparing state hashes and removing a player who stalls the run. A Co-op game's DOM-free half is here too: `CoopRules`, its lockstep parts. `arcadekit/net/browser` has the Co-op client that runs one, `makeCoopClient`: the lobby, the run and its drawing for one player, over rooms from `browserCoopRooms`. `arcadekit/net/testing` has what a game's own tests need: `fakeCoopRooms`, `manualTicker` and a small `testCoopGame`. `hostLockstepScoped` / `joinLockstepScoped` make the same session owned by a scope, run on Effect's `Clock` or a `Ticker` until it fails with its `LockstepError`. They talk through a `Transport`; `createMemoryNetwork` is the in-memory one for tests, with seeded latency, jitter and loss. `jsonCodec` and `schemaCodec` put input on the wire. `combinePlayerInputs` makes `arcadekit/runtime`'s `PlayerInputs` from each confirmed step. In `arcadekit/net/browser`: `hostRoom` / `joinRoom`, the signalling client that turns a join code into WebRTC links (host to each guest), and `linksTransport`, the WebRTC `Transport` over them. `arcadekit/net/signalling` is the protocol they speak with a signalling worker, as Effect Schemas. [`arcadekit/net/worker`](packages/arcadekit/src/net/worker) is that signalling worker, for Cloudflare: `signallingRoom` (the Durable Object class of a room, with its room size) and `signallingWorker` (the Worker's `fetch`), so an app's Worker is a few lines | Effect, core, runtime (Workers types for `net/worker`) |
| [`@arcadekit/survivors`](packages/survivors) | The survivors-like genre: content schema, simulation, view and engine. Co-op for 2 to 4 players ([ADR-0013](docs/adr/0013-survivors-co-op-shares-the-run-and-splits-the-heroes.md)): one hero per player, shared team XP, a level-up that waits for every player's pick; picks, pause and leaving are step input (`SurvivorsInput`, which is `arcadekit/runtime`'s `PlayerInputs` of `HeroInput`), filled by `soloInput` for one player and by `arcadekit/net`'s `combinePlayerInputs` in lockstep. Cue counters for sound in `World.cues` ([ADR-0014](docs/adr/0014-sounds-come-from-cue-counters-read-by-the-presentation.md)), played by `SurvivorsSoundView`; `makeSurvivorsGame` takes the app's art, cue table and audio, and `makeSurvivorsEngineLayer({ sheet, sounds })` takes the app's sheet load, cue table and audio. Its `SurvivorsEngine` is an engine loader ([ADR-0015](docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md)). `SurvivorsView` draws pixel-art sprites from the app's sheet. For co-op it is a Co-op game: `survivorsCoopRules` (DOM-free) and `makeSurvivorsCoopGame` (`./browser`), which `arcadekit/net/browser`'s Co-op client runs; the views read the local player's slot on every frame | all of the above except foldkit |
| [`@arcadekit/push-puzzle`](packages/push-puzzle) | The push-puzzle genre: level schema, turn-based simulation with undo and holes and cue counters, a pixel-art sprite view, sound view and engine. `makePushPuzzleGame` takes the app's sheet, cue table and audio, and `makePushPuzzleEngineLayer({ sheet, sounds })` takes the app's sheet load, cue table and audio. Its `PushPuzzleEngine` is an engine loader ([ADR-0015](docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md)) | all of the above except foldkit |
| [`apps/survivor-demo`](apps/survivor-demo) | The survivors demo: JSON content, Foldkit screens, a save of each hero's best run, sound and music with a volume panel, and co-op for 2 to 4 players: a lobby by join code, then a lockstep run over WebRTC. Deployed with Alchemy as one Cloudflare Worker that serves the site and is the kit's [signalling worker](packages/arcadekit/src/net/worker) (a Durable Object per join code) | survivors, audio, content, save, foldkit, runtime, net (Alchemy and Workers types to run, deploy and check its Worker) |
| [`apps/push-puzzle-demo`](apps/push-puzzle-demo) | The push-puzzle demo: three levels, level select, HUD, solved screen, a save of solved levels, sound with a volume panel, and pixel art from a sprite sheet it loads at startup | push-puzzle, audio, content, save, foldkit, runtime, render-three |
| [`apps/docs`](apps/docs) | The docs site, [arcadekit.dev](https://arcadekit.dev): each entry's README, the glossary and the decisions as pages, read where they are, so nothing is copied. A new entry's README is a page as soon as it exists, and a dead link in one fails `pnpm build`. Deployed with Alchemy as static files on Cloudflare | VitePress (Alchemy to deploy) |

The typecheck sets which environment each entry may use. `packages/arcadekit/tsconfig.root.json` compiles `core` and the root entries of `content`, `save`, `audio`, `runtime` and `net` (and `net/signalling`) without DOM types, so browser code there fails the typecheck; only their `./browser` entries may use the DOM. `tsconfig.worker.json` compiles `net/worker` with Cloudflare's Workers types and no DOM, and `tsconfig.json` leaves it out, so Workers globals reach no other entry. Both genre packages check their root entry the same way. That keeps the simulation runnable in a Web Worker or on a game server.

## Making a new game

### In an existing genre

Copy the demo app closest to your game (`apps/survivor-demo` or `apps/push-puzzle-demo`), then change the JSON in `public/content/` and the screens in `src/app/`.

### In a new genre

Write a genre package (or start inside your app) in two halves. Its root entry exports the simulation, a `GameSimulation` from `arcadekit/runtime`, with no DOM:

```ts
export const mySimulation: GameSimulation<Config, State, Input, Event> = {
  create: (config, seed) => /* new State */,
  step: (state, input, dt) => /* advance; deterministic */,
  drainEvents: state => state.events.drain(),          // EventBuffer from core
  sample: { everyMs: 100, read: state => /* HUD event */ },  // or `version: state => state.turns` for a turn-based HUD
}
```

Its `./browser` entry adds input and the view, and makes the engine, all from `arcadekit/runtime/browser`:

```ts
export const myGame: GameDefinition<Config, State, Input, Event> = {
  ...mySimulation,
  createInput: surface => /* wrap an InputController; `endStep: () => controller.consumePresses()` if one press must make one turn */,
  createView: container => /* a GameView using Stage, InstancedSprites or MeshInstances… */,
}

class MyEngine extends Context.Service<MyEngine, GameEngine<Config, State, Event>>()('my-game/Engine') {}
const MyEngineLayer = Layer.sync(MyEngine, () => makeGameEngine(myGame))
```

A game that draws from assets the app loads, such as a sprite sheet, gets an engine loader instead, as both genres do ([ADR-0015](docs/adr/0015-pixel-art-sprites-loaded-by-the-app.md)). There is no engine before its assets: the app's `LoadContent` runs `load`, and everything else reaches the engine through it (`engineOf(MyEngine)`):

```ts
class MyEngine extends Context.Service<
  MyEngine,
  EngineLoader<Config, State, Event, SpriteSheet, SpriteSheetError>
>()("my-game/Engine") {}
const makeMyEngineLayer = (
  sheet: Effect.Effect<SpriteSheet, SpriteSheetError>
) =>
  Layer.effect(
    MyEngine,
    makeEngineLoader({
      assets: sheet,
      game: makeMyGame,
      release: (s) => s.dispose(),
    })
  );
```

Tests and replays step the simulation without a browser, in the same step order as the demo: `const loop = new GameLoop(mySimulation)`, `loop.start(config, seed, 0)`, then `loop.frame({ read: step => inputs[step] }, { steps: 1 }, nowMs)` per step (`packages/survivors/src/replay.test.ts` does this).

Then connect it to a Foldkit app with `arcadekit/foldkit`, as `apps/survivor-demo/src/app/` does:

1. The view renders `gameViewport(h, { mounted, unmounted })`; the Model keeps those Messages as a Boolean, and the Subscription `engineEntry` runs the engine while it is true, turning its events into Messages. `engineEntry` takes `onError`, the Message sent if the engine fails to load or to attach (no WebGL, say) or crashes (a step or a render threw), and an app whose engine comes through a load keeps the Boolean false until its load has succeeded. The Messages and the Model use the genre's event payload Schemas (`events.ts` in both genres), so a field the genre adds reaches the app.
2. **Commands** call the engine (through `engineOf` for an engine loader, turning a failed load into a Message): `start`, `modify` (change state from the UI, e.g. picking an upgrade), `setPaused`, `stop`.

Rules of thumb for the simulation (see `packages/survivors/src/world.ts` for a real-time genre and `packages/push-puzzle/src/world.ts` for a turn-based one):

- Keep large collections in `createPool`, and don't allocate inside `step`.
- Write the step as plain code: it runs no Effect and reads no clock of its own, so its time comes in as an argument. Effect is for what has a lifecycle: loading, the engine, connections. `AGENTS.md` ("Effect and plain code") and [ADR-0017](docs/adr/0017-effect-at-the-edges-plain-code-inside.md) say where the line is.
- Use the run's `Rng` for every random choice, so the same seed and inputs give the same run.
- Report rare, meaningful facts through an `EventBuffer`. Never send per-entity data to the UI.

`docs/push-puzzle-findings.md` lists what building the second genre showed about the kit: which primitives are known to fit one genre, and the issues filed for them. `docs/co-op-findings.md` lists what moving co-op into the kit left in the apps. `docs/architecture-review.md` records the #27 survey of the kit and the demo apps, and where each verdict landed. `docs/adr/` holds the kit's decisions the follow-ups build on. `CONTEXT.md` is the glossary (step vs turn, SpatialGrid vs tile map).

## The survivors demo

Content lives in `apps/survivor-demo/public/content/`: rules, heroes, enemies, weapons (`bolt` or `aura`, with an optional `sound`: the id of a bolt's shot sound), passive upgrades and the wave schedule. Heroes, enemies and weapons have an optional `sprite`: an enemy's or bolt's tag in the sprite sheet (`slime/move`, `bolt/arc`), or a hero's tag prefix (`spark` for `spark/walk`, `spark/idle` and `spark/down`); without one, or if the sheet lacks it, a generic sprite is drawn in the content's `color`. It's checked against `packages/survivors/src/schema.ts` at load and by `apps/survivor-demo/src/content.test.ts`.

Hero select shows each hero's best time and most kills. The save keeps them in localStorage under `arcadekit/survivors/save`. `src/app/save.ts` says what a hero's record holds and how two merge; `arcadekit/save` does the rest.

Sound: `src/app/sound.ts` lists the sounds in `public/sounds/` (each id is its file name) and which one each cue plays; the genre's sound view plays them as its cue counters rise, and the aura hums while a hero carries it and the run is moving. The menus have one music loop and a run another, crossfading as a run starts and ends; pausing turns the music down. The menu and pause screens have volume sliders and a mute button, kept in localStorage under `arcadekit/survivors/settings`, apart from the save; M mutes on any screen. Nothing plays until the first click or key press. In co-op every player hears the whole fight, their own hero's hurt and down loudest.

Art: one sprite sheet, `public/sprites/survivors.png` and `.json` (Aseprite's export format), made by `pnpm sprites`. `src/app/main.ts` hands its load to the engine layer, and `LoadContent` loads it beside the content; if it can't be loaded, the loading screen shows the error and a "Try again" button, which loads again only what failed and goes to the menu. The co-op client draws with the same loaded sheet. The view draws pixel art seen straight down: a 24 px hero standing on a ring in its player slot's colour (how co-op players tell their heroes apart), 16 px enemies, gems by value, bright projectiles with a trail, the aura in whole pixels, and a calm arena with a stone wall. `public/sprites/README.md` lists the tags and how to replace the art; `src/app/sprites.test.ts` checks the sheet has every tag the content names.

With about 750 enemies, three maxed weapons and 480 XP gems on screen, one simulation step takes about 0.3 ms.

### Co-op

2 to 4 players, each in their own browser, play one run in lockstep ([ADR-0012](docs/adr/0012-delay-based-lockstep-over-a-host-star.md), [ADR-0013](docs/adr/0013-survivors-co-op-shares-the-run-and-splits-the-heroes.md), [ADR-0019](docs/adr/0019-the-kit-owns-co-op-and-the-app-keeps-the-screens.md)). `pnpm dev` runs the demo under `alchemy dev`, which serves the site and the signalling worker together, with no Cloudflare account ([the demo's README](apps/survivor-demo/README.md) has the details, and how to deploy). Pick **Co-op** in two windows. One player hosts and reads out the join code; the others join with it. Everyone picks a hero, and the host starts. The host sends the run's seed and content hash at the start; a player whose content differs refuses to start, with a message naming both hashes, and the host's run goes on without them. The view follows your own hero. A level-up freezes the run until every player has picked; Escape pauses it for everyone until you resume. If a player's input stops arriving, everyone sees "Waiting for …", and the host removes that player after about 10 s. A desync, being removed or losing the host stops the run with a message saying which. Co-op runs aren't saved as records.

The kit's Co-op client (`makeCoopClient`, [`arcadekit/net/browser`](packages/arcadekit/src/net/README.md)) runs co-op: the lobby over the signalling worker, then a lockstep session it ticks on a worker's timer and draws on animation frames. The genre supplies its half: `survivorsCoopRules` in `@arcadekit/survivors` (a lobby pick is a hero id, an answer is an upgrade pick) and `makeSurvivorsCoopGame` in its `./browser` entry, whose views follow the local player's hero. The app keeps the screens and the Foldkit glue: `src/app/coop.ts` makes the client as a `Coop` service, Commands call it, and a Subscription turns its events into Messages. A guest whose game lacks a hero the host started with refuses the start, with a message. The client finds the signalling worker on the page's own origin, since one Worker serves both (`src/coop/config.ts`); `VITE_STUN_URLS` sets the STUN servers (default `stun:stun.l.google.com:19302`; comma-separated, or empty for none).

`pnpm test:e2e` checks co-op end to end: it starts the demo under `alchemy dev` (in a stage of its own, `e2e`), opens two Chromium pages that host and join, plays a few seconds with different inputs on each, and checks that both report the same state hashes at the same steps with no error. Then it hides the guest's tab for real (a Chromium of its own, with a second tab in front, so its main-thread timers drop to about once a second) and checks that the run keeps stepping at full rate past the host's 10 s drop-out, with no one removed. It isn't part of `pnpm test`, since it needs Chromium and workerd and takes about a minute. It skips itself when Playwright or Chromium is missing, or when `alchemy dev` doesn't start.

`pnpm test:browsers` checks that every browser engine computes the same run ([ADR-0011](docs/adr/0011-a-step-uses-only-exact-math.md)). It bundles survivors' simulation, `GameLoop` and the long-run scenario that `packages/survivors/src/determinism.test.ts` pins in Node (`src/long-run.ts`: three seeds, 20,000 steps each, a full horde under an analog stick), serves the bundle to Chromium, Firefox and WebKit through Playwright with no network, and checks that each gives the recorded final hash and the same trace hash after every step. On a mismatch it names the first step whose state differs from Node's. It takes about 15 s with Chromium alone. A browser Playwright can't launch is skipped with a message; with `CI` set it fails instead. Install the browsers with `pnpm exec playwright install --with-deps chromium firefox webkit`. CI runs it in all three browsers through `.github/workflows/cross-browser.yml`, which caches the browsers by Playwright version.

## The push-puzzle demo

Levels live in `apps/push-puzzle-demo/public/content/levels.json`, as rows of standard Sokoban text plus `^` for a hole: `#` wall, space floor, `@` player, `+` player on goal, `$` box, `*` box on goal, `.` goal. A box pushed into a hole fills it. They're checked against `packages/push-puzzle/src/schema.ts` at load, and `apps/push-puzzle-demo/src/content.test.ts` plays a known solution for each level.

Arrows, WASD or the d-pad move one cell per press (hold to repeat), and so does a swipe on a touch screen; Z, Backspace or B undo; R restarts; Escape goes back to level select; M mutes on any screen.

Level select marks each solved level with its best move count, and the Solved screen says when a solve is a new best. The save keeps them in localStorage under `arcadekit/push-puzzle/save`. `src/app/save.ts` says what a level's record holds and how two merge; `arcadekit/save` does the rest.

Sound: `src/app/audio.ts` lists the sounds in `public/sounds/` (each id is its file name) and which one each cue plays (`move`, `push`, `hole`, `undo`, `solved`); the genre's sound view plays them as its cue counters rise. One music loop starts with the app and is heard after the first click or key press. Level select has volume sliders and a mute switch, kept in localStorage under `arcadekit/push-puzzle/settings`, apart from the save.

Art: one sprite sheet, `public/sprites/push-puzzle.png` and `.json` (Aseprite's export format), made by `pnpm sprites`. `src/app/main.ts` hands its load (`SHEET_URL` in `src/app/sprites.ts`) to the engine layer, and `LoadContent` loads it beside the levels; if it can't be loaded, the loading screen shows the error, as for levels that can't be loaded, and a "Try again" button, which loads again only what failed and goes to level select. The view draws the board at the largest whole pixel scale that fits, and needs the tags in `PUSH_PUZZLE_SPRITE_TAGS`; `public/sprites/README.md` lists them and how to replace the art.

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
- More in the save. `arcadekit/save` holds records by id only: no settings, no unlocks and no run in progress. Every save is at version 1, so there is no migration API yet ([ADR-0009](docs/adr/0009-a-save-package-is-earned.md)).
- Foldkit's Vite plugin for keeping UI state across live reloads. It's left out because engine state isn't preserved, so a reload mid-run would show a "Playing" UI with no run.
- Browsers pause `requestAnimationFrame` in hidden tabs, so a single-player run pauses when you switch tabs. A co-op run keeps going: it steps on a timer in a Web Worker, which a hidden tab doesn't throttle, and only stops drawing. A player whose game really stalls (closed, or frozen by the browser) holds the others up until the host removes them after about 10 s ([ADR-0012](docs/adr/0012-delay-based-lockstep-over-a-host-star.md)).
