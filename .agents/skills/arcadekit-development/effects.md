# Effect code

## Where to look up Effect

Effect's own guidance is how Effect code is written here, and this file says only where the package decides something or departs from it. Look an API up in this order:

1. **The installed source.** `packages/arcadekit/node_modules/effect/src/<Module>.ts` is the version this repository builds against, and every export has a doc comment with examples. It cannot be out of date.
2. **Effect's guide for writing Effect code**, [LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md), and the runnable examples it links to under [ai-docs/src](https://github.com/Effect-TS/effect/tree/main/ai-docs/src). This is the closest thing Effect has to a house style.
3. **The v4 documentation**: the [guides](https://effect.website/docs/v4/guides) and the [API reference](https://effect.website/docs/v4/api/effect).
4. **The migration notes**, [MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md), when something you remember from Effect 3 does not exist. Most tutorials, answers and examples on the web are Effect 3. See [Effect 3 habits](effect-3.md).

Do not use any other copy of Effect's documentation. Effect's own guide says the same: mirrors and older pages are often wrong for v4.

## Writing Effects

- **`Effect.fn("Module.name")`** for a reusable function that returns an Effect and is worth seeing in a trace. **`Effect.fnUntraced`** for one that is not, which is most of a library's internals. Do not write a function whose whole body is `return Effect.gen(...)`: that is what these two are for. See the [Effect.fn example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/01_basics/02_effect-fn.ts).
- **Not for anything that runs every tick.** `Effect.fn` records a stack trace on each call. A system is built once with `Effect.gen` and the same Effect value is run every tick; `System.tick`, `System.frame` and `System.input` do this for you.
- **Fail by yielding the error, and return it**: `return yield* new NotYourTurn(...)`. A tagged error is yieldable, so it needs no `Effect.fail`, and the lint rule `effecttsgo/unnecessary-fail-yieldable-error` refuses one. A value that is not yieldable, such as a plain `Error`, is failed with `Effect.fail`. Without `return`, TypeScript does not know the code below is unreachable.

```ts sketch
export const loadLevel = Effect.fn("Level.load")(function* (name: string) {
  const assets = yield* Assets;
  return yield* assets.read(`levels/${name}.json`);
});
```

## Errors

Effect separates two kinds of failure, and so does this package. See [Two Types of Errors](https://effect.website/docs/v4/error-management/two-error-types).

- **An expected failure is a value in the error channel.** A move that breaks the rules, a payload that does not match its schema, a save file that will not load. Each is a class with a `_tag`, so a caller can handle it by name and the type says what can go wrong:
  - `Data.TaggedError` for an error that stays inside the program.
  - `Schema.TaggedError` for one that has to be written down or sent somewhere, because it can be encoded.
- **A bug is a defect, and is not caught.** Calling `dispatch` during a tick, registering two systems with one name, changing the world while a query is iterating. Synchronous code throws an `Error` whose message says what to do instead; Effect code uses `Effect.die`. Nothing in the package recovers from a defect.
- **Tags are unique across the package.** Two error classes with the same tag are caught by the same `catchTag`, and nothing warns you.

References: [Expected Errors](https://effect.website/docs/v4/error-management/expected-errors), [Unexpected Errors](https://effect.website/docs/v4/error-management/unexpected-errors), [Yieldable Errors](https://effect.website/docs/v4/error-management/yieldable-errors); [error handling example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/04_errors/01_error-handling.ts); API for [Data](https://effect.website/docs/v4/api/effect/Data) and [Exit](https://effect.website/docs/v4/api/effect/Exit).

## Domain values you can yield and pipe

The package's own values behave like Effect's, using the same three mechanisms.

- **Yieldable.** A value a system asks for is an Effect: `yield* Moving` gives a query's view, `yield* Collided` an event's channel, `yield* Gravity` a resource. A new kind of value like these extends `Effectable.Class` and implements `asEffect()`. `src/Query.ts` and `src/Event.ts` are the examples. API: [Effectable](https://effect.website/docs/v4/api/effect/Effectable).
- **Pipeable.** A value that is refined step by step has `.pipe()`: `Query.all(A).pipe(Query.without(B))`, `System.frame(...)`. A class that extends `Effectable.Class` has it already; anything else implements `pipe() { return pipeArguments(this, arguments); }`. API: [Pipeable](https://effect.website/docs/v4/api/effect/Pipeable).
- **Dual.** A function that refines a value works both ways: `System.inStage(system, stage)` and `system.pipe(System.inStage(stage))`. Define it with `dual` and write both signatures out. See [Dual APIs](https://effect.website/docs/v4/code-style/dual) and [Function](https://effect.website/docs/v4/api/effect/Function).

```ts sketch
export const inStage: {
  (stage: Stage): <E, R>(self: System<E, R>) => System<E, R>;
  <E, R>(self: System<E, R>, stage: Stage): System<E, R>;
} = dual(2, <E, R>(self: System<E, R>, stage: Stage): System<E, R> =>
  build({ ...self, stage })
);
```

Values like these are immutable descriptions. `System.inStage` returns a new system; it does not change the one it was given.

## Schema at the boundary

Data that comes from outside the program, or leaves it, is parsed at that boundary with a `Schema`, as pstack's [`principle-boundary-discipline`](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-boundary-discipline/SKILL.md) skill says: an action's payload, a save file, a network message.

- **Decode with the `Exit` forms** (`Schema.decodeUnknownExit`) in synchronous code, so a mismatch is a value and not an exception.
- **Store and send the JSON form.** `Schema.toCodecJson(schema)` gives a codec whose encoded side is JSON, converting the values Schema knows how to convert (a bigint, a date).
- **Use the `Predicate` module** for a type guard that is not worth a schema, not a hand-written `isString`.
- **Inside the simulation there are no schemas.** Component data is columns of numbers.

References: Schema [introduction](https://effect.website/docs/v4/schema/introduction), [basic usage](https://effect.website/docs/v4/schema/basic-usage), [filters](https://effect.website/docs/v4/schema/filters), [canonical codecs](https://effect.website/docs/v4/schema/canonical-codecs) and [class APIs](https://effect.website/docs/v4/schema/classes); the full guide, [SCHEMA.md](https://github.com/Effect-TS/effect/blob/main/packages/effect/SCHEMA.md); API for [Schema](https://effect.website/docs/v4/api/effect/Schema) and [Predicate](https://effect.website/docs/v4/api/effect/Predicate).

## What the tick replaces of Effect

- **The scheduler.** `src/internals/tick-scheduler.ts` replaces Effect's, so a fiber only resumes when the tick flushes it. That is why a tick is deterministic, and why no other `Scheduler` is provided to code inside an app. What has to go on in real time while the game runs is forked by a service in a plugin's `layer`, with the context it found there less the app's own services, as `src/Assets.ts` does. API: [Scheduler](https://effect.website/docs/v4/api/effect/Scheduler), [Fiber](https://effect.website/docs/v4/api/effect/Fiber).
- **Events.** `src/Event.ts` has its own implementation and does not use Effect's `PubSub`: each system keeps a read position from one tick to the next, and a refused action has to be able to take back the events it emitted and the reads it made.
- **A test of what several peers must agree on** runs two apps side by side and compares their hashes, as `test/Lockstep.test.ts` does.
