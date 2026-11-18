---
name: arcadekit-development
description: How code in arcadekit is written. Use when adding, changing or reviewing code of `packages/arcadekit` or `packages/three`, a test of either, an example or a benchmark, or a game built on them.
---

How code in arcadekit is written, so that it reads like Effect code and like the rest of the package.

When this guide and Effect's own guidance disagree, this guide wins inside the simulation (the storage core and anything a tick runs), because that code has constraints Effect's guidance does not have in mind. Everywhere else, Effect's guidance wins and the disagreement is a bug in this guide.

## Workflow

1. Decide which of the two kinds of code the change is, below.
2. Select every branch the change touches, and read its file before editing. Read no branch the change does not touch:
   - a new module, an entry, a name, an export's doc comment, or a package of its own: [modules.md](modules.md);
   - Effect code, its errors, or a value a system yields or pipes: [effects.md](effects.md);
   - a service, a resource, a layer, or how a program starts: [services.md](services.md);
   - data that comes in from outside or goes out: [schema.md](schema.md);
   - a part of a game (a component, a system, an event, an action, a view, a sound, a session, a script, a plugin, what draws): [game-parts.md](game-parts.md);
   - anything a tick runs: [determinism.md](determinism.md);
   - `src/ecs/` or a loop that runs once per entity: [storage-core.md](storage-core.md);
   - the types of an export: [types.md](types.md);
   - a test, or showing that a change works: [tests.md](tests.md);
   - a new rule, or a correction that could be a check: [checks.md](checks.md);
   - a complex feature that an engine has solved before: [design.md](design.md);
   - an Effect API remembered from Effect 3: [effect-3.md](effect-3.md).
3. Read what the code will not stop in the area the change is in, and no other area: the section of [to-revisit.md](../../../roadmap/to-revisit.md) on the order systems run in, on ticks, frames and real time, on several peers, on what a save and the hash do not hold, or on who lets go of what.
4. Look up each API the change uses, as below, and read nearby source and tests for what this guide does not say.

The task is complete when the change follows each selected branch, has been run and shown to work as [tests.md](tests.md) says, and the checks that `AGENTS.md` lists for it pass or are reported as not run.

## The rules the design depends on

- A system is one Effect per tick with plain loops inside.
- Nothing changes the set of entities or their components while a query is iterating. Such changes go through `Commands` and are applied when the system finishes.
- A tick gives the same result from the same inputs. Time comes from `Time`, waiting from `Script`, and fibers only resume when the tick flushes its scheduler.
- What draws the game runs in the frame stage, between ticks, and never changes the world: a game that is drawn is the same game as one that is not.
- What is heard is played in the frame stage too, from the events the simulation emits. The simulation never plays a sound.
- What the devices say reaches the game as actions, issued in the input stage before a tick and logged like any other: a replay reads no device.
- The peers of a game send each other the actions their players issue, each stamped with the tick it applies on, and nothing else. A session takes its app over, so that nothing moves one machine's game alone, and holds no socket and no timer: it is given the messages that arrived and gives the ones to send, and `Transport`, a service, carries them, between machines through a relay, which is a handler of plain functions (`Relay.join`, `Relay.forward`) that a host calls and that holds each peer to the name it connected under. A session that runs ahead of the network goes back with `app.rewind`, which puts back the world and what is waiting in the app and nothing else: what the simulation reads is in the world.
- A system that says what it reads and writes, with `System.access`, says all of it, and the app holds it to that: what it says can be relied on by whatever orders systems or runs them side by side.
- A UI holds a bridge and nothing of the game: it sees the views the game publishes in the frame stage, and acts by sending actions, which are issued and logged the same way.

## Two kinds of code

Everything in the package is one of two kinds, and the first decision for any new code is which.

|  | Plain code | Effect code |
| --- | --- | --- |
| Where | `src/ecs/`, and the inside of any loop that runs once per entity | Everything else |
| Looks like | Synchronous functions and classes, typed arrays, mutation | `Effect.gen`, services, layers, typed errors |
| May import `effect` | No | Yes |
| Why | It runs tens of thousands of times a tick. One Effect per entity measured about 25 times slower than a loop over columns. | It runs a handful of times a tick, and needs what Effect gives: dependencies, typed failure, resources, cancellation. |

The boundary is the system. A system is one Effect per tick; the loops inside it are plain.

