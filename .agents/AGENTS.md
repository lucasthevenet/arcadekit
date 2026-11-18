This is arcadekit: primitives for browser games on Effect 4 and Three.js. It publishes two packages. `arcadekit`, from `packages/arcadekit`, has an entry for every module (`arcadekit/App`, `arcadekit/Input` and so on), `arcadekit` for all of them together, `arcadekit/Browser` for what only a page can use, and `arcadekit/ecs`. `@arcadekit/three`, from `packages/three`, is the plugin that draws a game with Three.js, with `arcadekit`, Effect and Three.js as its peers. Use `pnpm` from the repository root.

arcadekit is a revamped version, designed fresh: an entity component system with Effect around it. `packages/arcadekit/README.md` describes the design, what works and what is not done yet; read it first. It is a first cut. `arcadekit` draws nothing itself: `@arcadekit/three` does, and `packages/three/README.md` describes it. The package does not depend on a UI library and will not: a game's menus and heads-up display are built with whatever it chooses.

Before writing code, read `docs/conventions.md`: how code here is written so that it stays Effect code, with references into Effect's documentation for each pattern. `docs/roadmap.md` says what to build next and in what order.

arcadekit is alpha, with no users to protect, so a better design wins over compatibility. Say what breaks in the changeset, the commit and the PR.

## The code is what gets copied

Whatever is in this repository is what the next change copies, whether a person or an agent writes it. Add only code that is fit to be copied, and expect to spend most of a change on showing that it works.

### A check before a sentence

- A rule that matters is held by something that runs: a type, a test, a lint rule in `oxlint.config.ts`, or a refusal at run time whose message says what to do instead. Prose, here, in `docs/conventions.md` or in a README, is for what no check holds yet.
- The repository already works this way, and a new rule joins these: `test/entries.test.ts` and `scripts/lint-entries.mjs` hold each entry to what it may import; `test/policy.test.ts` plays a game where making code from text is forbidden; the lists of writers in `test/transaction.test.ts`, `test/changes.test.ts`, `test/access.test.ts` and `test/frame.test.ts`; the world's guard, which refuses what a system did not say with `System.access`; a frozen world, which refuses a change from the frame and input stages; `Lockstep.Drifted`; and `bench:compare`.
- When you are corrected, ask first whether the correction can be a check, and propose that check, in the same PR when it is small. Apply a single correction to the case it was about. It becomes a line of this file or of the conventions only when no check can hold it, and then it says what would.
- What goes wrong with no error and that no check can hold yet goes in the roadmap's "To revisit before a stable release", as said below, with what would close it.

### Root causes, not workarounds

