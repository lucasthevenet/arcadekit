import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import { World as EcsWorld, SnapshotError } from "../src/ecs/index.ts";
import type { ComponentDef } from "../src/ecs/index.ts";
import { Component, Field, Query, Singleton } from "../src/index.ts";
import type { Entity, JsonValue, RefCodec } from "../src/index.ts";

const dates: RefCodec<Date> = {
  encode: (value) => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError("not a date");
    }
    return value.toISOString();
  },
  decode: (data) => {
    if (typeof data !== "string" || Number.isNaN(Date.parse(data))) {
      throw new TypeError(`"${String(data)}" is not a date`);
    }
    return new Date(data);
  },
};
const sets: RefCodec<Set<string>> = {
  encode: (value) => [...value].toSorted(),
  decode: (data) => new Set(data as string[]),
};

const Profile = Schema.Struct({
  name: Schema.String,
  level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
  joined: Schema.Date,
  gold: Schema.BigInt,
  title: Schema.optional(Schema.String),
});
type Profile = typeof Profile.Type;

// Every kind of field that is not a number, in a table and in a sparse set.
const fields = {
  data: Field.json<JsonValue>(null),
  when: Field.ref(dates, new Date(0)),
  tags: Field.ref(sets, new Set()),
  profile: Field.schema(Profile, {
    name: "",
    level: 1,
    joined: new Date(0),
    gold: 0n,
  }),
  handle: Field.transient<{ readonly id: number }>(),
  hp: Field.i32,
};
const Card = Component.define("fld/Card", fields);
const Badge = Component.define("fld/Badge", fields, { storage: "sparse" });
const both = [Card, Badge] as ComponentDef[];

const card = (n: number) => ({
  data: [{ n }, ["list", n], n % 2 === 0 ? null : `text ${n}`][n % 3],
  when: new Date(Date.UTC(2026, 0, 1 + n)),
  tags: new Set([`t${n}`, "common"]),
  profile: {
    name: `hero ${n}`,
    level: 1 + (n % 99),
    joined: new Date(Date.UTC(2020, n % 12, 1)),
    gold: 10n ** 20n + BigInt(n),
    ...(n % 2 === 0 ? { title: "the bold" } : {}),
  },
  handle: { id: n },
  hp: n,
});

type Row = Omit<ReturnType<typeof card>, "handle"> & {
  readonly handle: { readonly id: number } | undefined;
};

const populated = (count = 9) => {
  const world = new EcsWorld({ seed: 1 });
  const entities: Entity[] = [];
  for (let n = 0; n < count; n++) {
    const entity = world.spawn(Card.of(card(n)));
    world.add(entity, Badge.of(card(n + 50)));
    entities.push(entity);
  }
  return { world, entities };
};

const reload = (world: EcsWorld, components = both): EcsWorld => {
  const copy = new EcsWorld();
  copy.load(world.snapshot(), components);
  return copy;
};

