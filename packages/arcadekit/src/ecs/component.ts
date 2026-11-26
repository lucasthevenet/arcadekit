/**
 * Component and field definitions.
 *
 * No Effect dependency.
 */
import type { Column } from "./column.ts";
import type { Frozen, JsonValue } from "./frozen.ts";
import type { RelationSchema, RowOf, TargetField } from "./relation.ts";
import type { Spawned } from "./spawned.ts";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

declare const RefBrand: unique symbol;
declare const EntityBrand: unique symbol;

/**
 * An entity's id, an integer below 2^53 that packs two numbers. The low 22
 * bits are its index, the slot the entity occupies. The bits above are its
 * generation, which counts how many times the slot was used before. A reused
 * slot gets the next generation, so an id kept across the reuse refers to no
 * entity.
 *
 * The generation has 31 bits. A slot reused every tick, at sixty ticks a
 * second, lasts more than a year. Once its generations run out, the slot is
 * retired, so an id never refers to another entity.
 *
 * At run time an id is an ordinary number, and JSON writes it as an integer.
 * In the type it is not a number: it compares with `===` and keys a `Map` or
 * a `Set`, and no typed array, number field or arithmetic takes one, since a
 * `Uint32Array` or a bitwise operator would keep only its low 32 bits.
 *
 * **Gotchas**
 *
 * - A world holds at most 4,194,304 entities at a time, the range of a 22-bit
 *   index. A spawn beyond that throws.
 * - Keep an id in a component with `Field.entity` or a relation, and read its
 *   parts with `entityIndex` and `entityGeneration`.
 *
 * @category Models
 */
export type Entity = Entity.Ref & { readonly [EntityBrand]: true };

export declare namespace Entity {
  /**
   * An entity's id as a `Field.entity` keeps it, which may outlive its
   * entity. An `Entity` is a `Ref`, so a field takes one as it is, but a
   * `Ref` is not an `Entity`: no call of the world takes one. `world.live`
   * returns the entity a `Ref` refers to while it is alive.
   *
   *   const target = world.live(hunter.target)
   *   if (target !== undefined) world.get(target, Health)
   */
  export type Ref = { readonly [RefBrand]: true };
}

export const INDEX_BITS = 22;
export const INDEX_MASK = (1 << INDEX_BITS) - 1;
/** The number of indexes: what an id's generation is multiplied by. */
const INDEX_RANGE = 2 ** INDEX_BITS;
/**
 * The number of generations a slot has, from 0 up to this minus one. Once a
 * slot's last generation is used, the slot is retired.
 */
export const GENERATIONS = 2 ** (53 - INDEX_BITS);

// The one place an id and its number are converted, either way. The storage
// core keeps ids as numbers in `Float64Array`s.
/** @internal The number an id is at run time. */
export const idOf = (id: Entity.Ref | Spawned): number =>
  id as unknown as number;
/** @internal The entity whose id is this number, as a column of ids holds it. */
export const entityOf = (id: number): Entity => id as unknown as Entity;
/** @internal Whether a value is an id, which at run time is a number. */
export const isEntity = (value: unknown): value is Entity =>
  typeof value === "number";
/** @internal The entity a relation's value points at, placed by the time the world reads it. */
export const targetOf = (value: object): Entity =>
  (value as { readonly target: Entity }).target;
/** @internal The entity a `Spawned` id becomes, the same number. */
export const placedOf = (id: Entity | Spawned): Entity =>
  id as unknown as Entity;

// `&` takes a number's low 32 bits, whatever is above them: the index.
/**
 * Returns an entity's index, the slot it occupies in the world. Once the
 * entity is despawned, a new entity reuses the slot under the next
 * generation.
 *
 * @category Utilities
 */
export const entityIndex = (entity: Entity.Ref): number =>
  idOf(entity) & INDEX_MASK;
/**
 * Returns an entity's generation, the number of entities that held its index
 * before it. The generation tells the entity apart from them.
 *
 * @category Utilities
 */
export const entityGeneration = (entity: Entity.Ref): number =>
  Math.floor(idOf(entity) / INDEX_RANGE);
export const makeEntity = (index: number, generation: number): Entity =>
  entityOf(generation * INDEX_RANGE + index);

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * How a field is stored: a number in a typed array, an entity's id, or a
 * value of any type. `json`, `ref` and `transient` all hold any value, and
 * differ in what a snapshot and the hash do with it.
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
 * **Gotchas**
 *
 * - When `encode` throws, `World.snapshot` throws a `SnapshotError` whose
 *   problem is `"cannot be saved"` and names the field. `World.hash` throws
 *   the codec's own error.
 * - When `decode` throws, the load throws a `SnapshotError` whose problem is
 *   `"component changed"`.
 * - `World.hash` calls `encode` once for every value of the field.
 *
 * @category Models
 */
