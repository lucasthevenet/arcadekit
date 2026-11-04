# gamekit

Reusable packages for building browser games with **Effect 4**, **Foldkit** and **Three.js**, plus two demo games built on them: a survivors-like and a push-puzzle (Sokoban-like).

```bash
pnpm install
pnpm dev         # play the survivors demo at http://localhost:5173
pnpm dev:puzzle  # play the push-puzzle demo
pnpm test        # all package tests
pnpm typecheck   # every package, each against its own rules
pnpm check       # lint + format check (Ultracite: Oxlint + Oxfmt)
pnpm fix         # apply lint fixes and formatting
pnpm build       # typecheck + production build of both demos
```

`pnpm fix` applies Oxlint's autofixes. Run the tests afterwards: a few rules that don't fit this codebase are turned off in `oxlint.config.ts`, each with the reason.

## Packages

Lower layers have fewer dependencies. Nothing depends on a layer above it.

| Package | What it gives you | Depends on |
| --- | --- | --- |
| [`@gamekit/core`](packages/core) | `FixedStepClock`, seeded `makeRng`, struct-of-arrays `createPool` (and `createIdentifiedPool`, whose entities keep stable ids), `SpatialGrid`, `EventBuffer`, `clamp` | nothing (not even the DOM) |
| [`@gamekit/input`](packages/input) | `InputController`: keyboard, gamepad, touch-drag and swipes mapped to named axes and buttons; `MOVE_AXES` preset | DOM |
| [`@gamekit/content`](packages/content) | `loadContent` / `makeContentLoader`: load files, validate with an Effect Schema, cache the first success; `memorySource`. `fetchJsonSource` is in `@gamekit/content/browser` | Effect |
| [`@gamekit/save`](packages/save) | `makeSaveStore`: a game's records by id under one versioned key, merged with the stored save on each write, with a corrupt save backed up and storage failures logged rather than raised; `mergeRecords`. `BrowserSaveStorage` (localStorage, or memory if the browser refuses) is in `@gamekit/save/browser` | Effect |
| [`@gamekit/render-three`](packages/render-three) | `Stage` (renderer + scene + perspective or orthographic camera that resize with their container), `MeshInstances`, `followTarget`, `orbitAround`, `fitCamera` | Three.js |
| [`@gamekit/runtime`](packages/runtime) | `GameSimulation` (the DOM-free half a game implements) and `GameLoop`, which steps one anywhere: browser, Worker, server or test. In `@gamekit/runtime/browser`: `GameDefinition` (simulation plus input and view), `GameDriver` (the `requestAnimationFrame` loop over `GameLoop`), `makeGameEngine` (Effect API) | Effect, core |
| [`@gamekit/foldkit`](packages/foldkit) | `gameViewport` (the element an engine draws into), `engineEntry` (the Subscription that runs the engine there and turns its events into Messages), `keyPresses` | Effect, Foldkit, runtime |
| [`@gamekit/survivors`](packages/survivors) | The survivors-like genre: content schema, simulation, view and engine. Co-op for 2 to 4 players ([ADR-0013](docs/adr/0013-survivors-co-op-shares-the-run-and-splits-the-heroes.md)): one hero per player, shared team XP, a level-up that waits for every player's pick; picks, pause and leaving are step input (`HeroInput`), and `combineHeroInputs` feeds it from `@gamekit/net`'s lockstep | all of the above except foldkit |
| [`@gamekit/push-puzzle`](packages/push-puzzle) | The push-puzzle genre: level schema, turn-based simulation with undo and holes, view and engine | all of the above except foldkit |
| [`@gamekit/net`](packages/net) | Lockstep multiplayer (ADR-0012): `hostLockstep` / `joinLockstep` run one `GameSimulation` on 2 to 4 peers, stepping each step once the host has confirmed every player's input for it, comparing state hashes and removing a player who stalls the run. They talk through a `Transport`; `createMemoryNetwork` is the in-memory one for tests, with seeded latency, jitter and loss. `jsonCodec` and `schemaCodec` put input on the wire. In `@gamekit/net/browser`: `hostRoom` / `joinRoom`, the signalling client that turns a join code into WebRTC links (host to each guest), and `linksTransport`, the WebRTC `Transport` over them | Effect, core, runtime, signalling's protocol |
| [`services/signalling`](services/signalling) | The signalling worker (ADR-0012), not deployed yet: a Cloudflare Worker with a Durable Object per join code that relays WebRTC offers, answers and ICE candidates between a host and up to 3 guests, defined with Alchemy in `alchemy.run.ts`. `@gamekit/signalling/protocol` holds its message types for the browser transport | nothing (Alchemy and Workers types to deploy and check it) |
| [`apps/survivor-demo`](apps/survivor-demo) | The survivors demo: JSON content, Foldkit screens and a save of each hero's best run | survivors, content, save, foldkit |
| [`apps/push-puzzle-demo`](apps/push-puzzle-demo) | The push-puzzle demo: three levels, level select, HUD, solved screen and a save of solved levels | push-puzzle, content, save, foldkit |

Each package's `tsconfig.json` sets which environment it may use. `core` compiles without DOM types, so browser code there fails the typecheck. `content`, `save`, `runtime`, `net` and both genre packages check their root entry the same way (`tsconfig.root.json`); only their `./browser` entries may use the DOM. That keeps the simulation runnable in a Web Worker or on a game server.

## Making a new game

### In an existing genre

Copy the demo app closest to your game (`apps/survivor-demo` or `apps/push-puzzle-demo`), then change the JSON in `public/content/` and the screens in `src/app/`.