- Fix the cause. The workarounds this repository is most likely to grow are: a timer, a promise or `Effect.sleep` that makes something happen later (in a tick it resumes outside the tick, and no replay repeats it; order is said with `System.after`, `System.before`, a stage, a state's hooks or `Ticks.more`); a wait or a retry in a test that passes most of the time; a `try` that swallows a defect; a cast, `as unknown as`, an `any` or a `!` that quiets the compiler where the types are wrong; a write through a raw column or a `world._` field from code that may not make it; and `app.enqueue` from inside a system.
- Never disable, weaken or skip a check to get a change through: no `oxlint-disable`, `@ts-ignore`, `it.skip`, a `describe.runIf` that is false in CI, an assertion loosened until it passes, a writer left out of a test's list, or `Bench-slower:` for a slowdown nobody chose. If a check seems wrong, stop and say so in the reply or the PR. A type test's `// @ts-expect-error` is not this. Two exceptions exist and are kept on purpose: `eslint/require-yield` is off because a system is a generator even when it yields nothing, and `test/policy-game.ts` makes code from text because that is what it tests.
- Code that is already here is not precedent. If what you would copy is a workaround, a deprecated API or an Effect 3 habit, do not copy it: say so. If it is in the module you are changing and fixing it is small, fix it and add the check that keeps it out; otherwise name it in the PR.
- Use the constrained form when there is one:

| Not | But |
| --- | --- |
| `Date.now()`, `performance.now()`, Effect's `Clock`, in code a tick runs | `Time`, and `Frame` in the frame stage |
| `Math.random()` | `Random` |
| `Effect.sleep`, a `Schedule`, a timer, a promise, to wait in the game | `Script.sleep`, `Script.nextTick`, an event's `wait` |
| `Effect.forkChild` or `Effect.forkDetach` from a system | `Script.spawn` |
| `Layer.build`, a `Scheduler` of your own | `App.make` |
| `Effect.runSync` or `Effect.runPromise` inside a program | `yield*`, and the platform's `runMain` at the edge |
| `app.dispatch` or `app.tick` in a game of several peers | `app.enqueue` |
| A device read in the tick | An action issued in the input stage, and `Input.Keyboard`, `Input.Pointer`, `Input.Gamepad` |
| A UI that holds the app, or copies the game into its own state | `View.Bridge`; in React, `useSyncExternalStore` over it, as `examples/page/ui-react.ts` does, not a `useEffect` that copies |
| A flag a system checks to run something once | `State.onEnter`, `State.onExit` |
| A copy kept to see what changed | `Query.changed`, `Query.added`, `Query.removed` |

### Boundaries

The folders are a contract, and most of it is checked.

- `src/ecs/` imports nothing. Every other module of `arcadekit` imports Effect alone and names nothing that only a page has. `src/Browser.ts` is the one import of a browser package. `@arcadekit/three` imports `arcadekit` by its entries, as a game would, and defines no component. `test/entries.test.ts`, `packages/three/test/entries.test.ts` and `scripts/lint-entries.mjs` hold all of this.
- The stages are boundaries too. The tick is the simulation; the frame stage draws and plays sound and never changes the world; the input stage turns devices into actions. A frozen world, `Sound.Player` and a bundle read in the tick refuse what crosses them.
- A game is a folder for each plugin. Other plugins import its `index.ts` and nothing else of it, and its raw loops are in `loops.ts`, which imports nothing and closes over nothing.
- A hot path allocates nothing per entity and makes no Effect per entity: a loop over a query's rows, a plugin's `loops.ts`, `src/ecs/`, and the loops of `@arcadekit/three` that draw. A claim about allocation is measured, as `packages/three/test/three.test.ts` measures the heap over a frame.

### Comments and markdown

- Every export has a doc comment, with examples indented under a blank line and a `@category` from `website/src/lib/api.ts`. That is the package's reference, which the site is made from, and it is required.
- Inside the code, write no comment by default. Write one only for a why the code cannot say: an invariant, an order that matters, a number that was measured, the engine a design came from. Keep it to a line or two.
- No comment, doc, README sentence or rule explains a workaround or why the right thing was not done. Say that in the reply or the PR. If the debt stays, it is a line in the roadmap's "To revisit before a stable release" or in the conventions' "Where the code does not follow this yet", with what would close it.
- No markdown nobody asked for: no plan, summary or notes file, and no prose to defend a decision. What a change owes is part of it: a changeset for a published package, the README entry the roadmap asks of a finished item, the line in "To revisit", and the site's pages when what they show changes.

## Layout

- `packages/arcadekit/src/`: the package's source. Each subpath of its `package.json` `exports` names its source file under a `source` condition, and its built files as `./dist/<name>.d.ts` and `./dist/<name>.js`; `tsdown.config.ts` builds every export from that map, and generates the declarations with the TypeScript compiler (`tsgo`), so an export's type may be inferred.
- A module's file is named in PascalCase after the namespace it is imported as, as Effect's own are: `src/App.ts` is `App`, `src/TickScheduler.ts` holds `TickScheduler`. The files of `src/ecs/` and `index.ts` are lower case.
- Every module is an entry: `src/App.ts` is `arcadekit/App`. `src/index.ts` is the `arcadekit` entry, which gives them all but `Browser`. Each imports Effect and nothing else, and names nothing that only a page has. `src/Browser.ts` is the `arcadekit/Browser` entry: everything only a page can use, and the one import of a browser package. `src/ecs/index.ts` is the `arcadekit/ecs` entry. A new module gets its entry in `package.json` with it.
- `packages/arcadekit/src/ecs/`: the storage core (components, tables, queries, the command buffer). It is plain synchronous TypeScript and imports nothing from Effect.
- `packages/arcadekit/test/`: its tests, run by Vitest from the source with no build.
- `packages/arcadekit/examples/` and `packages/arcadekit/bench/`: two example games and a benchmark, run with `pnpm --filter arcadekit demo`, `duel` and `bench`, the comparison of two checkouts' storage cores, `pnpm --filter arcadekit bench:compare <base checkout>`, which the `Benchmarks` workflow runs on a pull request that touches the storage core, a measurement of loops shared between workers, `pnpm --filter arcadekit bench:parallel`, a relay under Node, `examples/relay.ts`, run with `pnpm --filter arcadekit relay`, the same relay on Cloudflare, `examples/relay-cloudflare/`, declared with Alchemy and run on this machine with `pnpm --filter arcadekit relay:cloudflare`, a check of either, `pnpm --filter arcadekit relay:check <address>`, and a game in a page, `examples/page/`, served by `pnpm --filter arcadekit page`. They are type-checked by `tsconfig.examples.json` and are not published. Alchemy and its Cloudflare package are dev dependencies for the relay's example alone, and are a beta. The page's UI is built twice, with the DOM and with React, which is a dev dependency for that alone; `test/page.test.ts` mounts both in a document (happy-dom) and plays the game through them.
- `packages/three/`: `@arcadekit/three`, laid out the same way: `src/Three.ts` is its module and its entry, `src/Gltf.ts` is the one for models, which brings the glTF loader of Three.js, `src/index.ts` gives both, and `test/`, `examples/page/` (`pnpm --filter @arcadekit/three page`) and `bench/` (`pnpm --filter @arcadekit/three bench`) are beside them. It imports `arcadekit` by its entries, as a game would, and defines no component: where a thing is drawn comes from `arcadekit/Transform3d` and, for a flat game, `arcadekit/Transform2d` (`packages/arcadekit/src/Transform3d.ts` and `Transform2d.ts`), which a game's rules write.
- `docs/`: the conventions and the roadmap.
- `website/`: the docs site, Starlight. Its own pages are in `website/src/content/docs/`: `making-a-game.md`, `concepts/` and `guides/`, each with a frontmatter, and linking to a README by its address on the site (`/reference/arcadekit#saving-and-loading`). It also serves each package's README and the files of `docs/` in place, and makes a reference page for each module from its doc comments, read from the built declarations: every export gets a doc comment, with examples indented under a blank line and a `@category` from the list in `website/src/lib/api.ts`, and one marked `@internal` is left off. `website/README.md` says how. `pnpm dev:docs` serves it and `pnpm build:docs` builds it, and the build fails on a dead link. Every `ts` block of `website/src/content/docs/` is compiled by the site's typecheck, and a block titled `*.test.ts` is run: mark a block that is not whole `ts sketch`.
- `scripts/`: the workspace's helpers (the `source` condition for Vite and Vitest, what every test file starts with, the entries of a package's build, and the package lint).
- `.changeset/`: pending release notes; see its README.

