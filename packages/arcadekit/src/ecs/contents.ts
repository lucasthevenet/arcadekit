/**
 * What a snapshot holds, apart from any world: read without the program's
 * component definitions, since a snapshot describes its own, and written
 * back. Migrations work on this form, to make an old save match the game's
 * current components.
 *
 * The format itself is in `format.ts`, which reads into these contents as
 * it reads into a world, and writes from them as it writes from one.
 *
 * No Effect dependency.
 */
import type { Column } from "./column";
import type { FieldKind } from "./component";
import { read, write } from "./format";
import type { Shape, SnapshotStore, TableSource, Target } from "./format";
import { STORAGES, corrupt } from "./snapshot";

/**
 * A component as a snapshot describes it: by name, with its fields.
 *
 * @category Models
 */
export interface SnapshotComponent {
  /** Its name, by which a world finds its definition. */
  name: string;
  /** Where its data is stored: in tables, in a sparse set, or as a single value for the world. */
  storage: "table" | "sparse" | "singleton";
  /** Its fields, each with its name and kind, in the order they were defined. */
  fields: { name: string; kind: FieldKind }[];
}

/**
 * One table of a snapshot: the components its entities have, and one row per
 * entity.
 *
 * @category Models
 */
export interface SnapshotTable {
  /** The names of the table's components. */
  components: string[];
  /** The id of the entity in each row. */
  entities: Float64Array;
  /** For each component name and field name, one value per row. */
  columns: Record<string, Record<string, Column>>;
}

/**
 * One sparse component of a snapshot: the entities that have it, and their
 * values.
 *
 * @category Models
 */
export interface SnapshotSparse {
  /** The component's name. */
  component: string;
  /** The index of each entity that has the component, and not its id. */
  members: Uint32Array;
  /** For each field name, one value per member. */
  columns: Record<string, Column>;
}

/**
 * One singleton of a snapshot: the world's value for it.
 *
 * @category Models
 */
export interface SnapshotSingleton {
  /** The singleton's name. */
  component: string;
  /** For each field name, a column holding the single value. */
  columns: Record<string, Column>;
}

/**
 * Everything a snapshot holds, read without the program's component
 * definitions, since a snapshot describes its own components. Migrations work
 * on this form, to make an old save match the game's current components.
 *
 * A `json` field's column holds the plain data itself. A `ref` field's column
 * holds each value as its codec encoded it. A `transient` field has no column.
 *
 * **When to use**
 *
 * Use to read or change a snapshot outside any world, as a migration does.
 * `readSnapshot` makes one, and `writeSnapshot` writes it back to bytes.
 *
 * @category Models
 */
export interface SnapshotContents {
  /** The random generator's state, four 32-bit words. */
  random: Uint32Array;
  /** One generation per entity slot. */
  generations: Uint32Array;
  /** The freed slots, in the order they will be reused. */
  freed: number[];
  /** The components the tables, sparse sets and singletons hold, in order of name. */
  components: SnapshotComponent[];
  /** In the order queries visit them. */
  tables: SnapshotTable[];
  /** The sparse components that some entity has. */
  sparse: SnapshotSparse[];
  /** The singletons that had been written. */
  singletons: SnapshotSingleton[];
  /**
   * What the world's stores held, for each store that held anything, in order
   * of name. In an app's world, they are the events waiting to be read, the
   * actions queued for the next tick, and what change queries had yet to
   * visit.
   */
  stores: SnapshotStore[];
}

const columnOf = (kind: FieldKind, count: number): Column => {
  switch (kind) {
    case "f32": {
      return new Float32Array(count);
    }
    case "f64": {
      return new Float64Array(count);
    }
    case "i32": {
      return new Int32Array(count);
    }
    case "u32": {
      return new Uint32Array(count);
    }
    case "entity": {
      return new Float64Array(count);
    }
    case "u16": {
      return new Uint16Array(count);
    }
    case "u8": {
      return new Uint8Array(count);
    }
    default: {
      return Array.from({ length: count }, () => undefined);
    }
  }
};

/** A component of some contents, as the format reads and writes it. */
interface Listed extends Shape {
  readonly component: SnapshotComponent;
}

const listed = (component: SnapshotComponent): Listed => ({
  name: component.name,
  fields: component.fields.map((field) => field.name),
  kinds: component.fields.map((field) => field.kind),
  component,
});

/** New columns for a component's saved fields, of `count` values each. */
const columnsFor = (
  { component }: Listed,
  count: number
): Record<string, Column> => {
  const columns: Record<string, Column> = {};
  for (const { kind, name } of component.fields) {
    if (kind !== "transient") {
      columns[name] = columnOf(kind, count);
    }
  }
  return columns;
};