describe("a field that is not a number", () => {
  it("says where it is defined what kind it is: Field.ref takes a codec", () => {
    expect(() =>
      Component.define("fld/Bare", {
        // @ts-expect-error a bare ref says nothing about what saving does with it
        v: Field.ref<string>(),
      })
    ).not.toThrow();
    expect(Card.kinds).toEqual([
      "json",
      "ref",
      "ref",
      "ref",
      "transient",
      "i32",
    ]);
    expect(Card.codecs.map((codec) => codec !== undefined)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it("holds in a component given bare what it was made with, as its type says", () => {
    const Holder = Component.tag("fld/Holder", { requires: [Card, Badge] });
    const world = new EcsWorld();
    const added = world.spawn();
    world.add(added, Card);
    world.add(added, Badge);
    for (const entity of [
      world.spawn(Card, Badge),
      added,
      world.spawn(Holder),
    ]) {
      for (const def of both) {
        expect(world.get(entity, def)).toEqual({
          data: null,
          when: new Date(0),
          tags: new Set(),
          profile: { name: "", level: 1, joined: new Date(0), gold: 0n },
          handle: undefined,
          hp: 0,
        });
      }
    }
    expect(reload(world, [...both, Holder]).hash()).toBe(world.hash());

    const Named = Component.define("fld/Named", {
      name: Field.json<string>("nobody"),
    });
    const name = world.get(world.spawn(Named), Named)!.name;
    expectTypeOf(name).toEqualTypeOf<string>();
    expect(name).toBe("nobody");

    // A bool beside a json field is false, a boolean, in the bare value too.
    const flagged = { open: Field.bool, label: Field.json<string>("door") };
    const Gate = Component.define("fld/Gate", flagged);
    const Hatch = Component.define("fld/Hatch", flagged, { storage: "sparse" });
    const bare = { open: false, label: "door" };
    expect([Gate.initial, Hatch.initial]).toStrictEqual([bare, bare]);
    const Latch = Singleton.define("fld/Latch", flagged, Gate.initial!);
    const gates = new EcsWorld({ seed: 2 });
    const shut = gates.spawn();
    gates.add(shut, Gate);
    gates.add(shut, Hatch);
    for (const entity of [shut, gates.spawn(Gate, Hatch)]) {
      expect([gates.get(entity, Gate), gates.get(entity, Hatch)]).toStrictEqual(
        [bare, bare]
      );
    }
    const read: unknown[] = [];
    gates.view(Query.all(Gate, Hatch)).each((gate, hatch) => {
      read.push([gate.open, gate.label], [hatch.open, hatch.label]);
    });
    expect(read).toStrictEqual([
      [false, "door"],
      [false, "door"],
      [false, "door"],
      [false, "door"],
    ]);
    const latch = gates.singleton(Latch);
    expect([latch.open, latch.label]).toStrictEqual([false, "door"]);
    latch.label = "latch";

    const given = new EcsWorld({ seed: 2 });
    const kept = given.spawn();
    given.add(kept, Gate.of(bare));
    given.add(kept, Hatch.of(bare));
    given.spawn(Gate.of(bare), Hatch.of(bare));
    given.singleton(Latch).label = "latch";
    expect(gates.hash()).toBe(given.hash());
    const loaded = reload(gates, [Gate, Hatch, Latch.component]);
    expect(loaded.hash()).toBe(gates.hash());
    expect(loaded.get(shut, Hatch)).toStrictEqual(bare);
    expect(loaded.singleton(Latch).open).toBe(false);
  });

  it("is told where it is made what a component given bare holds", () => {
    expect(() =>
      Component.define("fld/Untold", {
        // @ts-expect-error a json field is given what a bare component holds
        name: Field.json<string>(),
        // @ts-expect-error a ref field is given what a bare component holds
        when: Field.ref(dates),
        // @ts-expect-error a schema field is given what a bare component holds
        born: Field.schema(Schema.Date),
      })
    ).not.toThrow();
  });

  it("is saved and loaded as what it held, or not at all when it is transient", () => {
    const { entities, world } = populated();
    const copy = reload(world);
    for (const def of both) {
      for (const [n, entity] of entities.entries()) {
        const then = world.get(entity, def) as Row;
        const now = copy.get(entity, def) as Row;
        expect(now.data).toEqual(then.data);
        expect(now.when).toEqual(then.when);
        expect(now.when).toBeInstanceOf(Date);
        expect(now.tags).toEqual(then.tags);
        expect(now.tags).toBeInstanceOf(Set);
        expect(now.profile).toEqual(then.profile);
        expect(now.profile.joined).toBeInstanceOf(Date);
        expect(typeof now.profile.gold).toBe("bigint");
        expect(now.hp).toBe(then.hp);
        // Not saved: the loaded world has to make its handles again.
        expect(then.handle).toEqual({ id: def === Card ? n : n + 50 });
        expect(now.handle).toBeUndefined();
      }
    }
  });

  it("is hashed as it is saved: a loaded world hashes the same", () => {
    const { world } = populated();
    expect(reload(world).hash()).toBe(world.hash());
    // And a loaded world saves to the same bytes again.
    expect(reload(world).snapshot()).toEqual(world.snapshot());
  });

  it("changes the hash when it changes, unless it is transient", () => {
    const { entities, world } = populated(5);
    const base = world.hash();
    const seen = new Set([base]);
    const changes: Record<string, unknown> = {
      data: { other: true },
      when: new Date(0),
      tags: new Set(["x"]),
      profile: { ...card(0).profile, level: 42 },
      hp: -1,
    };
    for (const def of both) {
      for (const entity of entities) {
        const original = world.get(entity, def)!;
        for (const [field, value] of Object.entries(changes)) {
          world.set(entity, def, { [field]: value });
          const changed = world.hash();
          expect(changed, `${def.name}.${field}`).not.toBe(base);
          seen.add(changed);
          world.set(entity, def, { [field]: original[field] });
          expect(world.hash(), `${def.name}.${field} restored`).toBe(base);
        }
        world.set(entity, def, { handle: { id: 999 } });
        expect(world.hash(), `${def.name}.handle`).toBe(base);
        world.set(entity, def, { handle: undefined });
        expect(world.hash(), `${def.name}.handle`).toBe(base);
      }
    }
    expect(seen.size).toBe(1 + both.length * entities.length * 5);
  });

  it("hashes a ref field by what its codec makes of it, not by which object it is", () => {
    const hashWith = (tags: Set<string>, when: Date): number => {
      const world = new EcsWorld();
      world.spawn(Card.of({ ...card(1), tags, when }));
      return world.hash();
    };
    const base = hashWith(new Set(["a", "b"]), new Date(5));
    // Another Set with the same members, added in another order.
    expect(hashWith(new Set(["b", "a"]), new Date(5))).toBe(base);
    expect(hashWith(new Set(["a", "c"]), new Date(5))).not.toBe(base);
    expect(hashWith(new Set(["a", "b"]), new Date(6))).not.toBe(base);
  });

  it("keeps a transient field through a transaction, like any other", () => {
    const { entities, world } = populated(3);
    const handle = world.get(entities[0]!, Card)!.handle;
    world.begin();
    world.set(entities[0]!, Card, { handle: { id: 7 } });
    world.view(Query.all(Card).pipe(Query.writes(Card))).each((row) => {
      row.handle = undefined;
      row.data = "gone";
    });
    world.rollback();
    expect(world.get(entities[0]!, Card)!.handle).toBe(handle);
    expect(world.get(entities[1]!, Card)!.data).toEqual(card(1).data);
  });

  it("is part of what its component is: a snapshot does not load into another kind", () => {
    const { world } = populated(2);
    const bytes = world.snapshot();
    const retyped = (data: ComponentDef) => {
      try {
        new EcsWorld().load(bytes, [data, Badge]);
      } catch (error) {
        return error as SnapshotError;
      }
    };
    const transient = retyped(
      Component.define("fld/Card", { ...fields, data: Field.transient() })
    );
    expect(transient!.problem).toBe("component changed");
    expect(transient!.message).toContain("data: json");
    expect(transient!.message).toContain("data: transient");
    expect(
      retyped(
        Component.define("fld/Card", {
          ...fields,
          handle: Field.json<JsonValue>(null),
        })
      )!.problem
    ).toBe("component changed");
    expect(
      retyped(
        Component.define("fld/Card", {
          ...fields,
          data: Field.ref(dates, new Date(0)),
        })
      )!.problem
    ).toBe("component changed");
  });

  it("refuses a snapshot when a codec or a schema will not take a value, naming the field and saying why", () => {
    const refused = (
      change: Record<string, unknown>,
      def: ComponentDef = Card
    ) => {
      const { entities, world } = populated(3);
      world.set(entities[1]!, def, change);
      try {
        world.snapshot();
      } catch (error) {
        return error as SnapshotError;
      }
    };
    const date = refused({ when: new Date(Number.NaN) })!;
    expect(date).toBeInstanceOf(SnapshotError);
    expect(date.problem).toBe("cannot be saved");
    expect(date.component).toBe("fld/Card");
    expect(date.message).toBe(
      '"fld/Card.when" holds a value its codec refuses: not a date'
    );
    // A level the schema does not allow, which the compiler cannot see.
    const level = refused({ profile: { ...card(1).profile, level: 100 } })!;
    expect(level.problem).toBe("cannot be saved");
    expect(level.message).toMatch(
      /^"fld\/Card\.profile" holds a value its codec refuses: Expected a value between 1 and 99/
    );
    expect(refused({ when: "yesterday" }, Badge)!.message).toContain(
      '"fld/Badge.when"'
    );
    expect(refused({ hp: 5 })).toBeUndefined();
  });

  it("refuses to load a value its codec will not take back, and names the field", () => {
    // Saved with one codec for `when`, loaded with one that wants a number.
    const strict: RefCodec<Date> = {
      encode: (value) => value.getTime(),
      decode: (data) => {
        if (typeof data !== "number") {
          throw new TypeError("a date is saved as a number here");
        }
        return new Date(data);
      },
    };
    const Changed = Component.define("fld/Card", {
      ...fields,
      when: Field.ref(strict, new Date(0)),
    });
    const { world } = populated(2);
    let error: unknown;
    try {
      new EcsWorld().load(world.snapshot(), [Changed, Badge]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).problem).toBe("component changed");
    expect((error as SnapshotError).component).toBe("fld/Card");
    expect((error as SnapshotError).message).toBe(
      '"fld/Card.when" has a codec that refuses a value the snapshot holds: a date is saved as a number here'
    );
  });

  it("refuses a snapshot whose JSON is damaged, as damaged and not as a changed component", () => {
    const Note = Component.define("fld/Note", {
      v: Field.json<JsonValue>(null),
    });
    const world = new EcsWorld();
    world.spawn(Note.of({ v: { key: "value" } }));
    const bytes = world.snapshot();
    const text = new TextEncoder().encode('{"key":"value"}');
    const at = bytes.findIndex((_, i) =>
      text.every((byte, k) => bytes[i + k] === byte)
    );
    expect(at).toBeGreaterThan(0);
    // The opening brace becomes a letter: still text, no longer JSON.
    bytes[at] = 0x78;
    let error: unknown;
    try {
      new EcsWorld().load(bytes, [Note]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).problem).toBe("corrupt");
    expect((error as SnapshotError).message).toMatch(/is not JSON/);
  });

  it("saves plain data in a json field as JSON does: what comes back is what JSON makes of it", () => {
    const world = new EcsWorld();
    const Note = Component.define("fld/Note", {
      v: Field.json<JsonValue>(null),
    });
    const values: JsonValue[] = [
      { a: 1, b: [true, null, "x", { c: [] }] },
      [],
      {},
      [[[]]],
      "text",
      0,
      -0,
      Number.NaN,
      12n,
      undefined,
      null,
      // Not plain data, and JSON's own rules apply: the date becomes text,
      // the undefined member is dropped, and NaN inside becomes null.
      // @ts-expect-error A Date is not JSON, nor is an undefined member.
      { when: new Date(0), gone: undefined, bad: Number.NaN },
    ];
    const entities = values.map((v) => world.spawn(Note.of({ v })));
    const copy = new EcsWorld();
    copy.load(world.snapshot(), [Note]);
    const back = entities.map((entity) => copy.get(entity, Note)!.v);
    expect(back.slice(0, 11)).toEqual(values.slice(0, 11));
    expect(Object.is(back[6], -0)).toBe(true);
    expect(back[11]).toEqual({ when: "1970-01-01T00:00:00.000Z", bad: null });
    // The hash is of the saved form, so it agrees all the same.
    expect(copy.hash()).toBe(world.hash());
  });
});

describe("a bool field", () => {
  const Door = Component.define("fld/Door", {
    open: Field.bool,
    label: Field.json<string>(""),
  });
  const Lever = Singleton.define(
    "fld/Lever",
    { pulled: Field.bool, pulls: Field.u8 },
    { pulled: true, pulls: 1 }
  );

  it("reads and writes true and false, and is false in a component spawned bare", () => {
    const world = new EcsWorld();
    const bare = world.spawn(Door);
    const front = world.spawn(Door.of({ open: true, label: "front" }));
    expect(world.get(bare, Door)).toEqual({ open: false, label: "" });
    expect(world.get(front, Door)).toEqual({ open: true, label: "front" });
    expectTypeOf(world.get(bare, Door)!.open).toEqualTypeOf<boolean>();

    world.set(front, Door, { open: false });
    expect(world.get(front, Door)!.open).toBe(false);
    const doors = world.view(Query.all(Door).pipe(Query.writes(Door)));
    const read: unknown[] = [];
    doors.each((door) => {
      expectTypeOf(door.open).toEqualTypeOf<boolean>();
      read.push(door.open);
      door.open = !door.open;
    });
    expect(read).toEqual([false, false]);
    expect(world.get(bare, Door)).toEqual({ open: true, label: "" });
    expect(world.get(front, Door)).toEqual({ open: true, label: "front" });

    const lever = world.singleton(Lever);
    expect([lever.pulled, lever.pulls]).toEqual([true, 1]);
    lever.pulled = false;
    expect(lever.pulled).toBe(false);
    // What a tool reads of the world, as `app.inspect()` gives it.
    expect(world.contents().entities[0]!.components["fld/Door"]).toEqual({
      open: true,
      label: "",
    });
    expect(world.contents().singletons["fld/Lever"]).toEqual({
      pulled: false,
      pulls: 1,
    });

    // Only compiled: a number is no boolean.
    const numbers = (): void => {
      // @ts-expect-error a bool field is given true or false
      Door.of({ open: 1, label: "back" });
      // @ts-expect-error in set, too
      world.set(front, Door, { open: 0 });
      doors.each((door) => {
        // @ts-expect-error and in each
        door.open = 1;
      });
    };
    void numbers;
  });

  it("refuses an assignment where it is only read, and is put back by a rollback", () => {
    const world = new EcsWorld();
    const door = world.spawn(Door.of({ open: true, label: "front" }));
    expect(() =>
      world.view(Query.all(Door)).each((read) => {
        (read as { open: boolean }).open = false;
      })
    ).toThrow(
      /"fld\/Door\.open" was assigned to through a query that only reads/
    );
    world.begin();
    world.view(Query.all(Door).pipe(Query.writes(Door))).each((written) => {
      written.open = false;
    });
    expect(world.get(door, Door)!.open).toBe(false);
    world.rollback();
    expect(world.get(door, Door)!.open).toBe(true);
  });

  it("is handed to eachChunk as its column, a Uint8Array of 0 for false and 1 for true", () => {
    const world = new EcsWorld();
    const doors = [true, false, true].map((open) =>
      world.spawn(Door.of({ open, label: "" }))
    );
    world
      .view(Query.all(Door).pipe(Query.writes(Door)))
      .eachChunk((start, end, door) => {
        expectTypeOf(door.open).toEqualTypeOf<Uint8Array>();
        expect(door.open).toBeInstanceOf(Uint8Array);
        expect(Array.from(door.open.subarray(start, end))).toEqual([1, 0, 1]);
        door.open[start + 1] = 1;
      });
    expect(doors.map((door) => world.get(door, Door)!.open)).toEqual([
      true,
      true,
      true,
    ]);
    world.view(Query.all(Door)).eachChunk((start, _end, door) => {
      expectTypeOf(door.open[start]).toEqualTypeOf<number | undefined>();
    });
  });

  it("is saved and hashed as a u8 of 0 and 1, so a save of either kind loads as the other", () => {
    const Switch = Component.define("fld/Switch", { on: Field.bool });
    const SwitchU8 = Component.define("fld/Switch", { on: Field.u8 });
    const world = new EcsWorld({ seed: 3 });
    const entities = [true, false, true].map((on) =>
      world.spawn(Switch.of({ on }))
    );
    const asU8 = new EcsWorld({ seed: 3 });
    for (const on of [1, 0, 1]) {
      asU8.spawn(SwitchU8.of({ on }));
    }
    expect(world.snapshot()).toEqual(asU8.snapshot());
    expect(world.hash()).toBe(asU8.hash());

    const loaded = new EcsWorld();
    loaded.load(world.snapshot(), [Switch]);
    expect(entities.map((entity) => loaded.get(entity, Switch)!.on)).toEqual([
      true,
      false,
      true,
    ]);
    expect(loaded.hash()).toBe(world.hash());
    world.set(entities[1]!, Switch, { on: true });
    expect(world.hash()).not.toBe(loaded.hash());

    // Loaded with no migration, either way: any number but 0 is true.
    asU8.set(entities[2]!, SwitchU8, { on: 7 });
    const fromU8 = new EcsWorld();
    fromU8.load(asU8.snapshot(), [Switch]);
    expect(entities.map((entity) => fromU8.get(entity, Switch)!.on)).toEqual([
      true,
      false,
      true,
    ]);
    const toU8 = new EcsWorld();
    toU8.load(loaded.snapshot(), [SwitchU8]);
    expect(entities.map((entity) => toU8.get(entity, SwitchU8)!.on)).toEqual([
      1, 0, 1,
    ]);
  });
});

describe("a field that holds an object", () => {
  it("holds in a json field only what JSON holds, refused where the field is made", () => {
    const Notes = Component.define("fld/Notes", {
      tags: Field.json<{ tags: string[] }>({ tags: [] }),
      // @ts-expect-error A Date comes back from JSON as text: it is a ref.
      when: Field.json<Date>(new Date()),
      // @ts-expect-error A Map comes back from JSON as an empty object.
      counts: Field.json<Map<string, number>>(new Map()),
      // @ts-expect-error JSON cannot write a function at all.
      call: Field.json<() => void>(() => {}),
    });
    expect(Notes.kinds).toEqual(["json", "json", "json", "json"]);
  });

  it("is read-only where it is read, and replaced with set", () => {
    const Tagged = Component.define("fld/Tagged", {
      tags: Field.json<{ tags: string[] }>({ tags: [] }),
      labels: Field.ref(sets, new Set()),
    });
    const world = new EcsWorld();
    const entity = world.spawn(
      Tagged.of({ tags: { tags: ["a"] }, labels: new Set(["x"]) })
    );
    // Only compiled: run, each line would change the stored value where no
    // change query sees it and no rollback undoes it.
    const inPlace = (): void => {
      const read = world.get(entity, Tagged);
      if (read === undefined) return;
      // @ts-expect-error The array is read-only.
      read.tags.tags.push("b");
      // @ts-expect-error So is each of its elements.
      read.tags.tags[0] = "b";
      // @ts-expect-error A set read back is a ReadonlySet.
      read.labels.add("y");
      world.view(Query.all(Tagged).pipe(Query.writes(Tagged))).each((row) => {
        // @ts-expect-error In a query, too.
        row.tags.tags.push("b");
        // @ts-expect-error In a query, too.
        row.labels.add("y");
      });
    };
    void inPlace;

    world.set(entity, Tagged, {
      tags: { tags: ["a", "b"] },
      labels: new Set(["x", "y"]),
    });
    expect(world.get(entity, Tagged)?.tags).toEqual({ tags: ["a", "b"] });
    expect(world.get(entity, Tagged)?.labels).toEqual(new Set(["x", "y"]));
    // In a query, a field is assigned whole.
    world.view(Query.all(Tagged).pipe(Query.writes(Tagged))).each((row) => {
      row.tags = { tags: [...row.tags.tags, "c"] };
      row.labels = new Set([...row.labels, "z"]);
    });
    expect(world.get(entity, Tagged)?.tags).toEqual({ tags: ["a", "b", "c"] });
    expect(world.get(entity, Tagged)?.labels).toEqual(new Set(["x", "y", "z"]));
  });
});
