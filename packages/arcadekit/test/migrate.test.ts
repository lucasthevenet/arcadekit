import { Cause, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  CommandBuffer,
  Component,
  EcsWorld,
  Field,
  Migrate,
  Plugin,
  Query,
  readSnapshot,
  Save,
  writeSnapshot,
} from "../src/index";
import type { ComponentDef, Entity } from "../src/index";

const withApp = <T, E, A>(
  make: Effect.Effect<T, E, Scope.Scope>,
  use: (app: T) => A
): A => Effect.runSync(Effect.scoped(Effect.map(make, use)));

const unwrap = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) {
    throw Cause.squash(exit.cause);
  }

  return exit.value;
};

const refusal = (exit: Exit.Exit<unknown, unknown>): any =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

// --- version 0 of a game ----------------------------------------------------------

const Hp0 = Component.define("mg/Hp", { points: Field.i32 });
const Pos0 = Component.define("mg/Pos", { x: Field.f32, y: Field.f32 });
const Name0 = Component.define("mg/Name", { value: Field.json<string>() });
const Old0 = Component.tag("mg/Old");

const Buff0 = Component.define(
  "mg/Buff",
  { power: Field.u8, note: Field.json<string>() },
  { storage: "sparse" }
);

const Heal0 = Action.define("mg/Heal", Schema.Struct({ amount: Schema.Int }));

const heal0 = Action.handler(Heal0, function* ({ amount }) {
  (yield* Query.all(Hp0)).each((hp) => {
    hp.points += amount;
  });
});

const Game0 = Plugin.make("mg/Game", {
  components: [Hp0, Pos0, Name0, Old0, Buff0],
  handlers: [heal0],
});

/** Plays a little of version 0 and saves it, with an action waiting. */
const savedByVersion0 = () =>
  withApp(App.make({ plugins: [Game0] }), (app) => {
    const entities: Entity[] = [];

    for (let n = 0; n < 9; n += 1) {
      const entity = app.world.spawn(
        Hp0.of({ points: 10 * n }),
        Pos0.of({ x: n, y: -n }),
        Name0.of({ value: `unit ${n}` })
      );

      if (n % 2 === 0) {
        app.world.add(entity, Old0);
      }

      if (n % 3 === 0) {
        app.world.add(entity, Buff0.of({ power: n, note: `buff ${n}` }));
      }

      entities.push(entity);
    }

    app.world.despawn(entities.splice(4, 1)[0]!);
    app.tick(1);
    app.enqueue(Heal0, { amount: 3 });

    return { save: unwrap(app.save()), entities };
  });

// --- version 2 of the same game -----------------------------------------------------

const Health2 = Component.define("mg/Health", {
  armor: Field.i32,
  points: Field.f32,
});

const Pos2 = Component.define("mg/Pos", { px: Field.f32 });
const Name2 = Component.define("mg/Name", { value: Field.json<string>() });

const Buff2 = Component.define(
  "mg/Buff",
  {
    power: Field.u16,
    note: Field.json<string>(),
    fresh: Field.transient<object>(),
  },
  { storage: "sparse" }
);

const Mend2 = Action.define("mg/Mend", Schema.Struct({ by: Schema.Int }));

const mend2 = Action.handler(Mend2, function* ({ by }) {
  (yield* Query.all(Health2)).each((health) => {
    health.points += by;
  });
});

const Game2 = Plugin.make("mg/Game", {
  components: [Health2, Pos2, Name2, Buff2],
  handlers: [mend2],
});

const migrations: Save.Migration[] = [
  {
    from: 0,
    migrate: ({ world }) => {
      Migrate.renameComponent(world, "mg/Hp", "mg/Health");
      Migrate.addField(world, "mg/Health", "armor", "i32", 5, "points");
      Migrate.renameField(world, "mg/Pos", "x", "px");
    },
  },
  {
    from: 1,
    migrate: (contents) => {
      const { world } = contents;
      Migrate.mapField(world, "mg/Health", "points", "f32", (hp) => hp / 4);
      Migrate.removeField(world, "mg/Pos", "y");
      Migrate.removeComponent(world, "mg/Old");
      Migrate.mapField(
        world,
        "mg/Buff",
        "power",
        "u16",
        (power) => power * 100
      );
      Migrate.addField(world, "mg/Buff", "fresh", "transient", undefined);

      // The action that was waiting has another name and payload now.
      for (const action of contents.queued) {
        if (action.name === "mg/Heal") {
          action.name = "mg/Mend";
          action.payload = {
            by: (action.payload as { amount: number }).amount,
          };
        }
      }
    },
  },
];

