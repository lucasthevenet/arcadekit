/**
 * Functions that update an old save's world to match the game's current
 * components. A migration receives the save in a plain, self-describing form
 * (`Save.Contents`), and these functions edit its world:
 *
 *   const migrations: Save.Migration[] = [
 *     {
 *       from: 1,                                   // migrates version 1 to version 2
 *       migrate: ({ world }) => {
 *         Migrate.renameComponent(world, "game/Hp", "game/Health")
 *         Migrate.addField(world, "game/Health", "armor", "i32", 0)
 *       },
 *     },
 *   ]
 *
 * Each function edits the contents in place, and entities keep their ids. Each
 * throws when the component or field it targets doesn't exist, so a migration
 * that doesn't match its save says so. Singletons are migrated the same way, by
 * name, and are present in the save only if the game wrote them.
 */
import type { Column, FieldKind } from "./ecs/Component";
import type {
  SnapshotComponent,
  SnapshotContents,
  SnapshotTable,
} from "./ecs/Snapshot";

const componentOf = (
  world: SnapshotContents,
  name: string
): SnapshotComponent => {
  const component = world.components.find((each) => each.name === name);

  if (component === undefined) {
    throw new Error(
      `The save holds no component named "${name}". It holds: ${world.components.map((each) => each.name).join(", ") || "none"}.`
    );
  }

  return component;
};

/** Returns every set of columns the save holds for a component, with its row count. */
const columnsOf = (
  world: SnapshotContents,
  name: string
): { columns: Record<string, Column>; count: number }[] => [
  ...world.tables
    .filter((table) => table.components.includes(name))
    .map((table) => ({
      columns: (table.columns[name] ??= {}),
      count: table.entities.length,
    })),
  ...world.sparse
    .filter((set) => set.component === name)
    .map((set) => ({ columns: set.columns, count: set.members.length })),
  // A singleton is one row.
  ...world.singletons
    .filter((single) => single.component === name)
    .map((single) => ({ columns: single.columns, count: 1 })),
];

const fieldOf = (component: SnapshotComponent, field: string) => {
  const found = component.fields.find((each) => each.name === field);

  if (found === undefined) {
    throw new Error(
      `"${component.name}" has no field named "${field}" in the save. It has: ${component.fields.map((each) => each.name).join(", ") || "none"}.`
    );
  }

  return found;
};

const column = (kind: FieldKind, count: number, value: unknown): Column => {
  switch (kind) {
    case "f32": {
      return new Float32Array(count).fill(value as number);
    }

    case "f64": {
      return new Float64Array(count).fill(value as number);
    }

    case "i32": {
      return new Int32Array(count).fill(value as number);
    }

    case "u32": {
      return new Uint32Array(count).fill(value as number);
    }

    case "entity": {
      return new Float64Array(count).fill(value as number);
    }

    case "u16": {
      return new Uint16Array(count).fill(value as number);
    }

    case "u8": {
      return new Uint8Array(count).fill(value as number);
    }

    default: {
      return Array.from({ length: count }, () => value);
    }
  }
};

/**
 * Renames a component. Its data is unchanged.
 *
 * @category Migrations
 */
export const renameComponent = (
  world: SnapshotContents,
  from: string,
  to: string
): void => {
  const component = componentOf(world, from);

  if (world.components.some((each) => each.name === to)) {
    throw new Error(`The save already holds a component named "${to}".`);
  }

  component.name = to;

  for (const table of world.tables) {
    const at = table.components.indexOf(from);

    if (at !== -1) {
      table.components[at] = to;
      table.columns[to] = table.columns[from] ?? {};
      delete table.columns[from];
    }
  }

  for (const set of [...world.sparse, ...world.singletons]) {
    if (set.component === from) {
      set.component = to;
    }
  }
};

/**
 * Renames a field. Its values are unchanged.
 *
 * @category Migrations
 */
export const renameField = (
  world: SnapshotContents,
  component: string,
  from: string,
  to: string
): void => {
  const definition = componentOf(world, component);
  const field = fieldOf(definition, from);

  if (definition.fields.some((each) => each.name === to)) {
    throw new Error(`"${component}" already has a field named "${to}".`);
  }

  field.name = to;

  for (const { columns } of columnsOf(world, component)) {
    if (columns[from] !== undefined) {
      columns[to] = columns[from];
      delete columns[from];
    }
  }
};