export interface RefCodec<T> {
  // Methods, so that a codec of any value is a `RefCodec<unknown>`.
  encode(value: T): unknown;
  decode(data: unknown): T;
}

/**
 * A field type, as `Field` gives them: how one field of a component is
 * stored, saved and hashed.
 *
 * @typeParam T the value a loop reads and writes
 * @typeParam C the column that stores the field's values
 *
 * @category Models
 */
export interface FieldDef<T, C> {
  /** How the field is stored. */
  readonly kind: FieldKind;
  /** The codec of a `ref` field, and undefined on any other. */
  readonly codec?: RefCodec<T>;
  /** Never set: it carries `T` in the type. */
  readonly _T?: T;
  /** Never set: it carries `C` in the type. */
  readonly _C?: C;
}

const field = <T, C>(kind: FieldKind): FieldDef<T, C> => ({ kind });

/**
 * The field types a component is made of. A number field is a column of a
 * typed array. Any other field type says what a snapshot and the hash do with
 * its values.
 *
 *   const Hero = Component.define("game/Hero", { hp: Field.i32, name: Field.json<string>() })
 *
 * **When to use**
 *
 * Use with `Component.define` and `Component.singleton`. In a game, the
 * `Field` module of `arcadekit` gives the same field types, and
 * `Field.schema` besides.
 *
 * @category Fields
 */
export const Field = {
  /** A 32-bit float, in a `Float32Array`. */
  f32: field<number, Float32Array>("f32"),
  /** A 64-bit float, in a `Float64Array`. */
  f64: field<number, Float64Array>("f64"),
  /** A signed 32-bit integer, in an `Int32Array`. */
  i32: field<number, Int32Array>("i32"),
  /** An unsigned 32-bit integer, in a `Uint32Array`. */
  u32: field<number, Uint32Array>("u32"),
  /** An unsigned 16-bit integer, in a `Uint16Array`. */
  u16: field<number, Uint16Array>("u16"),
  /** An unsigned 8-bit integer, in a `Uint8Array`. */
  u8: field<number, Uint8Array>("u8"),
  /**
   * An entity's id, in a `Float64Array`. It holds whatever id was written,
   * and is stale once its entity is despawned, so it reads as an
   * `Entity.Ref`, which `world.live` turns back into an `Entity`. For a
   * reference the world keeps correct, use `Component.relation`.
   */
  entity: field<Entity.Ref, WritableColumn<Entity.Ref>>("entity"),
  /**
   * Plain data: a string, number, boolean, bigint, null or undefined, or an
   * array or object of strings, numbers, booleans and null. It is saved in
   * snapshots and included in the hash. An array or an object is saved and
   * hashed as its `JSON.stringify` text, so it loads as whatever `JSON.parse`
   * makes of that text.
   */
  json: <T extends JsonValue>(): FieldDef<Frozen<T>, Frozen<T>[]> =>
    field<Frozen<T>, Frozen<T>[]>("json"),
  /**
   * Any value, such as a `Date`, a `Map` or a class instance, with a codec
   * that converts it to plain data and back. Snapshots and the hash use its
   * encoded form, so every hash encodes each value once.
   */
  ref: <T>(codec: RefCodec<T>): FieldDef<Frozen<T>, Frozen<T>[]> => ({
    kind: "ref",
    codec: codec as RefCodec<Frozen<T>>,
  }),
  /**
   * A value that isn't part of the game's state, such as a handle, a cache,
   * or something another system can rebuild. It is neither saved nor hashed,
   * and is undefined in a world loaded from a snapshot.
   */
  transient: <T>(): FieldDef<
    Frozen<T> | undefined,
    (Frozen<T> | undefined)[]
  > => field<Frozen<T> | undefined, (Frozen<T> | undefined)[]>("transient"),
};

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export type Schema = Record<string, FieldDef<unknown, unknown>>;

/**
 * A component's value as a plain object, with one property per field:
 * `{ x: number; y: number }` for `{ x: Field.f32, y: Field.f32 }`. `World.get`
 * returns one.
 *
 * @category Type-level
 */
export type ValueOf<S extends Schema> = {
  -readonly [K in keyof S]: S[K] extends FieldDef<infer T, unknown> ? T : never;
};

/** A field of a value given to `of`: an entity field takes a spawned id too. */
type InputField<T> = [T] extends [Entity.Ref] ? T | Spawned : T;