const version2 = { plugins: [Game2], version: 2, migrations } as const;

describe("a snapshot read without the program's components", () => {
  it("describes its own components, and writes back to the same bytes", () => {
    const { save } = savedByVersion0();
    const contents = readSnapshot(save.world);
    expect(contents.components).toStrictEqual([
      {
        name: "mg/Buff",
        storage: "sparse",
        fields: [
          { name: "power", kind: "u8" },
          { name: "note", kind: "json" },
        ],
      },
      {
        name: "mg/Hp",
        storage: "table",
        fields: [{ name: "points", kind: "i32" }],
      },
      {
        name: "mg/Name",
        storage: "table",
        fields: [{ name: "value", kind: "json" }],
      },
      { name: "mg/Old", storage: "table", fields: [] },
      {
        name: "mg/Pos",
        storage: "table",
        fields: [
          { name: "x", kind: "f32" },
          { name: "y", kind: "f32" },
        ],
      },
    ]);
    // Two tables: units without the tag, then units with it.
    expect(contents.tables.map((table) => table.components)).toStrictEqual([
      ["mg/Hp", "mg/Name", "mg/Pos"],
      ["mg/Hp", "mg/Name", "mg/Old", "mg/Pos"],
    ]);
    expect(Array.from(contents.tables[1]!.columns["mg/Hp"]!.points!)).toStrictEqual([
      0, 20, 80, 60,
    ]);
    expect(contents.tables[1]!.columns["mg/Name"]!.value).toStrictEqual([
      "unit 0",
      "unit 2",
      "unit 8",
      "unit 6",
    ]);
    expect(contents.sparse).toHaveLength(1);
    expect(Array.from(contents.sparse[0]!.members)).toStrictEqual([0, 3, 6]);
    expect(contents.freed).toStrictEqual([4]);
    expect(contents.generations).toHaveLength(9);
    expect(writeSnapshot(contents)).toStrictEqual(save.world);
  });

  it("writes back the bytes of any world it read", () => {
    const kinds = {
      single: Field.f32,
      double: Field.f64,
      signed: Field.i32,
      unsigned: Field.u32,
      short: Field.u16,
      byte: Field.u8,
      other: Field.entity,
      data: Field.json<unknown>(),
      when: Field.ref<Date>({
        encode: (date) => date.getTime(),
        decode: (data) => new Date(data as number),
      }),
      handle: Field.transient<object>(),
    };

    const Wide = Component.define("mg/Wide", kinds);
    const Thin = Component.define("mg/Thin", kinds, { storage: "sparse" });
    const Tag = Component.tag("mg/Tag");

    const row = (n: number) => ({
      single: n / 3,
      double: n / 7,
      signed: -n,
      unsigned: 4_000_000_000 - n,
      short: 65_000 - n,
      byte: n % 256,
      other: n as Entity,
      data: [n, { n }, `text ${n}`, null, undefined, 5n][n % 6],
      when: new Date(n * 1000),
      handle: { n },
    });

    const dice = new EcsWorld({ seed: 5 }).random;

    for (let round = 0; round < 20; round += 1) {
      const world = new EcsWorld({ seed: round });
      const commands = new CommandBuffer(world);
      const alive: Entity[] = [];

      for (let step = 0; step < 60; step += 1) {
        const choice = dice.int(0, 5);

        if (choice <= 2 || alive.length === 0) {
          const entity = commands.spawn(Wide.of(row(step)));
          commands.apply();

          if (dice.int(0, 1) === 1) {
            world.add(entity, Thin.of(row(step + 7)));
          }

          if (dice.int(0, 2) === 1) {
            world.add(entity, Tag);
          }

          alive.push(entity);
        } else if (choice === 3) {
          world.despawn(alive.splice(dice.int(0, alive.length - 1), 1)[0]!);
        } else {
          world.random.next();
        }
      }

      const bytes = world.snapshot();
      expect(writeSnapshot(readSnapshot(bytes))).toStrictEqual(bytes);
    }
  });
});

