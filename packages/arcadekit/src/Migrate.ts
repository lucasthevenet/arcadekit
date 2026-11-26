/**
 * Migrations bring a save that an older version of a game wrote up to the
 * game as it is: one step from each version to the next, each an edit of the
 * save that names what the game has now by its definition, and what it no
 * longer has by its old name.
 *
 *   const Duel = App.define({
 *     plugins: [Game],
 *     version: 2,
 *     migrations: [
 *       Migrate.step(1, (save) => {               // from version 1 to version 2
 *         save.renameComponent("game/Hp", Health)
 *         save.addField(Health, "max", 10)        // a field of Health's, its kind Health's
 *         save.renameEvent("game/Hit", Struck)
 *         save.mapPayloads(Move, (payload) => ({ ...(payload as Move0), run: false }))
 *         save.renameStateValue(Phase, "play", "playing")
 *       }),
 *     ],
 *   })
 *
 * A save holds the components, the singletons, the states with the entities
 * scoped to their values, the events waiting to be read and the actions
 * queued, each by name. A step changes them in place, and entities keep their
 * ids. A change throws when what it names isn't in the save, and the load
 * fails with `"migration failed"`, so a migration that doesn't match its save
 * says so.
 */
import { Exit, Schema } from "effect";

import * as Action from "./Action.ts";
import { makeColumn } from "./ecs/column.ts";
import type { Column } from "./ecs/column.ts";
import { idOf, isEntity } from "./ecs/component.ts";
import type { ComponentDef, FieldKind, ValueOf } from "./ecs/component.ts";
import { readSnapshot, writeSnapshot } from "./ecs/contents.ts";
import type {
  SnapshotComponent,
  SnapshotContents,
  SnapshotTable,
} from "./ecs/contents.ts";
import { renameInChanges } from "./ecs/query.ts";
import { SnapshotError } from "./ecs/snapshot.ts";
import * as Event from "./Event.ts";
import { VISITS, VisitsData, loading } from "./internal/save.ts";
import { LoadRefused } from "./Save.ts";
import type { Save } from "./Save.ts";
import type * as State from "./State.ts";

/** The field types that hold numbers, in a typed array. */
type NumericKind = "f32" | "f64" | "i32" | "u32" | "u16" | "u8" | "entity";

/**
 * What a migration names a component of the game by: its definition, or a
 * singleton's, whose fields are a component's.
 *
 * @category Type-level
 */
export type Component<
  S extends ComponentDef["schema"] = ComponentDef["schema"],
> = ComponentDef<S> | { readonly component: ComponentDef<S> };

/** The fields of a component, by name. */
type FieldsOf<C> = C extends Component<infer S> ? S : never;

const defOf = (component: Component): ComponentDef =>
  "component" in component ? component.component : component;

/** A component as the save lists it, or a refusal that names what it holds. */
const listed = (world: SnapshotContents, name: string): SnapshotComponent => {
  const component = world.components.find((each) => each.name === name);
  if (component === undefined) {
    throw new Error(
      `The save holds no component named "${name}". It holds: ${world.components.map((each) => each.name).join(", ") || "none"}.`
    );
  }
  return component;
};

/** Every set of columns the save holds for a component, with its row count. */
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

/** A value of a field as its column holds it: an entity as its id, a `ref` encoded. */
const storedOf = (
  def: ComponentDef,
  field: string,
  value: unknown
): unknown => {
  const at = def.fields.indexOf(field);
  const kind = def.kinds[at];
  if (kind === "entity") {
    if (!isEntity(value)) {
      throw new Error(
        `The entity field "${field}" of "${def.name}" cannot hold ${shown(value)}: it holds an entity.`
      );
    }
    return idOf(value);
  }
  const codec = def.codecs[at];
  return codec === undefined ? value : codec.encode(value);
};

/** What a snapshot holds of the events waiting to be read. */
interface Waiting {
  name: string;
  waiting: unknown[];
  read: Record<string, number>;
}

/** What a snapshot holds of the actions queued for the next tick. */
interface Queued {
  queued: { name: string; payload: unknown; from?: string }[];
}

/**
 * A save as a migration edits it, in a plain form that describes itself:
 * what it holds, by name, whatever the game's definitions are now. A step of
 * `Migrate.step` is given one. A tool that edits a snapshot makes one of its
 * contents, `new Migrate.Contents(readSnapshot(bytes))`.
 *
 * Each change names what the game has now by its definition, so that a name
 * the game doesn't have, or a field its definition doesn't have, doesn't
 * compile, and names what the game no longer has by its old name. Each
 * throws, naming what it was asked for, when the save doesn't hold it.
 *
 * @category Models
 */
