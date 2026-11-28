/**
 * The storage core's benchmark: every variant here goes through
 * `arcadekit/ecs` and nothing else, so it imports no Effect.
 *
 * Every variant of the first group does the same work: pos += vel * dt over
 * the same 100,000 entities. Each reports the median time of a pass, after
 * warm-up.
 *
 * `bench/accessors.ts` reports these with the rest of the package's, and
 * `bench/compare.ts` runs them for two builds of the storage core, turn and
 * turn about, to say whether a change made any of them slower: that is the
 * check CI runs on a pull request. A variant is run on its own as
 *
 *   node --import tsx bench/core.ts <name>
 *
 * which prints the median milliseconds of a pass. Each run is a process of
 * its own: V8 optimises a call site for the functions it has seen there, so
 * running variants one after another in one process makes later ones look
 * slower than they are.
 */
import { pathToFileURL } from "node:url";

import {
  CommandBuffer,
  Component,
  Field,
  World,
  entityIndex,
} from "../src/ecs/index.ts";
import type { Entity, Terms } from "../src/ecs/index.ts";
import { Query } from "../src/Query.ts";

// Not exported: a loop that reads an exported constant reads it through the
// module each time, which measured a tenth slower over these loops.
const N = 100_000;
const DT = 1 / 60;
/** How many entities the variants loop over, and the step they move them by. */
export const sizes = { entities: N, step: DT } as const;

export const Position = Component.define("bench/Position", {
  x: Field.f32,
  y: Field.f32,
});
export const Velocity = Component.define("bench/Velocity", {
  x: Field.f32,
  y: Field.f32,
});
const tags = [0, 1, 2, 3, 4].map((i) => Component.tag(`bench/Tag${i}`));
const Frozen = Component.tag("bench/Frozen", { storage: "sparse" });
const Heat = Component.define(
  "bench/Heat",
  { degrees: Field.f32 },
  { storage: "sparse" }
);
const Aims = Component.relation("bench/Aims", { onTargetDespawn: "remove" });
const Child = Component.relation("bench/Child", { onTargetDespawn: "despawn" });

const query = <const D extends Terms>(
  terms: D,
  more: {
    readonly withDefs?: Terms;
    readonly withoutDefs?: Terms;
    readonly changedDefs?: Terms;
    readonly addedDefs?: Terms;
    readonly readDefs?: Terms;
  } = {}
): Query<D> =>
  new Query(
    terms,
    more.withDefs ?? [],
    more.withoutDefs ?? [],
    more.changedDefs,
    more.addedDefs,
    terms.filter((def) => more.readDefs?.includes(def) !== true)
  );

/** Visits only the entities whose position was written since its last visit. */
const Repositioned = query([Velocity], { changedDefs: [Position] });

/** Gives the sparse tag to one entity in every `n`. */
const tagEvery = (world: World, n: number): void => {
  const all = world.view(query([Position])).entities();
  for (let i = 0; i < all.length; i += n) {
    world.add(all[i]!, Frozen);
  }
};

export const populate = (world: World, fragmented = false): void => {
  for (let i = 0; i < N; i++) {
    const extra = fragmented ? tags.filter((_, bit) => (i >> bit) & 1) : [];
    world.spawn(
      Position.of({ x: i, y: i }),
      Velocity.of({ x: 1, y: 2 }),
      ...extra
    );
  }
};

// Seven tags make 128 tables, of which `spread` fills 100.
const spreadTags = [0, 1, 2, 3, 4, 5, 6].map((i) =>
  Component.tag(`bench/Spread${i}`)
);

/** The same entities as `populate`, over 100 tables; the last has every tag. */
const spread = (world: World): void => {
  for (let i = 0; i < N; i++) {
    const table = 28 + (i % 100);
    world.spawn(
      Position.of({ x: i, y: i }),
      Velocity.of({ x: 1, y: 2 }),
      ...spreadTags.filter((_, bit) => (table >> bit) & 1)
    );
  }
};

/**
 * `populate`, where the first 100 entities are parents and 1,000 others,
 * spread over the rest, are their children, 10 each: returns the parents.
 */