/**
 * Adds a field to a component, with the same value for every entity that has
 * the component. The field goes after the existing ones, or before the field
 * named in `before`: a component's fields are in definition order.
 *
 * @category Migrations
 */
export const addField = (
  world: SnapshotContents,
  component: string,
  field: string,
  kind: FieldKind,
  value: unknown,
  before?: string
): void => {
  const definition = componentOf(world, component);

  if (definition.fields.some((each) => each.name === field)) {
    throw new Error(`"${component}" already has a field named "${field}".`);
  }

  const at =
    before === undefined
      ? definition.fields.length
      : definition.fields.indexOf(fieldOf(definition, before));

  definition.fields.splice(at, 0, { name: field, kind });

  if (kind === "transient") {
    return;
  }

  for (const { columns, count } of columnsOf(world, component)) {
    columns[field] = column(kind, count, value);
  }
};

/**
 * Removes a field, and its values, from a component.
 *
 * @category Migrations
 */
export const removeField = (
  world: SnapshotContents,
  component: string,
  field: string
): void => {
  const definition = componentOf(world, component);
  definition.fields.splice(
    definition.fields.indexOf(fieldOf(definition, field)),
    1
  );

  for (const { columns } of columnsOf(world, component)) {
    delete columns[field];
  }
};

/**
 * Changes a field's type, and computes each new value from the old one:
 * `mapField(world, "game/Hp", "points", "f32", (hp) => hp / 2)`. For a `ref`
 * field, the old value is its encoded form.
 *
 * @category Migrations
 */
export const mapField = (
  world: SnapshotContents,
  component: string,
  field: string,
  kind: FieldKind,
  map: (value: any) => unknown
): void => {
  const definition = componentOf(world, component);
  const found = fieldOf(definition, field);
  const was = found.kind;
  found.kind = kind;

  for (const { columns, count } of columnsOf(world, component)) {
    const old = columns[field];

    if (kind === "transient") {
      delete columns[field];
      continue;
    }

    const next = column(kind, count, 0);

    for (let row = 0; row < count; row += 1) {
      next[row] = map(was === "transient" ? undefined : old?.[row]) as never;
    }

    columns[field] = next;
  }
};

/**
 * Removes a component, and every entity's values of it, from the save. The
 * entities remain. Two tables that now hold the same components are merged,
 * with the later table's rows after the earlier one's.
 *
 * @category Migrations
 */
export const removeComponent = (
  world: SnapshotContents,
  name: string
): void => {
  const component = componentOf(world, name);
  world.components.splice(world.components.indexOf(component), 1);
  world.sparse = world.sparse.filter((set) => set.component !== name);
  world.singletons = world.singletons.filter(
    (single) => single.component !== name
  );
  const merged = new Map<string, SnapshotTable>();
  const tables: SnapshotTable[] = [];

  for (const table of world.tables) {
    const at = table.components.indexOf(name);

    if (at !== -1) {
      table.components.splice(at, 1);
      delete table.columns[name];
    }

    const key = table.components.toSorted().join("\\u0000");
    const first = merged.get(key);

    if (first === undefined) {
      merged.set(key, table);
      tables.push(table);
      continue;
    }

    // The same set of components as an earlier table: its rows move there.
    const count = first.entities.length;
    const entities = new Float64Array(count + table.entities.length);
    entities.set(first.entities);
    entities.set(table.entities, count);
    first.entities = entities;

    for (const [of, columns] of Object.entries(first.columns)) {
      for (const [field, values] of Object.entries(columns)) {
        const more = table.columns[of]?.[field];

        if (more === undefined) {
          continue;
        }

        if (Array.isArray(values)) {
          columns[field] = [...values, ...(more as unknown[])];
        } else {
          const joined = new (values.constructor as Float32ArrayConstructor)(
            entities.length
          );

          joined.set(values as Float32Array);
          joined.set(more as Float32Array, count);
          columns[field] = joined;
        }
      }
    }
  }

  world.tables = tables;
};
