---
title: "What a system reads and writes"
description: "A system can say what it reads and writes. The app holds it to that, and can then list the pairs of systems whose order matters and that nothing says."
---

A system can say what it reads and writes. The app holds it to that, and can then list the pairs of systems whose order matters and that nothing says.

## Saying it

`System.access` says it. Most of it is the system's queries, which already say which terms they only read. Beside them it names what it touches some other way:

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

| It says | For |
| --- | --- |
| `queries` | The queries it visits, `Query.removed` among them. A query's terms are written, but for the ones it [only reads](queries.md); what it requires, excludes or watches for changes is read |
| `reads` | What it reads and doesn't change: a singleton, a state, an event it reads, a component it reads through `World` |
| `writes` | What it changes: a singleton, a state, an event it emits, a component it sets through `World` or spawns, adds or removes through `Commands` |
| `random: true` | It draws from `Random` |
| `actions: true` | It issues actions with `Actions.enqueue` |
| `scripts: true` | It starts scripts with `Script.spawn` |

Some things are not said:

- What a condition given with `System.runIf(State.is(...))` reads is known. A condition of the game's own is the system's to say, as is what `System.otherwise` does.
- `Time` and `Ticks`, and the devices, `Input.Keyboard` and its kind.

A system of a plugin says what it touches, so that whichever game installs it can check its order.

## What the app holds a system to

What a system said is all of what it does. A query, a singleton, an event, a read or a write through the world, a command, an action or a script that was left out throws where it is made, names the system and says what to add. So what a system says can be relied on.

- A draw from `Random` that was left out is found when the system has run.
- A system is held as it runs, and no sooner. One that touches what it left out only when some condition of the game holds is refused in the first tick in which it does, which may be an hour into a game and never in a test.
- What a system may write it may read. A query it didn't name is let through when everything the query touches is within what the system said.
- A despawn takes everything an entity has, whatever was said. It is held to this much: the entity has a component the system said it writes. A system that despawns bullets says `writes: [Bullet]`.
- Scripts and handlers are not systems, and are held to nothing.
- A system that hasn't said may do anything, and costs a tick nothing more. One that has costs it about 50 ns: a tick of ten systems that do nothing takes 6.1 µs when each has said, against 5.6. Nothing is checked inside a loop.

## Checking the order

Which of two systems runs first is often an accident of [where they were listed](systems.md#order). `app.conflicts` lists the pairs for which the accident decides something, and `app.undeclared` the systems that haven't said, which are in no check:

```ts sketch
app.conflicts;
// [{
//   first: "game/Movement", // runs first, as things stand
//   second: "game/Aiming",
//   over: [{ what: "game/Position", kind: "component", first: "writes", second: "reads" }],
// }]
```

- Two systems are in conflict when both touch a component, a singleton, a state or an event, one of them at least to write it; or both draw from `Random`, both issue actions, or both start scripts.
- They are not when their order is said: one is `after` or `before` the other, directly or through others; they are in different stages; or one is a hook, which runs before a tick's systems. Hooks of one moment are checked among themselves.
- The systems of the frame stage and of the input stage change nothing, and are in neither list.

A conflict is settled by saying the order, with `System.after` or `System.before`, which changes nothing when it is the order they run in already. A test holds the list to empty, and `app.undeclared` too in a game that wants every system to have said:

```ts sketch
expect(app.conflicts).toEqual([]);
expect(app.undeclared).toEqual([]);
```

`System.conflicts(systems)` is the same check of any list of systems, and `System.accessOf(system)` is what one of them said, worked out.

## What the check doesn't find

- **Which way round is right.** `"watches"` is a read through a change query. A system listed ahead of the one that writes what it watches reacts a tick late, and the pair is in the list until its order is said. An order said the wrong way round is taken at its word. In a game that [ticks only when needed](running-a-game.md), the tick such a system is late by may not come: the game rests with work undone, unless the system that made the change asks for a tick with `Ticks.more`.
- **What a despawn takes.** A despawn is said by one component, and the entity's other components go with it, as does whatever hangs from it by a relation. A system that visits those through components the first never named is not found to be in conflict with it.
- **A system that hasn't said.** It is in `app.undeclared` and in no pair.

## Read more

- [Systems](systems.md): their order and their stages.
- [`System`](/reference/arcadekit/System) in the API reference.
