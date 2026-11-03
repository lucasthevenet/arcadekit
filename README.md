# Survivor Kit

A starter framework for 3D "survivors-like" browser games: an auto-attacking hero, waves of enemies, XP gems, and a pick-one-of-three upgrade on each level-up.

Stack: **Effect 4** for services and side effects, **Foldkit** for the UI, **Three.js** for rendering, **Vite** for building.

```bash
npm install
npm run dev        # play at http://localhost:5173
npm test           # simulation tests
npm run build      # typecheck + production build into dist/
```

## Making a game

Most of a game is data. Edit the JSON files in `public/content/`:

| File | What it defines |
|---|---|
| `rules.json` | Arena size, enemy cap, XP curve, run length |
| `heroes.json` | Playable characters and their starting weapon |
| `enemies.json` | HP, speed, contact damage, size, XP dropped |
| `weapons.json` | Damage, cooldown, scaling per level, and behavior (`bolt` or `aura`) |
| `passives.json` | Stat upgrades (damage, cooldown, area, speed, max HP, pickup range, regen) |
| `waves.json` | The spawn schedule: which enemy, how many per second, between which times |

Files are checked against the schemas in `src/kit/content/schema.ts` when the game loads. A typo or a reference to a missing id shows an error on screen instead of breaking mid-run.

New weapon behaviors (orbiting blades, chain lightning, …) are a new variant in the `behavior` schema plus a function in `src/kit/sim/world.ts`.

## How it fits together

```
src/
  kit/                      the reusable framework
    content/                Effect Schema for content + ContentService (loads and validates JSON)
    sim/                    the simulation: plain TypeScript, no Effect, no DOM
      world.ts              World state and step(world, input, dt)
      grid.ts               spatial grid for "who is near this point"
      rng.ts                seeded random numbers
    render/ThreeRenderer.ts draws a World with Three.js (InstancedMesh per crowd)
    input/                  keyboard + gamepad + touch-drag joystick
    engine/
      EngineCore.ts         frame loop: fixed 60 Hz steps, render, emit events
      GameEngine.ts         the engine as an Effect service
  app/                      the Foldkit UI (menus, HUD, level-up, pause, game over)
    model.ts                UI state (Schema)
    message.ts              everything that can happen
    update.ts               how state changes, and which Commands run
    commands.ts             side effects, as Effects using the services
    subscriptions.ts        engine events -> Messages, Escape key, the viewport Mount
    view.ts                 HTML
```

The split follows one rule: **Effect and Foldkit handle everything around the game. The per-frame simulation is plain code.**

- The simulation updates hundreds of enemies 60 times per second. It stores them in typed arrays and allocates nothing per frame, so the garbage collector never causes stutters. With ~750 enemies and three maxed weapons, one step takes about 0.3 ms.
- `step` is a pure function of state, input and a seeded random generator. The same seed and inputs give the same run, which `world.test.ts` checks. This is the basis for replays and lockstep multiplayer later.
- The engine reports only coarse events to the UI: a HUD snapshot 10 times per second, "level up" with the choices, and "run ended". Foldkit never sees individual enemies.

How the UI and engine connect:

1. The view always renders `#game-viewport`, with a **Mount** that reports when the element exists.
2. A **Subscription** (gated on that) attaches the `GameEngine` service to the element and turns engine events into Messages. When the subscription's scope closes, the engine detaches and cleans up.
3. `update` sends orders to the engine through **Commands** (`StartRun`, `ChooseUpgrade`, `SetPaused`, `EndRun`).
4. `ContentService` and `GameEngine` are Effect **Layers** given to Foldkit as app-wide `resources` (see `app/main.ts`). To test or swap a part, provide a different Layer.

## Not included yet

- Art and sound: everything is colored shapes. Three.js `GLTFLoader` for `.glb` models and sprite sheets would slot into `ThreeRenderer`.
- Saving unlocks between runs.
- Multiplayer. The deterministic `step` makes lockstep over WebRTC possible: send inputs, not positions.
- Foldkit's Vite plugin (`@foldkit/vite-plugin`) for keeping UI state across live reloads. It's left out because the engine's run state isn't preserved, so a reload mid-run would show a "Playing" UI with no run.
- Browsers pause `requestAnimationFrame` in hidden tabs, so the game pauses when you switch tabs. That's fine solo; online play would need the loop driven by a timer instead.