describe("a save from another version of the game", () => {
  it("records the version of the game that wrote it", () => {
    expect(savedByVersion0().save.version).toBe(0);
    withApp(App.make({ version: 7 }), (app) => {
      const save = unwrap(app.save());
      expect(save.version).toBe(7);
      expect(unwrap(Save.decode(Save.encode(save))).version).toBe(7);
    });

    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => withApp(App.make({ version: bad }), () => 0)).toThrow(
        /A game's version must be a whole number from 0 up/u
      );
    }
  });

  it("is migrated, one version at a time, and loads into the game as it is now", () => {
    const { entities, save } = savedByVersion0();
    withApp(App.load(save, version2), (app) => {
      const { world } = app;
      expect(world.entityCount).toBe(8);

      for (const entity of entities) {
        const n = world.get(entity, Name2)!.value.slice("unit ".length);
        // Hp became Health: points a quarter of what they were, as a float,
        // behind an armor of 5 that every unit was given.
        expect(world.get(entity, Health2)).toStrictEqual({
          armor: 5,
          points: (10 * Number(n)) / 4,
        });
        // Pos kept x under its new name and lost y.
        expect(world.get(entity, Pos2)).toStrictEqual({ px: Number(n) });
      }

      // The sparse component kept its members, with power a hundredfold.
      const buffed = entities.filter((entity) => world.has(entity, Buff2));
      expect(buffed.map((entity) => world.get(entity, Buff2))).toStrictEqual([
        { power: 0, note: "buff 0", fresh: undefined },
        { power: 300, note: "buff 3", fresh: undefined },
        { power: 600, note: "buff 6", fresh: undefined },
      ]);
      expect(world.component("mg/Old")).toBeUndefined();
      expect(world.component("mg/Hp")).toBeUndefined();

      // The ids are the ones the old game handed out, dead ones stay dead,
      // and the next entity gets the id the old game would have given.
      expect(world.view(Query.all(Health2)).entities().toSorted()).toStrictEqual(
        entities.toSorted()
      );
      const next = world.spawn(Health2.of({ armor: 0, points: 1 }));
      expect(next & 0x3f_ff_ff).toBe(4);
      expect(next >>> 22).toBe(1);
      world.despawn(next);

      // The action that was waiting is applied under its new name.
      const before = world.get(entities[1]!, Health2)!.points;
      app.tick(1);
      expect(world.get(entities[1]!, Health2)!.points).toBe(before + 3);
      expect(app.time.tick).toBe(2);

      // What it saves now is a save of version 2, which loads as it is.
      const again = unwrap(app.save());
      expect(again.version).toBe(2);
      withApp(App.load(again, version2), (reloaded) => {
        expect(reloaded.world.hash()).toBe(world.hash());
      });
    });
  });

  it("joins two tables that a removed component had kept apart", () => {
    const { entities, save } = savedByVersion0();
    withApp(App.load(save, version2), (app) => {
      // One table now: the units that never had the tag, then those that did.
      const order = app.world.view(Query.all(Name2)).entities();
      const names = order.map((entity) => app.world.get(entity, Name2)!.value);
      expect(names).toStrictEqual([
        "unit 1",
        "unit 3",
        "unit 5",
        "unit 7",
        "unit 0",
        "unit 2",
        "unit 8",
        "unit 6",
      ]);
      expect(order.toSorted()).toStrictEqual(entities.toSorted());
      let chunks = 0;
      app.world.view(Query.all(Name2)).eachChunk(() => {
        chunks += 1;
      });
      expect(chunks).toBe(1);
    });
  });

  it("is refused when a later version of the game wrote it", () => {
    const save = withApp(App.make({ plugins: [Game2], version: 3 }), (app) =>
      unwrap(app.save())
    );

    const error = refusal(
      Effect.runSync(Effect.scoped(Effect.exit(App.load(save, version2))))
    );

    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(error.problem).toBe("newer version");
    expect(error.message).toBe(
      "The save was written by version 3 of the game, and this is version 2. A game cannot read what a later version of itself wrote."
    );
  });

  it("is refused when a migration is missing, and says which", () => {
    const { save } = savedByVersion0();

    const load = (given: readonly Save.Migration[], version = 2) =>
      refusal(
        Effect.runSync(
          Effect.scoped(
            Effect.exit(
              App.load(save, { plugins: [Game2], version, migrations: given })
            )
          )
        )
      );

    const none = load([]);
    expect(none.problem).toBe("no migration");
    expect(none.message).toBe(
      "The save was written by version 0 of the game, and this is version 2. There is no migration from version 0 to version 1."
    );
    expect(load([migrations[0]!]).message).toMatch(
      /no migration from version 1 to version 2/u
    );
    expect(load([migrations[1]!]).message).toMatch(
      /no migration from version 0 to version 1/u
    );
    // With no migrations given at all, an older save is refused the same way.
    expect(
      refusal(
        Effect.runSync(
          Effect.scoped(
            Effect.exit(App.load(save, { plugins: [Game2], version: 2 }))
          )
        )
      ).problem
    ).toBe("no migration");
  });

  it("is refused when a migration fails, and says which and why", () => {
    const { save } = savedByVersion0();

    const failing = (migrate: Save.Migration["migrate"]) =>
      refusal(Save.migrate(save, 1, [{ from: 0, migrate }]));

    const thrown = failing(() => {
      throw new Error("the old saves had no such thing");
    });

    expect(thrown.problem).toBe("migration failed");
    expect(thrown.message).toBe(
      "The migration from version 0 to version 1 failed: the old saves had no such thing"
    );

    // Each helper refuses what is not there, by name.
    const cases: [(world: Save.Contents["world"]) => void, RegExp][] = [
      [
        (world) => Migrate.renameComponent(world, "mg/Nope", "mg/Else"),
        /holds no component named "mg\/Nope"\. It holds: mg\/Buff, mg\/Hp/u,
      ],
      [
        (world) => Migrate.renameComponent(world, "mg/Hp", "mg/Pos"),
        /already holds a component named "mg\/Pos"/u,
      ],
      [
        (world) => Migrate.renameField(world, "mg/Pos", "z", "w"),
        /"mg\/Pos" has no field named "z" in the save\. It has: x, y/u,
      ],
      [
        (world) => Migrate.renameField(world, "mg/Pos", "x", "y"),
        /"mg\/Pos" already has a field named "y"/u,
      ],
      [
        (world) => Migrate.addField(world, "mg/Pos", "x", "f32", 0),
        /"mg\/Pos" already has a field named "x"/u,
      ],
      [
        (world) => Migrate.addField(world, "mg/Pos", "z", "f32", 0, "w"),
        /no field named "w"/u,
      ],
      [
        (world) => Migrate.removeField(world, "mg/Pos", "z"),
        /no field named "z"/u,
      ],
      [
        (world) => Migrate.mapField(world, "mg/Pos", "z", "f64", (v) => v),
        /no field named "z"/u,
      ],
      [
        (world) => Migrate.removeComponent(world, "mg/Nope"),
        /no component named/u,
      ],
    ];

    for (const [change, message] of cases) {
      const error = failing(({ world }) => change(world));
      expect(error.problem).toBe("migration failed");
      expect(error.message).toMatch(message);
    }
  });

  it("is refused by name when its migrations do not bring it all the way", () => {
    // The first migration alone: the save now claims version 1, and the game
    // of version 1 given here still has version 2's components.
    const { save } = savedByVersion0();

    const error = refusal(
      Effect.runSync(
        Effect.scoped(
          Effect.exit(
            App.load(save, {
              plugins: [Game2],
              version: 1,
              migrations: [migrations[0]!],
            })
          )
        )
      )
    );

    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(["component changed", "unknown component"]).toContain(error.problem);
    expect(error.message).toMatch(/mg\//u);
  });

  it("is left as it is when it is of this version already", () => {
    const { save } = savedByVersion0();
    let ran = 0;
    const counting: Save.Migration[] = [
      {
        from: 0,
        migrate: () => {
          ran += 1;
        },
      },
    ];
    expect(unwrap(Save.migrate(save, 0, counting))).toBe(save);
    expect(ran).toBe(0);
    // A migration that changes nothing gives the same game, a version on.
    const moved = unwrap(Save.migrate(save, 1, counting));
    expect(ran).toBe(1);
    expect(moved.version).toBe(1);
    expect(moved.world).toStrictEqual(save.world);
    expect({ ...moved, version: 0 }).toStrictEqual(save);
    // The save it was given is not changed by a migration that edits.
    const before = structuredClone(save);
    unwrap(Save.migrate(save, 2, migrations));
    expect(save).toStrictEqual(before);
  });

  it("is written back the way the game itself would write it, whatever was renamed or removed", () => {
    const { entities, save } = savedByVersion0();
    const contents = readSnapshot(save.world);
    // Renames that change where a component sorts, one of them sparse, and
    // a sparse component and a tag taken out.
    Migrate.renameComponent(contents, "mg/Pos", "mg/Apos");
    Migrate.renameComponent(contents, "mg/Hp", "mg/Zhp");
    Migrate.renameComponent(contents, "mg/Buff", "mg/Boon");
    Migrate.removeComponent(contents, "mg/Old");
    const bytes = writeSnapshot(contents);

    const Apos = Component.define("mg/Apos", { x: Field.f32, y: Field.f32 });
    const Zhp = Component.define("mg/Zhp", { points: Field.i32 });

    const Boon = Component.define(
      "mg/Boon",
      { power: Field.u8, note: Field.json<string>() },
      { storage: "sparse" }
    );

    const world = new EcsWorld();
    world.load(bytes, [Apos, Zhp, Boon, Name0]);
    expect(world.get(entities[0]!, Apos)).toStrictEqual({ x: 0, y: -0 });
    expect(world.get(entities[2]!, Zhp)).toStrictEqual({ points: 20 });
    expect(world.get(entities[3]!, Boon)).toStrictEqual({ power: 3, note: "buff 3" });
    expect(world.view(Query.all(Boon)).count()).toBe(3);
    // Byte for byte what the loaded world saves: one form, not two.
    expect(world.snapshot()).toStrictEqual(bytes);

    // The sparse component taken out altogether.
    Migrate.removeComponent(contents, "mg/Boon");
    expect(contents.sparse).toStrictEqual([]);
    const without = new EcsWorld();
    without.load(writeSnapshot(contents), [Apos, Zhp, Name0]);
    expect(without.entityCount).toBe(8);
    expect(without.component("mg/Boon")).toBeUndefined();
    expect(without.snapshot()).toStrictEqual(writeSnapshot(contents));
  });

  it("is refused when a migration leaves a column with the wrong number of values", () => {
    const { save } = savedByVersion0();

    const error = refusal(
      Save.migrate(save, 1, [
        {
          from: 0,
          migrate: ({ world }) => {
            world.tables[0]!.columns["mg/Hp"]!.points = new Int32Array(1);
          },
        },
      ])
    );

    expect(error).toBeInstanceOf(Save.LoadRefused);
    expect(error.problem).toBe("corrupt");
    expect(error.message).toMatch(
      /"mg\/Hp\.points" has no column of 4 values/u
    );

    // And when it takes a column away, or leaves data for a component it
    // took off the list.
    const missing = refusal(
      Save.migrate(save, 1, [
        {
          from: 0,
          migrate: ({ world }) => {
            delete world.tables[1]!.columns["mg/Pos"]!.y;
          },
        },
      ])
    );

    expect(missing.message).toMatch(/"mg\/Pos\.y" has no column/u);

    const unlisted = refusal(
      Save.migrate(save, 1, [
        {
          from: 0,
          migrate: ({ world }) => {
            world.components = world.components.filter(
              (component) => component.name !== "mg/Buff"
            );
          },
        },
      ])
    );

    expect(unlisted.problem).toBe("corrupt");
    expect(unlisted.message).toMatch(
      /holds data for "mg\/Buff", which it does not list/u
    );
  });

  it("can have every kind of change made to a field", () => {
    const Thing = Component.define("mg/Thing", {
      a: Field.u8,
      b: Field.json<string>(),
    });

    const world = new EcsWorld();

    const entities = [1, 2, 3].map((n) =>
      world.spawn(Thing.of({ a: n, b: `b${n}` }))
    );

    const contents = readSnapshot(world.snapshot());
    Migrate.mapField(contents, "mg/Thing", "a", "json", (a) => ({ was: a }));
    Migrate.mapField(
      contents,
      "mg/Thing",
      "b",
      "f64",
      (b) => Number(b.slice(1)) / 2
    );
    Migrate.addField(contents, "mg/Thing", "c", "entity", entities[0]);
    Migrate.addField(contents, "mg/Thing", "d", "json", "new", "a");
    Migrate.addField(contents, "mg/Thing", "e", "u16", 500);
    Migrate.addField(contents, "mg/Thing", "f", "f32", 0.5);

    const Thing2: ComponentDef<any> = Component.define("mg/Thing", {
      d: Field.json<string>(),
      a: Field.json<{ was: number }>(),
      b: Field.f64,
      c: Field.entity,
      e: Field.u16,
      f: Field.f32,
    });

    const loaded = new EcsWorld();
    loaded.load(writeSnapshot(contents), [Thing2]);
    expect(entities.map((entity) => loaded.get(entity, Thing2))).toStrictEqual([
      { d: "new", a: { was: 1 }, b: 0.5, c: entities[0], e: 500, f: 0.5 },
      { d: "new", a: { was: 2 }, b: 1, c: entities[0], e: 500, f: 0.5 },
      { d: "new", a: { was: 3 }, b: 1.5, c: entities[0], e: 500, f: 0.5 },
    ]);
  });
});
