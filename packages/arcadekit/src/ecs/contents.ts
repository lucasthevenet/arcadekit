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
  name: string;
  /** Where its data is stored: in tables, in a sparse set, or as a single value for the world. */
  storage: "table" | "sparse" | "singleton";
  fields: { name: string; kind: FieldKind }[];
}

/**
 * One table of a snapshot: its entities' components, and their rows.
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
  component: string;
  /** The index (not the id) of each entity that has the component. */
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
  component: string;
  /** For each field name, a column holding the single value. */
  columns: Record<string, Column>;
}

/**
 * Everything a snapshot holds, read without the program's component
 * definitions, since a snapshot describes its own. Migrations work on this
 * form, to make an old save match the game's current components.
 *
 * A `json` field's column holds the plain data itself. A `ref` field's column
 * holds each value as its codec encoded it. A `transient` field has no column.
 *
 * @category Models
 */
export interface SnapshotContents {
  /** The random generator's four words. */
  random: Uint32Array;
  /** One generation per entity slot. */
  generations: Uint32Array;
  /** The freed slots, in the order they will be reused. */
  freed: number[];
  components: SnapshotComponent[];
  /** In the order queries visit them. */
  tables: SnapshotTable[];
  sparse: SnapshotSparse[];
  /** The singletons that had been written. */
  singletons: SnapshotSingleton[];
  /**
   * What the world's stores held, the ones that held anything, in order of
   * name: in an app's world, the events waiting to be read, the actions
   * queued for the next tick, and what change queries had yet to visit.
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
 * Reads a snapshot into its contents, without needing component definitions.
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
 * Writes contents back into snapshot bytes. The contents must be consistent:
 * every component a table or a sparse set names is listed, and every saved
 * field has a column with one value per row. `World.load` checks the rest when
 * it reads the result.
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
