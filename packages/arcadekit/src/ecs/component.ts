/**
 * Component and field definitions.
 *
 * No Effect dependency: this file and world.ts are the storage core and are
 * plain synchronous TypeScript on purpose.
 */

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** An entity is a 32-bit number: 22 bits of index, 10 bits of generation. */
export type Entity = number & { readonly _brand: "Entity" };

export const INDEX_BITS = 22;
export const INDEX_MASK = (1 << INDEX_BITS) - 1;
export const GENERATION_MASK = (1 << (32 - INDEX_BITS)) - 1;

export const entityIndex = (entity: Entity): number => entity & INDEX_MASK;
export const entityGeneration = (entity: Entity): number =>
  entity >>> INDEX_BITS;
export const makeEntity = (index: number, generation: number): Entity =>
  ((((generation & GENERATION_MASK) << INDEX_BITS) | index) >>> 0) as Entity;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

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
 * The three kinds whose values are not numbers. They are kept in a plain
 * array, one value per row, and each says what a snapshot and the hash do
 * with it:
 *
 * - `json`: plain data, saved and hashed as it is.
 * - `ref`: any value, saved and hashed through a codec.
 * - `transient`: not saved and not hashed.
 */
export const isBoxed = (kind: FieldKind): boolean =>
  kind === "json" || kind === "ref" || kind === "transient";

/**
 * How the values of a `ref` field are turned into plain data and back.
 * `encode` gives something JSON can write, and `decode` takes what JSON
 * read back. Either may throw for a value it will not take.
 */
export interface RefCodec<T> {
  readonly encode: (value: T) => unknown;
  readonly decode: (data: unknown) => T;
}

/**
 * A field of a component. `T` is the value you read and write, `C` is the
 * column type that stores it.
 */
export interface FieldDef<T, C> {
  readonly kind: FieldKind;
  /** Present on a `ref` field. */
  readonly codec?: RefCodec<T>;
  readonly _T?: T;
  readonly _C?: C;
}

const field = <T, C>(kind: FieldKind): FieldDef<T, C> => ({ kind });