### In a new genre

Write a genre package (or start inside your app) in two halves. Its root entry exports the simulation, a `GameSimulation` from `@gamekit/runtime`, with no DOM:

```ts
export const mySimulation: GameSimulation<Config, State, Input, Event> = {
  create: (config, seed) => /* new State */,
  step: (state, input, dt) => /* advance; deterministic */,
  drainEvents: state => state.events.drain(),          // EventBuffer from core
  sample: { everyMs: 100, read: state => /* HUD event */ },  // or `version: state => state.turns` for a turn-based HUD
}
```

Its `./browser` entry adds input and the view, and makes the engine, all from `@gamekit/runtime/browser`:

```ts
export const myGame: GameDefinition<Config, State, Input, Event> = {
  ...mySimulation,
  createInput: surface => /* wrap an InputController; `endStep: () => controller.consumePresses()` if one press must make one turn */,
  createView: container => /* a GameView using Stage, MeshInstances… */,
}

class MyEngine extends Context.Service<MyEngine, GameEngine<Config, State, Event>>()('my-game/Engine') {}
const MyEngineLayer = Layer.sync(MyEngine, () => makeGameEngine(myGame))
```

Tests and replays step the simulation without a browser, in the same step order as the demo: `const loop = new GameLoop(mySimulation)`, `loop.start(config, seed, 0)`, then `loop.frame({ read: step => inputs[step] }, { steps: 1 }, nowMs)` per step (`packages/survivors/src/replay.test.ts` does this).

Then connect it to a Foldkit app with `@gamekit/foldkit`, as `apps/survivor-demo/src/app/` does:

1. The view renders `gameViewport(h, { mounted, unmounted })`; the Model keeps those Messages as a Boolean, and the Subscription `engineEntry` runs the engine while it is true, turning its events into Messages. The Messages and the Model use the genre's event payload Schemas (`events.ts` in both genres), so a field the genre adds reaches the app.
2. **Commands** call the engine: `start`, `modify` (change state from the UI, e.g. picking an upgrade), `setPaused`, `stop`.

Rules of thumb for the simulation (see `packages/survivors/src/world.ts` for a real-time genre and `packages/push-puzzle/src/world.ts` for a turn-based one):

- Keep large collections in `createPool`, and don't allocate inside `step`.
- Use the run's `Rng` for every random choice, so the same seed and inputs give the same run.
- Report rare, meaningful facts through an `EventBuffer`. Never send per-entity data to the UI.

`docs/push-puzzle-findings.md` lists what building the second genre showed about the kit: which primitives are known to fit one genre, and the issues filed for them. `docs/architecture-review.md` records the #27 survey of the kit and the demo apps, and where each verdict landed. `docs/adr/` holds the kit's decisions the follow-ups build on. `CONTEXT.md` is the glossary (step vs turn, SpatialGrid vs tile map).

## The survivors demo

Content lives in `apps/survivor-demo/public/content/`: rules, heroes, enemies, weapons (`bolt` or `aura`), passive upgrades and the wave schedule. It's checked against `packages/survivors/src/schema.ts` at load and by `apps/survivor-demo/src/content.test.ts`.

Hero select shows each hero's best time and most kills. The save keeps them in localStorage under `gamekit/survivors/save`. `src/app/save.ts` says what a hero's record holds and how two merge; `@gamekit/save` does the rest.

With about 750 enemies, three maxed weapons and 480 XP gems on screen, one simulation step takes about 0.3 ms.

## The push-puzzle demo

Levels live in `apps/push-puzzle-demo/public/content/levels.json`, as rows of standard Sokoban text plus `^` for a hole: `#` wall, space floor, `@` player, `+` player on goal, `$` box, `*` box on goal, `.` goal. A box pushed into a hole fills it. They're checked against `packages/push-puzzle/src/schema.ts` at load, and `apps/push-puzzle-demo/src/content.test.ts` plays a known solution for each level.

Arrows, WASD or the d-pad move one cell per press (hold to repeat), and so does a swipe on a touch screen; Z, Backspace or B undo; R restarts; Escape goes back to level select.

Level select marks each solved level with its best move count, and the Solved screen says when a solve is a new best. The save keeps them in localStorage under `gamekit/push-puzzle/save`. `src/app/save.ts` says what a level's record holds and how two merge; `@gamekit/save` does the rest.

## Not done yet

- **Publishing.** Packages export their TypeScript source directly, which suits a workspace. Publishing to npm needs a build step (e.g. tsdown), `effect`/`three`/`foldkit` moved to `peerDependencies`, and the `@gamekit` scope swapped for one you own.
- Art and sound (everything is colored shapes).
- Online co-op in the demo. Survivors' rules and `@gamekit/net`'s lockstep support it, but there is no lobby UI to pick heroes and show "waiting for X" yet, and no deployed signalling worker. `@gamekit/net/browser` has the WebRTC transport and the signalling client.
- More in the save. `@gamekit/save` holds records by id only: no settings, no unlocks and no run in progress. Every save is at version 1, so there is no migration API yet ([ADR-0009](docs/adr/0009-a-save-package-is-earned.md)).
- Foldkit's Vite plugin for keeping UI state across live reloads. It's left out because engine state isn't preserved, so a reload mid-run would show a "Playing" UI with no run.
- Browsers pause `requestAnimationFrame` in hidden tabs, so the game pauses when you switch tabs. Online play would need a timer-driven loop: an adapter that calls `GameLoop.frame` on a timer ([ADR-0010](docs/adr/0010-a-game-is-a-simulation-and-a-presentation.md)).
