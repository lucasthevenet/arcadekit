---
title: "Vectors and overlaps"
description: "Vec2 measures and scales two-dimensional vectors in a loop, Overlap tells whether circles and boxes touch, and Overlap.pairs finds every bullet that meets an enemy."
---

An **overlap** is two shapes that touch. `Overlap` tests circles and boxes, and finds every pair of entities of two queries whose shapes touch, such as the bullets that meet an enemy. `Vec2` is the arithmetic of a direction or a speed in two dimensions. Both are plain functions, made to be called inside a loop of the tick: they allocate nothing, and give the same answer on every machine.

## Move at the same speed in every direction

```ts
import {
  Component,
  Field,
  Query,
  System,
  Time,
  Transform2d,
  Vec2,
} from "arcadekit";

const Stick = Component.define("game/Stick", { x: Field.f32, y: Field.f32 });
const Velocity = Component.define("game/Velocity", {
  x: Field.f32,
  y: Field.f32,
});

const Steered = Query.all(Velocity, Stick).pipe(Query.writes(Velocity));
const Moving = Query.all(Transform2d.Position, Velocity).pipe(
  Query.writes(Transform2d.Position)
);

export const Steer = System.tick("game/Steer", function* () {
  (yield* Steered).each((velocity, stick) => {
    Vec2.clampLength(velocity, stick.x * 5, stick.y * 5, 5);
  });
});

export const Move = System.tick("game/Move", function* () {
  const { delta } = yield* Time;
  (yield* Moving).each((position, velocity) => {
    position.x += velocity.x * delta;
    position.y += velocity.y * delta;
  });
});
```

A function that makes a vector writes it into its first argument, any object with an `x` and a `y`. Given the row of a query, it writes the component, as `Vec2.clampLength` writes `Velocity` here: a stick pushed into a corner moves the entity no faster than one pushed straight up.

| Function | Returns |
| --- | --- |
| `Vec2.length(x, y)` | The length of the vector |
| `Vec2.distance(ax, ay, bx, by)` | The distance between two points |
| `Vec2.normalize(out, x, y)` | `out`, set to length 1 in the direction of `(x, y)`, or `(0, 0)` |
| `Vec2.clampLength(out, x, y, max)` | `out`, set to `(x, y)` shortened to `max` if it is longer |

## Test two shapes

```ts
import { Overlap } from "arcadekit";

Overlap.circles(0, 0, 1, 1.5, 0, 0.5); // true: centres 1.5 apart, radii 1 and 0.5
Overlap.boxes(0, 0, 2, 1, 3, 0, 1, 1); // true: half widths 2 and 1, 3 apart
Overlap.circleBox(0, 4, 1, 0, 0, 2, 2); // false: the circle stops 1 above the box
```

Each test takes the shapes as numbers: a circle as its centre and its radius, a box as its centre, its half width and its half height. Shapes touch when they share a point, so circles whose edges meet touch. A box has its sides along the axes.

## Find every bullet that hits an enemy

```ts
import {
  Commands,
  Component,
  Field,
  Overlap,
  Query,
  System,
  Transform2d,
  World,
} from "arcadekit";

const Bullet = Component.tag("game/Bullet");
const Enemy = Component.define("game/Enemy", { hp: Field.i32 });

const Bullets = Query.all(Transform2d.Position, Overlap.Circle).pipe(
  Query.with(Bullet)
);
const Enemies = Query.all(Transform2d.Position, Overlap.Circle, Enemy);

export const Hit = System.tick("game/Hit", function* () {
  const world = yield* World.writes(Enemy);
  const commands = yield* Commands;
  Overlap.pairs(commands, yield* Bullets, yield* Enemies, (_bullet, enemy) => {
    const hp = world.get(enemy, Enemy)!.hp - 1;
    world.set(enemy, Enemy, { hp });
    return hp > 0 ? "first" : "both";
  });
});
```

A shape is a component beside `Transform2d.Position`: `Overlap.Circle` gives a `radius`, and `Overlap.Box` a `halfWidth` and a `halfHeight`, centred on the position. Each query given to `Overlap.pairs` starts with the position, then the shape, then any terms of its own. A query of other terms doesn't compile.

`Overlap.pairs` calls the callback for every pair of an entity of the first query and an entity of the second whose shapes touch, and the callback returns what to despawn: `"first"`, `"second"`, `"both"` or `"neither"`. An entity queued to despawn takes part in no later pair of the call, whether the callback returned it or despawned it with `commands.despawn`. Here a bullet is spent on the first enemy it reaches, and an enemy two bullets reach in one tick takes one hit for each, and dies once.

- Pairs come in the order of the first query's entities, and for each, of the second's, so a replay hits the same enemies.
- Where the entities are is read once, when the call begins.
- It tests every pair: about 2.5 ms for a thousand bullets against a thousand enemies. Keep the two queries to what can touch, with a tag or `Query.without`.
- Shapes ignore `Transform2d.Rotation` and `Transform2d.Scale`.
