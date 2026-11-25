import { Cause, Exit, Schema } from "effect";

import type { CommandBuffer } from "../ecs/commands";
import type { Entity } from "../ecs/component";
import { readSingleton } from "../ecs/contents";
import { SnapshotError } from "../ecs/snapshot";
import type { Spawned } from "../ecs/spawned";
import type { Store } from "../ecs/store";
import type { World } from "../ecs/world";
import { LoadRefused, SaveRefused, VISITS, migrate } from "../Save";
import type { Migration, Save } from "../Save";

/** Says what a failed decoding found wrong. */
const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Takes a world as it is, with `take`, to `save` or to `capture`: refused
 * while commands are queued and not applied, and when the world holds what
 * has no saved form.
 *
 * @internal
 */
export const taking = <A>(
  commands: CommandBuffer<Entity | Spawned>,
  to: "save" | "capture",
  take: () => A
): Exit.Exit<A, SaveRefused> => {
  if (commands.size > 0) {
    return Exit.fail(
      new SaveRefused({
        message: `${commands.size} commands are queued and not applied. They are applied at the end of a tick: ${to} after one.`,
      })
    );
  }
  try {
    return Exit.succeed(take());
  } catch (error) {
    if (error instanceof SnapshotError) {
      return Exit.fail(new SaveRefused({ message: error.message }));
    }
    throw error;
  }
};

/**
 * `app.save()`: a save of a world, for a game of a version whose log has a
 * length.
 *
 * @internal
 */
export const take = (
  world: World,
  commands: CommandBuffer<Entity | Spawned>,
  version: number,
  logLength: number
): Exit.Exit<Save, SaveRefused> =>
  Exit.map(
    taking(commands, "save", () => world.snapshot()),
    (bytes) => ({ version, world: bytes, logLength })
  );

/**
 * The version a game is made with: a whole number from 0 up, and 0 when it
 * gives none.
 *
 * @internal
 */
export const versionOf = (given: number | undefined): number => {
  const version = given ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(
      `A game's version must be a whole number from 0 up, and this one is ${version}.`
    );
  }
  return version;
};

/**
 * Fills an empty world from a save, brought up to a version of the game
 * first, and returns the save as it was loaded.
 *
 * @internal
 */
export const into = (
  world: World,
  save: Save,
  version: number,
  migrations: readonly Migration[]
): Exit.Exit<Save, LoadRefused> => {
  const current = migrate(save, version, migrations);
  if (Exit.isFailure(current)) {
    return current;
  }
  try {
    world.load(current.value.world);
  } catch (error) {
    if (!(error instanceof SnapshotError)) {
      throw error;
    }
    return Exit.fail(
      new LoadRefused({
        problem: error.problem,
        message:
          error.problem === "unknown component"
            ? `${error.message} A migration renames or removes a component in a save.`
            : error.problem === "unknown store" ||
                error.problem === "store changed"
              ? `${error.message} A migration changes the events and the queued actions of a save in \`world.stores\`.`
              : error.message,
      })
    );
  }
  return current;
};

/**
 * The first value a save's world holds of a singleton's field, or undefined
 * when it holds none. It reads none of the save's entities.
 *
 * @internal
 */
export const singleton = (
  save: Save,
  component: string,
  field: string
): unknown => readSingleton(save.world, component)?.columns[field]?.[0];

/**
 * What a snapshot holds of the visits: `world.saveChanges()`.
 * @internal
 */
export const VisitsData = Schema.Array(
  Schema.Struct({
    component: Schema.String,
    kind: Schema.Literals(["changed", "added", "removed"]),
    entries: Schema.Array(Schema.Number),
    readers: Schema.Record(Schema.String, Schema.Number),
  })
);

/**
 * Where each system of the tick and each handler has got to in what changed:
 * what its change queries have yet to visit. The world keeps the logs; this
 * puts them in its snapshot, so that a loaded game goes on as the saved one
 * did. The frame and input stages' own places are not the game's: a loaded
 * game has everything still to draw.
 *
 * @internal
 */
export class Visits implements Store<undefined> {
  readonly name = VISITS;
  // Not hashed, and the world's own logs refuse what a frozen world refuses.
  readonly betweenTicks = true;
  private readonly world: World;
  private readonly saved: (reader: string) => boolean;

  /** `saved` says whose place a snapshot holds, by reader. */
  constructor(world: World, saved: (reader: string) => boolean) {
    this.world = world;
    this.saved = saved;
  }

  save(): unknown {
    const saved = this.world.saveChanges(this.saved);
    return saved.length === 0 ? undefined : saved;
  }

  load(data: unknown): void {
    const saved = Schema.decodeUnknownExit(VisitsData)(data);
    if (Exit.isFailure(saved)) {
      throw new SnapshotError(
        "corrupt",
        `The snapshot is damaged: what its change queries had yet to visit is not as a world saves it: ${describeCause(saved.cause)}`
      );
    }
    this.world.restoreChanges(saved.value);
  }

  hashed(): unknown {
    return undefined;
  }

  // A moment's are kept by whoever captures it, who says whose it holds.
  capture(): undefined {
    return undefined;
  }

  rewind(): void {}

  // The world empties its own logs.
  clear(): void {}

  begin(): void {}

  rollback(): void {}

  commit(): void {}

  contents(): unknown {
    return undefined;
  }
}