## Rules the design depends on

- A system is one Effect per tick with plain loops inside. Code that runs once per entity is never an Effect: measured, that is about 25 times slower than a loop over columns.
- Nothing changes the set of entities or their components while a query is iterating. Such changes go through `Commands` and are applied when the system finishes.
- A tick gives the same result from the same inputs. Time comes from `Time`, waiting from `Script`, and fibers only resume when the tick flushes its scheduler.
- What draws the game runs in the frame stage, between ticks, and never changes the world: a game that is drawn is the same game as one that is not.
- What is heard is played in the frame stage too, from the events the simulation emits. The simulation never plays a sound.
- What the devices say reaches the game as actions, issued in the input stage before a tick and logged like any other: a replay reads no device.
- The peers of a game send each other the actions their players issue, each stamped with the tick it applies on, and nothing else. A session takes its app over, so that nothing moves one machine's game alone, and holds no socket and no timer: it is given the messages that arrived and gives the ones to send, and `Transport`, a service, carries them, between machines through a relay, which is a handler of plain functions (`Relay.join`, `Relay.forward`) that a host calls and that holds each peer to the name it connected under. A session that runs ahead of the network goes back with `app.rewind`, which puts back the world and what is waiting in the app and nothing else: what the simulation reads is in the world.
- A system that says what it reads and writes, with `System.access`, says all of it, and the app holds it to that: what it says can be relied on by whatever orders systems or runs them side by side.
- A UI holds a bridge and nothing of the game: it sees the views the game publishes in the frame stage, and acts by sending actions, which are issued and logged the same way.