/**
 * The value a component's `of` takes. It is the component's `ValueOf`, except
 * that an entity field also takes a `Spawned` id, one that `Commands.spawn`
 * returned.
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
 * What the type of a query term carries when an entity may lack it. It exists
 * only in the type, and tells `each` and `eachChunk` to hand out `undefined`
 * for a table that doesn't have it.
 */
export interface MaybeTerm {
  readonly _maybe: true;
}

/** `undefined` for a term an entity may lack, and nothing for any other. */
export type Absent<T> = T extends MaybeTerm ? undefined : never;

/** What `each` hands out for each term: read-only for a term the query only reads, and a relation's `target` in any. */
export type AccessorsOf<D extends readonly ComponentDef[]> = {
  [K in keyof D]: D[K] extends ComponentDef<infer S extends Schema, Storage>
    ? (D[K] extends ReadOnlyTerm ? Readonly<RowOf<S>> : RowOf<S>) | Absent<D[K]>
    : never;
};

/**
 * What the type of a query term carries when the query also watches it for
 * writes. It exists only in the type, and takes `eachChunk` away from a query
 * that writes a term it watches.
 */
export interface WatchedTerm {
  readonly _watched: true;
}

/** The names of the terms a query both watches for writes and writes. */
type WatchedAndWritten<D extends readonly ComponentDef[]> = {
  [K in keyof D]: D[K] extends WatchedTerm
    ? D[K] extends ReadOnlyTerm
      ? never
      : D[K]["name"]
    : never;
}[number];

/**
 * What `eachChunk` asks of its view: any view, unless the query writes a term
 * it watches, which raw columns would count as a change at every visit.
 */
export type Chunked<D extends readonly ComponentDef[]> = [
  WatchedAndWritten<D>,
] extends [never]
  ? unknown
  : {
      readonly "eachChunk can't hand out a component the query watches and writes: visit it with each, or leave it out of Query.writes if the loop only reads it": WatchedAndWritten<D>;
    };

/**
 * Where a component's data is stored. `"table"` keeps it in the tables of the
 * entities that have it, one column per field. `"sparse"` keeps it in a set
 * of its own, so that adding or removing it doesn't move the entity to
 * another table.
 *
 * @category Models
 */
export type Storage = "table" | "sparse";

/**
 * What a relation does when its target is despawned. With `"despawn"`, the
 * entity that holds the relation is despawned too. With `"remove"`, the
 * relation is removed from it.
 *
 * @category Models
 */
export type OnTargetDespawn = "despawn" | "remove";

/**
 * A column that a loop reads and cannot assign. `eachChunk` hands one out for
 * each field of a term the query only reads, and for a relation's `target`,
 * since the world must see every change of target.
 *
 * @category Models
 */
export interface ReadonlyColumn<T> {
  readonly [index: number]: T;
  readonly length: number;
}

/**
 * A column that a loop reads and assigns, and no more. `eachChunk` hands one
 * out for a `Field.entity` of a term the query writes: its ids are numbers in
 * a `Float64Array`, which the type doesn't show, so that no number is taken
 * for an id.
 *
 * @category Models
 */
export interface WritableColumn<T> {
  [index: number]: T;
  readonly length: number;
}

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
  /**
   * Points the fields at columns that throw when read or written, once the
   * world's entities changed: kept, the accessor would read and write a row
   * that is now another entity's, or a column the table no longer uses.
   */
  retract(): void;
}

/**
 * @internal What an accessor does with an assignment: writes it; writes it
 * and notes whose row it was, for the queries that watch the component;
 * or refuses it, in a query that only reads the component or in a world
 * that is frozen.
 */
export type AccessorMode = "writes" | "notes" | "reads" | "frozen";

/**
 * A component's definition, as `Component.define`, `Component.tag` and
 * `Component.relation` return it. A query names it as a term, and
 * `Position.of({ x: 0, y: 0 })` pairs it with a value for `spawn` and `add`.
 *
 * @typeParam S its fields, by name
 * @typeParam St where its data is stored
 * @typeParam N its name. The compiler tells apart two components with the
 *   same fields by their names, for example to know which of a query's terms
 *   `Query.writes` was given. A name built at run time has the type `string`,
 *   and the compiler cannot tell such a component from another.
 *
 * @category Models
 */
export interface ComponentDef<
  S extends Schema = Schema,
  St extends Storage = Storage,
  N extends string = string,
  R extends string = string,
