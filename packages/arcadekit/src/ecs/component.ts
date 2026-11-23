/**
 * Component and field definitions.
 *
 * No Effect dependency: this file and world.ts are the storage core, and are
 * plain synchronous TypeScript by design.
 */
import type { Spawned } from "./spawned";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * An entity id, an integer below 2^53: the low 22 bits are its index, the slot
 * it occupies, and the bits above are its generation, which counts how many
 * times the slot was reused before. A reused slot gets the next generation, so
 * an id held across the reuse refers to no entity.
 *
 * The generation has 31 bits. A slot reused every tick at sixty ticks a second
 * lasts over a year, and once its generations run out it is retired, so an id
 * never refers to any entity but its own.
 *
 * An id is an ordinary number. It is stored in arrays of 64-bit floats, which
 * hold every integer below 2^53 exactly, and is an integer in JSON.
 *
 * **Gotchas**
 *
 * - A world holds at most 4,194,304 entities at a time, which is what 22 bits
 *   of index allow. A spawn beyond that throws.
 * - Store ids in a `Float64Array`. A `Uint32Array` truncates the id of an
 *   entity whose slot was reused more than 1,023 times, and keeps the remainder
 *   as if it were a valid id.
 * - Read the two parts with `entityIndex` and `entityGeneration`: a bit shift
 *   only sees 32 bits.
 *
 * @category Models
 */
export type Entity = number & { readonly _brand: "Entity" };

export const INDEX_BITS = 22;
export const INDEX_MASK = (1 << INDEX_BITS) - 1;
/** The number of indexes: what an id's generation is multiplied by. */
const INDEX_RANGE = 2 ** INDEX_BITS;
/**
 * The number of generations a slot has, from 0 up to this minus one. Once a
 * slot's last generation is used, the slot is retired.
 */
export const GENERATIONS = 2 ** (53 - INDEX_BITS);

// `&` takes a number's low 32 bits, whatever is above them: the index.
/**
 * Returns an entity's index: its slot in the world, which a successor reuses
 * after the entity is despawned.
 *
 * @category Utilities
 */
export const entityIndex = (entity: Entity): number => entity & INDEX_MASK;
/**
 * Returns an entity's generation: how many entities held its index before it,
 * which distinguishes it from them.
 *
 * @category Utilities
 */
export const entityGeneration = (entity: Entity): number =>
  Math.floor(entity / INDEX_RANGE);
export const makeEntity = (index: number, generation: number): Entity =>
  (generation * INDEX_RANGE + index) as Entity;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * How a field is stored: a typed array of numbers, an entity, or a value of any
 * type.
 *
 * @category Models
 */
export type FieldKind =
  | "f32"
  | "f64"
  | "i32"
  | "u32"
  | "u16"
  | "u8"
  | "entity"
  | "json"
  | "ref"
  | "transient";

/**
 * Returns whether a field type holds non-numeric values. Such values are stored
 * in a plain array, one per row, and each type defines what snapshots and the
 * hash do with them:
 *
 * - `json`: plain data, saved and hashed as is.
 * - `ref`: any value, saved and hashed through a codec.
 * - `transient`: neither saved nor hashed.
 */
export const isBoxed = (kind: FieldKind): boolean =>
  kind === "json" || kind === "ref" || kind === "transient";

/**
 * Converts the values of a `ref` field to plain data and back. `encode` returns
 * something JSON can serialize, and `decode` takes what JSON parsed back.
 * Either may throw for a value it rejects.
 *
 * @category Models
 */
export interface RefCodec<T> {
  // Methods, so that a codec of any value is a `RefCodec<unknown>`.
  encode(value: T): unknown;
  decode(data: unknown): T;
}

/**
 * A field of a component. `T` is the value you read and write, and `C` the
 * column type that stores it.
 *
 * @category Models
 */
export interface FieldDef<T, C> {
  readonly kind: FieldKind;
  /** Present on a `ref` field. */
  readonly codec?: RefCodec<T>;
  readonly _T?: T;
  readonly _C?: C;
}