## What only knowing the inside prevents

`docs/roadmap.md` keeps a list, "To revisit before a stable release": things that go wrong with no error and that nothing in the types or at run time stops, so that only someone who knows how the inside works avoids them. The order systems really run in is one; a value that has to be in some form and is not checked is another. When you come across one, while building, testing or writing a README sentence that begins "it is the game's to", add a line to that list in the same commit, with what would close it if you know. When you close one, take its line out.

## Verifying

A change is not done until it has been run and shown to work. Reasoning that it should work is not that.

- Run it. The tests, then whatever a user of it would run: `pnpm --filter arcadekit demo` and `duel`, the pages with `pnpm --filter arcadekit page` and `pnpm --filter @arcadekit/three page` (Chromium and Playwright are installed in a cloud session), and the relay with `relay:check`. Use these, and the drivers the tests already have (`Input.makeManualSource`, `Driver.makeManualDisplay`, `View.makeBridge`, `Sound.makeRecorder`, `Transport.makeHub`), before writing a script of your own.
- The simulation's evidence is its hash. A change to what a tick does is checked by running two apps of the same game side by side and comparing `world.hash()` after every tick, by replaying the log with `App.replay`, and, for peers, by the shuffled, late network of `test/peers.ts`.
- The repository's property tests are random operations against a model that is obviously right, with a seeded generator so that a failure repeats, as `test/storage.test.ts` and `test/restore.test.ts` are. A change to the storage core, a query, the hash, a snapshot, a rewind or a session adds to one or extends one.
- Every bug that is fixed comes with a test that fails without the fix. Break the code a new test covers and see it go red.
- A test waits for what it expects, with a limit, and never for a fixed time. A frame loop is turned by hand.
- Name things as the READMEs and the site's concepts and guides name them. They are the map of what a game author sees.

CI runs `pnpm check`, `pnpm test` and `pnpm build`, and on a pull request `pnpm build:packages && pnpm lint:packages`, and the `Benchmarks` workflow when the storage core changes. For any code change run `pnpm fix`, then `pnpm check`, `pnpm typecheck` and the tests that cover it. `pnpm check` is formatting plus oxlint's default rules; there are no style rules. For a change to the storage core or to a query, also run `pnpm --filter arcadekit bench`, and `pnpm --filter arcadekit bench:compare <base checkout>` against a checkout of the base, which fails on a variant that is slower by more than the noise unless a commit says `Bench-slower: <variants>` in its message; for a change to the loops of `@arcadekit/three` that draw, `pnpm --filter @arcadekit/three bench`. For a change to a package's exports or its build, or to what a module imports, run `pnpm build:packages && pnpm lint:packages`, which also checks what each built entry of each package imports. For a change to `website/` or `docs/`, run `pnpm --filter @arcadekit/website typecheck`, which compiles the pages' code, and `pnpm build:docs`.

## Pull requests

- One purpose each, small enough to be checked and reverted alone. A cleanup found on the way is a PR of its own, unless it is small and in the module being changed.
- Show the evidence, so that a reviewer can judge the change from it: the checks that were run and what they said, and which could not be run; the benchmark before and after for a hot path; a screenshot of a page or of what is drawn, when either changed; and for a change to a flow (a session, the stages of a frame, states, a game that ticks when needed) a short diagram of it when that is clearer than prose.
- Do not make it slower. A slowdown on purpose says so with `Bench-slower:` and the reason above it.
- Say what breaks, in the changeset, the commit and the PR.

## Issues

Issues live in this repository's GitHub Issues, with the triage labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`.
