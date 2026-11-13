# arcadekit

## Project status: alpha

arcadekit is alpha. Nothing depends on it in production yet: no players, deployments or users to protect. Breaking changes are fine when they improve the code, and a better design wins over compatibility. That covers API changes, renames, removing or reshaping exports, changing stored data formats or localStorage keys, and large refactors.

- Don't add compatibility shims, deprecation paths or data migrations. Change the code and update its callers.
- Still say what breaks: in the commit message, in the PR description, and, for the published `arcadekit` package, in its changeset (a minor bump while below 1.0).
- Keep the replay and determinism hashes unless a change to the simulation's rules is the point.

## A game is declared

A game is written as **declarations**: one named class per part, hosted by a Layer or a loop ([ADR-0020](docs/adr/0020-a-game-is-declared.md)). They are `Game.Event`, `Game.Command`, `Game.Rejection` and `Game.Simulation` (`arcadekit/game`), `Game.Engine` (`arcadekit/game/browser`), `Content` and `Asset` (`arcadekit/content`), `Coop` (`arcadekit/net/browser`, [ADR-0021](docs/adr/0021-co-op-is-declared-from-the-games-engine.md)), `Save` and `Setting` (`arcadekit/save`), and `CueTable` (`arcadekit/audio`). Push-puzzle and its demo are the example to copy, and [the entry's README](packages/arcadekit/src/game/README.md) shows each block.

- **A new part a game supplies is a declaration**: a builder `(name, definition)` that returns a class with the definition as statics, typed by an explicit `XClass` interface. If it has a service, the class is its key and a `layer` provides it.
- **Handlers inside a declaration are plain functions** (`create`, `step`, `apply`, `view`, `input`). What hosts it is Effect, or plain code as `Game.Loop` is. `step` and `apply` change the state in place and return nothing (`apply`, or a rejection): anything else is a type error, and `Game.Loop` throws on it.
- **A run changes only at a step**: by its input, and by a `Game.Command` the loop applies at the start of the next step. An `apply` handler takes its command or refuses it by returning one of the `Game.Rejection`s the command declares, and the sender's `engine.send` fails with it.
- **Rules are checked with scenarios** (`arcadekit/game/scenario`).
- **Kit source names a declaration's base first**, as `audio/service.ts` does, since it is checked with `isolatedDeclarations`. Genre packages and apps write `class X extends Game.Event(...) {}`.
- **Co-op is declared from the game's engine**: `class SurvivorsCoop extends Coop("SurvivorsCoop", { engine: SurvivorsEngine, ... }) {}`. The class is the key of the Co-op client and its `layer` provides it over the app's `CoopRooms`; the engine's `view` is told the local player (`{ local }`) by both hosts; and an app turns what a seat reports into Messages with the class's `match`, the run's events under `run`. Its lockstep run steps the game's declared simulation through `Game.Loop`, and what a co-op player decides is one of that simulation's commands, sent with the client's `send`: it rides the player's next step to every peer. Nothing of the older contract is left in the kit's entries (`makeGameEngine`, `GameSimulation`, the `runtime` entry). New work goes on the declarations.

## Adding to the kit

Before adding or reshaping a module of the kit (a declaration, what hosts one, a service, an entry's exports), read [`docs/code-style.md`](docs/code-style.md): what kind of module it is, the shape of a declaration, its names and types, and when it is done. Lint and `packages/arcadekit/test/style.test.ts` check part of it, and the page says which part.

## Effect and plain code

Every module of the kit has Effect's shape ([`docs/code-style.md`](docs/code-style.md), "An Effect module"). Whether its code is Effect or plain is decided by one question: would we write it plain if performance were free? ([ADR-0024](docs/adr/0024-the-kit-is-written-as-effect-modules.md), which amends [ADR-0017](docs/adr/0017-effect-at-the-edges-plain-code-inside.md).) Code stays plain only for correctness, and these are the reasons:

1. **The same bits on every peer.** A step gives the same result on every peer and every replay, so it reads no clock or random source of its own: its time comes in as an argument and its randomness from the run's seeded `Rng`. Never use Effect's `Clock`, `Random` or `DateTime` there, nor `Date`, `Temporal`, `performance`, `crypto` or `Math.random`. Lint enforces this.
2. **It finishes in the call.** A step finishes inside the frame or tick that runs it, and a frame draws whole before the browser shows it. An Effect can't promise that: one that waits throws when run synchronously, and on a fiber the scheduler can cut a long run after 2,048 operations ([ADR-0020](docs/adr/0020-a-game-is-declared.md)).
3. **Pure data work**, of the kind Effect writes plain itself: its `Array`, `Number` and `MutableRef` are plain functions over data.
4. **A framework's contract.** Foldkit's `update` and `view` are pure functions; their side effects are Commands, Subscriptions and Mounts.

Cost is not a reason. Code that was plain only to save an allocation, a fiber per frame, tick or message, or an Effect per entity outside a step becomes Effect wherever Effect buys something: a lifecycle, interruption, a typed failure in place of a throw, a service, a stream in place of listeners, or a span. Where Effect buys nothing the code stays plain: don't add Effect for consistency alone. Performance is deferred, not ignored: run `pnpm bench` before and after a rework and give its numbers against [`docs/perf-baseline.md`](docs/perf-baseline.md) in the PR.

Plain on purpose, by entry. An entry still on `NOT_YET_EFFECT_STYLE` (`packages/arcadekit/test/style.test.ts`) keeps its line as ADR-0017 wrote it, cost reasons included, until its rework moves the line to ADR-0024's reasons:

- **`arcadekit/core`**, reworked: every file is plain, for 1 and 2, since a step calls it, and for 3. `entity-pool.ts`, `ring.ts`, `ring-reader.ts`, `tile-map.ts`, `layout.ts` and `internal/fields.ts` are typed arrays a step writes and a view reads; `spatial-grid.ts` answers a step's "what is near" with exact arithmetic; `fixed-step-clock.ts` turns a frame's time, given as an argument, into steps; `rng.ts` is the run's seeded randomness; `event-buffer.ts` holds what a step reports until its loop delivers it; `state-hash.ts` folds a state into the digest peers compare; `exact-math.ts`, `point2.ts`, `timer.ts` and `tween.ts` are the arithmetic a step or a view calls, exact by [ADR-0011](docs/adr/0011-a-step-uses-only-exact-math.md). None imports `effect` but for its module shape (`Pipeable`, `Inspectable`, `Predicate`, `Function.dual`).
- **The simulation.** Each genre's step (`world.ts`, and survivors' `hero.ts` and `hash-world.ts`), a declared simulation's `create`, `step` and `apply` with the `Game.Loop` that runs them, the kernel under it (`Kernel`, which no entry exports) and the scenarios that check them (`packages/arcadekit/src/game/loop.ts`, `kernel.ts`, `simulation.ts`, `scenario.ts`), the step input built from the players' inputs (`player-inputs.ts` in `game` and in `net`), and the lockstep protocol (`packages/arcadekit/src/net/lockstep.ts`, which decodes its messages with Schema but ticks as plain code, and the codec of a player's step payload in `codec.ts`, since every peer steps on what it decodes). A step must give the same bits on every peer, and a step over many entities must not allocate per entity (an event is a class instance, so reporting one allocates, and events are rare). So it runs no Effect, and it reads no clock or random source of its own.
- **Per-frame drawing and input.** `arcadekit/render-three`'s drawing (its sprite loading is Effect), the genres' views and sound views, a view's reads of a ring (`RingReader`), a `Game.Engine`'s `view` and `input`, `InputController`'s reads, `Game.View` and `combineViews`, the `FrameSource` adapter, the audio mixer's play calls, the per-message channel code (`dataChannelText`, `linksTransport`), and what the Co-op client calls between steps: the local player's input source (a `Coop`'s `input`), and nothing else of the game's. None of it runs an Effect itself. The engine calls views and input from one `Effect.try` per frame, built once per attach. A lockstep run on a ticker is one `Effect.callback` whose ticks are plain calls, and messages reach the session through plain listeners. Their lifecycles are Effect: the engine makes and disposes views, input and listeners with `acquireRelease`, and each peer link's connection and channels have their own.
- **Rules behind an Effect shell.** `packages/arcadekit/src/net/browser/room-state.ts` and the signalling worker's `room.ts` (`packages/arcadekit/src/net/worker/`, the `arcadekit/net/worker` entry). They take inputs and return outputs, and a rejection is a value, not a throw. A shell does the I/O: `signalling.ts` for the client; in the worker, the Durable Object's Effects in `connections.ts`, which call the plain `sockets.ts` to carry out the room's outputs on the sockets. A room size no room can have is the one throw: it is a mistake in the app's setup, refused when the Worker's module loads.
- **Foldkit `update` and `view`.** Pure functions. Their side effects are Commands, Subscriptions and Mounts.

Everything with a lifecycle is Effect: loops, connections, timers, workers, resources and services. So is untrusted input (decode it with Schema where it arrives) and any failure a caller should handle (a typed error).

Where plain code and Effect meet:

- **Waiting on a host callback:** `Effect.callback`. The engine's frame loop waits on each frame this way, then does the frame's work in one `Effect.try`. A peer link waits for its channels to open the same way, and a lockstep run on a ticker is one `Effect.callback` that resumes when the run ends.
- **Repeating host events:** `Stream.callback` with `Queue.offerUnsafe` (`keyPresses`), or a `Queue` that the host's listeners feed with `Queue.offerUnsafe` (the signalling worker's sockets, the Co-op client's lobby links in `packages/arcadekit/src/net/browser/coop-client.ts`).
- **Plain code a host calls that must run an Effect:** capture a runner once, then use it on each call: `FiberHandle.runtime` (the Co-op client forks its seats this way), or `Effect.context` with `Effect.runForkWith` or `Effect.runPromiseWith`.
- **A platform that owns the entry points:** run each one's Effect there. The signalling worker's entry points are in the kit, in `packages/arcadekit/src/net/worker/index.ts`, and nowhere else: its Worker runs each request with `Effect.runPromise`, and its Durable Object, whose connections outlive a request, builds one `ManagedRuntime` with the object and runs every entry point on it.
- **No other `Effect.run*` in library code** (`packages/*/src`; test helpers aside). That one file is the exception, since Cloudflare owns its entry points. The browser apps run their Effects through Foldkit's runtime.
- **Throws:** plain code that throws on an expected failure is wrapped once, at the boundary, with `Effect.try` into a tagged error. Any other throw is a bug, and the Effect around it reports it as a defect. A frame is the exception: one that throws ends the engine's `attach` with the typed `GameCrashed`, so the app can show it.

## One package, twenty entries

The kit is one published package, `arcadekit` (`packages/arcadekit`), whose entries live in `src/<entry>/` ([ADR-0018](docs/adr/0018-one-package-with-entries.md)). Inside it, import another entry by relative path to its public file (`../core/index`), never as `arcadekit/core`. `ENTRY_IMPORTS` in `oxlint.config.ts` lists which entry may import which, and lint enforces it: adding an arrow is a design decision, so say why in the PR. The genre packages and the apps import `arcadekit/<entry>`. `arcadekit/net/worker` is the one entry that runs on Cloudflare: `tsconfig.worker.json` checks it with Workers types and no DOM, and no other entry may import `cloudflare:workers` (`test/entry-packages.test.ts`). `arcadekit/game/testing` holds the frames a test drives an engine on, `arcadekit/net/testing` a Co-op game's test helpers (fake rooms, a manual ticker, the Clock and scheduler of a test on fake timers, a test game), `arcadekit/render-three/testing` a sprite view's (a sheet with no image, what a batch shows, two checks of a sheet's PNG), and `arcadekit/game/scenario` the scenarios that check a simulation; only tests import them. `arcadekit/render-three/testing` runs in Node and imports `node:zlib`: `tsconfig.node.json` checks it with Node's types beside the DOM's, `tsconfig.json` leaves its folder out, and the same test allows a `node:` built-in only in an entry that only a test or a script imports. `arcadekit/game/browser` has everything `arcadekit/game` has plus the engine, so a file imports one of the two as `Game`.

## The docs site

Each entry's `README.md` is also a page of [arcadekit.dev](https://arcadekit.dev) (`apps/docs`, VitePress), read where it is. So is `CONTEXT.md` (the glossary) and every ADR. `pnpm build` builds the site and fails on a dead link in any of them. A new entry's README starts with its import path as the heading (`# arcadekit/net/testing`), then a paragraph; [`apps/docs/README.md`](apps/docs/README.md) has the rest.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
