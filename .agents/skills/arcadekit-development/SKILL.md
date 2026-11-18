---
name: arcadekit-development
description: How code in arcadekit is written. Use when adding, changing or reviewing code of `packages/arcadekit` or `packages/three`, a test of either, an example or a benchmark, or a game built on them.
---

How code in arcadekit is written, so that it reads like Effect code and like the rest of the package.

When this guide and Effect's own guidance disagree, this guide wins inside the simulation (the storage core and anything a tick runs), because that code has constraints Effect's guidance does not have in mind. Everywhere else, Effect's guidance wins and the disagreement is a bug in this guide.

## Workflow

1. Decide which of the two kinds of code the change is, below.
2. Select every branch the change touches, and read its file before editing:
   - a new module, an entry, a name, or a package of its own: [modules.md](modules.md);
   - Effect code, its errors, or a value a system yields or pipes: [effects.md](effects.md);
   - a service, a resource, a layer, or how a program starts: [services.md](services.md);
   - data that comes in from outside or goes out: [schema.md](schema.md);
   - a part of a game (a component, a system, an event, an action, a view, a sound, a session, a script, a plugin, what draws): [game-parts.md](game-parts.md);
   - anything a tick runs: [determinism.md](determinism.md);
   - `src/ecs/` or a loop that runs once per entity: [storage-core.md](storage-core.md);
   - the types of an export: [types.md](types.md);
   - a test: [tests.md](tests.md);
   - a complex feature that an engine has solved before: [design.md](design.md);
   - an Effect API remembered from Effect 3: [effect-3.md](effect-3.md).
3. Look up each Effect API the change uses, as below, and read nearby source and tests for what this guide does not say.

The task is complete when the change follows each selected branch, and the checks that `AGENTS.md` lists for it pass or are reported as not run.

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

## Where to look things up

In this order:

1. **The installed source.** `packages/arcadekit/node_modules/effect/src/<Module>.ts` is the version this repository builds against, and every export has a doc comment with examples. It cannot be out of date.
2. **Effect's guide for writing Effect code**, [LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md), and the runnable examples it links to under [ai-docs/src](https://github.com/Effect-TS/effect/tree/main/ai-docs/src). This is the closest thing Effect has to a house style.
3. **The v4 documentation**: the [guides](https://effect.website/docs/v4/guides) and the [API reference](https://effect.website/docs/v4/api/effect).
4. **The migration notes**, [MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md), when something you remember from Effect 3 does not exist. Most tutorials, answers and examples on the web are Effect 3. See [Effect 3 habits](effect-3.md).

Do not use any other copy of Effect's documentation. Effect's own guide says the same: mirrors and older pages are often wrong for v4.

## Where the code does not follow this yet

Nothing at the moment. When code has to depart from this guide for a while, list it here with what is missing, and remove the entry with the fix.

The references to Effect's repository and documentation were checked on 2026-11-15, against Effect 4.1. The repository installs 4.1.4, which Alchemy, a dev dependency of the relay's example, asks for; the packages still take any 4.1 from 4.1.2.
