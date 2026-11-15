import { describe, expect, it } from "vitest";

import {
  CommandBuffer,
  Component,
  EcsWorld,
  Field,
  Query,
  SnapshotError,
} from "../src/index";
import type { ComponentDef, Entity } from "../src/index";

// One component of every field kind, in a table and in a sparse set.
const kinds = {
  single: Field.f32,
  double: Field.f64,
  signed: Field.i32,
  unsigned: Field.u32,
  short: Field.u16,
  byte: Field.u8,
  other: Field.entity,
  note: Field.ref<unknown>(),
};
const define = (prefix: string) => ({
  Body: Component.define(`${prefix}/Body`, { x: Field.f32, y: Field.f32 }),
  Sheet: Component.define(`${prefix}/Sheet`, kinds),
  Marked: Component.tag(`${prefix}/Marked`),
  Aura: Component.define(`${prefix}/Aura`, kinds, { storage: "sparse" }),
  Chilled: Component.tag(`${prefix}/Chilled`, { storage: "sparse" }),
});
const C = define("snap");
const all = Object.values(C) as ComponentDef<any>[];

const notes: unknown[] = [
  "plain",
  "",
  "ünïcödé ✓ 日本語 🎲",
  0,
  -0,
  1.5,
  Number.NaN,
  Infinity,
  -Infinity,
  true,
  false,
  null,
  undefined,
  12_345_678_901_234_567_890n,
  -7n,
];
const sheet = (n: number) => ({
  single: n + 0.5,
  double: n + 0.25,
  signed: -n,
  unsigned: 3_000_000_000 + n,
  short: 60_000 + n,
  byte: 200 + (n % 50),
  other: n as Entity,
  note: notes[n % notes.length],
});

type Kit = ReturnType<typeof define>;

/**
 * Runs `steps` operations chosen by a seed against a world, and calls
 * `after` when each is done. The same seed does the same things to any
 * world that starts out the same.
 */
const play = (
  world: EcsWorld,
  kit: Kit,
  seed: number,
  steps: number,
  after: () => void = () => {}
): void => {
  const dice = new EcsWorld({ seed }).random;
  const commands = new CommandBuffer(world);
  const optional = Object.values(kit) as ComponentDef<any>[];
  let serial = seed * 1000;
  const valueFor = (def: ComponentDef<any>) =>
    def === kit.Body
      ? kit.Body.of({ x: ++serial, y: dice.next() })
      : def === kit.Sheet
        ? kit.Sheet.of(sheet(++serial))
        : def === kit.Aura
          ? kit.Aura.of(sheet(++serial))
          : def;
  for (let step = 0; step < steps; step++) {
    // Whatever is alive is read from the world, so that a world which was
    // loaded is played exactly like the one it was saved from.
    const alive = world.view(Query.all()).entities();
    const choice = alive.length === 0 ? 0 : dice.int(0, 7);
    const entity = alive.length === 0 ? undefined : dice.pick(alive);
    if (choice <= 1 || entity === undefined) {
      const inputs = optional
        .filter(() => dice.int(0, 1) === 1)
        .map((def) => valueFor(def));
      if (choice === 0) {
        world.spawn(...inputs);
      } else {
        commands.spawn(...inputs);
        commands.apply();
      }
    } else if (choice === 2) {
      world.despawn(entity);
    } else if (choice === 3 || choice === 4) {
      const def = dice.pick(optional);
      if (world.has(entity, def)) {
        world.remove(entity, def);
      } else {
        world.add(entity, valueFor(def));
      }
    } else if (choice === 5) {
      world.random.next();
    } else if (world.has(entity, kit.Body)) {
      world.set(entity, kit.Body, { x: dice.next() });
    } else {
      world.add(entity, valueFor(kit.Body));
    }
    after();
  }
};

/** Everything a game could read out of a world, entity by entity. */
const contents = (world: EcsWorld, kit: Kit) =>
  world
    .view(Query.all())
    .entities()
    .map((entity) => [
      entity,
      world.get(entity, kit.Body),
      world.get(entity, kit.Sheet),
      world.get(entity, kit.Aura),
      world.has(entity, kit.Marked),
      world.has(entity, kit.Chilled),
    ]);