const family = (world: World): Entity[] => {
  populate(world);
  const all = world.view(query([Position])).entities();
  const parents = all.slice(0, 100);
  for (let c = 0; c < 1000; c++) {
    world.add(all[100 + c * 97]!, Child.of({ target: parents[c % 100]! }));
  }
  return parents;
};

const Moving = query([Position, Velocity]);
/** The one entity of its table: what a game has one of, such as its player. */
const Player = Component.tag("bench/Player");
const Players = query([Position], { withDefs: [Player] });
/** The entities of `spread`'s last table, and no others: 1 table in 100. */
const OneTable = query([Position, Velocity], { withDefs: spreadTags });

/** A component of eight fields, as a body of a physics game has. */
const Body = Component.define("bench/Body", {
  x: Field.f32,
  y: Field.f32,
  vx: Field.f32,
  vy: Field.f32,
  angle: Field.f32,
  spin: Field.f32,
  mass: Field.f32,
  drag: Field.f32,
});
/** Ten entities among the 100,000, which a loop between changes visits. */
const Few = Component.tag("bench/Few");
const Fews = query([Position, Velocity], { withDefs: [Few] });

/**
 * Median milliseconds of a round, of `perSample` a sample: a change of the
 * world's entities, then `visit`'s loops. The change gives a sparse tag to
 * one of the 100,000, or takes it back. Like every change of the entities,
 * it retracts each accessor a loop handed out, and the loop binds its own
 * again on its next visit. Also the rounds it ran.
 */
const changing = (
  world: World,
  visit: () => void,
  perSample = 1000
): { readonly ms: number; readonly rounds: number } => {
  const bystander = world.view(Moving).entities()[N >> 1]!;
  const runs = 2000;
  const warmup = 500;
  let rounds = 0;
  const ms = measure(
    () => {
      for (let i = 0; i < perSample; i++) {
        if ((rounds & 1) === 0) {
          world.add(bystander, Frozen);
        } else {
          world.remove(bystander, Frozen);
        }
        rounds++;
        visit();
      }
    },
    runs,
    warmup
  );
  // An even number of changes leaves the entity as it was.
  if (rounds !== (runs + warmup) * perSample || world.has(bystander, Frozen)) {
    throw new Error(
      `After ${rounds} changes, the entity has the tag: ${world.has(bystander, Frozen)}.`
    );
  }
  return { ms: ms / perSample, rounds };
};

/** Throws unless each of `values` is `expected`. */
const expectEach = (
  what: string,
  values: readonly number[],
  expected: number
): void => {
  const wrong = values.filter((value) => value !== expected);
  if (wrong.length > 0 || values.length === 0) {
    throw new Error(
      `${what}: ${wrong.length} of ${values.length} are not ${expected}.`
    );
  }
};

/** pos += vel * dt over what a query matches, written as a system would. */
const step = (world: World, spec: typeof Moving): void => {
  world.view(spec).eachChunk((start, end, pos, vel) => {
    for (let i = start; i < end; i++) {
      pos.x[i]! += vel.x[i]! * DT;
      pos.y[i]! += vel.y[i]! * DT;
    }
  });
};

/**
 * Median milliseconds per call. `before`, when given, runs ahead of every
 * call and is not timed: it puts back what the call uses up.
 */
export const measure = (
  run: () => void,
  runs = 300,
  warmup = 80,
  before?: () => void
): number => {
  for (let i = 0; i < warmup; i++) {
    before?.();
    run();
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    before?.();
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1]!;
};

export interface Variant {
  readonly label: string;
  /** How to report the time: divided by all entities, or for the whole pass. */
  readonly unit?: "entity" | "matches" | "dispatch" | "visit";
  /** Median milliseconds of a pass. */
  readonly run: () => number;
}

