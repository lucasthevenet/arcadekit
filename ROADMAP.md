# Roadmap

What to build next, in order, and why in that order. The [docs site](website/src/content/docs/) says what exists today, and [Not done yet](website/src/content/docs/not-done-yet.md) what does not; the [`arcadekit-development` skill](.agents/skills/arcadekit-development/SKILL.md) says how to write what comes next.

Each item says what it is for, what has to be true for it to be done, and what it depends on. An item is not done until it has tests that fail when it is broken, a guide on the site, and a doc comment on each of its exports.

The order follows one rule: build what later items stand on first. Saving needs a seeded random source; netcode needs saving; a renderer needs a frame loop. Within a milestone the items are in order too.

Two lists are beside this one, each read when it is needed and not before:

- [roadmap/decisions.md](roadmap/decisions.md): what an item waits on, and what was decided and why.
- [roadmap/to-revisit.md](roadmap/to-revisit.md): what goes wrong with no error, by area, to be closed before a stable release.

## Next

### 0. Housekeeping

Small, and worth doing before anything is built on top.

- **Move to TypeScript 7.1 when it is released.** The declaration build prints a deprecation warning on 7.0. Done when `pnpm build` is quiet.

### 7. Speed and scale

Only with a benchmark that shows the need.

- **Parallel systems.** Workers over shared memory, for systems whose declared access does not overlap. Done when it is faster on a real workload, and still deterministic. Measured, and not built: there is two to four times to gain, in a game larger than any the package has been tried on, and it waits on four decisions that are still open. [What was measured](roadmap/decisions.md#parallel-systems-what-was-measured) and [what it waits on](roadmap/decisions.md#waiting) are in the decisions.

### 8. Seeing what is going on

- **An inspector.** Entities, their components, the systems and how long each took, the events of the last tick. Done when a bug can be found without adding a `console.log`.
- **Tracing.** A layer that turns each system into a span. `System.withSpan` exists; this makes it one line to switch on for a whole app.
- **Plugins that can be switched off.** Removing a plugin's systems while the app runs, for tools and for tests.

## Done

What is built is described where a game's author reads it: each line names the pages of the site that do.

1. **Determinism you can rely on.** [Determinism](website/src/content/docs/concepts/determinism.md): [random numbers](website/src/content/docs/guides/systems.md#random-numbers), [the world's hash](website/src/content/docs/guides/replays.md#the-worlds-hash), [replays](website/src/content/docs/guides/replays.md) that check themselves, [refusals](website/src/content/docs/guides/events-and-actions.md#checking-and-refusing) that leave nothing behind, and a log that holds what came from outside the simulation. Saving and netcode stand on these.
2. **Saving and loading.** [Saving and loading](website/src/content/docs/guides/saving-and-loading.md): snapshots, [fields](website/src/content/docs/guides/components.md#the-kinds-of-field) that say what saving does with them, a game saved with what was waiting in it, and versions and migrations.
3. **What every game ends up needing.** [Change queries](website/src/content/docs/guides/queries.md#what-changed), [singletons](website/src/content/docs/guides/components.md#singletons), [relations](website/src/content/docs/guides/components.md#relations), [states](website/src/content/docs/guides/states.md) and run conditions, and [a frame stage](website/src/content/docs/concepts/ticks-and-frames.md) that draws the game between ticks and cannot change the world. Running in a browser stands on the last.
4. **Running in a browser.** A frame loop and `App.run`, [in a page](website/src/content/docs/guides/running-a-game.md); [input](website/src/content/docs/guides/input.md), through the action log; and [assets](website/src/content/docs/guides/assets.md), loaded as a scoped resource. Drawing and UI stand on these.
5. **Drawing and UI.** [Where a thing is](website/src/content/docs/guides/transforms.md); a Three.js plugin, as a package of its own, [`@arcadekit/three`](website/src/content/docs/guides/drawing-with-three.md); [the view bridge](website/src/content/docs/guides/ui.md); and [sound](website/src/content/docs/guides/sound.md). These are plugins, not part of the core: a game that draws with something else leaves them out. More than one player and tools stand on these.
6. **More than one player.** [Several players](website/src/content/docs/concepts/several-players.md): [lockstep, drift detection and rollback](website/src/content/docs/guides/lockstep-and-rollback.md), [a transport](website/src/content/docs/guides/transports-and-relays.md) and [a relay](website/src/content/docs/guides/hosting-a-relay.md). Depends on milestones 1 and 2 entirely.
7. **Speed and scale**, so far. Accessors without code generation, for [a page under a Content Security Policy](website/src/content/docs/guides/running-a-game.md#under-a-content-security-policy); [systems that say what they read and write](website/src/content/docs/guides/system-access.md), which is what running systems side by side will stand on; [wider entity ids](website/src/content/docs/concepts/entities-and-systems.md#an-entitys-id); and benchmarks in CI, which `packages/arcadekit/bench/verdict.ts` describes. [Performance](website/src/content/docs/guides/performance.md) has the numbers.
8. **A documentation site.** [arcadekit.dev](https://arcadekit.dev), from `website/`: its own pages, and a reference made from the doc comments. The READMEs are a description and links to it.