const field = <T, C>(kind: FieldKind): FieldDef<T, C> => ({ kind });

/**
 * The field types a component is made of. Numbers go in typed arrays; any other
 * field type defines what snapshots and the hash do with it.
 *
 * @category Fields
 */
export const Field = {
  f32: field<number, Float32Array>("f32"),
  f64: field<number, Float64Array>("f64"),
  i32: field<number, Int32Array>("i32"),
  u32: field<number, Uint32Array>("u32"),
  u16: field<number, Uint16Array>("u16"),
  u8: field<number, Uint8Array>("u8"),
  entity: field<Entity, Float64Array>("entity"),
  /**
   * Plain data: a string, number, boolean, bigint, null or undefined, or an
   * array or object of strings, numbers, booleans and null. It is saved in
   * snapshots and included in the hash. An array or an object is saved and
   * hashed as its `JSON.stringify` text, so it is loaded as whatever
   * `JSON.parse` makes of that text.
   */
  json: <T>(): FieldDef<T, T[]> => field<T, T[]>("json"),
  /**
   * Any value, with a codec that converts it to plain data and back: a Date, a
   * Map, a class instance. Snapshots and the hash use its encoded form, so it
   * is encoded once per value on every hash.
   */
  ref: <T>(codec: RefCodec<T>): FieldDef<T, T[]> => ({ kind: "ref", codec }),
  /**
   * A value that isn't part of the game's state, such as a handle, a cache, or
   * something another system can recreate. It is neither saved nor hashed, and
   * is undefined in a world loaded from a snapshot.
   */
  transient: <T>(): FieldDef<T | undefined, (T | undefined)[]> =>
    field<T | undefined, (T | undefined)[]>("transient"),
};

export type Column =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | unknown[];

export const makeColumn = (kind: FieldKind, capacity: number): Column => {
  switch (kind) {
    case "f32": {
      return new Float32Array(capacity);
    }
    case "f64": {
      return new Float64Array(capacity);
    }
    case "i32": {
      return new Int32Array(capacity);
    }
    case "u32": {
      return new Uint32Array(capacity);
    }
    case "entity": {
      // An id is a whole number below 2^53, which a 64-bit float holds.
      return new Float64Array(capacity);
    }
    case "u16": {
      return new Uint16Array(capacity);
    }
    case "u8": {
      return new Uint8Array(capacity);
    }
    case "json":
    case "ref":
    case "transient": {
      return Array.from({ length: capacity }, () => undefined);
    }
  }
};

