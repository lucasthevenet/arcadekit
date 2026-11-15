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
  | "ref";

/**
 * A field of a component. `T` is the value you read and write, `C` is the
 * column type that stores it.
 */
export interface FieldDef<T, C> {
  readonly kind: FieldKind;
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
  /** Any JS value, stored in a plain array. Use for strings, objects, handles. */
  ref: <T>(): FieldDef<T, T[]> => field<T, T[]>("ref"),
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
    case "ref": {
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
  if (kind === "ref") {
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

/** @internal A reusable cursor over one row of a component's columns. */
export interface Accessor {
  _i: number;
  _bind(columns: Record<string, Column>): void;
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
  /** Tracked in the type so queries know which terms have row-aligned columns. */
  readonly storage: St;
  readonly isTag: boolean;
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

// The name is the runtime identity (serialization, netcode, debugging), so two
// components with the same name are a bug. Effect's Context has the same rule
// for service keys.
const registry = new Map<string, ComponentDef<any>>();
let nextId = 0;

/**
 * Builds a class with one getter/setter pair per field, each reading
 * `column[row]` directly. Generated with `new Function` so every property
 * access is static and the JIT can inline it. Environments with a strict CSP
 * would need a non-codegen fallback (see bench/accessors.ts for the cost).
 */
const makeAccessorClass = (
  name: string,
  fields: readonly string[]
): new () => Accessor => {
  const init = fields.map((_, i) => `this._c${i} = null;`).join(" ");
  const props = fields
    .map((f, i) => {
      const key = JSON.stringify(f);
      return `get [${key}]() { return this._c${i}[this._i] } set [${key}](v) { this._c${i}[this._i] = v }`;
    })
    .join("\n");
  const bind = fields
    .map((f, i) => `this._c${i} = cols[${JSON.stringify(f)}];`)
    .join(" ");
  const source = `return class {
    constructor() { this._i = 0; ${init} }
    ${props}
    _bind(cols) { ${bind} }
  }`;
  void name;
  return new Function(source)() as new () => Accessor;
};

const define = <S extends Schema, St extends Storage = "table">(
  name: string,
  schema: S,
  options?: { readonly storage?: St }
): ComponentDef<S, St> => {
  if (registry.has(name)) {
    throw new Error(
      `Component "${name}" is already defined. Component names must be unique.`
    );
  }
  const fields = Object.keys(schema);
  const def: ComponentDef<S, St> = {
    id: nextId++,
    name,
    schema,
    fields,
    kinds: Object.values(schema).map((fieldDef) => fieldDef.kind),
    storage: (options?.storage ?? "table") as St,
    isTag: fields.length === 0,
    of: (value) => ({ def, value }),
    Accessor: makeAccessorClass(name, fields),
  };
  registry.set(name, def);
  return def;
};

export const Component = {
  /** Define a data component. Numeric fields become typed-array columns. */
  define,
  /** Define a component with no data, used only for filtering. */
  tag: <St extends Storage = "table">(
    name: string,
    options?: { readonly storage?: St }
  ): ComponentDef<{}, St> => define(name, {}, options),
  /** Look a component up by name (for save games, netcode, tooling). */
  byName: (name: string): ComponentDef<any> | undefined => registry.get(name),
};
