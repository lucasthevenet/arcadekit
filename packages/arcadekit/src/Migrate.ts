/**
 * Functions that update an old save's world to match the game's current
 * components. A migration receives the save as `Save.Contents`, a plain form
 * that describes itself, and these functions edit its world:
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
 * The functions edit the contents in place, and entities keep their ids. A
 * function throws when the component or field it names doesn't exist, and
 * the load fails with `"migration failed"`, so a migration that doesn't match
 * its save says so. A singleton is migrated the same way, by name, and a save
 * holds one only if the game wrote it.
 */
import { makeColumn } from "./ecs/column";
import type { Column } from "./ecs/column";
import type { FieldKind } from "./ecs/component";
import type {
  SnapshotComponent,
  SnapshotContents,
  SnapshotTable,
} from "./ecs/contents";

/** The field types that hold numbers, in a typed array. */
type NumericKind = "f32" | "f64" | "i32" | "u32" | "u16" | "u8" | "entity";

/**
 * What a migration gives a field of type `K`: a number for a field of a number
 * type, and anything for a `json`, `ref` or `transient` field.
 *
 * @category Type-level
 */
export type ValueOfKind<K extends FieldKind> = K extends NumericKind
  ? number
  : unknown;

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

/**
 * The values a field of each number type holds. A typed array stores anything
 * else as something it is not: a string as NaN or the number it parses to, 300
 * in a `u8` as 44, 1.5 in an `i32` as 1.
 */
const holds: Record<
  NumericKind,
  { readonly whole: boolean; min: number; max: number }
> = {
  f32: { whole: false, min: -Infinity, max: Infinity },
  f64: { whole: false, min: -Infinity, max: Infinity },
  i32: { whole: true, min: -(2 ** 31), max: 2 ** 31 - 1 },
  u32: { whole: true, min: 0, max: 2 ** 32 - 1 },
  u16: { whole: true, min: 0, max: 2 ** 16 - 1 },
  u8: { whole: true, min: 0, max: 2 ** 8 - 1 },
  entity: { whole: true, min: 0, max: Number.MAX_SAFE_INTEGER },
};

const isNumeric = (kind: FieldKind): kind is NumericKind => kind in holds;

const shown = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

/**
 * A column of `count` rows of a field of `kind`, each the value `at` gives for
 * its row. A number field throws for a value it cannot hold, and says which.
 */
const columnOf = (
  component: string,
  field: string,
  kind: FieldKind,
  count: number,
  at: (row: number) => unknown
): Column => {
  const made = makeColumn(kind, count);
  if (!isNumeric(kind)) {
    const boxed = made as unknown[];
    for (let row = 0; row < count; row++) {
      boxed[row] = at(row);
    }
    return made;
  }
  const { whole, min, max } = holds[kind];
  const numbers = made as Exclude<Column, unknown[]>;
  for (let row = 0; row < count; row++) {
    const value = at(row);
    if (
      typeof value !== "number" ||
      (whole && (!Number.isInteger(value) || value < min || value > max))
    ) {
      throw new Error(
        `The ${kind} field "${field}" of "${component}" cannot hold ${shown(value)}: it holds ${whole ? `whole numbers from ${min} to ${max}` : "numbers"}.`
      );
    }
    numbers[row] = value;
  }
  return made;
};

/**
 * Renames a component. Its data is unchanged. It throws when the save already
 * holds a component named `to`.
 *
 * **Gotchas**
 *
 * - It leaves the component's entries under `Save.VISITS` with the old name,
 *   so the load drops them, as `Save.Contents` says.
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
 * named in `before`. Put it where the component's definition does: a save
 * whose fields are in another order fails to load with `"component changed"`.
 * For a field of a number type, it throws on a value the type can't hold:
 * anything but a number, and, for a whole-number type, a fraction or a number
 * out of its range.
 *
 * @category Migrations
 */
export const addField = <K extends FieldKind>(
  world: SnapshotContents,
  component: string,
  field: string,
  kind: K,
  value: ValueOfKind<K>,
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
    columns[field] = columnOf(component, field, kind, count, () => value);
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
 *
 *   Migrate.mapField(world, "game/Hp", "points", "f32", (hp: number) => hp / 2)
 *
 * The save doesn't record the old value's TypeScript type, so the parameter
 * of `map` declares it. A `ref` field gives `map` its encoded form, and a
 * `transient` field gives it undefined. For a field of a number type, it
 * throws on a value the type can't hold, as `addField` does.
 *
 * @category Migrations
 */
export const mapField = <T, K extends FieldKind>(
  world: SnapshotContents,
  component: string,
  field: string,
  kind: K,
  map: (value: T) => ValueOfKind<K>
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
    columns[field] = columnOf(component, field, kind, count, (row) =>
      map((was === "transient" ? undefined : old?.[row]) as T)
    );
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
