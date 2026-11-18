# Roadmap

What to build next, in order, and why in that order. The package's [README](packages/arcadekit/README.md) says what exists today; the [`arcadekit-development` skill](.agents/skills/arcadekit-development/SKILL.md) says how to write what comes next.

Each item says what it is for, what has to be true for it to be done, and what it depends on. An item is not done until it has tests that fail when it is broken, and an entry in the README.

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
- **A documentation site.** Built from the README, these documents and the doc comments.
- **Plugins that can be switched off.** Removing a plugin's systems while the app runs, for tools and for tests.

## Done

What is built is described where a game's author reads it: each line names the sections of the package's [README](packages/arcadekit/README.md) that do, and each README ends with what is not done yet.

1. **Determinism you can rely on.** [Randomness](packages/arcadekit/README.md#randomness), [the world's hash](packages/arcadekit/README.md#the-worlds-hash), [replays that check themselves](packages/arcadekit/README.md#replays-that-check-themselves), [refusals that leave nothing behind](packages/arcadekit/README.md#refusals-leave-nothing-behind), and a log that holds what came from outside the simulation. Saving and netcode stand on these.
2. **Saving and loading.** [Snapshots](packages/arcadekit/README.md#snapshots), [fields](packages/arcadekit/README.md#fields) that say what saving does with them, [saving and loading](packages/arcadekit/README.md#saving-and-loading) a game with what was waiting in it, and [versions and migrations](packages/arcadekit/README.md#versions-and-migrations).
3. **What every game ends up needing.** [Change queries](packages/arcadekit/README.md#change-queries), [singletons](packages/arcadekit/README.md#singletons), [relations](packages/arcadekit/README.md#relations), [states and run conditions](packages/arcadekit/README.md#states-and-run-conditions), and [a frame stage](packages/arcadekit/README.md#the-tick-and-the-frame) that draws the game between ticks and cannot change the world. Running in a browser stands on the last.
4. **Running in a browser.** A frame loop and `App.run`, [in a page](packages/arcadekit/README.md#in-a-page); [input](packages/arcadekit/README.md#input), through the action log; and [assets](packages/arcadekit/README.md#assets), loaded as a scoped resource. Drawing and UI stand on these.
5. **Drawing and UI.** [Where a thing is](packages/arcadekit/README.md#where-a-thing-is); a Three.js plugin, as a package of its own, [`@arcadekit/three`](packages/three/README.md); [the view bridge](packages/arcadekit/README.md#the-view-bridge); and [sound](packages/arcadekit/README.md#sound). These are plugins, not part of the core: a game that draws with something else leaves them out. More than one player and tools stand on these.
6. **More than one player.** Lockstep, drift detection, rollback, a transport and a relay: [More than one player](packages/arcadekit/README.md#more-than-one-player). Depends on milestones 1 and 2 entirely.
7. **Speed and scale**, so far. [Accessors without code generation](packages/arcadekit/README.md#under-a-content-security-policy); [systems that say what they read and write](packages/arcadekit/README.md#what-a-system-reads-and-writes), which is what running systems side by side will stand on; [wider entity ids](packages/arcadekit/README.md#an-entitys-id); and [benchmarks in CI](packages/arcadekit/README.md#benchmarks-in-ci).