export class Contents {
  /**
   * The world, as the snapshot describes it: its components by name with
   * their fields, its tables, sparse sets and singletons with a column of
   * values per field, and its `stores`, what an app keeps of a game beside
   * its entities, each under its name. The changes below edit it, and it can
   * be edited by hand for what they don't do.
   */
  readonly world: SnapshotContents;

  constructor(world: SnapshotContents) {
    this.world = world;
  }

  /** The data a store of the world holds, by its name, or undefined. */
  private stored<A>(name: string): A | undefined {
    return this.world.stores.find((store) => store.name === name)?.data as
      | A
      | undefined;
  }

  // --- components and their fields -------------------------------------------------

  /**
   * Renames a component, or a singleton, to the name of its definition, with
   * what its change queries had yet to visit, so they go on from where they
   * were. Its data is unchanged. It throws when the save holds a component of
   * that name already.
   */
  renameComponent(from: string, to: Component): void {
    this.renamed(from, defOf(to).name);
  }

  private renamed(from: string, to: string): void {
    const { world } = this;
    const component = listed(world, from);
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
    const visits = world.stores.find((store) => store.name === VISITS);
    // Visits that aren't as a world saves them make the load fail as "corrupt".
    if (visits !== undefined && Schema.is(VisitsData)(visits.data)) {
      visits.data = renameInChanges(visits.data, from, to);
    }
  }

  /**
   * Removes a component, and every entity's values of it, from the save. The
   * entities remain. Two tables that now hold the same components are merged,
   * with the later table's rows after the earlier one's.
   */
  removeComponent(name: string): void {
    const { world } = this;
    const component = listed(world, name);
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
  }

  /** Renames a field to one of its definition's. Its values are unchanged. */
  renameField<C extends Component>(
    component: C,
    from: string,
    to: keyof FieldsOf<C> & string
  ): void {
    const def = defOf(component);
    const listing = listed(this.world, def.name);
    const field = fieldOf(listing, from);
    if (listing.fields.some((each) => each.name === to)) {
      throw new Error(`"${def.name}" already has a field named "${to}".`);
    }
    field.name = to;
    for (const { columns } of columnsOf(this.world, def.name)) {
      if (columns[from] !== undefined) {
        columns[to] = columns[from];
        delete columns[from];
      }
    }
  }

  /**
   * Adds a field of the component's definition, of the kind and at the place
   * the definition gives it, with the same value for every entity that has
   * the component. A field of a number type throws on a value it can't hold:
   * a fraction, or a number out of its range, for a whole-number type.
   */
  addField<C extends Component, F extends keyof FieldsOf<C> & string>(
    component: C,
    field: F,
    value: ValueOf<FieldsOf<C>>[F]
  ): void {
    const def = defOf(component);
    const listing = listed(this.world, def.name);
    if (listing.fields.some((each) => each.name === field)) {
      throw new Error(`"${def.name}" already has a field named "${field}".`);
    }
    const kind = def.kinds[def.fields.indexOf(field)]!;
    // Before the first field the save holds that the definition puts after it.
    const order = def.fields.indexOf(field);
    const after = listing.fields.findIndex(
      (each) => def.fields.indexOf(each.name) > order
    );
    listing.fields.splice(after === -1 ? listing.fields.length : after, 0, {
      name: field,
      kind,
    });
    if (kind === "transient") {
      return;
    }
    const stored = storedOf(def, field, value);
    for (const { columns, count } of columnsOf(this.world, def.name)) {
      columns[field] = columnOf(def.name, field, kind, count, () => stored);
    }
  }

  /** Removes a field the component's definition no longer has, and its values. */
  removeField(component: Component, field: string): void {
    const def = defOf(component);
    const listing = listed(this.world, def.name);
    listing.fields.splice(listing.fields.indexOf(fieldOf(listing, field)), 1);
    for (const { columns } of columnsOf(this.world, def.name)) {
      delete columns[field];
    }
  }

