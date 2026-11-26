import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { World as EcsWorld, SnapshotError } from "../src/ecs/index.ts";
import type { ComponentDef } from "../src/ecs/index.ts";
import { Component, Field, Query } from "../src/index.ts";
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
  data: Field.json<JsonValue>(),
  when: Field.ref(dates),
  tags: Field.ref(sets),
  profile: Field.schema(Profile),
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
        Component.define("fld/Card", { ...fields, handle: Field.json() })
      )!.problem
    ).toBe("component changed");
    expect(
      retyped(
        Component.define("fld/Card", { ...fields, data: Field.ref(dates) })
      )!.problem
    ).toBe("component changed");
  });

  it("refuses a snapshot when a codec or a schema will not take a value, and names the field", () => {
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
    expect(date.message).toContain('"fld/Card.when" holds a value its codec');
    // A level the schema does not allow, which the compiler cannot see.
    const level = refused({ profile: { ...card(1).profile, level: 100 } })!;
    expect(level.problem).toBe("cannot be saved");
    expect(level.message).toContain('"fld/Card.profile"');
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
      when: Field.ref(strict),
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
    const Note = Component.define("fld/Note", { v: Field.json<JsonValue>() });
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
    const Note = Component.define("fld/Note", { v: Field.json<JsonValue>() });
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

describe("a field that holds an object", () => {
  it("holds in a json field only what JSON holds, refused where the field is made", () => {
    const Notes = Component.define("fld/Notes", {
      tags: Field.json<{ tags: string[] }>(),
      // @ts-expect-error A Date comes back from JSON as text: it is a ref.
      when: Field.json<Date>(),
      // @ts-expect-error A Map comes back from JSON as an empty object.
      counts: Field.json<Map<string, number>>(),
      // @ts-expect-error JSON cannot write a function at all.
      call: Field.json<() => void>(),
    });
    expect(Notes.kinds).toEqual(["json", "json", "json", "json"]);
  });

  it("is read-only where it is read, and replaced with set", () => {
    const Tagged = Component.define("fld/Tagged", {
      tags: Field.json<{ tags: string[] }>(),
      labels: Field.ref(sets),
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