```ts sketch
const Movement = System.make("Movement", function* () {
  // Effect code: ask for what the system needs.
  const moving = yield* Moving;
  const { delta } = yield* Time;
  // Plain code: no `yield*` in here, however convenient it would be.
  moving.each((pos, vel) => {
    pos.x += vel.x * delta;
  });
});
```

If a loop body needs a service, take it out of the service before the loop and call it as a plain function inside.

## Boundaries

The folders are a contract, and most of it is checked. The stages are boundaries too, as the rules above say, and what crosses one is refused.

- `src/ecs/` imports nothing. Every other module of `arcadekit` imports Effect alone and names nothing that only a page has. `src/Browser.ts` is the one import of a browser package. `@arcadekit/three` imports `arcadekit` by its entries, as a game would, and defines no component. The package does not depend on a UI library and will not: a game's menus and heads-up display are built with whatever it chooses. See [modules.md](modules.md).
- A game is a folder for each plugin. Other plugins import its `index.ts` and nothing else of it, and its raw loops are in `loops.ts`, which imports nothing and closes over nothing. See [game-parts.md](game-parts.md).

## Root causes, not workarounds

- Fix the cause. The workarounds this repository is most likely to grow are: a timer, a promise or `Effect.sleep` that makes something happen later (in a tick it resumes outside the tick, and no replay repeats it; order is said with `System.after`, `System.before`, a stage, a state's hooks or `Ticks.more`); a wait or a retry in a test that passes most of the time; a `try` that swallows a defect; a cast, `as unknown as`, an `any` or a `!` that quiets the compiler where the types are wrong; a write through a raw column or a `world._` field from code that may not make it; and `app.enqueue` from inside a system.
- Code that is already here is not precedent. If what you would copy is a workaround, a deprecated API or an Effect 3 habit, do not copy it: say so. If it is in the module you are changing and fixing it is small, fix it and add the check that keeps it out; otherwise name it in the PR.
- Two checks are off on purpose, and no other is: `eslint/require-yield`, because a system is a generator even when it yields nothing, and `test/policy-game.ts` makes code from text because that is what it tests.
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

## Comments

- Every export has a doc comment: see [modules.md](modules.md).
- Inside the code, write no comment by default. Write one only for a why the code cannot say: an invariant, an order that matters, a number that was measured, the engine a design came from. Keep it to a line or two.
- No comment, doc, README sentence or rule explains a workaround or why the right thing was not done. Say that in the reply or the PR. If the debt stays, it is a line of [to-revisit.md](../../../roadmap/to-revisit.md) or of "Where the code does not follow this yet", below, with what would close it.

## Where to look things up

What arcadekit itself does, for the module the change is in and no other:

- its doc comments, in `packages/arcadekit/src/<Module>.ts`, which are its reference;
- its section of the package's README, found with `grep -n '^##' packages/arcadekit/README.md`: the README is 1,700 lines, and is read a section at a time;
- its guide, under `website/src/content/docs/guides/`, and the concept it stands on, under `website/src/content/docs/concepts/`;
- its tests, in `packages/arcadekit/test/`, named after what they test.

What Effect does, in this order:

1. **The installed source.** `packages/arcadekit/node_modules/effect/src/<Module>.ts` is the version this repository builds against, and every export has a doc comment with examples. It cannot be out of date.
2. **Effect's guide for writing Effect code**, [LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md), and the runnable examples it links to under [ai-docs/src](https://github.com/Effect-TS/effect/tree/main/ai-docs/src). This is the closest thing Effect has to a house style.
3. **The v4 documentation**: the [guides](https://effect.website/docs/v4/guides) and the [API reference](https://effect.website/docs/v4/api/effect).
4. **The migration notes**, [MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md), when something you remember from Effect 3 does not exist. Most tutorials, answers and examples on the web are Effect 3. See [Effect 3 habits](effect-3.md).

Do not use any other copy of Effect's documentation. Effect's own guide says the same: mirrors and older pages are often wrong for v4.

## Where the code does not follow this yet

Nothing at the moment. When code has to depart from this guide for a while, list it here with what is missing, and remove the entry with the fix.

The references to Effect's repository and documentation were checked on 2026-11-15, against Effect 4.1. The repository installs 4.1.4, which Alchemy, a dev dependency of the relay's example, asks for; the packages still take any 4.1 from 4.1.2.