/** A variant's time as a number in the unit it is reported in, and that unit. */
export const inUnit = (
  variant: Variant,
  ms: number
): { readonly value: number; readonly unit: string } =>
  variant.unit === "matches"
    ? { value: ms * 1000, unit: "µs per pass" }
    : variant.unit === "dispatch"
      ? { value: ms * 1000, unit: "µs per dispatch" }
      : variant.unit === "visit"
        ? { value: ms * 1e6, unit: "ns per visit" }
        : { value: (ms * 1e6) / N, unit: "ns/entity" };

export const variants: Record<string, Variant> = {
  raw: {
    label: "eachChunk: raw typed-array columns",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      return measure(() => {
        view.eachChunk((start, end, pos, vel) => {
          const px = pos.x;
          const py = pos.y;
          const vx = vel.x;
          const vy = vel.y;
          for (let i = start; i < end; i++) {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          }
        });
      });
    },
  },

  each: {
    label: "each: accessors, only one system in the program",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  eachMany: {
    // A real game calls each() from dozens of systems, so V8 can no longer
    // inline the callback. This is the number to plan around.
    label: "each: accessors, after 6 other systems used each()",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const positions = world.view(query([Position]));
      const velocities = world.view(query([Velocity]));
      let sink = 0;
      for (let pass = 0; pass < 80; pass++) {
        positions.each((pos) => {
          sink += pos.x;
        });
        positions.each((pos) => {
          sink += pos.y;
        });
        velocities.each((vel) => {
          sink += vel.x;
        });
        velocities.each((vel, entity) => {
          sink += entityIndex(entity);
        });
        view.each((pos, vel) => {
          sink += pos.x - vel.y;
        });
        view.each((_, vel, entity) => {
          sink += vel.x + entityIndex(entity);
        });
      }
      void sink;
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  eachComponents: {
    // A real game has more than two components, of more than one kind of
    // field. What `each` hands out must not cost more for that: generated
    // classes did, since one place in the loop assigned the row of every
    // class there was.
    label: "each: accessors, in a program of ten components",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const Health = Component.define("bench/Health", {
        hp: Field.i32,
        max: Field.i32,
      });
      const Spin = Component.define("bench/Spin", {
        angle: Field.f64,
        speed: Field.f64,
      });
      const Colour = Component.define("bench/Colour", {
        r: Field.u8,
        g: Field.u8,
        b: Field.u8,
      });
      const Team = Component.define("bench/Team", {
        side: Field.u16,
        rank: Field.u16,
      });
      const Owner = Component.define("bench/Owner", {
        by: Field.entity,
        since: Field.u32,
      });
      const Label = Component.define("bench/Label", {
        text: Field.json<string>(""),
      });
      const Mass = Component.define("bench/Mass", {
        kg: Field.f32,
        drag: Field.f32,
      });
      const Age = Component.define("bench/Age", { seconds: Field.f32 });
      const anchor = world.spawn();
      for (let i = 0; i < 2000; i++) {
        world.spawn(
          Health.of({ hp: i, max: i }),
          Spin.of({ angle: 0, speed: 1 }),
          Colour.of({ r: 1, g: 2, b: 3 }),
          Team.of({ side: i & 1, rank: i & 7 }),
          Owner.of({ by: anchor, since: i }),
          Label.of({ text: "thing" }),
          Mass.of({ kg: 1, drag: 0.5 }),
          Age.of({ seconds: 0 })
        );
      }
      const wounds = world.view(query([Health, Team]));
      const turning = world.view(query([Spin, Age]));
      const painted = world.view(query([Colour, Label]));
      const owned = world.view(query([Owner, Mass]));
      const falling = world.view(query([Mass, Age, Spin]));
      let sink = 0;
      for (let pass = 0; pass < 400; pass++) {
        wounds.each((health, team) => {
          health.hp = Math.min(health.max, health.hp + team.rank);
        });
        turning.each((spin, age) => {
          spin.angle += spin.speed * DT;
          age.seconds += DT;
        });
        painted.each((colour, label) => {
          colour.r = (colour.g + colour.b + label.text.length) & 255;
        });
        owned.each((owner, mass, entity) => {
          owner.since += 1;
          sink += entityIndex(owner.by) + mass.kg + entityIndex(entity);
        });
        falling.each((mass, age, spin) => {
          spin.speed -= mass.drag * age.seconds * DT;
        });
      }
      void sink;
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  fragmented: {
    label: "each: same entities spread over 32 tables",
    run: () => {
      const world = new World();
      populate(world, true);
      const view = world.view(Moving);
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  fragmentedRaw: {
    label: "eachChunk: same entities spread over 32 tables",
    run: () => {
      const world = new World();
      populate(world, true);
      const view = world.view(Moving);
      return measure(() => {
        view.eachChunk((start, end, pos, vel) => {
          const px = pos.x;
          const py = pos.y;
          const vx = vel.x;
          const vy = vel.y;
          for (let i = start; i < end; i++) {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          }
        });
      });
    },
  },

  withoutEach: {
    label: "each: without a sparse tag that 1% of entities have",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 100);
      const view = world.view(
        query([Position, Velocity], { withoutDefs: [Frozen] })
      );
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  withoutChunk: {
    label: "eachChunk: without a sparse tag that 1% have",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 100);
      const view = world.view(
        query([Position, Velocity], { withoutDefs: [Frozen] })
      );
      return measure(() => {
        view.eachChunk((start, end, pos, vel) => {
          const px = pos.x;
          const py = pos.y;
          const vx = vel.x;
          const vy = vel.y;
          for (let i = start; i < end; i++) {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          }
        });
      });
    },
  },

  withMask: {
    unit: "matches",
    label: "each: with a sparse tag 1 in 100 have, mask",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 100);
      const view = world.view(
        query([Position, Velocity], { withDefs: [Frozen] })
      );
      view._path = "mask";
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  withSorted: {
    unit: "matches",
    label: "each: with a sparse tag 1 in 100 have, sorted",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 100);
      const view = world.view(
        query([Position, Velocity], { withDefs: [Frozen] })
      );
      view._path = "sorted";
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },

  halfFrozenChunk: {
    label: "eachChunk: without a sparse tag every other entity has",
    run: () => {
      const world = new World();
      populate(world);
      tagEvery(world, 2);
      const view = world.view(
        query([Position, Velocity], { withoutDefs: [Frozen] })
      );
      return measure(() => {
        view.eachChunk((start, end, pos, vel) => {
          const px = pos.x;
          const py = pos.y;
          const vx = vel.x;
          const vy = vel.y;
          for (let i = start; i < end; i++) {
            px[i]! += vx[i]! * DT;
            py[i]! += vy[i]! * DT;
          }
        });
      });
    },
  },
  hash: {
    // The same world as the first line: four float fields and an id per
    // entity, so five 32-bit words each.
    label: "world.hash(): 100,000 entities in one table, all written",
    run: () => {
      const world = new World();
      populate(world);
      let sink = 0;
      const ms = measure(
        () => {
          sink ^= world.hash();
        },
        300,
        80,
        () => step(world, Moving)
      );
      void sink;
      return ms;
    },
  },

  hashFragmented: {
    label: "world.hash(): same entities spread over 32 tables, all written",
    run: () => {
      const world = new World();
      populate(world, true);
      let sink = 0;
      const ms = measure(
        () => {
          sink ^= world.hash();
        },
        300,
        80,
        () => step(world, Moving)
      );
      void sink;
      return ms;
    },
  },

  hashSparse: {
    // Every entity also has a sparse component with one float field, whose
    // members are hashed one by one so that their order does not matter.
    label: "world.hash(): the same, plus a sparse field on each, all written",
    run: () => {
      const world = new World();
      populate(world);
      for (const entity of world.view(query([Position])).entities()) {
        world.add(entity, Heat.of({ degrees: 1 }));
      }
      const heat = world.view(query([Heat]));
      let sink = 0;
      const ms = measure(
        () => {
          sink ^= world.hash();
        },
        300,
        80,
        () => {
          step(world, Moving);
          heat.each((h) => {
            h.degrees += 1;
          });
        }
      );
      void sink;
      return ms;
    },
  },
  captureAll: {
    label: "capture: every table written since the last",
    run: () => {
      const world = new World();
      populate(world);
      return measure(
        () => {
          world._capture();
        },
        300,
        80,
        () => step(world, Moving)
      );
    },
  },

  captureFew: {
    label: "capture: 1 of 100 tables written since the last",
    run: () => {
      const world = new World();
      spread(world);
      return measure(
        () => {
          world._capture();
        },
        300,
        80,
        () => step(world, OneTable)
      );
    },
  },

  rewindAll: {
    label: "rewind: every table written since the moment",
    run: () => {
      const world = new World();
      populate(world);
      const moment = world._capture();
      return measure(
        () => {
          world._rewind(moment, []);
        },
        300,
        80,
        () => step(world, Moving)
      );
    },
  },

  rewindFew: {
    label: "rewind: 1 of 100 tables written since the moment",
    run: () => {
      const world = new World();
      spread(world);
      const moment = world._capture();
      return measure(
        () => {
          world._rewind(moment, []);
        },
        300,
        80,
        () => step(world, OneTable)
      );
    },
  },

  hashFew: {
    label: "world.hash(): 1 of 100 tables written since the last",
    run: () => {
      const world = new World();
      spread(world);
      let sink = 0;
      const ms = measure(
        () => {
          sink ^= world.hash();
        },
        300,
        80,
        () => step(world, OneTable)
      );
      void sink;
      return ms;
    },
  },

  snapshot: {
    // The same world as the first line: per entity an id, four floats and a
    // generation, 22 bytes.
    label: "world.snapshot(): 100,000 entities in one table",
    run: () => {
      const world = new World();
      populate(world);
      let sink = 0;
      const ms = measure(() => {
        sink += world.snapshot().length;
      });
      void sink;
      return ms;
    },
  },

  load: {
    label: "world.load(): the same snapshot, into a new world",
    run: () => {
      const world = new World();
      populate(world);
      const bytes = world.snapshot();
      let sink = 0;
      const ms = measure(() => {
        const fresh = new World();
        fresh.load(bytes, [Position, Velocity]);
        sink += fresh.entityCount;
      });
      void sink;
      return ms;
    },
  },

  restore: {
    label: "world.restore(): the same snapshot, into its own world",
    run: () => {
      const world = new World();
      populate(world);
      const bytes = world.snapshot();
      let sink = 0;
      const ms = measure(() => {
        world.restore(bytes);
        sink += world.entityCount;
      });
      void sink;
      return ms;
    },
  },

  // Change detection. A write is noticed per row, and only for a component
  // some query watches: here Position, watched by `Repositioned`. Before
  // each timed pass the watching query visits, untimed, so that the pass
  // has every row to note afresh, which is the most a write can cost.
  watchedEach: {
    label: "each: writing a watched component, all noted",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const watcher = world.view(Repositioned);
      return measure(
        () => {
          view.each((pos, vel) => {
            pos.x += vel.x * DT;
            pos.y += vel.y * DT;
          });
        },
        300,
        80,
        () => watcher.eachChunk(() => {})
      );
    },
  },
  watchedEachNoted: {
    label: "each: the same, every row noted already",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      world.view(Repositioned).eachChunk(() => {});
      return measure(() => {
        view.each((pos, vel) => {
          pos.x += vel.x * DT;
          pos.y += vel.y * DT;
        });
      });
    },
  },
  watchedChunk: {
    label: "eachChunk: handed a watched component, all noted",
    run: () => {
      const world = new World();
      populate(world);
      const view = world.view(Moving);
      const watcher = world.view(Repositioned);
      return measure(
        () => {
          view.eachChunk((start, end, pos, vel) => {
            const px = pos.x;
            const py = pos.y;
            const vx = vel.x;
            const vy = vel.y;
            for (let i = start; i < end; i++) {
              px[i]! += vx[i]! * DT;
              py[i]! += vy[i]! * DT;
            }
          });
        },
        300,
        80,
        () => watcher.eachChunk(() => {})
      );
    },
  },
  watchedChunkReads: {
    label: "eachChunk: handed a watched component it only reads",
    run: () => {
      const world = new World();
      populate(world);
      // Velocity is written from Position, which the query only reads.
      const view = world.view(
        query([Position, Velocity], { readDefs: [Position] })
      );
      const watcher = world.view(Repositioned);
      return measure(
        () => {
          view.eachChunk((start, end, pos, vel) => {
            const px = pos.x;
            const py = pos.y;
            const vx = vel.x;
            const vy = vel.y;
            for (let i = start; i < end; i++) {
              vx[i]! += px[i]! * DT;
              vy[i]! += py[i]! * DT;
            }
          });
        },
        300,
        80,
        () => watcher.eachChunk(() => {})
      );
    },
  },
  changedNone: {
    unit: "visit",
    label: "change query: nothing changed",
    run: () => {
      const world = new World();
      populate(world);
      const watcher = world.view(Repositioned);
      watcher.eachChunk(() => {});
      let sink = 0;
      const ms = measure(
        () => {
          // A thousand visits a sample: one is too short to time.
          for (let i = 0; i < 1000; i++) {
            watcher.each((vel) => {
              sink += vel.x;
            });
          }
        },
        2000,
        500
      );
      void sink;
      return ms / 1000;
    },
  },
  single: {
    unit: "visit",
    label: "single: the one player among 100,000, read and written",
    run: () => {
      const world = new World();
      populate(world);
      world.spawn(Position.of({ x: 0, y: 0 }), Velocity, Player);
      const players = world.view(Players);
      let sink = 0;
      const ms = measure(
        () => {
          // A thousand reads a sample: one is too short to time.
          for (let i = 0; i < 1000; i++) {
            const [position] = players.single();
            position.x += DT;
            sink += position.y;
          }
        },
        2000,
        500
      );
      void sink;
      return ms / 1000;
    },
  },
  singleByEach: {
    unit: "visit",
    label: "the same, written by hand with each",
    run: () => {
      const world = new World();
      populate(world);
      world.spawn(Position.of({ x: 0, y: 0 }), Velocity, Player);
      const players = world.view(Players);
      let sink = 0;
      const ms = measure(
        () => {
          for (let i = 0; i < 1000; i++) {
            let seen = 0;
            players.each((position) => {
              seen++;
              position.x += DT;
              sink += position.y;
            });
            if (seen !== 1) {
              throw new Error(`${seen} players`);
            }
          }
        },
        2000,
        500
      );
      void sink;
      return ms / 1000;
    },
  },

  // Loops between changes of the world's entities, as a game's systems run
  // between the commands the systems before them applied. A visit is one
  // change and the loops after it, over ten entities of the 100,000.
  eachAfterChange: {
    unit: "visit",
    label: "each: ten entities, after a change of the entities",
    run: () => {
      const world = new World();
      populate(world);
      for (let i = 0; i < 10; i++) {
        world.spawn(
          Position.of({ x: 0, y: 0 }),
          Velocity.of({ x: 1, y: 2 }),
          Few
        );
      }
      const view = world.view(Fews);
      const { ms, rounds } = changing(world, () => {
        view.each((pos, vel) => {
          pos.x += 1;
          pos.y += vel.y * DT;
        });
      });
      expectEach(
        "Visits of each",
        view.entities().map((entity) => world.get(entity, Position)!.x),
        rounds
      );
      return ms;
    },
  },
  fieldsAfterChange: {
    unit: "visit",
    label: "each: the same, of a component of eight fields",
    run: () => {
      const world = new World();
      populate(world);
      for (let i = 0; i < 10; i++) {
        world.spawn(
          Body.of({
            x: 0,
            y: 0,
            vx: 1,
            vy: 2,
            angle: 0,
            spin: 1,
            mass: 2,
            drag: 0.5,
          })
        );
      }
      const view = world.view(query([Body]));
      const { ms, rounds } = changing(world, () => {
        view.each((body) => {
          body.x += 1;
          body.y += body.vy * DT;
          body.vx -= body.vx * body.drag * DT;
          body.vy -= (body.vy * body.drag * DT) / body.mass;
          body.angle += body.spin * DT;
        });
      });
      expectEach(
        "Visits of each",
        view.entities().map((entity) => world.get(entity, Body)!.x),
        rounds
      );
      return ms;
    },
  },
  nestedAfterChange: {
    unit: "visit",
    label: "each: the same ten, each against each, nested",
    run: () => {
      const world = new World();
      populate(world);
      for (let i = 0; i < 10; i++) {
        world.spawn(
          Position.of({ x: 0, y: i }),
          Velocity.of({ x: 1, y: 2 }),
          Few
        );
      }
      const view = world.view(Fews);
      let pairs = 0;
      // A hundred pairs a round: a hundred rounds a sample are enough.
      const { ms, rounds } = changing(
        world,
        () => {
          view.each((a) => {
            view.each((b, vel) => {
              pairs++;
              a.y += (b.y - a.y) * vel.x * DT;
            });
            a.x += 1;
          });
        },
        100
      );
      if (pairs !== rounds * 100) {
        throw new Error(`${pairs} pairs in ${rounds} visits, not 100 each.`);
      }
      expectEach(
        "Visits of each",
        view.entities().map((entity) => world.get(entity, Position)!.x),
        rounds
      );
      return ms;
    },
  },
  sparseAfterChange: {
    unit: "visit",
    label: "each: the same ten, with a sparse term",
    run: () => {
      const world = new World();
      populate(world);
      for (let i = 0; i < 10; i++) {
        world.spawn(
          Position.of({ x: 0, y: 0 }),
          Velocity.of({ x: 1, y: 2 }),
          Heat.of({ degrees: 0 })
        );
      }
      const view = world.view(query([Position, Heat]));
      const { ms, rounds } = changing(world, () => {
        view.each((pos, heat) => {
          heat.degrees += 1;
          pos.y += DT;
        });
      });
      expectEach(
        "Visits of each",
        view.entities().map((entity) => world.get(entity, Heat)!.degrees),
        rounds
      );
      return ms;
    },
  },
  changedOne: {
    unit: "visit",
    label: "change query: one write in 100,000, set and visit",
    run: () => {
      const world = new World();
      populate(world);
      const watcher = world.view(Repositioned);
      watcher.eachChunk(() => {});
      const target = world.view(Moving).entities()[N >> 1]!;
      let sink = 0;
      const ms = measure(
        () => {
          for (let i = 0; i < 1000; i++) {
            world.set(target, Position, { x: i });
            watcher.each((vel) => {
              sink += vel.x;
            });
          }
        },
        2000,
        500
      );
      void sink;
      return ms / 1000;
    },
  },
  changedPercent: {
    unit: "matches",
    label: "change query: visiting the 1,000 written, of 100,000",
    run: () => {
      const world = new World();
      populate(world);
      const watcher = world.view(Repositioned);
      watcher.eachChunk(() => {});
      const all = world.view(Moving).entities();
      let sink = 0;
      const ms = measure(
        () => {
          watcher.each((vel) => {
            sink += vel.x;
          });
        },
        2000,
        500,
        () => {
          for (let i = 0; i < N; i += 100) {
            world.set(all[i]!, Position, { x: i });
          }
        }
      );
      void sink;
      return ms;
    },
  },
  changedAll: {
    label: "change query: visiting all 100,000, all written",
    run: () => {
      const world = new World();
      populate(world);
      const writer = world.view(query([Position]));
      const watcher = world.view(Repositioned);
      let sink = 0;
      const ms = measure(
        () => {
          watcher.each((vel) => {
            sink += vel.x;
          });
        },
        300,
        80,
        () =>
          writer.each((pos) => {
            pos.x += 1;
          })
      );
      void sink;
      return ms;
    },
  },

  // Entities coming and going: a thousand spawned and despawned again, in
  // the world of 100,000. Despawning looks for who points at the entity.
  churn: {
    unit: "matches",
    label: "spawn 1,000 entities and despawn them again",
    run: () => {
      const world = new World();
      populate(world);
      const made: Entity[] = [];
      return measure(
        () => {
          for (let i = 0; i < 1000; i++) {
            made.push(
              world.spawn(
                Position.of({ x: i, y: i }),
                Velocity.of({ x: 1, y: 2 })
              )
            );
          }
          for (let i = 0; i < 1000; i++) {
            world.despawn(made[i]!);
          }
          made.length = 0;
        },
        2000,
        500
      );
    },
  },

  churnRelated: {
    unit: "matches",
    label: "the same, each pointing at one entity with a relation",
    run: () => {
      const world = new World();
      populate(world);
      const anchor = world.spawn(Position.of({ x: 0, y: 0 }));
      const made: Entity[] = [];
      return measure(
        () => {
          for (let i = 0; i < 1000; i++) {
            made.push(
              world.spawn(
                Position.of({ x: i, y: i }),
                Velocity.of({ x: 1, y: 2 }),
                Aims.of({ target: anchor })
              )
            );
          }
          for (let i = 0; i < 1000; i++) {
            world.despawn(made[i]!);
          }
          made.length = 0;
        },
        2000,
        500
      );
    },
  },
  despawnQueued: {
    // A system queues its despawns on its commands, which keep a set of the
    // entities they despawn, and the app applies them after it.
    unit: "matches",
    label: "despawn 1,000 entities through a CommandBuffer",
    run: () => {
      const world = new World();
      populate(world);
      const commands = new CommandBuffer(world);
      const made: Entity[] = [];
      let applied = 0;
      const ms = measure(
        () => {
          for (let i = 0; i < 1000; i++) {
            commands.despawn(made[i]!);
          }
          applied += commands.apply();
          made.length = 0;
        },
        2000,
        500,
        () => {
          for (let i = 0; i < 1000; i++) {
            made.push(
              world.spawn(
                Position.of({ x: i, y: i }),
                Velocity.of({ x: 1, y: 2 })
              )
            );
          }
        }
      );
      if (applied !== 2500 * 1000 || world.entityCount !== N) {
        throw new Error(
          `${applied} despawns applied, which left ${world.entityCount} entities.`
        );
      }
      return ms;
    },
  },
  pointingAt: {
    unit: "matches",
    label: "each: the 10 children of each of 100 parents, by relation target",
    run: () => {
      const world = new World();
      const parents = family(world);
      const view = world.view(query([Position, Child]));
      return measure(() => {
        for (let p = 0; p < parents.length; p++) {
          view.pointingAt(Child, parents[p]!).each((pos) => {
            pos.x += DT;
          });
        }
      });
    },
  },

  pointingAtSources: {
    unit: "matches",
    label: "the same, with world.sources, get and set",
    run: () => {
      const world = new World();
      const parents = family(world);
      return measure(() => {
        for (let p = 0; p < parents.length; p++) {
          for (const child of world.sources(parents[p]!, Child)) {
            world.set(child, Position, {
              x: world.get(child, Position)!.x + DT,
            });
          }
        }
      });
    },
  },

  cascade: {
    unit: "matches",
    label: "despawn 100 parents, each taking its 10 children",
    run: () => {
      const world = new World();
      populate(world);
      const parents: Entity[] = [];
      return measure(
        () => {
          for (let i = 0; i < 100; i++) {
            world.despawn(parents[i]!);
          }
          parents.length = 0;
        },
        2000,
        500,
        () => {
          for (let i = 0; i < 100; i++) {
            const parent = world.spawn(Position.of({ x: i, y: i }));
            parents.push(parent);
            for (let c = 0; c < 10; c++) {
              world.spawn(
                Position.of({ x: c, y: c }),
                Child.of({ target: parent })
              );
            }
          }
        }
      );
    },
  },
};

// Run as a program: one variant, and its median on the last line.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const variant = variants[process.argv[2] ?? ""];
  if (variant === undefined) {
    throw new Error(
      `bench/core.ts is given the name of a variant, one of: ${Object.keys(variants).join(", ")}.`
    );
  }
  console.log(JSON.stringify(variant.run()));
}
