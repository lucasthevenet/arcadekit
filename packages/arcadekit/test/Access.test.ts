import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { ComponentDef, Guard, QuerySpec } from "../src/ecs/index";
import {
  Action,
  App,
  Commands,
  Component,
  EcsWorld,
  Event,
  Field,
  Input,
  Plugin,
  Query,
  Random,
  Script,
  Singleton,
  State,
  System,
  Time,
  World,
} from "../src/index";
import type { Entity } from "../src/index";

const Position = Component.define("ac/Position", {
  x: Field.f32,
  y: Field.f32,
});

const Velocity = Component.define("ac/Velocity", {
  x: Field.f32,
  y: Field.f32,
});

const Health = Component.define("ac/Health", { hp: Field.i32 });
const Bullet = Component.tag("ac/Bullet");

const Burning = Component.define(
  "ac/Burning",
  { seconds: Field.f32 },
  { storage: "sparse" }
);

const Score = Singleton.define(
  "ac/Score",
  { points: Field.i32 },
  { points: 0 }
);

const Phase = State.define("ac/Phase", ["playing", "over"]);
const Hit = Event.define("ac/Hit", Schema.Struct({ damage: Schema.Number }));
const Fired = Event.define("ac/Fired", Schema.Struct({}));
const Boost = Action.define("ac/Boost", Schema.Struct({}));

const boost = Action.handler(Boost, function* () {
  (yield* Score).points += 100;
});

const Moving = Query.all(Position, Velocity).pipe(Query.reads(Velocity));
const Wounded = Query.all(Health);

/** An app of these systems, with something in its world to visit. */
const playing = (systems: readonly System.System<any, any>[]) =>
  Effect.gen(function* () {
    const app = yield* App.make({
      systems: systems as readonly System.System<never, never>[],
      handlers: [boost],
      components: [Position, Velocity, Health, Bullet, Burning, Score, Phase],
      seed: 3,
    });

    for (let i = 0; i < 6; i += 1) {
      app.world.spawn(
        Position.of({ x: i, y: 0 }),
        Velocity.of({ x: 1, y: 1 }),
        Health.of({ hp: 10 + i }),
        ...(i % 2 === 0 ? [Bullet] : [])
      );
    }

    return app;
  });

/** Runs `body` as the one system of an app, with this access, for one tick. */
const ticking = (
  access: System.Access | undefined,
  body: () => Generator<Effect.Effect<unknown, unknown, unknown>, void, never>
): void =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const made = System.make("Sneaky", body);

        const app = yield* playing([
          access === undefined ? made : made.pipe(System.access(access)),
        ]);

        app.tick(1);
      })
    )
  );

const hashes = (systems: readonly System.System<any, any>[]): number[] =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* playing(systems);
        const out: number[] = [];

        for (let tick = 0; tick < 12; tick += 1) {
          app.tick(1 / 60);
          out.push(app.world.hash());
        }

        // The game is one in which things happen.
        expect(app.world.singleton(Score).points).toBeGreaterThan(20);
        expect(app.world.entityCount).toBeLessThan(6);

        return out;
      })
    )
  );

const refused = (
  access: System.Access,
  use: (commands: Commands["Service"]) => void
): string => {
  let message = "it was not refused";
  ticking(access, function* () {
    const commands = yield* Commands;

    try {
      use(commands);
    } catch (error) {
      ({ message } = error as Error);
    }
  });

  return message;
};

const frame = (system: System.System<any, any>): void =>
  Effect.runSync(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* playing([system]);
        app.tick(1);
        app.frame(0);
      })
    )
  );

const touches = (access: System.Access): [string, System.Touch][] =>
  Array.from(
    System.accessOf(
      System.make("S", function* () {}).pipe(System.access(access))
    )!.components,
    ([name, { touch }]) => [name, touch]
  );

