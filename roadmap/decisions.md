# Decisions

What the [roadmap](../ROADMAP.md) waits on, and what was decided and why. Not work yet: each one that waits needs an answer before the item that depends on it.

## Parallel systems: what was measured

`pnpm --filter arcadekit bench:parallel` is the smallest thing that could be called this, and no part of the package: columns in shared memory, a loop that is a plain function every thread has imported, a table's rows shared out between three workers and the main thread, which waits for them before it goes on. On four cores of a shared machine, the best of three:

| Loop | One thread | Four, asleep between jobs | Four, spinning |
| --- | --: | --: | --: |
| `pos += vel * dt`, 1,000 entities | 2.8 µs | 69.7 µs | 2.5 µs |
| The same, 100,000 | 263 µs | 180 µs | 69 µs |
| A flock, each steering by its eight neighbours, 10,000 | 370 µs | 253 µs | 178 µs |
| The same, 100,000 | 3.7 ms | 2.1 ms | 1.3 ms |
| The same, 400,000 | 14.8 ms | 8.0 ms | 6.7 ms |

Every line leaves the same numbers behind however the rows are shared out, since the loops write nothing another thread reads. Shared memory costs a loop on one thread nothing: 261 µs against 263.

So there is something to gain, two to four times, where a tick is over its budget: a flock of 400,000 does not fit in a sixtieth of a second on one thread and does on four. There is nothing to gain for the 100,000 entities of the package's own benchmark, which move in a quarter of a millisecond, and a loss wherever workers are left to sleep and the loop is short: waking one takes longer than a thousand entities take to move. That is the need, and it is a game larger than any the package has been tried on.

What it stands on is there: a system says what it reads and writes, and is held to it. What it waits on is what a worker runs. A worker has no closure of the main thread's, so the loop it runs is a function of a module it imported itself, given columns and numbers: a raw loop over columns, which is the `eachChunk` path. Three decisions were about exactly that, and are settled: the `!` stays in a raw loop, a sparse component filters a loop that runs on a worker and is not its data, and a game is a folder for each plugin, with its raw loops in a module of their own. Building it first would have settled them by accident.

## Waiting

Parallel systems wait on these four, which `pnpm --filter arcadekit bench:parallel` was written to inform. They came after three that are settled, below: a loop that runs on a worker is a raw loop over columns, it has to say what a sparse component is to it, and it has to be in a module that a worker's entry imports.

- **What a worker runs.** A function of a module the worker imported, given columns, a range of rows and numbers, and nothing it closed over. Whether that is a new kind of system, or the loop of an ordinary one given a name, and how a worker comes to import it. Four ways were sketched, and none is chosen: it waits until a game needs workers.
  - A registry at the game's root that names every plugin's loops, imported by the main thread and by a `worker.ts` there.
  - Each loop named where it is, `Parallel.loop("physics/fall", ...)`, and a `worker.ts` at the root that imports every plugin's `loops.ts`; the workers say which loops they hold when they start, so a plugin left out fails then. The one leaned towards: one set of workers, one wake a tick, and plain TypeScript.
  - A worker for each plugin, which a plugin installed from a package could bring with it, at the cost of threads that multiply with plugins and a wake for each.
  - A plugin of the bundler's that takes loops written inline in systems out into a worker it generates: the least to write, and a plugin for every bundler.
- **Whether workers sleep.** One that sleeps between jobs takes 25 µs to 70 µs to wake, which is more than most loops take; one that spins is there at once and burns a core, on a phone as on a desk. A page's main thread may not sleep at all, and spins while it waits.
- **Where shared memory is not to be had.** A page gets it only with the headers that isolate it from other origins, which are its host's to send. A game served without them runs on one thread, and has to be the same game.
- **What cannot be shared.** A field that holds an object, `json`, `ref` or `transient`, is not in shared memory. A worker's commands, the events it emits and the numbers it draws have to come back to the main thread and be applied in the order the systems were listed in, or a tick is no longer the same from the same inputs.

## Decided

Decided, and no longer waiting: raw columns under `noUncheckedIndexedAccess`. A raw loop asserts every read, `pos.x[i]!`, and there is no API of the fast path that does not. A checked accessor is a call per read, and the raw path is there because it makes none; the assertions stay inside loop bodies, where they are the one place `!` belongs. The [README](../packages/arcadekit/README.md#raw-columns-and-strict-indexing) says so.

Also decided: sparse data in raw loops. On the main thread a sparse component stays `{ columns, indexOf }` in `eachChunk`, which is what its rows not lining up with the table's comes to. A loop that runs on a worker takes a sparse component as a filter only, `with` or `without`, and never as data: the main thread works out the runs of rows, and the loop sees table columns alone. A component common enough for its loop to be worth sharing out is better in a table anyway. The [README](../packages/arcadekit/README.md#sparse-components-in-a-raw-loop) says so.

Also decided: how a game is laid out on disk. A folder for each plugin, its `index.ts` the plugin and what other plugins use of it, and its raw loops in a module of their own, `loops.ts`: plain functions of a range of rows, columns and numbers, which import nothing and close over nothing, so that whatever runs a loop needs only to have imported it. A file at the game's root makes the app. How a worker comes to run them is not decided: see what a worker runs, above. `examples/demo/` is laid out so, and the [README](../packages/arcadekit/README.md#how-a-game-is-laid-out) describes it.

Also decided: no UI library. The previous version drew its UI with Foldkit; this one does not depend on it, or on any other. Three.js is different, because it does a job the package would otherwise have to do itself. A game's UI reaches the game through the view bridge of milestone 5, with whatever library it likes.

Also decided: one entry or several. Several: an entry for every module, `arcadekit/App` and the rest, and `arcadekit` for all of them together, each importing Effect alone. What only a page can use is one entry, `arcadekit/Browser`, and starts a game in it. `arcadekit/ecs` is the storage core, which imports nothing. A UI bridge and netcode are each an entry of their own when they are built.

Also decided: a game that ticks when a player moves, in a page. It is an option of the frame loop and not a driver of its own: `ticks: "whenNeeded"`, on `Driver.frames`, `Driver.fixedStep` and `App.run`. The loop draws every frame and runs the input stage every frame, ticks while the app is not settled and once more after, and rests. What a menu sends through the view bridge is heard in the frame it is sent in.

Also decided: where a renderer lives. In a package of its own, `@arcadekit/three`, and not in an entry of `arcadekit` with Three.js as an optional peer, which is what this document said before. `arcadekit` then asks nobody for Three.js, and the plugin is versioned with the library it draws with.

Also decided: where a relay lives. In `arcadekit`, as a handler, `arcadekit/Relay`: plain functions that import Effect alone and that a host calls, since what accepts a WebSocket is a different thing on every platform and what to do with one is the same. Hosting it is the game's, with an example for each kind of host: a server that stays in memory, and one that is put to sleep between messages. A host that needs a library of its own would be a package of its own, as the renderer is.

Also decided: where the components for where a thing is live, and what they are called. In `arcadekit`, as `arcadekit/Transform3d` and `arcadekit/Transform2d`, each named for its dimensions, so that neither is the one a game gets without choosing. They were first in the renderer's package, in an entry that imported no Three.js, which made a server that runs a game's rules install the renderer. A game's rules write them, so they are the game's, and a renderer, sound that knows where a thing is, or netcode reads the same ones. A flat game has a variant of its own, `arcadekit/Transform2d`, in place of a `z` it does not use and a quaternion for a turn about one axis; whatever reads where things are reads both.
