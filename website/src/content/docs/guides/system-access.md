---
title: "What a system reads and writes"
description: "A system can declare what it reads and writes. The app enforces the declaration, and lists the pairs of systems whose order matters but isn't declared."
---

A system can declare what it reads and writes. The app enforces the declaration, and can then list the pairs of systems whose order matters but isn't declared.

## Declaring access

`System.access` takes the declaration. Most of it is the system's queries, which already state which terms they only read. Alongside them, you list what the system touches in other ways:

```ts
import {
  Component,
  Event,
  Field,
  Query,
  Singleton,
  System,
  Time,
} from "arcadekit";

const Position = Component.define("game/Position", { x: Field.f32 });
const Velocity = Component.define("game/Velocity", { x: Field.f32 });
const Score = Singleton.define(
  "game/Score",
  { points: Field.i32 },
  { points: 0 }
);
const Hit = Event.define<{ readonly damage: number }>("game/Hit");

const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));

const Movement = System.make("game/Movement", function* () {
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
  });
}).pipe(System.access({ queries: [Moving] }));

const Scoring = System.make("game/Scoring", function* () {
  const score = yield* Score;
  for (const hit of (yield* Hit).read()) {
    score.points += hit.damage;
  }
}).pipe(System.access({ reads: [Hit], writes: [Score] }));
```

| Option | Declares |
| --- | --- |
| `queries` | The queries it runs, including `Query.removed`. A query's terms count as written, except the ones it [only reads](queries.md#read-only-access); what it requires, excludes or watches counts as read |
| `reads` | What it reads without changing: a singleton, a state, an event it reads, a component it reads through `World` |
| `writes` | What it changes: a singleton, a state, an event it emits, a component it sets through `World` or spawns, adds or removes through `Commands` |
| `random: true` | It draws from `Random` |
| `actions: true` | It issues actions with `Actions.enqueue` |
| `scripts: true` | It starts scripts with `Script.spawn` |

Some things don't need declaring:

- What a `System.runIf(State.is(...))` condition reads is known. A condition of your own must be declared by the system, as must whatever `System.otherwise` does.
- `Time`, `Ticks`, and the devices, such as `Input.Keyboard`.

Declare access in a plugin's systems, so that any game that installs the plugin can check its order.

## Enforcement

A declaration is the complete list of what a system does. Accessing a query, singleton or event, reading or writing through the world, issuing a command, an action or a script that isn't declared throws where it happens, names the system, and says what to add. So you can rely on a declaration.

- An undeclared draw from `Random` is detected once the system has run.
- A system is checked as it runs, not before. A system that touches something undeclared only under some game condition is refused on the first tick it does so, which may be an hour into a game and never in a test.
- Whatever a system may write, it may also read. An undeclared query is allowed when everything it touches is within the declaration.
- A despawn removes everything an entity has, whatever was declared. The check is that the entity has a component the system declares it writes: a system that despawns bullets declares `writes: [Bullet]`.
- Scripts and handlers aren't systems and aren't checked.
- A system without a declaration may do anything, at no extra cost. One with a declaration costs about 50 ns per tick: a tick of ten empty systems takes 6.1 µs when each has a declaration, against 5.6 µs. Nothing is checked inside a loop.

## Checking the order

Which of two systems runs first is often an accident of [where they were listed](systems.md#ordering). `app.conflicts` lists the pairs where that accident matters, and `app.undeclared` lists the systems with no declaration, which no check covers:

```ts sketch
app.conflicts;
// [{
//   first: "game/Movement", // currently runs first
//   second: "game/Aiming",
//   over: [{ what: "game/Position", kind: "component", first: "writes", second: "reads" }],
// }]
```

- Two systems conflict when both touch a component, singleton, state or event and at least one writes it, or when both draw from `Random`, both issue actions, or both start scripts.
- They don't conflict when their order is declared (one is `after` or `before` the other, directly or through others), when they are in different stages, or when one is a hook, which runs before a tick's systems. Hooks for the same moment are checked against each other.
- Frame and input stage systems change nothing, and appear in neither list.

Resolve a conflict by declaring the order with `System.after` or `System.before`, which changes nothing if that is already the running order. A test can require the list to be empty, and `app.undeclared` too, in a game where every system declares its access:

```ts sketch
expect(app.conflicts).toEqual([]);
expect(app.undeclared).toEqual([]);
```

`System.conflicts(systems)` runs the same check on any list of systems, and `System.accessOf(system)` returns one system's resolved declaration.

## What the check doesn't catch

- **Which order is right.** `"watches"` is a read through a change query. A system listed before the one that writes what it watches reacts a tick late, and the pair stays in the list until you declare an order. A declared order is trusted even if it's the wrong way round. In a game that [ticks only when needed](running-a-game.md), the late tick may never come: the game rests with work undone, unless the system that made the change requests a tick with `Ticks.more`.
- **What a despawn removes.** A despawn is declared through one component, but the entity's other components go with it, as does everything attached to it by a relation. A system that visits those through components the first never declared isn't found to conflict with it.
- **Systems without a declaration.** They appear in `app.undeclared` and in no pair.

## Read more

- [Systems](systems.md): ordering and stages.
- [`System`](/reference/arcadekit/System) in the API reference.