describe("a system that says what it reads and writes", () => {
  const Movement = System.make("Movement", function* () {
    const { delta } = yield* Time;
    (yield* Moving).each((position, velocity) => {
      position.x += velocity.x * delta;
      position.y += velocity.y * delta;
    });
  });

  const Scoring = System.make("Scoring", function* () {
    const score = yield* Score;

    for (const hit of (yield* Hit).read()) {
      score.points += hit.damage;
    }
  });

  const Wounding = System.make("Wounding", function* () {
    const random = yield* Random;
    const hit = yield* Hit;
    const commands = yield* Commands;
    (yield* Wounded).each((health, entity) => {
      const damage = random.int(1, 3);
      health.hp -= damage;
      hit.emit({ damage });

      if (health.hp <= 0) {
        commands.despawn(entity);
      }
    });
  });

  const said = [
    Movement.pipe(System.access({ queries: [Moving] })),
    Wounding.pipe(
      System.access({ queries: [Wounded], writes: [Hit], random: true })
    ),
    Scoring.pipe(System.access({ reads: [Hit], writes: [Score] })),
  ];

  it("is the same game as one whose systems said nothing", () => {
    expect(hashes(said)).toStrictEqual(hashes([Movement, Wounding, Scoring]));
  });

  it("is refused a query it did not name, where it asks, and told what to do", () => {
    expect(() =>
      ticking({ queries: [Moving] }, function* () {
        yield* Wounded;
      })
    ).toThrow(
      'System "Sneaky" asked for a query that writes "ac/Health", and did not say it would write it. A system that says what it reads and writes says all of it: add this to its System.access, or leave the system without one.'
    );

    // What it requires, excludes or watches is read.
    for (const query of [
      Query.all(Position).pipe(Query.with(Health)),
      Query.all(Position).pipe(Query.without(Health)),
      Query.all(Position).pipe(Query.changed(Health)),
      Query.all(Position).pipe(Query.added(Health)),
    ]) {
      expect(() =>
        ticking({ queries: [Moving] }, function* () {
          yield* query;
        })
      ).toThrow(
        'System "Sneaky" asked for a query that reads "ac/Health", and did not say it would read it.'
      );
    }

    expect(() =>
      ticking({ queries: [Moving] }, function* () {
        yield* Query.removed(Health);
      })
    ).toThrow(
      'System "Sneaky" asked which entities lost "ac/Health", and did not say it would read it.'
    );
  });

  it("may ask for another query of what it said, and not for one that writes what it said it reads", () => {
    let visited = 0;
    ticking({ reads: [Velocity, Health], writes: [Position] }, function* () {
      // Not the query it would have named, and within what it said.
      (yield* Query.all(Position, Velocity).pipe(Query.reads(Velocity))).each(
        () => {
          visited += 1;
        }
      );
      (yield* Query.all(Velocity).pipe(Query.reads(), Query.with(Health))).each(
        () => {
          visited += 1;
        }
      );
      (yield* Query.removed(Health)).read();
    });
    expect(visited).toBe(12);
    expect(() =>
      ticking({ reads: [Velocity], writes: [Position] }, function* () {
        yield* Query.all(Position, Velocity);
      })
    ).toThrow('a query that writes "ac/Velocity"');
    // A query's own word that it only reads a term is the query's.
    expect(() =>
      ticking({ queries: [Moving] }, function* () {
        yield* Query.all(Position, Velocity);
      })
    ).toThrow('a query that writes "ac/Velocity"');
  });

  it("reads a singleton it said it reads and is refused a write to it", () => {
    let points = -1;
    ticking({ reads: [Score] }, function* () {
      ({ points } = yield* Score);
    });
    expect(points).toBe(0);
    expect(() =>
      ticking({ reads: [Score] }, function* () {
        (yield* Score).points = 5;
      })
    ).toThrow(
      'System "Sneaky" wrote the singleton "ac/Score", and did not say it would write it.'
    );
    expect(() =>
      ticking({ queries: [Moving] }, function* () {
        yield* Score;
      })
    ).toThrow(
      'System "Sneaky" asked for the singleton "ac/Score", and did not say it would read it.'
    );
    ticking({ writes: [Score] }, function* () {
      (yield* Score).points = 5;
    });
  });

  it("reads a state it said it reads, and moves one it said it writes", () => {
    ticking({ reads: [Phase] }, function* () {
      expect((yield* Phase).is("playing")).toBe(true);
    });
    expect(() =>
      ticking({ reads: [Phase] }, function* () {
        (yield* Phase).set("over");
      })
    ).toThrow('wrote the singleton "ac/Phase"');
    expect(() =>
      ticking({}, function* () {
        yield* Phase;
      })
    ).toThrow('asked for the singleton "ac/Phase"');
    ticking({ writes: [Phase] }, function* () {
      (yield* Phase).set("over");
    });
  });

  it("is held to it through the world: get, has, sources and set", () => {
    const first = 0 as Entity;
    let hp = 0;
    ticking({ reads: [Health] }, function* () {
      const world = yield* World;
      expect(world.has(first, Health)).toBe(true);
      ({ hp } = world.get(first, Health)!);
    });
    expect(hp).toBe(10);

    for (const use of [
      (world: World["Service"]) => world.get(first, Health),
      (world: World["Service"]) => world.has(first, Health),
      (world: World["Service"]) => world.sources(first, Health),
    ]) {
      expect(() =>
        ticking({ queries: [Moving] }, function* () {
          use(yield* World);
        })
      ).toThrow(
        'System "Sneaky" read "ac/Health" through the world, and did not say it would read it.'
      );
    }

    expect(() =>
      ticking({ reads: [Health] }, function* () {
        (yield* World).set(first, Health, { hp: 1 });
      })
    ).toThrow(
      'System "Sneaky" wrote "ac/Health" through the world, and did not say it would write it.'
    );
    ticking({ writes: [Health] }, function* () {
      const world = yield* World;
      world.set(first, Health, { hp: 1 });
      expect(world.get(first, Health)).toStrictEqual({ hp: 1 });
    });
    // Outside a loop the world may be changed directly, and is held the same.
    expect(() =>
      ticking({ reads: [Health] }, function* () {
        (yield* World).spawn(Health.of({ hp: 1 }));
      })
    ).toThrow('System "Sneaky" spawned an entity with "ac/Health"');
    expect(() =>
      ticking({ reads: [Health] }, function* () {
        (yield* World).remove(first, Health);
      })
    ).toThrow('System "Sneaky" removed "ac/Health"');
  });

  it("is held to it through commands, where they are queued", () => {
    const first = 0 as Entity;

    expect(
      refused({ writes: [Position] }, (commands) =>
        commands.spawn(Position.of({ x: 0, y: 0 }), Bullet)
      )
    ).toContain(
      'System "Sneaky" spawned an entity with "ac/Bullet", and did not say it would write it.'
    );
    expect(
      refused({ reads: [Burning] }, (commands) =>
        commands.add(first, Burning.of({ seconds: 1 }))
      )
    ).toContain(
      'System "Sneaky" added "ac/Burning", and did not say it would write it.'
    );
    expect(
      refused({ reads: [Bullet] }, (commands) => commands.remove(first, Bullet))
    ).toContain(
      'System "Sneaky" removed "ac/Bullet", and did not say it would write it.'
    );
    // A despawn takes everything an entity has: it is said by a component
    // the system knows the entity by.
    expect(
      refused({ writes: [Burning] }, (commands) => commands.despawn(first))
    ).toContain(
      'System "Sneaky" despawned an entity that has none of the components it said it writes ("ac/Burning").'
    );
    expect(
      refused({ reads: [Bullet] }, (commands) => commands.despawn(first))
    ).toContain("it said it writes (none)");

    for (const allowed of [
      (commands: Commands["Service"]) => commands.despawn(first),
      (commands: Commands["Service"]) =>
        commands.spawn(Position.of({ x: 0, y: 0 }), Bullet),
      (commands: Commands["Service"]) => commands.remove(first, Bullet),
      (commands: Commands["Service"]) => commands.add(first, Bullet),
      // One that is gone already, or not there yet: nothing is taken.
      (commands: Commands["Service"]) => commands.despawn(99 as Entity),
      (commands: Commands["Service"]) =>
        commands.despawn(commands.spawn(Bullet)),
    ]) {
      expect(refused({ writes: [Position, Bullet] }, allowed)).toBe(
        "it was not refused"
      );
    }
  });

  it("reads an event it said it reads, emits one it said it writes, and neither otherwise", () => {
    expect(() =>
      ticking({ queries: [Moving] }, function* () {
        yield* Hit;
      })
    ).toThrow(
      'System "Sneaky" asked for the event "ac/Hit", which is not among what it said it reads and writes.'
    );
    expect(() =>
      ticking({ reads: [Hit] }, function* () {
        const hit = yield* Hit;
        hit.read();
        hit.emit({ damage: 1 });
      })
    ).toThrow(
      'System "Sneaky" emitted the event "ac/Hit", which it said it reads and did not say it writes.'
    );
    let heard = -1;
    ticking({ writes: [Hit], reads: [Fired] }, function* () {
      const hit = yield* Hit;
      hit.emit({ damage: 1 });
      // What it may emit it may read.
      heard = hit.read().length + (yield* Fired).read().length;
    });
    expect(heard).toBe(1);
  });

  it("is found to have drawn from Random when it has run, unless it said it would", () => {
    expect(() =>
      ticking({ queries: [Moving] }, function* () {
        (yield* Random).next();
      })
    ).toThrow(
      'System "Sneaky" drew from Random, and did not say it would: random: true.'
    );
    ticking({ random: true }, function* () {
      (yield* Random).next();
    });
    ticking({}, function* () {
      yield* Random;
    });
  });

  it("issues an action or starts a script only if it said it would", () => {
    expect(() =>
      ticking({}, function* () {
        (yield* Action.Actions).enqueue(Boost, {});
      })
    ).toThrow(
      'System "Sneaky" issued the action "ac/Boost", and did not say it issues actions: actions: true.'
    );
    expect(() =>
      ticking({}, function* () {
        yield* (yield* Script).spawn(Effect.void);
      })
    ).toThrow(
      'System "Sneaky" started a script, and did not say it would: scripts: true.'
    );
    let ran = false;
    ticking({ actions: true, scripts: true }, function* () {
      (yield* Action.Actions).enqueue(Boost, {});
      // A script is not the system: it is held to nothing.
      yield* (yield* Script).spawn(
        Effect.gen(function* () {
          (yield* Score).points += 1;
          ran = true;
        })
      );
    });
    expect(ran).toBe(true);
  });

  it("need not say what its condition reads, when the condition is a state's", () => {
    let runs = 0;
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const Gated = System.make("Gated", function* () {
            yield* Moving;
            runs += 1;
          }).pipe(
            System.access({ queries: [Moving] }),
            System.runIf(State.is(Phase, "playing"))
          );

          const app = yield* playing([Gated]);
          app.tick(1);
          expect(
            System.accessOf(Gated)?.components.get("ac/Phase")?.touch
          ).toBe("reads");
        })
      )
    );
    expect(runs).toBe(1);
    // A condition of the game's own is the system's to say.
    expect(() =>
      Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* playing([
              System.make("Gated", function* () {
                yield* Moving;
              }).pipe(
                System.access({ queries: [Moving] }),
                System.runIf(Effect.map(Score, (score) => score.points === 0))
              ),
            ]);

            app.tick(1);
          })
        )
      )
    ).toThrow('System "Gated" asked for the singleton "ac/Score"');
  });

  it("is held to it in the frame stage too, and in what it does in place of running", () => {
    expect(() =>
      frame(
        System.make("Draw", function* () {
          yield* Wounded;
        }).pipe(System.inStage("frame"), System.access({ queries: [Moving] }))
      )
    ).toThrow('System "Draw" asked for a query that writes "ac/Health"');
    frame(
      System.make("Draw", function* () {
        yield* Moving;
      }).pipe(System.inStage("frame"), System.access({ queries: [Moving] }))
    );
    expect(() =>
      frame(
        System.make("Idle", function* () {
          yield* Moving;
        }).pipe(
          System.access({ queries: [Moving] }),
          System.runIf(State.is(Phase, "over")),
          System.otherwise(
            Effect.map(Score, (score) => {
              score.points += 1;
            })
          )
        )
      )
    ).toThrow('System "Idle" asked for the singleton "ac/Score"');
  });

  it("holds the systems after it to what they said, and no system to what another said", () => {
    const log: string[] = [];
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const Strict = System.make("Strict", function* () {
            yield* Moving;
            (yield* Commands).spawn(Position.of({ x: 0, y: 0 }));
          }).pipe(System.access({ queries: [Moving] }));

          // Says nothing, and so may do anything: the next system is not
          // held to what the one before it said.
          const Free = System.make("Free", function* () {
            const world = yield* World;
            world.spawn(Health.of({ hp: 1 }));
            (yield* Score).points += 1;
            (yield* Random).next();
            (yield* Hit).emit({ damage: 1 });
            log.push("free");
          });

          const Narrow = System.make("Narrow", function* () {
            yield* Score;
            log.push("narrow");
          }).pipe(System.access({ reads: [Hit] }));

          const app = yield* playing([Strict, Free, Narrow]);
          expect(() => app.tick(1)).toThrow(
            'System "Narrow" asked for the singleton "ac/Score"'
          );
          // The tick that failed leaves nobody held: a script started from
          // outside does as it likes.
          app.spawnScript(
            Effect.gen(function* () {
              (yield* Score).points += 10;
              (yield* World).spawn(Bullet);
              log.push("script");
            })
          );
          expect(app.world.guard).toBeUndefined();
        })
      )
    );
    expect(log).toStrictEqual(["free", "script"]);
  });

  it("reads the picture of the devices without saying so, as it reads the time", () => {
    const source = Input.makeManualSource();
    let jumped = false;
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          // The first to ask for the picture in this world, and held.
          const Jump = System.make("Jump", function* () {
            jumped ||= (yield* Input.Keyboard).pressed("Space");
            (yield* Input.Pointer).down();
            (yield* Input.Gamepad()).axis(0);
          }).pipe(System.access({}));

          const app = yield* App.make({
            plugins: [Input.plugin],
            systems: [Jump],
          }).pipe(Effect.provideService(Input.Source, source));

          app.tick(1);
          expect(jumped).toBe(false);
          source.press("Space");
          app.tick(1);
          expect(app.world.guard).toBeUndefined();
        })
      )
    );
    expect(jumped).toBe(true);
    // And is held all the same to what it said, from there on.
    expect(() =>
      Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const app = yield* App.make({
              plugins: [Input.plugin],
              components: [Score],
              systems: [
                System.make("Peek", function* () {
                  yield* Input.Keyboard;
                  yield* Score;
                }).pipe(System.access({})),
              ],
            });

            app.tick(1);
          })
        )
      )
    ).toThrow('System "Peek" asked for the singleton "ac/Score"');
  });

  it("holds nobody once a system whose condition did not hold has been passed over", () => {
    let ran = false;
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const Asleep = System.make("Asleep", function* () {
            yield* Moving;
          }).pipe(
            System.access({ queries: [Moving] }),
            System.runIf(State.is(Phase, "over"))
          );

          const Free = System.make("Free", function* () {
            (yield* Score).points += 1;
            (yield* Hit).emit({ damage: 1 });
            ran = true;
          });

          const app = yield* playing([Asleep, Free]);
          app.tick(1);
        })
      )
    );
    expect(ran).toBe(true);
  });

  it("is held to it as a hook, and its handlers are not systems", () => {
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const Enter = System.make("Enter", function* () {
            (yield* Score).points = 7;
          }).pipe(
            State.onEnter(Phase, "playing"),
            System.access({ writes: [Score] })
          );

          const Leave = System.make("Leave", function* () {
            (yield* Score).points = 9;
          }).pipe(State.onExit(Phase, "playing"), System.access({}));

          const app = yield* playing([Enter, Leave]);
          app.tick(1);
          expect(app.world.singleton(Score).points).toBe(7);
          // A handler is no system, and writes what it likes.
          app.dispatch(Boost, {});
          expect(app.world.singleton(Score).points).toBe(107);
          app.spawnScript(Effect.map(Phase, (phase) => phase.set("over")));
          expect(() => app.tick(1)).toThrow(
            'System "Leave" asked for the singleton "ac/Score"'
          );
        })
      )
    );
  });

  it("says more when it is given an access twice", () => {
    const system = System.make("Twice", function* () {}).pipe(
      System.access({ queries: [Moving], random: true }),
      System.access({ writes: [Score], reads: [Hit], actions: true })
    );

    const declared = System.accessOf(system)!;
    expect(
      Array.from(declared.components, ([name, { touch }]) => [name, touch])
    ).toStrictEqual([
      ["ac/Position", "writes"],
      ["ac/Velocity", "reads"],
      ["ac/Score", "writes"],
    ]);
    expect([...declared.events]).toStrictEqual([["ac/Hit", "reads"]]);
    expect([declared.random, declared.actions, declared.scripts]).toStrictEqual(
      [true, true, false]
    );
    expect(
      System.accessOf(System.make("Silent", function* () {}))
    ).toBeUndefined();
  });

  it("takes the strongest of the ways it touches a thing", () => {
    expect(
      touches({
        queries: [
          Query.all(Position).pipe(Query.changed(Health), Query.with(Bullet)),
          Query.removed(Burning),
        ],
        reads: [Health, Position],
      })
    ).toStrictEqual([
      ["ac/Position", "writes"],
      ["ac/Bullet", "reads"],
      ["ac/Health", "watches"],
      ["ac/Burning", "watches"],
    ]);
    expect(
      touches({
        queries: [Query.all(Health).pipe(Query.reads(), Query.added(Health))],
        writes: [Phase],
      })
    ).toStrictEqual([
      ["ac/Health", "watches"],
      ["ac/Phase", "writes"],
    ]);
  });
});