const loaded = (bytes: Uint8Array, components = all): EcsWorld => {
  const world = new EcsWorld({ seed: 999 });
  world.load(bytes, components);
  return world;
};

describe("a snapshot of a world", () => {
  it("loads into an empty world that hashes the same and holds the same", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const world = new EcsWorld({ seed });
      play(world, C, seed, 300);
      const copy = loaded(world.snapshot());
      expect(copy.hash()).toBe(world.hash());
      expect(copy.entityCount).toBe(world.entityCount);
      expect(contents(copy, C)).toEqual(contents(world, C));
      expect(Array.from(copy.random.state)).toEqual(
        Array.from(world.random.state)
      );
      // The history really did despawn, reuse slots and empty tables.
      expect(world.entityCount).toBeGreaterThan(10);
    }
  });

  it("holds every kind of field, in tables and sparse sets, exactly", () => {
    const world = new EcsWorld({ seed: 3 });
    const entities = notes.map((_, n) => {
      const entity = world.spawn(
        C.Body.of({ x: n, y: -n }),
        C.Sheet.of(sheet(n))
      );
      world.add(entity, C.Aura.of(sheet(n + 3)));
      return entity;
    });
    world.set(entities[0]!, C.Sheet, {
      single: -0,
      double: -0,
      signed: -(2 ** 31),
      unsigned: 2 ** 32 - 1,
      short: 65_535,
      byte: 255,
    });
    world.set(entities[1]!, C.Sheet, {
      single: Number.NaN,
      double: Number.MIN_VALUE,
      signed: 2 ** 31 - 1,
    });
    const copy = loaded(world.snapshot());
    expect(copy.hash()).toBe(world.hash());
    for (const entity of entities) {
      const then = world.get(entity, C.Sheet)!;
      const now = copy.get(entity, C.Sheet)!;
      for (const field of C.Sheet.fields) {
        // Object.is tells 0 from -0, and takes NaN for NaN.
        expect(
          Object.is(
            now[field as keyof typeof now],
            then[field as keyof typeof then]
          ),
          `Sheet.${field} of ${entity}`
        ).toBe(true);
      }
      expect(copy.get(entity, C.Aura)).toEqual(world.get(entity, C.Aura));
    }
    expect(copy.get(entities[13]!, C.Sheet)!.note).toBe(
      12_345_678_901_234_567_890n
    );
  });

  it("gives a world that goes on exactly as the one it was taken from", () => {
    // Saved in the middle of a history, then both are played on with the
    // same moves: the same ids for new entities, the same order of
    // iteration, the same random numbers, at every step.
    for (const seed of [11, 12, 13]) {
      const world = new EcsWorld({ seed });
      play(world, C, seed, 200);
      const copy = loaded(world.snapshot());
      const original: unknown[] = [];
      const resumed: unknown[] = [];
      const record = (of: EcsWorld, into: unknown[]) => () => {
        into.push([
          of.hash(),
          of.view(Query.all(C.Body)).entities(),
          of.view(Query.all(C.Aura).pipe(Query.without(C.Chilled))).entities(),
        ]);
      };
      play(world, C, seed + 100, 200, record(world, original));
      play(copy, C, seed + 100, 200, record(copy, resumed));
      expect(resumed).toEqual(original);
      expect(copy.random.next()).toBe(world.random.next());
      expect(copy.spawn()).toBe(world.spawn());
    }
  });

  it("keeps despawned slots: stale ids stay dead and the next ids are the same", () => {
    const world = new EcsWorld();
    const first = world.spawn(C.Body.of({ x: 1, y: 1 }));
    const second = world.spawn(C.Body.of({ x: 2, y: 2 }));
    const third = world.spawn(C.Body.of({ x: 3, y: 3 }));
    world.despawn(second);
    world.despawn(first);
    const reborn = world.spawn(C.Marked);
    world.despawn(reborn);
    const copy = loaded(world.snapshot());
    expect(copy.hash()).toBe(world.hash());
    for (const stale of [first, second, reborn]) {
      expect(copy.isAlive(stale)).toBe(false);
    }
    expect(copy.isAlive(third)).toBe(true);
    expect(copy.get(third, C.Body)).toEqual({ x: 3, y: 3 });
    const next = [world.spawn(), world.spawn(), world.spawn()];
    expect([copy.spawn(), copy.spawn(), copy.spawn()]).toEqual(next);
  });

  it("keeps a table that has emptied in its place", () => {
    const world = new EcsWorld();
    const early = world.spawn(C.Body, C.Marked);
    world.remove(early, C.Marked);
    const copy = loaded(world.snapshot());
    expect(copy.hash()).toBe(world.hash());
    // The table of marked bodies was made first, so its entities come first.
    const marked = [world, copy].map((each) => each.spawn(C.Body, C.Marked));
    expect(copy.view(Query.all(C.Body)).entities()).toEqual(
      world.view(Query.all(C.Body)).entities()
    );
    expect(copy.view(Query.all(C.Body)).entities()[0]).toBe(marked[1]);
  });

  it("is as big as the data it holds, give or take a header", () => {
    const world = new EcsWorld();
    for (let n = 0; n < 10_000; n++) {
      world.spawn(C.Body.of({ x: n, y: n }));
    }
    // Per entity: 4 bytes of id, two floats of 4, and 2 of generation.
    const data = 10_000 * (4 + 4 + 4 + 2);
    const { length } = world.snapshot();
    expect(length).toBeGreaterThanOrEqual(data);
    expect(length).toBeLessThan(data + 200);
    expect(new EcsWorld().snapshot().length).toBeLessThan(64);
  });

  it("is a copy: the world can go on changing without changing it", () => {
    const world = new EcsWorld();
    const entity = world.spawn(C.Body.of({ x: 1, y: 1 }));
    const bytes = world.snapshot();
    const before = Uint8Array.from(bytes);
    world.set(entity, C.Body, { x: 9 });
    world.spawn(C.Sheet.of(sheet(1)));
    expect(bytes).toEqual(before);
    expect(loaded(bytes).get(entity, C.Body)).toEqual({ x: 1, y: 1 });
    // Taking a snapshot reads and changes nothing, in a transaction or out.
    const hash = world.hash();
    world.begin();
    world.set(entity, C.Body, { y: 5 });
    const inside = world.snapshot();
    world.rollback();
    expect(world.hash()).toBe(hash);
    expect(loaded(inside).get(entity, C.Body)).toEqual({ x: 9, y: 5 });
  });

  it("knows components by name, whatever order this program defined them in", () => {
    // The same components, defined again in another order: other ids.
    const other = {
      Chilled: Component.tag("snap/Chilled", { storage: "sparse" }),
      Aura: Component.define("snap/Aura", kinds, { storage: "sparse" }),
      Sheet: Component.define("snap/Sheet", kinds),
      Body: Component.define("snap/Body", { x: Field.f32, y: Field.f32 }),
      Marked: Component.tag("snap/Marked"),
    };
    const world = new EcsWorld({ seed: 6 });
    play(world, C, 6, 200);
    const copy = loaded(world.snapshot(), Object.values(other));
    expect(copy.hash()).toBe(world.hash());
    expect(copy.component("snap/Body")).toBe(other.Body);
    expect(contents(copy, other)).toEqual(contents(world, C));
    // Components given to load are known to the world, used or not.
    const empty = new EcsWorld();
    empty.load(new EcsWorld().snapshot(), [C.Body]);
    expect(empty.component("snap/Body")).toBe(C.Body);
    // Ones the world already knows need not be given again.
    const known = new EcsWorld();
    for (const def of all) {
      known.register(def);
    }
    known.load(world.snapshot());
    expect(known.hash()).toBe(world.hash());
  });
});

