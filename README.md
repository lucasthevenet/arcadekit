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
| [`@gamekit/content`](packages/content) | `loadContent` / `makeContentLoader`: load files, validate with an Effect Schema, cache; `memorySource`. `fetchJsonSource` is in `@gamekit/content/browser` | Effect |
| [`@gamekit/render-three`](packages/render-three) | `Stage` (renderer + scene + perspective or orthographic camera that resize with their container), `MeshInstances`, `followTarget`, `orbitAround`, `fitCamera` | Three.js |
| [`@gamekit/runtime`](packages/runtime) | `GameDefinition` (the interface a game implements), `GameDriver` (frame loop), `makeGameEngine` (Effect API) | Effect, core |
| [`@gamekit/foldkit`](packages/foldkit) | `engineMessages` (engine events → Foldkit Subscription), `keyPresses` | Effect, Foldkit, runtime |
| [`@gamekit/survivors`](packages/survivors) | The survivors-like genre: content schema, simulation, view and engine | all of the above except foldkit |
| [`@gamekit/push-puzzle`](packages/push-puzzle) | The push-puzzle genre: level schema, turn-based simulation with undo and holes, view and engine | all of the above except foldkit |
| [`apps/survivor-demo`](apps/survivor-demo) | The survivors demo: JSON content and Foldkit screens | survivors, content, foldkit |
| [`apps/push-puzzle-demo`](apps/push-puzzle-demo) | The push-puzzle demo: three levels, level select, HUD, solved screen | push-puzzle, content, foldkit |

Each package's `tsconfig.json` sets which environment it may use. `core` compiles without DOM types, so browser code there fails the typecheck. `content` and both genre packages check their root entry the same way (`tsconfig.root.json`); only their `./browser` entries may use the DOM. That keeps the simulation runnable in a Web Worker or on a game server.

## Making a new game

### In an existing genre

Copy the demo app closest to your game (`apps/survivor-demo` or `apps/push-puzzle-demo`), then change the JSON in `public/content/` and the screens in `src/app/`.

### In a new genre

Write a genre package (or start inside your app) that implements `GameDefinition` from `@gamekit/runtime`:

```ts
const myGame: GameDefinition<Config, State, Input, Event> = {
  create: (config, seed) => /* new State */,
  step: (state, input, dt) => /* advance; deterministic */,
  drainEvents: state => state.events.drain(),          // EventBuffer from core
  sample: { everyMs: 100, read: state => /* HUD event */ },  // or `version: state => state.turns` for a turn-based HUD
  createInput: surface => /* wrap an InputController; `endStep: () => controller.consumePresses()` if one press must make one turn */,
  createView: container => /* a GameView using Stage, MeshInstances… */,
}

class MyEngine extends Context.Service<MyEngine, GameEngine<Config, State, Event>>()('my-game/Engine') {}
const MyEngineLayer = Layer.sync(MyEngine, () => makeGameEngine(myGame))
```

Then connect it to a Foldkit app the way `apps/survivor-demo/src/app/subscriptions.ts` does:

1. The view always renders the game's container element, with a **Mount** that reports when it exists.
2. A **Subscription** gated on that returns `engineMessages(...)`, which attaches the engine and turns its events into Messages. The Messages and the Model use the genre's event payload Schemas (`events.ts` in both genres), so a field the genre adds reaches the app.
3. **Commands** call the engine: `start`, `modify` (change state from the UI, e.g. picking an upgrade), `setPaused`, `stop`.

Rules of thumb for the simulation (see `packages/survivors/src/world.ts` for a real-time genre and `packages/push-puzzle/src/world.ts` for a turn-based one):

- Keep large collections in `createPool`, and don't allocate inside `step`.
- Use the run's `Rng` for every random choice, so the same seed and inputs give the same run.
- Report rare, meaningful facts through an `EventBuffer`. Never send per-entity data to the UI.

`docs/push-puzzle-findings.md` lists what building the second genre showed about the kit: which primitives are known to fit one genre, and the issues filed for them. `CONTEXT.md` is the glossary (step vs turn, SpatialGrid vs tile map).

## The survivors demo

Content lives in `apps/survivor-demo/public/content/`: rules, heroes, enemies, weapons (`bolt` or `aura`), passive upgrades and the wave schedule. It's checked against `packages/survivors/src/schema.ts` at load and by `apps/survivor-demo/src/content.test.ts`.

With about 750 enemies, three maxed weapons and 480 XP gems on screen, one simulation step takes about 0.3 ms.

## The push-puzzle demo

Levels live in `apps/push-puzzle-demo/public/content/levels.json`, as rows of standard Sokoban text plus `^` for a hole: `#` wall, space floor, `@` player, `+` player on goal, `$` box, `*` box on goal, `.` goal. A box pushed into a hole fills it. They're checked against `packages/push-puzzle/src/schema.ts` at load, and `apps/push-puzzle-demo/src/content.test.ts` plays a known solution for each level.

Arrows, WASD or the d-pad move one cell per press (hold to repeat), and so does a swipe on a touch screen; Z, Backspace or B undo; R restarts; Escape goes back to level select.

## Not done yet

- **Publishing.** Packages export their TypeScript source directly, which suits a workspace. Publishing to npm needs a build step (e.g. tsdown), `effect`/`three`/`foldkit` moved to `peerDependencies`, and the `@gamekit` scope swapped for one you own.
- Art and sound (everything is colored shapes), saved progress, and multiplayer. The deterministic `step` makes lockstep multiplayer possible: send inputs, not positions.
- Foldkit's Vite plugin for keeping UI state across live reloads. It's left out because engine state isn't preserved, so a reload mid-run would show a "Playing" UI with no run.
- Browsers pause `requestAnimationFrame` in hidden tabs, so the game pauses when you switch tabs. Online play would need a timer-driven loop.