// The storage core on its own: what an app sets before such a system.
const guarded = (
  reads: readonly ComponentDef[],
  writes: readonly ComponentDef[]
) => {
  const world = new EcsWorld();

  const first = world.spawn(
    Position.of({ x: 1, y: 2 }),
    Health.of({ hp: 3 }),
    Bullet
  );

  const guard: Guard = {
    who: "The test",
    advice: " Say so.",
    reads: [],
    writes: [],
    writeDefs: writes,
    queries: new Set(),
  };

  for (const def of [...reads, ...writes]) {
    (guard.reads as true[])[def.id] = true;
  }

  for (const def of writes) {
    (guard.writes as true[])[def.id] = true;
  }

  world.guard = guard;

  return { world, guard, first };
};

const spec = (
  terms: readonly ComponentDef[],
  more: Partial<QuerySpec> = {}
): QuerySpec => ({ terms, withDefs: [], withoutDefs: [], ...more });

describe("a world with a guard", () => {
  it("refuses what was not said where it is done, and says who, what and what to do", () => {
    const { first, world } = guarded([Health], [Position]);
    expect(world.get(first, Health)).toStrictEqual({ hp: 3 });
    expect(world.set(first, Position, { x: 9 })).toBe(true);
    // What may be written may be read.
    expect(world.get(first, Position)).toStrictEqual({ x: 9, y: 2 });
    expect(() => world.set(first, Health, { hp: 0 })).toThrow(
      'The test wrote "ac/Health" through the world, and did not say it would write it. Say so.'
    );
    expect(() => world.has(first, Bullet)).toThrow(
      'The test read "ac/Bullet" through the world, and did not say it would read it. Say so.'
    );
    expect(() => world.add(first, Velocity.of({ x: 0, y: 0 }))).toThrow(
      'The test added "ac/Velocity", and did not say it would write it. Say so.'
    );
    expect(() => world.remove(first, Health)).toThrow(
      'The test removed "ac/Health", and did not say it would write it. Say so.'
    );
    expect(() => world.spawn(Position.of({ x: 0, y: 0 }), Health)).toThrow(
      'The test spawned an entity with "ac/Health", and did not say it would write it. Say so.'
    );
    // Nothing of it was done.
    world.guard = undefined;
    expect(world.entityCount).toBe(1);
    expect(world.get(first, Health)).toStrictEqual({ hp: 3 });
    expect(world.has(first, Velocity)).toBe(false);
  });

  it("holds a despawn to an entity that has something that may be written", () => {
    const { first, world } = guarded([Position], [Burning]);
    const other = world.guard!;
    world.guard = undefined;

    const burning = world.spawn(
      Health.of({ hp: 1 }),
      Burning.of({ seconds: 1 })
    );

    world.guard = other;
    expect(() => world.despawn(first)).toThrow(
      'The test despawned an entity that has none of the components it said it writes ("ac/Burning"). A despawn takes everything an entity has, and is said by a component the entity is known by: one of those it has. Say so.'
    );
    expect(world.isAlive(first)).toBe(true);
    // It is known by what it burns with, and its health goes with it.
    expect(world.despawn(burning)).toBe(true);
    expect(world.despawn(burning)).toBe(false);
  });

  it("lets a query through when all it touches was said, and does not look at it again", () => {
    const { guard, world } = guarded([Health], [Position]);

    const within = spec([Position, Health], {
      readDefs: [Health],
      withoutDefs: [Health],
    });

    expect(guard.queries.has(within)).toBe(false);
    expect(world.view(within).count()).toBe(0);
    expect(guard.queries.has(within)).toBe(true);
    // One that was named is not looked at at all: whoever named it said it.
    const named = spec([Velocity]);
    guard.queries.add(named);
    expect(world.view(named).count()).toBe(0);

    for (const [refusedQuery, what] of [
      [spec([Position, Health]), 'a query that writes "ac/Health"'],
      [
        spec([Bullet], { readDefs: [Bullet] }),
        'a query that reads "ac/Bullet"',
      ],
      [
        spec([Position], { withDefs: [Bullet] }),
        'a query that reads "ac/Bullet"',
      ],
      [
        spec([Position], { addedDefs: [Velocity] }),
        'a query that reads "ac/Velocity"',
      ],
    ] as const) {
      expect(() => world.view(refusedQuery)).toThrow(
        `The test asked for ${what}, and did not say it would`
      );
      expect(guard.queries.has(refusedQuery)).toBe(false);
    }

    expect(() => world.removed(Bullet)).toThrow(
      'The test asked which entities lost "ac/Bullet"'
    );
    world.removed(Health).read();
  });

  it("holds a singleton to it, to read and to write", () => {
    const { world } = guarded([Score.component], [Phase.component]);
    const score = world.singleton(Score);
    expect(score.points).toBe(0);
    expect(() => {
      score.points = 1;
    }).toThrow('The test wrote the singleton "ac/Score"');
    world.singleton(Phase).value = "over";
    world.guard = { ...world.guard!, reads: [] };
    expect(() => world.singleton(Score)).toThrow(
      'The test asked for the singleton "ac/Score"'
    );
  });
});