export const growColumn = (
  kind: FieldKind,
  old: Column,
  capacity: number
): Column => {
  const next = makeColumn(kind, capacity);
  if (isBoxed(kind)) {
    const from = old as unknown[];
    const to = next as unknown[];
    for (let i = 0; i < from.length; i++) {
      to[i] = from[i];
    }
  } else {
    (next as Float32Array).set(old as Float32Array);
  }
  return next;
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export type Schema = Record<string, FieldDef<unknown, unknown>>;

/**
 * The plain-object shape of a component: `{ x: number, y: number }`.
 *
 * @category Type-level
 */
export type ValueOf<S extends Schema> = {
  -readonly [K in keyof S]: S[K] extends FieldDef<infer T, unknown> ? T : never;
};

/** A field of a value given to `of`: an entity field takes a spawned id too. */
type InputField<T> = [T] extends [Entity] ? Entity | Spawned : T;

/**
 * The shape of the value a component's `of` takes: its `ValueOf`, where an
 * entity field takes an id that `Commands.spawn` returned as well.
 *
 * @category Type-level
 */
export type InputOf<S extends Schema> = {
  -readonly [K in keyof S]: S[K] extends FieldDef<infer T, unknown>
    ? InputField<T>
    : never;
};

/** The column shape of a component: `{ x: Float32Array, y: Float32Array }`. */
export type ColumnsOf<S extends Schema> = {
  readonly [K in keyof S]: S[K] extends FieldDef<unknown, infer C> ? C : never;
};

/** The columns of a component a query only reads: indexable, but not assignable. */
export type ReadonlyColumnsOf<S extends Schema> = {
  readonly [K in keyof S]: S[K] extends FieldDef<infer T, unknown>
    ? ReadonlyColumn<T>
    : never;
};

/**
 * What the type of a query term carries when the query only reads it. It exists
 * only in the type, and tells `each` and `eachChunk` to hand out something that
 * can't be assigned.
 */
export interface ReadOnlyTerm {
  readonly _reads: true;
}

/**
 * How a component is stored: in the tables of the entities that have it, or
 * `"sparse"`, in a set of its own, for a component that is added and removed
 * often.
 *
 * @category Models
 */
export type Storage = "table" | "sparse";

/**
 * What happens to a relation when its target entity is despawned: the entity
 * that holds it is despawned too, or the relation is removed from it.
 *
 * @category Models
 */
export type OnTargetDespawn = "despawn" | "remove";

/**
 * A read-only column: a relation's `target`, which the world tracks and so must
 * see every change to.
 *
 * @category Models
 */
export interface ReadonlyColumn<T> {
  readonly [index: number]: T;
  readonly length: number;
}

/** A relation's fields: its target, then any of its own. */
export type RelationSchema<S extends Schema> = {
  readonly target: FieldDef<Entity, ReadonlyColumn<Entity>>;
} & S;

/** @internal What an accessor that notices writes tells: `ChangeLog` in world.ts. */
export interface WriteLog {
  /** For each entity index, 1 when the entity is already recorded. */
  noted: Uint8Array;
  note(index: number): void;
}

/**
 * @internal The row a loop is at. The accessors a loop hands out read and
 * write that row of their columns, so moving the loop on is one assignment
 * here, however many components it visits.
 */
export interface Row {
  i: number;
}

/**
 * @internal What a query's loop is handed for one of its terms: an object
 * with a property per field, which reads and writes the row its loop is
 * at, and what points it at a table's columns.
 */
export interface Accessor {
  /** What `each` passes to its callback. It holds the fields and nothing else. */
  readonly fields: object;
  /**
   * Points the fields at a set of columns. `entities` and `log` are for an
   * accessor that records writes: the entity of each row (ids for a table,
   * indexes for a sparse set), and where a write is recorded.
   */
  bind(
    columns: Record<string, Column>,
    entities?: Uint32Array | Float64Array,
    log?: WriteLog
  ): void;
}

/**
 * @internal What an accessor does with an assignment: writes it; writes it
 * and notes whose row it was, for the queries that watch the component;
 * or refuses it, in a query that only reads the component or in a world
 * that is frozen.
 */
export type AccessorMode = "writes" | "notes" | "reads" | "frozen";

/**
 * @param S  the component's fields
 * @param St where its data is stored
 * @param N  its name. Two components can have the same fields, and the compiler distinguishes them by name: for example, to know which of a query's terms `Query.writes` was given. A name built at run time is just `string`, and such a component is indistinguishable from others.
 *
 * @category Models
 */
export interface ComponentDef<
  S extends Schema = Schema,
  St extends Storage = Storage,
  N extends string = string,
> {
  readonly id: number;
  readonly name: N;
  readonly schema: S;
  readonly fields: readonly string[];
  readonly kinds: readonly FieldKind[];
  /** For each field, the codec of a `ref` field, or undefined for any other. */
  readonly codecs: readonly (RefCodec<unknown> | undefined)[];
  /** Tracked in the type, so queries know which terms have row-aligned columns. */
  readonly storage: St;
  readonly isTag: boolean;
  /**
   * True for the fields of a singleton, which the world holds once and no
   * entity has: see `Component.singleton`.
   */
  readonly single: boolean;
  /**
   * For a relation, what happens to it when its target is despawned; undefined
   * for any other component. See `Component.relation`.
   */
  readonly relation: OnTargetDespawn | undefined;
  /**
   * The value of a component added or spawned bare, with no value: see
   * `Component.define`. Undefined for one whose bare value is all zeros.
   */
  readonly initial: Readonly<ValueOf<S>> | undefined;
  /**
   * Pairs this component with a value, for `spawn` and `add`. A method, so
   * that any component is a `ComponentDef`.
   */
  of(value: InputOf<S>): ComponentValue<S, N>;
}

/**
 * A component with its value, as `spawn` and `add` take it:
 * `Position.of({ x: 0, y: 0 })`.
 *
 * @category Models
 */
export interface ComponentValue<
  S extends Schema = Schema,
  N extends string = string,
> {
  readonly def: ComponentDef<S, Storage, N>;
  readonly value: InputOf<S>;
}

/**
 * What `spawn` and `add` accept: a value, or a bare component (zeroed, or a
 * tag).
 *
 * @category Type-level
 */
export type ComponentInput = ComponentValue | ComponentDef;

export const isComponentDef = (u: ComponentInput): u is ComponentDef =>
  "id" in u;

/**
 * Data that exists once per world, such as whose turn it is, the score, or the
 * current level. `world.singleton(spec)` returns the value, which you read and
 * write like an object, and which belongs to the world: saved in snapshots,
 * included in the hash, and restored when a transaction rolls back.
 *
 * Any object with this shape works; the Effect layer provides a yieldable one.
 *
 * @category Models
 */
export interface SingletonSpec<S extends Schema = Schema> {
  /** The singleton's name and fields, in the form of a component. */
  readonly component: ComponentDef<S>;
  /** Its value in a world that hasn't written it. */
  readonly initial: ValueOf<S>;
}

// A component's name is its identity in a save, on the network and in a tool.
// A world keeps the names of the components it stores and refuses two with one
// name (see `World.register`). The id is only a number that tells definitions
// apart; it is never saved or compared between processes.
let nextId = 0;

// Every component this program has defined, by name, so that a world can load
// a save that holds one it hasn't met yet. Of two definitions with one name, as
// a module that is loaded again under hot reload makes, it is the newer. A
// world that meets both refuses the second (see `World.register`).
const defined = new Map<string, ComponentDef>();

/**
 * Returns the component this program defined last with this name, or undefined
 * if it defined none.
 */
export const definedComponent = (name: string): ComponentDef | undefined =>
  defined.get(name);

/** Explains a failed attempt to change a frozen world. */
export const frozenWrite = (what: string): string =>
  `${what} was made while the world is frozen. A frozen world is read and not changed: an app freezes its world for the frame stage, which draws the game between two ticks, and for the input stage, which reads the devices before one. Change the game from a system that runs in the tick, or from outside with an action.`;

/** Explains what to do instead of writing a relation's target. */
export const retarget = (name: string): string =>
  `"${name}" is a relation, and its target is not written like a field: the world keeps track of who points at whom. Give it another target by adding it again, with add(entity, ${name.split("/").pop()}.of({ target })) on Commands or on the world.`;

/** Explains that a relation was given without a value, and so has no target. */
export const targetless = (def: ComponentDef): Error =>
  new Error(
    `"${def.name}" is a relation, and a relation needs a target: give it as ${def.name.split("/").pop()}.of({ target }).`
  );

// ---------------------------------------------------------------------------
// Accessors: what `each` hands its callback
// ---------------------------------------------------------------------------
//
// An accessor is an object with a getter and a setter per field, each a
// closure over the field's column and the row its loop is at. Nothing here
// is generated from text: a page whose Content Security Policy forbids
// `eval` and `new Function` runs it as it is.
//
// What makes that as fast as generated code is where an engine keeps what
// it learns. It learns per function as written in the source, not per
// closure made of it, and specialises a read of `column[row]` for the kinds
// of array it has seen there. So:
//
// - Every kind of column has its functions written out, below, seven times
//   over. One getter for every kind would meet every kind of array at one
//   place in the source, and past four an engine stops specialising: such
//   a getter measured 112 ns an entity in a program with seven kinds of
//   field, where these measure 10.
// - The getters and setters reach nothing through `this`. What they need
//   they close over: the column, in a variable that `bind` assigns, and
//   the row, in an object every loop has one of in the same shape.
// - The properties are defined on an object that is then made a prototype,
//   and the accessor is an empty object under it. An object given
//   accessor properties of its own, one closure after another, is turned
//   into a dictionary by V8 and read five times slower.
//
// Measured against classes generated with `new Function`, which this
// replaces, in `bench/accessors.ts`: 8.0 ns an entity against 6.7 with one
// callback in the program, 10.7 against 9.6 with seven, and 10.2 against
// 17.7 in a program of ten components. A generated class kept its row in a
// field of its own, and the loop that assigned it had by then met too many
// classes to know where the field was.

/** What an accessor that records writes was last bound to. */
interface Noting {
  /** A table's ids, or a sparse set's indexes. */
  entities: Uint32Array | Float64Array;
  log: WriteLog;
}

/**
 * Defines one field on `target` and returns a function that points it at a
 * column. `noting` is given for an accessor that records writes, and `refusal`,
 * what an assignment throws, for a read-only field.
 */
type DefineField = (
  target: object,
  name: string,
  row: Row,
  noting: Noting | undefined,
  refusal: string | undefined
) => (column: Column) => void;

const refuse = (message: string) => (): never => {
  throw new Error(message);
};

// The seven that follow differ in the type of `column` and in nothing
// else. They are not one function given the type: see above.

const defineF32: DefineField = (target, name, row, noting, refusal) => {
  let column = undefined as unknown as Float32Array;
  Object.defineProperty(target, name, {
    get: () => column[row.i],
    set:
      refusal !== undefined
        ? refuse(refusal)
        : noting === undefined
          ? (value: number) => {
              column[row.i] = value;
            }
          : (value: number) => {
              column[row.i] = value;
              // The log keeps one entry per entity until a reader has been.
              // The check `note` starts with is written out here, so that a
              // row which is noted already costs a few reads and a
              // comparison, and no call. `noted` is read through the log
              // each time: the log replaces it when it grows.
              const index = noting.entities[row.i]! & INDEX_MASK;
              if (noting.log.noted[index] !== 1) {
                noting.log.note(index);
              }
            },
  });
  return (to) => {
    column = to as Float32Array;
  };
};

const defineF64: DefineField = (target, name, row, noting, refusal) => {
  let column = undefined as unknown as Float64Array;
  Object.defineProperty(target, name, {
    get: () => column[row.i],
    set:
      refusal !== undefined
        ? refuse(refusal)
        : noting === undefined
          ? (value: number) => {
              column[row.i] = value;
            }
          : (value: number) => {
              column[row.i] = value;
              const index = noting.entities[row.i]! & INDEX_MASK;
              if (noting.log.noted[index] !== 1) {
                noting.log.note(index);
              }
            },
  });
  return (to) => {
    column = to as Float64Array;
  };
};

const defineI32: DefineField = (target, name, row, noting, refusal) => {
  let column = undefined as unknown as Int32Array;
  Object.defineProperty(target, name, {
    get: () => column[row.i],
    set:
      refusal !== undefined
        ? refuse(refusal)
        : noting === undefined
          ? (value: number) => {
              column[row.i] = value;
            }
          : (value: number) => {
              column[row.i] = value;
              const index = noting.entities[row.i]! & INDEX_MASK;
              if (noting.log.noted[index] !== 1) {
                noting.log.note(index);
              }
            },
  });
  return (to) => {
    column = to as Int32Array;
  };
};

const defineU32: DefineField = (target, name, row, noting, refusal) => {
  let column = undefined as unknown as Uint32Array;
  Object.defineProperty(target, name, {
    get: () => column[row.i],
    set:
      refusal !== undefined
        ? refuse(refusal)
        : noting === undefined
          ? (value: number) => {
              column[row.i] = value;
            }
          : (value: number) => {
              column[row.i] = value;
              const index = noting.entities[row.i]! & INDEX_MASK;
              if (noting.log.noted[index] !== 1) {
                noting.log.note(index);
              }
            },
  });
  return (to) => {
    column = to as Uint32Array;
  };
};

const defineU16: DefineField = (target, name, row, noting, refusal) => {
  let column = undefined as unknown as Uint16Array;
  Object.defineProperty(target, name, {
    get: () => column[row.i],
    set:
      refusal !== undefined
        ? refuse(refusal)
        : noting === undefined
          ? (value: number) => {
              column[row.i] = value;
            }
          : (value: number) => {
              column[row.i] = value;
              const index = noting.entities[row.i]! & INDEX_MASK;
              if (noting.log.noted[index] !== 1) {
                noting.log.note(index);
              }
            },
  });
  return (to) => {
    column = to as Uint16Array;
  };
};

const defineU8: DefineField = (target, name, row, noting, refusal) => {
  let column = undefined as unknown as Uint8Array;
  Object.defineProperty(target, name, {
    get: () => column[row.i],
    set:
      refusal !== undefined
        ? refuse(refusal)
        : noting === undefined
          ? (value: number) => {
              column[row.i] = value;
            }
          : (value: number) => {
              column[row.i] = value;
              const index = noting.entities[row.i]! & INDEX_MASK;
              if (noting.log.noted[index] !== 1) {
                noting.log.note(index);
              }
            },
  });
  return (to) => {
    column = to as Uint8Array;
  };
};

/** Defines a `json`, `ref` or `transient` field: a plain array, one value per row. */
const defineBoxed: DefineField = (target, name, row, noting, refusal) => {
  let column = undefined as unknown as unknown[];
  Object.defineProperty(target, name, {
    get: () => column[row.i],
    set:
      refusal !== undefined
        ? refuse(refusal)
        : noting === undefined
          ? (value: unknown) => {
              column[row.i] = value;
            }
          : (value: unknown) => {
              column[row.i] = value;
              const index = noting.entities[row.i]! & INDEX_MASK;
              if (noting.log.noted[index] !== 1) {
                noting.log.note(index);
              }
            },
  });
  return (to) => {
    column = to as unknown[];
  };
};

const DEFINE_FIELD: Readonly<Record<FieldKind, DefineField>> = {
  f32: defineF32,
  f64: defineF64,
  i32: defineI32,
  u32: defineU32,
  // An entity id is kept in the same kind of array as an `f64`.
  entity: defineF64,
  u16: defineU16,
  u8: defineU8,
  json: defineBoxed,
  ref: defineBoxed,
  transient: defineBoxed,
};

/**
 * Makes an accessor of a component for one loop: its fields read and write
 * the row that `row` says, of the columns it was last bound to.
 * @internal
 */
export const makeAccessor = (
  def: ComponentDef,
  mode: AccessorMode,
  row: Row
): Accessor => {
  const { fields, kinds, name } = def;
  const noting: Noting | undefined =
    mode === "notes"
      ? {
          entities: undefined as unknown as Float64Array,
          log: undefined as unknown as WriteLog,
        }
      : undefined;
  const target = {};
  const binders = fields.map((field, f) =>
    DEFINE_FIELD[kinds[f]!](
      target,
      field,
      row,
      noting,
      mode === "reads"
        ? `"${name}.${field}" was assigned to through a query that only reads "${name}". A query only reads its terms unless it names them with Query.writes: name "${name}" there to write it.`
        : mode === "frozen"
          ? frozenWrite(`An assignment to "${name}.${field}"`)
          : // A relation's target is the world's to change.
            def.relation !== undefined && field === "target"
            ? retarget(name)
            : undefined
    )
  );
  return {
    fields: Object.create(target) as object,
    bind(columns, entities, log) {
      for (let f = 0; f < binders.length; f++) {
        binders[f]!(columns[fields[f]!]!);
      }
      if (noting !== undefined) {
        noting.entities = entities!;
        noting.log = log!;
      }
    },
  };
};

const define = <
  S extends Schema,
  St extends Storage = "table",
  N extends string = string,
>(
  name: N,
  schema: S,
  options?: {
    readonly storage?: St;
    readonly single?: boolean;
    readonly relation?: OnTargetDespawn;
    readonly initial?: ValueOf<S>;
  }
): ComponentDef<S, St, N> => {
  const fields = Object.keys(schema);
  const def: ComponentDef<S, St, N> = {
    id: nextId++,
    name,
    schema,
    fields,
    kinds: Object.values(schema).map((fieldDef) => fieldDef.kind),
    codecs: Object.values(schema).map((fieldDef) => fieldDef.codec),
    storage: (options?.storage ?? "table") as St,
    isTag: fields.length === 0,
    single: options?.single === true,
    relation: options?.relation,
    initial: options?.initial,
    of: (value) => ({ def, value }),
  };
  defined.set(name, def as ComponentDef);
  return def;
};

/**
 * Defines components: data, a tag, or a relation to another entity.
 *
 * @category Constructors
 */
export const Component = {
  /**
   * Defines a data component. Numeric fields become typed-array columns.
   *
   * `name` is its identity in a world and in a save, prefixed with the feature
   * it belongs to: `"physics/Position"`. A world that encounters two different
   * components with the same name refuses the second. With `storage: "sparse"`,
   * it is stored in a set of its own, for a component that is added and removed
   * often or that few entities have.
   *
   * Added or spawned bare, with no value, a component is `initial`, or all
   * zeros without it: give `initial` to a component whose zeros are wrong, such
   * as a size, `{ initial: { x: 1, y: 1 } }`.
   */
  define: <
    const N extends string,
    S extends Schema,
    St extends Storage = "table",
  >(
    name: N,
    schema: S,
    options?: { readonly storage?: St; readonly initial?: ValueOf<S> }
  ): ComponentDef<S, St, N> => define(name, schema, options),
  /**
   * Defines a singleton: data the world holds once, with its value until it is
   * written. Its name is one of the world's component names. No entity has it:
   * spawning or adding it throws.
   */
  singleton: <S extends Schema>(
    name: string,
    schema: S,
    initial: ValueOf<S>
  ): SingletonSpec<S> => ({
    component: define(name, schema, { single: true }),
    initial,
  }),
  /**
   * Defines a relation: a component that points at another entity, its
   * `target`, and stays correct when that entity is despawned.
   *
   *   const ChildOf = Component.relation("scene/ChildOf", { onTargetDespawn: "despawn" })
   *   world.spawn(Position.of({ x: 0, y: 0 }), ChildOf.of({ target: parent }))
   *
   * `onTargetDespawn` sets what a target's despawn does to the entities
   * pointing at it: `"despawn"` despawns them too (a parent and its children),
   * and `"remove"` removes the relation from them (a target, an owner). Either
   * way, nothing is left pointing at a despawned entity.
   *
   * `fields` are the relation's own fields, alongside `target`, and are written
   * like any others. The target isn't:
   *
   * - To change it, add the relation again: `add(entity, ChildOf.of({ target
   *   }))`. Assigning to it, in `each` or with `set`, throws, and its raw
   *   column is typed as read-only.
   * - It must be alive. A relation without a target is refused at the call
   *   site. Given a target that is already gone, whatever that entity's despawn
   *   would have done happens at once: the holder is despawned, or the relation
   *   isn't added.
   * - An entity has one target per relation. For another kind of link, define
   *   another relation.
   */
  relation: <
    const N extends string,
    S extends Schema = {},
    St extends Storage = "table",
  >(
    name: N,
    options: {
      readonly onTargetDespawn: OnTargetDespawn;
      readonly storage?: St;
      readonly fields?: S;
    }
  ): ComponentDef<RelationSchema<S>, St, N> =>
    define<RelationSchema<S>, St, N>(
      name,
      {
        target: Field.entity,
        ...options.fields,
      } as unknown as RelationSchema<S>,
      options.storage === undefined
        ? { relation: options.onTargetDespawn }
        : { storage: options.storage, relation: options.onTargetDespawn }
    ),
  /** Defines a component with no data, used only for filtering. */
  tag: <const N extends string, St extends Storage = "table">(
    name: N,
    options?: { readonly storage?: St }
  ): ComponentDef<{}, St, N> => define(name, {}, options),
};