  /**
   * Changes a field to the kind its definition gives it, and computes each
   * new value from the old one:
   *
   *   save.mapField(Health, "points", (hp: number) => hp / 2)
   *
   * The save doesn't record the old value's TypeScript type, so the parameter
   * of `map` declares it. A `ref` field gives `map` its encoded form, an
   * entity its id, and a `transient` field undefined. For a field of a number
   * type, it throws on a value the type can't hold, as `addField` does.
   */
  mapField<C extends Component, F extends keyof FieldsOf<C> & string, T>(
    component: C,
    field: F,
    map: (value: T) => ValueOf<FieldsOf<C>>[F]
  ): void {
    const def = defOf(component);
    const listing = listed(this.world, def.name);
    const found = fieldOf(listing, field);
    const was = found.kind;
    const kind = def.kinds[def.fields.indexOf(field)]!;
    found.kind = kind;
    for (const { columns, count } of columnsOf(this.world, def.name)) {
      const old = columns[field];
      if (kind === "transient") {
        delete columns[field];
        continue;
      }
      columns[field] = columnOf(def.name, field, kind, count, (row) =>
        storedOf(
          def,
          field,
          map((was === "transient" ? undefined : old?.[row]) as T)
        )
      );
    }
  }

  // --- events and actions ----------------------------------------------------------

  /** The waiting events of a name, or a refusal that names those the save holds. */
  private waitingOf(name: string): Waiting {
    const waiting = this.stored<Waiting[]>(Event.STORE) ?? [];
    const found = waiting.find((each) => each.name === name);
    if (found === undefined) {
      throw new Error(
        `The save holds no event named "${name}" waiting to be read. It holds: ${waiting.map((each) => each.name).join(", ") || "none"}.`
      );
    }
    return found;
  }

  /** The queued actions of a name, or a refusal that names those the save holds. */
  private queuedOf(name: string): Queued["queued"] {
    const queued = this.stored<Queued>(Action.INTAKE)?.queued ?? [];
    const found = queued.filter((each) => each.name === name);
    if (found.length === 0) {
      throw new Error(
        `The save holds no action named "${name}" queued for the next tick. It holds: ${[...new Set(queued.map((each) => each.name))].join(", ") || "none"}.`
      );
    }
    return found;
  }

  /**
   * Renames the events of a name that are waiting to be read to the name of
   * their definition. Where each system had read to goes with them.
   */
  renameEvent(from: string, to: Event.Event<unknown>): void {
    this.waitingOf(from).name = to.name;
  }

  /** Removes the events of a name that are waiting to be read. */
  removeEvent(name: string): void {
    const waiting = this.waitingOf(name);
    const store = this.world.stores.find((each) => each.name === Event.STORE)!;
    store.data = (store.data as Waiting[]).filter((each) => each !== waiting);
  }

  /** Renames the actions of a name queued for the next tick to their definition's. */
  renameAction(from: string, to: Action.Any): void {
    for (const action of this.queuedOf(from)) {
      action.name = to.name;
    }
  }

  /** Removes the actions of a name queued for the next tick. */
  removeAction(name: string): void {
    const queued = this.queuedOf(name);
    const intake = this.stored<Queued>(Action.INTAKE)!;
    intake.queued = intake.queued.filter((each) => !queued.includes(each));
  }

  /**
   * Computes anew the payload of each waiting event, or each queued action,
   * of a definition, from the one the save holds: the old payload in its JSON
   * form, and the new one as its schema gives its type. The new one is
   * encoded with the definition's schema, and throws when the schema doesn't
   * take it.
   *
   *   save.mapPayloads(Move, (old) => ({ ...(old as { dx: number }), run: false }))
   */
  mapPayloads<P>(
    of: Event.Event<P> | Action.Action<string, P>,
    map: (payload: unknown) => P
  ): void {
    const encode = (payload: P): unknown => {
      const json = Schema.encodeUnknownExit(of.codec)(payload);
      if (Exit.isFailure(json)) {
        throw new Error(
          `A payload of "${of.name}" is not one its schema takes: ${String(json.cause)}`
        );
      }
      return json.value;
    };
    if (of instanceof Event.Event) {
      const waiting = this.waitingOf(of.name);
      waiting.waiting = waiting.waiting.map((payload) => encode(map(payload)));
      return;
    }
    for (const action of this.queuedOf(of.name)) {
      action.payload = encode(map(action.payload));
    }
  }

  // --- states ----------------------------------------------------------------------

  /**
   * Renames a state to the name of its definition, with the tags of the
   * entities scoped to its values.
   */
  renameState(from: string, to: State.State<string>): void {
    this.renamed(from, to.name);
    for (const value of to.values) {
      if (
        this.world.components.some(
          (each) => each.name === `${from}.Scoped.${value}`
        )
      ) {
        this.renamed(`${from}.Scoped.${value}`, `${to.name}.Scoped.${value}`);
      }
    }
  }