const problemOf = (run: () => unknown): SnapshotError => {
  try {
    run();
  } catch (error) {
    if (error instanceof SnapshotError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a SnapshotError");
};

describe("a snapshot that cannot be taken", () => {
  it("names the field that holds a value with no saved form", () => {
    for (const [value, what] of [
      [{ hp: 1 }, "an object"],
      [[1, 2], "an array"],
      [() => 1, "a function"],
      [Symbol("s"), "a symbol"],
      [new Map(), "an object"],
    ] as const) {
      const world = new EcsWorld();
      world.spawn(C.Sheet.of(sheet(1)));
      world.spawn(C.Sheet.of({ ...sheet(2), note: value }));
      const error = problemOf(() => world.snapshot());
      expect(error.problem).toBe("cannot be saved");
      expect(error.component).toBe("snap/Sheet");
      expect(error.message).toContain(`"snap/Sheet.note"`);
      expect(error.message).toContain(what);
      // The same in a sparse component.
      const sparse = new EcsWorld();
      sparse.add(sparse.spawn(), C.Aura.of({ ...sheet(2), note: value }));
      expect(problemOf(() => sparse.snapshot()).message).toContain(
        `"snap/Aura.note"`
      );
    }
  });

  it("is refused while a spawn is queued and not applied", () => {
    const world = new EcsWorld();
    const commands = new CommandBuffer(world);
    commands.spawn(C.Body);
    commands.spawn(C.Body);
    const error = problemOf(() => world.snapshot());
    expect(error.problem).toBe("cannot be saved");
    expect(error.message).toMatch(
      /2 entities were spawned through a CommandBuffer/
    );
    commands.apply();
    expect(loaded(world.snapshot()).entityCount).toBe(2);
  });
});

describe("a snapshot that cannot be loaded", () => {
  const sample = (): Uint8Array => {
    const world = new EcsWorld({ seed: 2 });
    play(world, C, 2, 60);
    return world.snapshot();
  };

  it("is refused by a world that is not empty", () => {
    const bytes = sample();
    const used = new EcsWorld();
    used.spawn(C.Body);
    expect(problemOf(() => used.load(bytes, all)).problem).toBe(
      "world not empty"
    );
    const emptied = new EcsWorld();
    emptied.despawn(emptied.spawn());
    expect(problemOf(() => emptied.load(bytes, all)).problem).toBe(
      "world not empty"
    );
    // An id handed out for a spawn that is still queued: no table yet.
    const reserved = new EcsWorld();
    new CommandBuffer(reserved).spawn(C.Body);
    expect(problemOf(() => reserved.load(bytes, all)).problem).toBe(
      "world not empty"
    );
    const busy = new EcsWorld();
    busy.begin();
    expect(problemOf(() => busy.load(bytes, all)).problem).toBe(
      "world not empty"
    );
    // A world that has only been asked questions is still empty.
    const asked = new EcsWorld();
    asked.view(Query.all(C.Body).pipe(Query.without(C.Chilled))).count();
    asked.load(bytes, all);
    expect(asked.entityCount).toBeGreaterThan(0);
  });

  it("names a component it holds that the program does not have", () => {
    const error = problemOf(() =>
      loaded(
        sample(),
        all.filter((def) => def !== C.Aura)
      )
    );
    expect(error.problem).toBe("unknown component");
    expect(error.component).toBe("snap/Aura");
    expect(error.message).toContain('"snap/Aura"');
  });

  it("names a component whose fields are not what they were, and says how", () => {
    const changed = (body: ComponentDef<any>) =>
      problemOf(() =>
        loaded(sample(), [...all.filter((def) => def !== C.Body), body])
      );
    const renamed = changed(
      Component.define("snap/Body", { x: Field.f32, z: Field.f32 })
    );
    expect(renamed.problem).toBe("component changed");
    expect(renamed.component).toBe("snap/Body");
    expect(renamed.message).toBe(
      '"snap/Body" is not what it was when the snapshot was taken. Then: table { x: f32, y: f32 }. Now: table { x: f32, z: f32 }.'
    );
    for (const body of [
      Component.define("snap/Body", { x: Field.f32, y: Field.f64 }),
      Component.define("snap/Body", { x: Field.f32 }),
      Component.define("snap/Body", {
        x: Field.f32,
        y: Field.f32,
        z: Field.f32,
      }),
      Component.define("snap/Body", { y: Field.f32, x: Field.f32 }),
      Component.define(
        "snap/Body",
        { x: Field.f32, y: Field.f32 },
        { storage: "sparse" }
      ),
    ]) {
      expect(changed(body).problem).toBe("component changed");
    }
  });

  it("is refused when the bytes are not a snapshot, or are from a newer format", () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array(3),
      new Uint8Array(64),
      new TextEncoder().encode("<html>not a save</html>"),
    ]) {
      expect(problemOf(() => loaded(bytes)).problem).toBe("not a snapshot");
    }
    const newer = sample();
    new DataView(newer.buffer).setUint32(4, 2, true);
    const error = problemOf(() => loaded(newer));
    expect(error.problem).toBe("newer format");
    expect(error.message).toMatch(/format 2, and this version reads format 1/);
  });

  it("is refused wherever it is cut short, without a crash", () => {
    const bytes = sample();
    for (let length = 0; length < bytes.length; length++) {
      const error = problemOf(() => loaded(bytes.subarray(0, length)));
      expect(["truncated", "not a snapshot", "corrupt"]).toContain(
        error.problem
      );
    }
    // And with something after its end.
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    expect(problemOf(() => loaded(longer)).problem).toBe("corrupt");
    // A view into a larger buffer loads as itself.
    const padded = new Uint8Array(bytes.length + 16);
    padded.set(bytes, 8);
    expect(loaded(padded.subarray(8, 8 + bytes.length)).hash()).toBe(
      loaded(bytes).hash()
    );
  });

  it("is refused or loaded when a byte is damaged, and never anything else", () => {
    // A damaged byte in the data loads as other data; a damaged count, name
    // or id is caught. Either way: a SnapshotError or a world, no other
    // exception, and no allocation the bytes could not back.
    const bytes = sample();
    const dice = new EcsWorld({ seed: 31 }).random;
    let refusedCount = 0;
    let loadedCount = 0;
    for (let round = 0; round < 1500; round++) {
      const damaged = Uint8Array.from(bytes);
      const at = round < bytes.length ? round : dice.int(0, bytes.length - 1);
      damaged[at] = damaged[at]! ^ (1 << dice.int(0, 7));
      if (round % 5 === 0) {
        damaged[dice.int(0, bytes.length - 1)] = dice.int(0, 255);
      }
      try {
        const world = loaded(damaged);
        // What loads is a world that works.
        world.hash();
        world.spawn(C.Body);
        loadedCount++;
      } catch (error) {
        expect(error).toBeInstanceOf(SnapshotError);
        refusedCount++;
      }
    }
    expect(refusedCount).toBeGreaterThan(50);
    expect(loadedCount).toBeGreaterThan(50);
  });

  it("is refused when its entities and freed slots do not add up", () => {
    // Four bodies in one table, the second and third despawned. The bytes
    // start: magic, format, four words of generator, the number of slots,
    // one generation of two bytes per slot, the number of freed slots, and
    // those slots in the order they will be reused.
    const world = new EcsWorld();
    const [a, b, c, d] = [0, 1, 2, 3].map((n) =>
      world.spawn(C.Body.of({ x: n, y: n }))
    );
    world.despawn(b!);
    world.despawn(c!);
    world.add(a!, C.Aura.of(sheet(1)));
    const bytes = world.snapshot();
    const slots = 24;
    const generations = slots + 4;
    const freed = generations + 4 * 2;
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(slots, true)).toBe(4);
    expect(view.getUint32(freed, true)).toBe(2);
    expect([
      view.getUint32(freed + 4, true),
      view.getUint32(freed + 8, true),
    ]).toEqual([1, 2]);
    /** Where two whole numbers stand side by side in the bytes. */
    const find = (first: number, second: number): number => {
      for (let at = freed + 12; at + 8 <= bytes.length; at++) {
        if (
          view.getUint32(at, true) === first &&
          view.getUint32(at + 4, true) === second
        ) {
          return at;
        }
      }
      throw new Error("not found");
    };
    const rows = find(a!, d!);
    // The sparse set comes last: its one member, the index of entity a,
    // then that member's eight fields (32 bytes, the note being an empty
    // string) and the four bytes that end a snapshot.
    const member = bytes.length - 4 - 32 - 4;
    expect(view.getUint32(member - 4, true)).toBe(1);
    expect(view.getUint32(member, true)).toBe(0);
    const damaged = (change: (view: DataView) => void): SnapshotError => {
      const copy = Uint8Array.from(bytes);
      change(new DataView(copy.buffer));
      return problemOf(() => loaded(copy));
    };
    expect(loaded(bytes).hash()).toBe(world.hash());

    const cases: [string, (view: DataView) => void][] = [
      ["a slot freed twice", (v) => v.setUint32(freed + 8, 1, true)],
      [
        "a freed slot that does not exist",
        (v) => v.setUint32(freed + 4, 9, true),
      ],
      [
        "a freed slot that holds an entity",
        (v) => v.setUint32(freed + 4, 0, true),
      ],
      [
        "a generation no entity could have",
        (v) => v.setUint16(generations + 2, 5000, true),
      ],
      ["an entity in two rows", (v) => v.setUint32(rows + 4, a!, true)],
      [
        "an entity of another generation",
        (v) => v.setUint32(rows, a! + (1 << 22), true),
      ],
      [
        "an entity in a slot that does not exist",
        (v) => v.setUint32(rows, 77, true),
      ],
      [
        "an entity in a freed slot",
        (v) => v.setUint32(rows + 4, 1 + (1 << 22), true),
      ],
      [
        "a sparse component on a freed slot",
        (v) => v.setUint32(member, 2, true),
      ],
      [
        "a sparse component on no slot at all",
        (v) => v.setUint32(member, 50, true),
      ],
    ];
    for (const [what, change] of cases) {
      const error = damaged(change);
      expect(error.problem, what).toBe("corrupt");
      expect(error.message, what).toMatch(/^The snapshot is damaged: /);
    }

    // One freed slot cut out of the list: a slot that is neither in a table
    // nor free, which no entity could ever be given.
    const shorter = new Uint8Array(bytes.length - 4);
    shorter.set(bytes.subarray(0, freed + 8));
    shorter.set(bytes.subarray(freed + 12), freed + 8);
    new DataView(shorter.buffer).setUint32(freed, 1, true);
    const lost = problemOf(() => loaded(shorter));
    expect(lost.problem).toBe("corrupt");
    expect(lost.message).toMatch(/neither in a table nor free/);
  });

  it("is refused when its text is not text", () => {
    const world = new EcsWorld();
    world.spawn(C.Sheet.of({ ...sheet(1), note: "abcdef" }));
    const bytes = world.snapshot();
    const text = new TextEncoder().encode("abcdef");
    const at = bytes.findIndex((_, i) =>
      text.every((byte, k) => bytes[i + k] === byte)
    );
    expect(at).toBeGreaterThan(0);
    // 0xff is a byte no UTF-8 text contains.
    bytes[at + 2] = 0xff;
    const error = problemOf(() => loaded(bytes));
    expect(error.problem).toBe("corrupt");
    expect(error.message).toMatch(/text that is not text/);
  });

  it("is refused when it claims more than its bytes could hold", () => {
    // An empty world's snapshot with its count of entity slots set to four
    // billion: refused before a single byte is allocated for them.
    const bytes = new EcsWorld().snapshot();
    const view = new DataView(bytes.buffer);
    view.setUint32(24, 0xffffffff, true);
    const started = performance.now();
    expect(problemOf(() => loaded(bytes)).problem).toBe("truncated");
    expect(performance.now() - started).toBeLessThan(50);
  });
});