const system = (
  name: string,
  access?: System.Access
): System.System<never, never> => {
  const made = System.make(name, function* () {});

  return access === undefined ? made : made.pipe(System.access(access));
};

describe("the order of systems", () => {
  const Move = system("Move", { queries: [Moving] });

  const Aim = system("Aim", {
    queries: [Query.all(Position).pipe(Query.reads())],
    writes: [Score],
  });

  it("is in conflict where one writes what another touches and nothing says which runs first", () => {
    expect(System.conflicts([Move, Aim])).toStrictEqual({
      conflicts: [
        {
          first: "Move",
          second: "Aim",
          over: [
            {
              what: "ac/Position",
              kind: "component",
              first: "writes",
              second: "reads",
            },
          ],
        },
      ],
      undeclared: [],
    });
    // Listed the other way round, they run the other way round.
    expect(System.conflicts([Aim, Move]).conflicts).toStrictEqual([
      {
        first: "Aim",
        second: "Move",
        over: [
          {
            what: "ac/Position",
            kind: "component",
            first: "reads",
            second: "writes",
          },
        ],
      },
    ]);
  });

  it("is settled by saying the order, directly or through others", () => {
    expect(
      System.conflicts([Move, Aim.pipe(System.after(Move))]).conflicts
    ).toStrictEqual([]);
    expect(
      System.conflicts([Move.pipe(System.before(Aim)), Aim]).conflicts
    ).toStrictEqual([]);
    expect(
      System.conflicts([Aim, Move.pipe(System.before("Aim"))]).conflicts
    ).toStrictEqual([]);
    // Through a system that touches nothing of theirs.
    const Between = system("Between", { writes: [Phase] });
    expect(
      System.conflicts([
        Move,
        Between.pipe(System.after(Move)),
        Aim.pipe(System.after(Between)),
      ]).conflicts
    ).toStrictEqual([]);
    // An order said of two others settles nothing between these two.
    expect(
      System.conflicts([Move, Between.pipe(System.after(Move)), Aim]).conflicts
    ).toStrictEqual([
      expect.objectContaining({ first: "Move", second: "Aim" }),
    ]);
  });

  it("is none between two that only read, and says who watches for changes", () => {
    const Read = system("Read", {
      queries: [Query.all(Position).pipe(Query.reads())],
    });

    const Watch = system("Watch", {
      queries: [
        Query.all(Health).pipe(Query.changed(Position), Query.reads()),
        Query.removed(Bullet),
      ],
    });

    expect(System.conflicts([Read, Watch, Aim]).conflicts).toStrictEqual([]);
    // Listed ahead of what it watches, it hears of it a tick late.
    const Clean = system("Clean", { writes: [Bullet, Position] });
    expect(System.conflicts([Watch, Clean]).conflicts).toStrictEqual([
      {
        first: "Watch",
        second: "Clean",
        over: [
          {
            what: "ac/Bullet",
            kind: "component",
            first: "watches",
            second: "writes",
          },
          {
            what: "ac/Position",
            kind: "component",
            first: "watches",
            second: "writes",
          },
        ],
      },
    ]);
  });

  it("is one over a singleton, a state, an event and what comes of the order two systems draw, issue and start in", () => {
    const One = system("One", {
      writes: [Score, Hit],
      reads: [Phase, Fired],
      random: true,
      actions: true,
      scripts: true,
    });

    const Two = system("Two", {
      reads: [Score, Hit, Fired],
      writes: [Phase],
      random: true,
      actions: true,
      scripts: true,
    });

    expect(System.conflicts([One, Two]).conflicts).toStrictEqual([
      {
        first: "One",
        second: "Two",
        over: [
          {
            what: "ac/Phase",
            kind: "component",
            first: "reads",
            second: "writes",
          },
          {
            what: "ac/Score",
            kind: "component",
            first: "writes",
            second: "reads",
          },
          { what: "ac/Hit", kind: "event", first: "writes", second: "reads" },
          {
            what: "Actions",
            kind: "service",
            first: "writes",
            second: "writes",
          },
          {
            what: "Random",
            kind: "service",
            first: "writes",
            second: "writes",
          },
          {
            what: "Script",
            kind: "service",
            first: "writes",
            second: "writes",
          },
        ],
      },
    ]);
    // One alone draws: the other is not waiting on its numbers.
    expect(
      System.conflicts([
        system("Draws", { random: true, actions: true }),
        system("Starts", { scripts: true }),
      ]).conflicts
    ).toStrictEqual([]);
  });

  it("is none across stages, which run one after the other, nor between a hook and the tick", () => {
    expect(
      System.conflicts([Move.pipe(System.inStage("postUpdate")), Aim]).conflicts
    ).toStrictEqual([]);
    expect(
      System.conflicts([
        Move.pipe(System.inStage("preUpdate")),
        Aim.pipe(System.inStage("preUpdate")),
      ]).conflicts
    ).toStrictEqual([
      expect.objectContaining({ first: "Move", second: "Aim" }),
    ]);
    const Enter = Move.pipe(State.onEnter(Phase, "playing"));
    expect(System.conflicts([Enter, Aim]).conflicts).toStrictEqual([]);
    // Hooks of one moment are a list of their own.
    const AlsoEnter = Aim.pipe(State.onEnter(Phase, "playing"));
    const Leave = Aim.pipe(State.onExit(Phase, "playing"));
    expect(System.conflicts([Enter, AlsoEnter]).conflicts).toStrictEqual([
      expect.objectContaining({ first: "Move", second: "Aim" }),
    ]);
    expect(System.conflicts([Enter, Leave]).conflicts).toStrictEqual([]);
    expect(
      System.conflicts([Enter, AlsoEnter.pipe(System.after(Enter))]).conflicts
    ).toStrictEqual([]);
  });

  it("leaves out the stages that change nothing, and names the systems that said nothing", () => {
    const Draw = system("Draw").pipe(System.inStage("frame"));
    const Listen = system("Listen").pipe(System.inStage("input"));

    const Paint = system("Paint", {
      queries: [Query.all(Position)],
    }).pipe(System.inStage("postFrame"));

    const Hook = system("Hook").pipe(State.onEnter(Phase, "over"));
    expect(
      System.conflicts([Move, system("Quiet"), Draw, Listen, Paint, Hook, Aim])
    ).toStrictEqual({
      conflicts: [expect.objectContaining({ first: "Move", second: "Aim" })],
      undeclared: ["Hook", "Quiet"],
    });
  });

  it("is told of every pair, in the order the systems run in", () => {
    const Third = system("Third", { writes: [Position, Score] });
    expect(
      System.conflicts([Third, Move, Aim]).conflicts.map(
        ({ first, over, second }) =>
          `${first} then ${second}: ${over.map((each) => each.what).join(", ")}`
      )
    ).toStrictEqual([
      "Third then Move: ac/Position",
      "Third then Aim: ac/Position, ac/Score",
      "Move then Aim: ac/Position",
    ]);
    // `before` pulls a system forward, and the pairs are of the order that
    // results.
    expect(
      System.conflicts([
        Third,
        Move,
        Aim.pipe(System.before(Third)),
      ]).conflicts.map(({ first, second }) => `${first} then ${second}`)
    ).toStrictEqual(["Aim then Move", "Third then Move"]);
  });

  it("is an app's own: its plugins' systems and its own, as they are ordered", () => {
    Effect.runSync(
      Effect.scoped(
        Effect.gen(function* () {
          const Physics = Plugin.make("ac/Physics", { systems: [Move] });

          const app = yield* App.make({
            plugins: [Physics],
            systems: [Aim, system("Quiet")],
            components: [Position, Velocity, Score],
          });

          expect(app.systemOrder).toStrictEqual(["Move", "Aim", "Quiet"]);
          expect(app.undeclared).toStrictEqual(["Quiet"]);
          expect(app.conflicts).toStrictEqual([
            {
              first: "Move",
              second: "Aim",
              over: [
                {
                  what: "ac/Position",
                  kind: "component",
                  first: "writes",
                  second: "reads",
                },
              ],
            },
          ]);

          const settled = yield* App.make({
            plugins: [Physics],
            systems: [Aim.pipe(System.after(Move))],
            components: [Position, Velocity, Score],
          });

          expect(settled.conflicts).toStrictEqual([]);
          expect(settled.undeclared).toStrictEqual([]);
        })
      )
    );
  });
});