> {
  /** A number that tells definitions apart in this program. It is never saved. */
  readonly id: number;
  /** Its identity in a world and in a save, such as `"physics/Position"`. */
  readonly name: N;
  /** Its fields, as `Component.define` was given them. */
  readonly schema: S;
  /** The names of its fields, in the order they were defined. */
  readonly fields: readonly string[];
  /** How each field is stored, in the order of `fields`. */
  readonly kinds: readonly FieldKind[];
  /** For each field, the codec of a `ref` field, or undefined for any other. */
  readonly codecs: readonly (RefCodec<unknown> | undefined)[];
  /**
   * Where its data is stored. The type carries it too, so that a query knows
   * which of its terms are in the table's rows.
   */
  readonly storage: St;
  /** Whether it has no fields, as a tag has none. */
  readonly isTag: boolean;
  /**
   * Whether it is a singleton's, which the world holds once and no entity
   * has. See `Component.singleton`.
   */
  readonly single: boolean;
  /**
   * For a relation, what its target's despawn does to it, and undefined for
   * any other component. See `Component.relation`.
   */
  readonly relation: OnTargetDespawn | undefined;
  /**
   * Its value when it is added or spawned bare, with no value, and undefined
   * when that value is all zeros. See `Component.define`.
   */
  readonly initial: Readonly<ValueOf<S>> | undefined;
  /**
   * What a spawn or an add of it gives the entity beside it, when the entity
   * doesn't have it and the spawn doesn't give it: the components
   * `Component.define` was given as `requires`, and what they require. See
   * `Component.define`.
   */
  readonly requires: readonly ComponentInput[];
  /**
   * Holds no value. It carries the names of `requires`, in a tuple so that a
   * component that requires nothing has none, whatever the compiler's options.
   */
  readonly _requires?: readonly [R];
  /**
   * Pairs this component with a value, for `spawn` and `add`. It is a method,
   * so that a component of any fields is a `ComponentDef`.
   */
  of(value: InputOf<S>): ComponentValue<S, N, R>;
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
  R extends string = string,
> {
  /** The component. */
  readonly def: ComponentDef<S, Storage, N, R>;
  /** Its value. */
  readonly value: InputOf<S>;
}

/**
 * What `spawn` and `add` take: a component with its value, or a component
 * given bare. A bare component gets its `initial` value, or all zeros.
 *
 * @category Models
 */
export type ComponentInput = ComponentValue | ComponentDef;

export const isComponentDef = (u: ComponentInput): u is ComponentDef =>
  "id" in u;

/**
 * The names of the components a spawn or an add of a component gives the
 * entity beside it, at any depth: what it requires, and `never` for a
 * component that requires nothing. It reads a component or its value.
 *
 * @category Type-level
 */
export type RequiredOf<I> = I extends { readonly def: infer D }
  ? RequiredOf<D>
  : I extends { readonly _requires?: readonly [infer R extends string] }
    ? R
    : never;

type NameIn<I> = I extends { readonly def: { readonly name: infer N } }
  ? N & string
  : I extends { readonly name: infer N extends string }
    ? N
    : never;

/** A required component and what it requires, as one union of names. */
type Closed<I> = I extends unknown ? NameIn<I> | RequiredOf<I> : never;

/** What `requires` is told of a component it can't take, and `unknown` for one it can. */
type Requirable<I> = string extends NameIn<I> | RequiredOf<I>
  ? "A component requires components whose names the compiler reads, defined with a literal name. A singleton's is not one: no entity has it."
  : I extends
        | { readonly schema: { readonly target: TargetField } }
        | {
            readonly def: { readonly schema: { readonly target: TargetField } };
          }
    ? `"${NameIn<I>}" is a relation, and a requirement can't be one: there is no target to fill in. Give the relation at the spawn.`
    : unknown;

const defOf = (input: ComponentInput): ComponentDef =>
  isComponentDef(input) ? input : input.def;

// Of two requirements of one component, the later wins, and one given in
// `requires` beats one it inherits.
const closeRequires = (
  direct: readonly ComponentInput[]
): readonly ComponentInput[] => {
  const all = new Map<number, ComponentInput>();
  for (const input of direct) {
    const def = defOf(input);
    if (def.relation !== undefined || def.single) {
      throw new Error(
        `"${def.name}" can't be required: a relation has no target to fill in, and no entity has a singleton. Give a relation at the spawn.`
      );
    }
    for (const inherited of def.requires) {
      all.set(defOf(inherited).id, inherited);
    }
  }
  for (const input of direct) {
    all.set(defOf(input).id, input);
  }
  return [...all.values()];
};

/**
 * The definition of a singleton, data that exists once per world, such as the
 * score, whose turn it is or the current level. `Component.singleton` makes
 * one. `world.singleton(spec)` returns the world's value, an object whose
 * fields you read and write in place.
 *
 * The value belongs to the world. Once written, it is saved in snapshots,
 * included in the hash, and restored when a transaction rolls back.
 *
 * **When to use**
 *
 * Use with the storage core alone. In a game, `Singleton.define` from
 * `arcadekit` makes a definition that a system can also `yield*`. The world
 * takes any object of this shape.
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

/**
 * Refuses a relation's target given to `set`, which only a cast lets through:
 * an undefined, like any number not given, is left as it was.
 */
export const refuseRetarget = (def: ComponentDef, value: object): void => {
  if (
    def.relation !== undefined &&
    "target" in value &&
    value.target !== undefined
  ) {
    throw new Error(retarget(def.name));
  }
};

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

// A typed array ignores an index it doesn't have, so a retracted accessor's
// refusal is in its column, and the getters and setters check nothing.
const refusing = (message: string): Float32Array =>
  new Proxy(new Float32Array(0), {
    get: refuse(message),
    set: refuse(message),
  });

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
  let retracted: Column[] | undefined;
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
    retract() {
      retracted ??= fields.map((field) =>
        refusing(
          `"${name}.${field}" was used through an accessor that each() or single() handed out before the world's entities last changed. A spawn, a despawn, an add or a remove, and a restore or a rewind, can move an entity to another row, and the accessor would read and write another entity's. Read the entity again with world.get(entity, ${name.split("/").pop()}), or ask the query again. To change the world's entities while you hold an accessor, queue the change on Commands.`
        )
      );
      for (let f = 0; f < binders.length; f++) {
        binders[f]!(retracted[f]!);
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
    readonly requires?: readonly ComponentInput[];
  }
): ComponentDef<S, St, N, never> => {
  const fields = Object.keys(schema);
  const def: ComponentDef<S, St, N, never> = {
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
    requires:
      options?.requires === undefined ? [] : closeRequires(options.requires),
    of: (value) => ({ def, value }),
  };
  defined.set(name, def as ComponentDef);
  return def;
};

/**
 * A name the compiler reads, or the error that says to write one: a name known
 * only as `string` makes no component.
 *
 * @category Type-level
 */
export type LiteralName<N extends string> = N &
  (string extends N
    ? 'A component\'s name is a literal, "game/Hero"'
    : unknown);

/**
 * Defines components: a component with data, a tag, a relation to another
 * entity, or a singleton.
 *
 * **When to use**
 *
 * Use in a program of the storage core alone. In a game, the `Component`
 * module of `arcadekit` defines components, relations and tags, and
 * `Singleton.define` defines a singleton.
 *
 * @category Constructors
 */
export const Component = {
  /**
   * Defines a component with data. `Component.define` of `arcadekit` says
   * how.
   */
  define: <
    const N extends string,
    S extends Schema,
    St extends Storage = "table",
    const Req extends readonly ComponentInput[] = readonly [],
  >(
    name: LiteralName<N>,
    schema: S,
    options?: {
      readonly storage?: St;
      readonly initial?: ValueOf<S>;
      readonly requires?: {
        readonly [K in keyof Req]: Req[K] & Requirable<Req[K]>;
      };
    }
  ): ComponentDef<S, St, N, Closed<Req[number]>> =>
    define(name, schema, options),
  /**
   * Defines a singleton, data the world holds once, which has the value
   * `initial` until it is written. A world registers its name as a
   * component's, so no component of the world can share it. No entity has
   * it, and spawning or adding it throws.
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
   * Defines a relation, a component that points at another entity and stays
   * correct when that entity is despawned. `Component.relation` of
   * `arcadekit` says how.
   */
  relation: <
    const N extends string,
    S extends Schema = {},
    St extends Storage = "table",
  >(
    name: LiteralName<N>,
    options: {
      readonly onTargetDespawn: OnTargetDespawn;
      readonly storage?: St;
      readonly fields?: S;
    }
  ): ComponentDef<RelationSchema<S>, St, N, never> =>
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
  /**
   * Defines a tag, a component with no fields. `Component.tag` of `arcadekit`
   * says how.
   */
  tag: <
    const N extends string,
    St extends Storage = "table",
    const Req extends readonly ComponentInput[] = readonly [],
  >(
    name: LiteralName<N>,
    options?: {
      readonly storage?: St;
      readonly requires?: {
        readonly [K in keyof Req]: Req[K] & Requirable<Req[K]>;
      };
    }
  ): ComponentDef<{}, St, N, Closed<Req[number]>> => define(name, {}, options),
};
