# gamekit

Reusable packages for building browser games with **Effect 4**, **Foldkit** and **Three.js**, plus a demo survivors-like game built on them.

```bash
npm install
npm run dev         # play the demo at http://localhost:5173
npm test            # all package tests
npm run typecheck   # every package, each against its own rules
npm run build       # typecheck + production build of the demo
```

## Packages

Lower layers have fewer dependencies. Nothing depends on a layer above it.

| Package | What it gives you | Depends on |
|---|---|---|
| [`@gamekit/core`](packages/core) | `FixedStepClock`, seeded `makeRng`, struct-of-arrays `createPool`, `SpatialGrid`, `EventBuffer`, small math | nothing (not even the DOM) |
| [`@gamekit/input`](packages/input) | `InputController`: keyboard, gamepad and touch-drag mapped to named axes and buttons; `MOVE_AXES` preset | DOM |
| [`@gamekit/content`](packages/content) | `loadContent` / `makeContentLoader`: load files, validate with an Effect Schema, cache; `fetchJsonSource`, `memorySource` | Effect |
| [`@gamekit/render-three`](packages/render-three) | `Stage` (renderer + scene + camera that resize with their container), `InstancedCrowd`, `followTarget`, `orbitAround` | Three.js |
| [`@gamekit/runtime`](packages/runtime) | `GameDefinition` (the interface a game implements), `GameDriver` (frame loop), `makeGameEngine` (Effect API) | Effect, core |
| [`@gamekit/foldkit`](packages/foldkit) | `engineMessages` (engine events → Foldkit Subscription), `keyPresses` | Effect, Foldkit, runtime |
| [`@gamekit/survivors`](packages/survivors) | The survivors-like genre: content schema, simulation, renderer and engine | all of the above except foldkit |
| [`apps/survivor-demo`](apps/survivor-demo) | The demo game: JSON content and Foldkit screens | survivors, foldkit |

Each package's `tsconfig.json` sets which environment it may use. `core` compiles without DOM types, so browser code there fails the typecheck. That keeps the simulation runnable in a Web Worker or on a game server.

## Making a new game

### In an existing genre

Copy `apps/survivor-demo`, then change the JSON in `public/content/` and the screens in `src/app/`.

### In a new genre

Write a genre package (or start inside your app) that implements `GameDefinition` from `@gamekit/runtime`:

```ts
const myGame: GameDefinition<Config, State, Input, Event> = {
  create: (config, seed) => /* new State */,
  step: (state, input, dt) => /* advance; deterministic */,
  drainEvents: state => state.events.drain(),          // EventBuffer from core
  sample: { everyMs: 100, read: state => /* HUD event */ },
  createInput: surface => /* wrap an InputController */,
  createView: container => /* a GameView using Stage, InstancedCrowd… */,
}

class MyEngine extends Context.Service<MyEngine, GameEngine<Config, State, Event>>()('my-game/Engine') {}
const MyEngineLayer = Layer.sync(MyEngine, () => makeGameEngine(myGame))
```

Then connect it to a Foldkit app the way `apps/survivor-demo/src/app/subscriptions.ts` does:

1. The view always renders the game's container element, with a **Mount** that reports when it exists.
2. A **Subscription** gated on that returns `engineMessages(...)`, which attaches the engine and turns its events into Messages.
3. **Commands** call the engine: `start`, `modify` (change state from the UI, e.g. picking an upgrade), `setPaused`, `stop`.

Rules of thumb for the simulation (see `packages/survivors/src/world.ts`):

- Keep large collections in `createPool`, and don't allocate inside `step`.
- Use the run's `Rng` for every random choice, so the same seed and inputs give the same run.
- Report rare, meaningful facts through an `EventBuffer`. Never send per-entity data to the UI.

## The survivors demo

Content lives in `apps/survivor-demo/public/content/`: rules, heroes, enemies, weapons (`bolt` or `aura`), passive upgrades and the wave schedule. It's checked against `packages/survivors/src/schema.ts` at load and by `apps/survivor-demo/src/content.test.ts`.

With about 750 enemies, three maxed weapons and 480 XP gems on screen, one simulation step takes about 0.3 ms.

## Not done yet

- **Publishing.** Packages export their TypeScript source directly, which suits a workspace. Publishing to npm needs a build step (e.g. tsdown), `effect`/`three`/`foldkit` moved to `peerDependencies`, and the `@gamekit` scope swapped for one you own.
- Art and sound (everything is colored shapes), saved progress, and multiplayer. The deterministic `step` makes lockstep multiplayer possible: send inputs, not positions.
- Foldkit's Vite plugin for keeping UI state across live reloads. It's left out because engine state isn't preserved, so a reload mid-run would show a "Playing" UI with no run.
- Browsers pause `requestAnimationFrame` in hidden tabs, so the game pauses when you switch tabs. Online play would need a timer-driven loop.