  /**
   * Renames a value of a state to one its definition has: where the state is,
   * where it is going, and the tag of the entities scoped to the value, which
   * a value the state no longer has would leave unknown to the game.
   */
  renameStateValue<V extends string>(
    state: State.State<V>,
    from: string,
    to: NoInfer<V>
  ): void {
    const single = this.world.singletons.find(
      (each) => each.component === state.name
    );
    if (single === undefined) {
      throw new Error(
        `The save holds no state named "${state.name}": the game never entered it.`
      );
    }
    let found = false;
    for (const field of ["value", "next"] as const) {
      const column = single.columns[field] as unknown[] | undefined;
      if (column?.[0] === from) {
        column[0] = to;
        found = true;
      }
    }
    const tag = `${state.name}.Scoped.${from}`;
    if (this.world.components.some((each) => each.name === tag)) {
      this.renamed(tag, `${state.name}.Scoped.${to}`);
      found = true;
    }
    if (!found) {
      throw new Error(
        `The state "${state.name}" is not at "${from}", is not going there, and no entity of the save is scoped to it.`
      );
    }
  }
}

/**
 * Turns a save written by version `from` of a game into one of version
 * `from + 1`, by editing in place the contents it receives.
 *
 * **Gotchas**
 *
 * - A migration turns an old save into a new game, and the log recorded
 *   before it no longer replays against it.
 * - A migration that comes with a schema change of an event or an action
 *   changes the payloads the save holds too, with `mapPayloads`. A waiting
 *   event that its schema no longer takes makes the load fail with
 *   `"store changed"`. A queued action that its schema no longer takes is
 *   refused when it is applied, as an `Action.Rejected` event.
 *
 * @category Models
 */
export interface Migration {
  readonly from: number;
  readonly migrate: (save: Contents) => void;
}

/**
 * Makes the step of a game's migrations from version `from` of its saves to
 * version `from + 1`, which edits the save it is given.
 *
 *   Migrate.step(1, (save) => {
 *     save.renameComponent("game/Hp", Health)
 *   })
 *
 * @category Constructors
 */
export const step = (
  from: number,
  migrate: (save: Contents) => void
): Migration => ({ from, migrate });

const refuse = (
  problem: LoadRefused["problem"],
  message: string
): Exit.Exit<never, LoadRefused> =>
  Exit.fail(new LoadRefused({ problem, message }));

/**
 * Migrates a save to a version of the game, one step at a time, as a game's
 * `migrations` do when it loads the save. A save already at that version is
 * returned unchanged.
 *
 * Fails with `Save.LoadRefused`: `"newer version"` for a save from a later
 * version, `"no migration"` when a step is missing, `"migration failed"` when
 * a step throws or leaves a value that can't be saved, and a snapshot's own
 * problems when the save's world can't be read or written back.
 *
 * @category Migrations
 */
export const migrate = (
  save: Save,
  version: number,
  migrations: readonly Migration[]
): Exit.Exit<Save, LoadRefused> => {
  if (save.version === version) {
    return Exit.succeed(save);
  }
  if (save.version > version) {
    return refuse(
      "newer version",
      `The save was written by version ${save.version} of the game, and this is version ${version}. A game cannot read what a later version of itself wrote.`
    );
  }
  let contents: Contents;
  try {
    contents = new Contents(readSnapshot(save.world));
  } catch (error) {
    if (error instanceof SnapshotError) {
      return refuse(loading(error), error.message);
    }
    throw error;
  }
  for (let from = save.version; from < version; from++) {
    const one = migrations.find((migration) => migration.from === from);
    if (one === undefined) {
      return refuse(
        "no migration",
        `The save was written by version ${save.version} of the game, and this is version ${version}. There is no migration from version ${from} to version ${from + 1}.`
      );
    }
    try {
      one.migrate(contents);
    } catch (error) {
      return refuse(
        "migration failed",
        `The migration from version ${from} to version ${from + 1} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  try {
    return Exit.succeed({ version, world: writeSnapshot(contents.world) });
  } catch (error) {
    if (!(error instanceof SnapshotError)) {
      throw error;
    }
    return error.problem === "cannot be saved"
      ? refuse(
          "migration failed",
          `The migrations from version ${save.version} to version ${version} left a world that can't be written back: ${error.message}`
        )
      : refuse(loading(error), error.message);
  }
};