/** Contents to read a snapshot into, and where the format puts each part. */
const reading = (): [SnapshotContents, Target<Listed>] => {
  const contents: SnapshotContents = {
    random: new Uint32Array(4),
    generations: new Uint32Array(0),
    freed: [],
    components: [],
    tables: [],
    sparse: [],
    singletons: [],
    stores: [],
  };
  const target: Target<Listed> = {
    random: contents.random,
    slots(count) {
      contents.generations = new Uint32Array(count);
      return contents.generations;
    },
    freed(indexes) {
      contents.freed = [...indexes];
    },
    component(name, code, names, kinds) {
      const storage = STORAGES[code];
      if (storage === undefined) {
        throw corrupt(
          "a component is kept in a way this version does not know"
        );
      }
      const fields: SnapshotComponent["fields"] = [];
      for (const [f, field] of names.entries()) {
        const kind = kinds[f];
        if (kind === undefined) {
          throw corrupt("a field is of a kind this version does not know");
        }
        fields.push({ name: field, kind });
      }
      const component: SnapshotComponent = { name, storage, fields };
      contents.components.push(component);
      return listed(component);
    },
    singleton(component) {
      const columns = columnsFor(component, 1);
      contents.singletons.push({ component: component.name, columns });
      return columns;
    },
    stores(stores) {
      contents.stores = stores;
    },
    table(components, count) {
      const table: SnapshotTable = {
        components: components.map((component) => component.name),
        entities: new Float64Array(count),
        columns: {},
      };
      contents.tables.push(table);
      return {
        entities: table.entities,
        placed() {},
        columns(component) {
          const columns = columnsFor(component, count);
          table.columns[component.name] = columns;
          return columns;
        },
      };
    },
    tabled() {},
    sparse(component, count) {
      const set: SnapshotSparse = {
        component: component.name,
        members: new Uint32Array(count),
        columns: columnsFor(component, count),
      };
      contents.sparse.push(set);
      return {
        members: set.members,
        placed() {},
        columns: () => set.columns,
      };
    },
    end() {},
  };
  return [contents, target];
};

/**
 * Reads a snapshot's bytes into its contents, without the program's component
 * definitions. Throws a `SnapshotError` when the bytes are not a snapshot,
 * are truncated or corrupt, or use a newer format.
 *
 * @category Codecs
 */
export const readSnapshot = (bytes: Uint8Array): SnapshotContents => {
  const [contents, target] = reading();
  read(bytes, target);
  return contents;
};

/**
 * Reads one singleton of a snapshot, as `readSnapshot` would, or undefined if
 * the snapshot doesn't hold it. From a snapshot of format 4, it reads none of
 * the entities.
 *
 * @internal
 */
export const readSingleton = (
  bytes: Uint8Array,
  component: string
): SnapshotSingleton | undefined => {
  const [contents, target] = reading();
  read(bytes, target, true);
  return contents.singletons.find((single) => single.component === component);
};

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const byComponent = (
  a: { component: string },
  b: { component: string }
): number => byName({ name: a.component }, { name: b.component });

/**
 * Writes contents back into a snapshot's bytes. It checks only that the
 * contents agree with themselves, and `World.load` checks the rest when it
 * reads the bytes.
 *
 * **Gotchas**
 *
 * It throws a `SnapshotError` whose problem is `"corrupt"` when the contents
 * disagree with themselves: a table, a sparse set or a singleton names a
 * component that `components` doesn't list, or a saved field has no column
 * of one value per row.
 *
 * @category Codecs
 */
export const writeSnapshot = (contents: SnapshotContents): Uint8Array => {
  const components = new Map<string, Listed>();
  for (const component of contents.components.toSorted(byName)) {
    if (components.has(component.name)) {
      throw corrupt(`it lists the component "${component.name}" twice`);
    }
    components.set(component.name, listed(component));
  }
  const named = (name: string): Listed => {
    const component = components.get(name);
    if (component === undefined) {
      throw corrupt(`it holds data for "${name}", which it does not list`);
    }
    return component;
  };
  /** The columns of a component's saved fields, each of `count` values. */
  const columnsOf = (
    { component }: Listed,
    columns: Record<string, Column> | undefined,
    count: number
  ): Record<string, Column> => {
    for (const { kind, name } of component.fields) {
      if (kind !== "transient" && columns?.[name]?.length !== count) {
        throw corrupt(
          `"${component.name}.${name}" has no column of ${count} values`
        );
      }
    }
    return columns ?? {};
  };

  const stores = contents.stores.toSorted(byName);
  for (const [i, store] of stores.entries()) {
    if (stores[i + 1]?.name === store.name) {
      throw corrupt(`it holds the store "${store.name}" twice`);
    }
  }
  return write<Listed, TableSource<Listed> & { readonly table: SnapshotTable }>(
    {
      estimate: 1024,
      random: contents.random,
      generations: contents.generations,
      slots: contents.generations.length,
      freed: contents.freed,
      components: [...components.values()],
      storage: ({ component }) => STORAGES.indexOf(component.storage),
      singletons: contents.singletons.toSorted(byComponent).map((single) => {
        const component = named(single.component);
        return { component, columns: columnsOf(component, single.columns, 1) };
      }),
      stores,
      tables: contents.tables.map((table) => {
        const of = table.components.map((name) => named(name)).toSorted(byName);
        const count = table.entities.length;
        for (const component of of) {
          columnsOf(component, table.columns[component.name], count);
        }
        return { components: of, count, entities: table.entities, table };
      }),
      columns: ({ table }, component) => table.columns[component.name] ?? {},
      sparse: contents.sparse
        .filter((set) => set.members.length > 0)
        .toSorted(byComponent)
        .map((set) => {
          const component = named(set.component);
          const count = set.members.length;
          return {
            component,
            count,
            members: set.members,
            columns: columnsOf(component, set.columns, count),
          };
        }),
    }
  );
};
