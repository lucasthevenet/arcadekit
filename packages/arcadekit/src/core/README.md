# arcadekit/core

The DOM-free building blocks of a game's simulation: a fixed-step clock, a seeded random generator, struct-of-arrays entity pools, a spatial grid and an event buffer. Nothing in it allocates per step, and nothing touches the DOM, so it runs in a browser, a Web Worker or on a server.

An entry of the [`arcadekit`](../../README.md) package.

## Install

```bash
pnpm add arcadekit effect
```

`effect` (~4.1) is the package's one required peer dependency, but this entry doesn't import it: a game can use `arcadekit/core` without running any Effect.

## Example

Enemies in a pool, spawned with the run's seeded `Rng`, and an event reported through an `EventBuffer` (as `@arcadekit/survivors` does):

```ts
import { EventBuffer, createPool, makeRng } from "arcadekit/core";

const rng = makeRng(42);
const events = new EventBuffer<{
  readonly type: "killed";
  readonly x: number;
}>();
const enemies = createPool(500, {
  x: Float32Array,
  z: Float32Array,
  hp: Float32Array,
});

const i = enemies.add(); // -1 when the pool is full
if (i !== -1) {
  enemies.fields.x[i] = rng.range(-10, 10);
  enemies.fields.z[i] = rng.range(-10, 10);
  enemies.fields.hp[i] = 3;
}

// Remove while iterating backwards: removing moves the last entity into the hole.
for (let j = enemies.count - 1; j >= 0; j--) {
  if (enemies.fields.hp[j]! <= 0) {
    events.push({ type: "killed", x: enemies.fields.x[j]! });
    enemies.remove(j);
  }
}
const facts = events.drain();
```

`createIdentifiedPool` gives entities stable ids too, for undo or a view that tweens each one. `FixedStepClock` turns frame times into whole fixed steps; `arcadekit/runtime`'s `GameLoop` uses it for you.

See [ADR-0003](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0003-one-fixed-step-clock.md) (one fixed-step clock), [ADR-0006](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0006-identified-pools-reuse-ids.md) (identified pools) and [ADR-0011](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0011-a-step-uses-only-exact-math.md) (a step uses only exact math).