export const Field = {
  f32: field<number, Float32Array>("f32"),
  f64: field<number, Float64Array>("f64"),
  i32: field<number, Int32Array>("i32"),
  u32: field<number, Uint32Array>("u32"),
  u16: field<number, Uint16Array>("u16"),
  u8: field<number, Uint8Array>("u8"),
  entity: field<Entity, Uint32Array>("entity"),
  /**
   * Plain data: text, a number, a boolean, a bigint, null or undefined, or
   * an array or object made of text, numbers, booleans and null. It is
   * saved in a snapshot and counted in the hash. An array or an object is
   * saved and hashed as the text `JSON.stringify` gives for it, so it comes
   * back as what `JSON.parse` makes of that text.
   */
  json: <T>(): FieldDef<T, T[]> => field<T, T[]>("json"),
  /**
   * Any value at all, with a codec that turns it into plain data and back:
   * a Date, a Map, an instance of a class. It is saved in a snapshot and
   * counted in the hash in its encoded form, so it is encoded once per
   * value for every hash.
   */
  ref: <T>(codec: RefCodec<T>): FieldDef<T, T[]> => ({ kind: "ref", codec }),
  /**
   * A value that is not part of the game's state: a handle, a cache,
   * something another system can make again. It is not saved and not
   * hashed, and is undefined in a world loaded from a snapshot.
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
  | any[];

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
    case "u32":
    case "entity": {
      return new Uint32Array(capacity);
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
    const from = old as any[];
    const to = next as any[];
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

export type Schema = Record<string, FieldDef<any, any>>;

/** The plain-object shape of a component: `{ x: number, y: number }`. */
export type ValueOf<S extends Schema> = {
  -readonly [K in keyof S]: S[K] extends FieldDef<infer T, any> ? T : never;
};

/** The column shape of a component: `{ x: Float32Array, y: Float32Array }`. */
export type ColumnsOf<S extends Schema> = {
  readonly [K in keyof S]: S[K] extends FieldDef<any, infer C> ? C : never;
};

export type Storage = "table" | "sparse";

/**
 * What becomes of a relation when the entity it points at is despawned:
 * the entity that holds it is despawned too, or the relation is removed
 * from it.
 */
export type OnTargetDespawn = "despawn" | "remove";

/**
 * A column that is read and not written: a relation's `target`, which the
 * world keeps track of and so has to be told of every change to.
 */
export interface ReadonlyColumn<T> {
  readonly [index: number]: T;
  readonly length: number;
}

/** The fields of a relation: its target, then any of its own. */
export type RelationSchema<S extends Schema> = {
  readonly target: FieldDef<Entity, ReadonlyColumn<Entity>>;
} & S;

/** @internal What an accessor that notices writes tells: `ChangeLog` in world.ts. */
export interface WriteLog {
  /** Per entity index: 1 when the entity is noted already. */
  noted: Uint8Array;
  note(index: number): void;
}

/** @internal A reusable cursor over one row of a component's columns. */
export interface Accessor {
  _i: number;
  /**
   * `entities` and `log` are for an accessor that notices writes: the entity
   * of each row (ids for a table, indexes for a sparse set), and where a
   * write is noted.
   */
  _bind(
    columns: Record<string, Column>,
    entities?: Uint32Array,
    log?: WriteLog
  ): void;
}

export interface ComponentDef<
  S extends Schema = Schema,
  St extends Storage = Storage,
> {
  readonly id: number;
  readonly name: string;
  readonly schema: S;
  readonly fields: readonly string[];
  readonly kinds: readonly FieldKind[];
  /** Per field: the codec of a `ref` field, undefined for any other. */
  readonly codecs: readonly (RefCodec<any> | undefined)[];
  /** Tracked in the type so queries know which terms have row-aligned columns. */
  readonly storage: St;
  readonly isTag: boolean;
  /**
   * True for the fields of a singleton, which the world holds one of and no
   * entity has: see `Component.singleton`.
   */
  readonly single: boolean;
  /**
   * For a relation, what becomes of it when its target is despawned;
   * undefined for any other component. See `Component.relation`.
   */
  readonly relation: OnTargetDespawn | undefined;
  /** Pair this component with a value, for `spawn` and `add`. */
  readonly of: (value: ValueOf<S>) => ComponentValue<S>;
  /** @internal */
  readonly Accessor: new () => Accessor;
}

export interface ComponentValue<S extends Schema = Schema> {
  readonly def: ComponentDef<S>;
  readonly value: ValueOf<S>;
}

/** What `spawn` and `add` accept: a value, or a bare component (zeroed / tag). */
export type ComponentInput = ComponentValue<any> | ComponentDef<any>;

export const isComponentDef = (u: ComponentInput): u is ComponentDef<any> =>
  "id" in u;

/**
 * One instance of some data per world: whose turn it is, the score, the
 * level being played. `world.singleton(spec)` gives the value, which is
 * read and written like an object and is the world's: saved in a snapshot,
 * counted in the hash, and put back when a transaction is rolled back.
 *
 * Any object with this shape works; the Effect layer supplies a yieldable
 * one.
 */
export interface SingletonSpec<S extends Schema = Schema> {
  /** The singleton's name and fields, in the form of a component. */
  readonly component: ComponentDef<S>;
  /** What it holds in a world that has not written it. */
  readonly initial: ValueOf<S>;
}

/** What an app is told of, so that a save which names it can be read. */
export type Listed = ComponentDef<any> | SingletonSpec<any>;

export const isSingletonSpec = (u: Listed): u is SingletonSpec<any> =>
  "initial" in u;

// A component's name is its identity in a save, on the network and in a tool.
// A world keeps the names of the components it stores and refuses two with one
// name (see `World.register`), so nothing here is shared between worlds. The
// id is only a number that tells definitions apart; it is never saved or
// compared between processes.
let nextId = 0;

/**
 * Builds a class with one getter/setter pair per field, each reading
 * `column[row]` directly. Generated with `new Function` so every property
 * access is static and the JIT can inline it. Environments with a strict CSP
 * would need a non-codegen fallback (see bench/accessors.ts for the cost).
 */
const makeAccessorClass = (
  fields: readonly string[],
  noticing = false,
  relation?: string
): new () => Accessor => {
  const init = fields.map((_, i) => `this._c${i} = null;`).join(" ");
  // An accessor that notices writes tells the log which entity it wrote,
  // by index. The log keeps one entry per entity until a reader has been.
  // The check `note` starts with is written out here, so that a row which
  // is noted already costs a few reads and a comparison, and no call.
  // Measured, 1.3 ns an assignment. `noted` is read through the log each
  // time: the log replaces it when it grows.
  const note = noticing
    ? `; const k = this._e[this._i] & ${INDEX_MASK}; if (this._l.noted[k] !== 1) this._l.note(k)`
    : "";
  const props = fields
    .map((f, i) => {
      const key = JSON.stringify(f);
      // A relation's target is the world's to change.
      const set =
        relation !== undefined && f === "target"
          ? `throw new Error(${JSON.stringify(retarget(relation))})`
          : `this._c${i}[this._i] = v${note}`;
      return `get [${key}]() { return this._c${i}[this._i] } set [${key}](v) { ${set} }`;
    })
    .join("\n");
  const bind = fields
    .map((f, i) => `this._c${i} = cols[${JSON.stringify(f)}];`)
    .join(" ");
  const source = noticing
    ? `return class {
    constructor() { this._i = 0; this._e = null; this._l = null; ${init} }
    ${props}
    _bind(cols, ents, log) { ${bind} this._e = ents; this._l = log; }
  }`
    : `return class {
    constructor() { this._i = 0; ${init} }
    ${props}
    _bind(cols) { ${bind} }
  }`;
  return new Function(source)() as new () => Accessor;
};

/** What to do instead of writing a relation's target. */
export const retarget = (name: string): string =>
  `"${name}" is a relation, and its target is not written like a field: the world keeps track of who points at whom. Give it another target by adding it again, with add(entity, ${name.split("/").pop()}.of({ target })) on Commands or on the world.`;

// Made the first time a world watches the component for changes, and kept:
// it is code, not state, so worlds can share it.
const noticingClasses = new WeakMap<ComponentDef<any>, new () => Accessor>();

/**
 * The accessor class of a component whose writes are noticed: as
 * `def.Accessor`, and every setter also notes the entity it wrote.
 * @internal
 */
export const noticingAccessor = (
  def: ComponentDef<any>
): new () => Accessor => {
  let made = noticingClasses.get(def);
  if (made === undefined) {
    made = makeAccessorClass(
      def.fields,
      true,
      def.relation === undefined ? undefined : def.name
    );
    noticingClasses.set(def, made);
  }
  return made;
};

const define = <S extends Schema, St extends Storage = "table">(
  name: string,
  schema: S,
  options?: {
    readonly storage?: St;
    readonly single?: boolean;
    readonly relation?: OnTargetDespawn;
  }
): ComponentDef<S, St> => {
  const fields = Object.keys(schema);
  const def: ComponentDef<S, St> = {
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
    of: (value) => ({ def, value }),
    Accessor: makeAccessorClass(
      fields,
      false,
      options?.relation === undefined ? undefined : name
    ),
  };
  return def;
};

export const Component = {
  /** Define a data component. Numeric fields become typed-array columns. */
  define: <S extends Schema, St extends Storage = "table">(
    name: string,
    schema: S,
    options?: { readonly storage?: St }
  ): ComponentDef<S, St> => define(name, schema, options),
  /**
   * Define a singleton: data the world holds one of, with the value it has
   * until it is written. Its name is one of the world's component names.
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
   * Define a relation: a component that points at another entity, its
   * `target`, and is kept correct when that entity is despawned.
   *
   *   const ChildOf = Component.relation("scene/ChildOf", { onTargetDespawn: "despawn" })
   *   world.spawn(Position.of({ x: 0, y: 0 }), ChildOf.of({ target: parent }))
   *
   * `onTargetDespawn` says what a target's despawn does to whoever points
   * at it: `"despawn"` takes them with it (a parent and its children),
   * `"remove"` takes the relation off them (a target, an owner). Either
   * way nothing is left pointing at an entity that is gone.
   *
   * `fields` are fields of the relation's own, beside `target`.
   */
  relation: <S extends Schema = {}, St extends Storage = "table">(
    name: string,
    options: {
      readonly onTargetDespawn: OnTargetDespawn;
      readonly storage?: St;
      readonly fields?: S;
    }
  ): ComponentDef<RelationSchema<S>, St> =>
    define<RelationSchema<S>, St>(
      name,
      {
        target: Field.entity,
        ...options.fields,
      } as unknown as RelationSchema<S>,
      options.storage === undefined
        ? { relation: options.onTargetDespawn }
        : { storage: options.storage, relation: options.onTargetDespawn }
    ),
  /** Define a component with no data, used only for filtering. */
  tag: <St extends Storage = "table">(
    name: string,
    options?: { readonly storage?: St }
  ): ComponentDef<{}, St> => define(name, {}, options),
};
