---
name: arcadekit-development
description: How code in arcadekit is written. Use when adding, changing or reviewing code of `packages/arcadekit` or `packages/three`, an example or a benchmark, or a game built on them.
---

How code in arcadekit is written, so that it reads like Effect code and like the rest of the package.

When this guide and Effect's own guidance disagree, this guide wins inside the simulation (the storage core and anything a tick runs), because that code has constraints Effect's guidance does not have in mind. Everywhere else, Effect's guidance wins and the disagreement is a bug in this guide.

## Workflow

1. Read what the public documentation says of the part the change is in. It is in two places, and there is no other:
   - **the site's pages**, `website/src/content/docs/`: a concept under `concepts/` for how the kit works and why, a guide under `guides/` for each part. A page is named after its subject, and `grep -rl "<Module>\." website/src/content/docs` finds the ones that use a module;
   - **the doc comments** of the module, in `packages/arcadekit/src/<Module>.ts`: the first is the module's, and each export has its own.

   They say what the part does, the rules a game follows with it, and what goes wrong. This skill does not repeat them: it says what a contributor needs beside them.

2. Decide which of the two kinds of code the change is, below.
3. Select every branch the change touches, and read its file before editing. Read no branch the change does not touch:
   - a new module, an entry, a name, or a package of its own: [modules.md](modules.md);
   - Effect code, its errors, a value a system yields or pipes, a schema, or what the tick replaces of Effect: [effects.md](effects.md);
   - a new service, a resource or a layer: [services.md](services.md);
   - `src/ecs/` or a loop that runs once per entity: [storage-core.md](storage-core.md);
   - the types of an export: [types.md](types.md);
   - a new rule, or a correction that could be a check: [checks.md](checks.md);
   - a new or changed API, or a complex feature that an engine has solved before: [design.md](design.md);
   - an Effect API remembered from Effect 3: [effect-3.md](effect-3.md).
4. Read what the code will not stop in the area the change is in, and no other area: the open issues labelled `silent-failure` that the roadmap, issue [#173](https://github.com/lucasthevenet/arcadekit/issues/173), lists under the order systems run in, ticks, frames and real time, several peers, what a save and the hash do not hold, values that are not checked, or who lets go of what.
5. Look up each Effect API the change uses, where [effects.md](effects.md) says to, and read nearby source and tests for what this guide does not say.
6. Keep the documentation true. A change that makes a page or a doc comment untrue, or that adds what a game's author has to know, changes them in the same change: a page with the `website-docs` skill, a doc comment with the `jsdocs` skill. Nothing is said a second time in a skill or in a README.
7. Test the change and show that it works, with the `test-development` skill.

The task is complete when the change follows each selected branch, the pages and doc comments say what it now does, it has been run and shown to work as the `test-development` skill says, and the checks that `AGENTS.md` lists for it pass or are reported as not run.

## Two kinds of code

Everything in the package is plain code or Effect code, and the first decision for any new code is which. Plain code is `src/ecs/` and the inside of any loop that runs once per entity: synchronous functions, typed arrays, mutation, and no import of `effect`. Everything else is Effect code. The boundary is the system: a system is one Effect per tick, and the loops inside it are plain, because one Effect per entity measured about 25 times slower than a loop over columns. If a loop body needs a service, take it out of the service before the loop and call it as a plain function inside. [Entities and systems](../../../website/src/content/docs/concepts/entities-and-systems.md#effect-outside-plain-loops-inside) says the same to a game's author.

## Boundaries

The folders are a contract, and most of it is checked.

- `src/ecs/` imports nothing. Every other module of `arcadekit` imports Effect alone and names nothing that only a page has. `src/Browser.ts` is the one import of a browser package. `@arcadekit/three` imports `arcadekit` by its entries, as a game would, and defines no component. The package does not depend on a UI library and will not. See [modules.md](modules.md).
- The stages are boundaries too: the tick is the simulation, the frame stage draws and plays sound and never changes the world, and the input stage turns devices into actions. What crosses one is refused. [Ticks and frames](../../../website/src/content/docs/concepts/ticks-and-frames.md) and [determinism](../../../website/src/content/docs/concepts/determinism.md) say what each may do.

## Root causes, not workarounds

- Fix the cause. The workarounds this repository is most likely to grow are: a timer, a promise or `Effect.sleep` that makes something happen later (in a tick it resumes outside the tick, and no replay repeats it; order is said with `System.after`, `System.before`, a stage, a state's hooks or `Ticks.more`); a wait or a retry in a test that passes most of the time; a `try` that swallows a defect; a cast, `as unknown as`, an `any` or a `!` that quiets the compiler where the types are wrong; a write through a raw column or a `world._` field from code that may not make it; and `app.enqueue` from inside a system.
- Code that is already here is not precedent. If what you would copy is a workaround, a deprecated API or an Effect 3 habit, do not copy it: say so. If it is in the module you are changing and fixing it is small, fix it and add the check that keeps it out; otherwise name it in the PR.
- Two checks are off on purpose, and no other is: `eslint/require-yield`, because a system is a generator even when it yields nothing, and `test/policyGame.ts` makes code from text because that is what it tests.
- Use the constrained form when there is one. [Rules for your simulation](../../../website/src/content/docs/concepts/determinism.md#rules-for-your-simulation) lists them for what a tick runs (`Time`, `Random`, `Script`, an action for a device), and the package's own code keeps to the same list. Beside it: `App.make` and never `Layer.build` or a `Scheduler` of your own; `yield*` and never `Effect.runSync` inside a program; `app.enqueue` and never `app.dispatch` in a game of several peers; `State.onEnter` and never a flag a system checks; `Query.changed` and never a copy kept to compare.

## Comments

- Every export has a doc comment, which is its reference: the `jsdocs` skill says how one is written.
- Inside the code, write no comment by default. Write one only for a why the code cannot say: an invariant, an order that matters, a number that was measured, the engine a design came from. Keep it to a line or two.
- No comment, doc sentence or rule explains a workaround or why the right thing was not done. Say that in the reply or the PR. If the debt stays, it is an issue, with what would close it, as `AGENTS.md` says.

## Where the code does not follow this yet

When code has to depart from this guide for a while, that is an issue that says what is missing, closed by the fix, and never a line here.

The references to Effect's repository and documentation were checked on 2026-11-15, against Effect 4.1. The repository installs 4.1.4, which Alchemy, a dev dependency of the relay's example, asks for; the packages still take any 4.1 from 4.1.2.
