/**
 * Structural changes queued for later: what a loop over a query can't do to
 * the world while it runs.
 *
 * No Effect dependency.
 */
import { frozenWrite } from "./component";
import type { ComponentDef, ComponentInput, Entity } from "./component";
import type { Targeted } from "./relation";
import type { Spawned } from "./spawned";
import type { World } from "./world";

/**
 * The id a command applies to: one spawned by this buffer is placed by the
 * time a later command in it is applied, since they are applied in order.
 */
const applied = (entity: Entity | Spawned): Entity => entity as Entity;

type Command =
  | {
      readonly op: "spawn";
      readonly entity: Entity;
      readonly inputs: readonly ComponentInput[];
      /** Whether the id's index had never been used, which `rollback` needs to know. */
      readonly fresh: boolean;
    }
  | { readonly op: "despawn"; readonly entity: Entity }
  | {
      readonly op: "add";
      readonly entity: Entity;
      readonly input: ComponentInput;
    }
  | {
      readonly op: "remove";
      readonly entity: Entity;
      readonly def: ComponentDef;
    };

/**
 * A queue of structural changes to a world: spawns, despawns, and components
 * added and removed. The world refuses those changes while a query iterates
 * and inside a transaction, so a loop queues them here. `apply` then makes
 * them in one pass, in order, at a point the caller chooses.
 *
 * **When to use**
 *
 * Use with the storage core alone. In a game, the `Commands` service queues
 * on the app's buffer, which the app applies when each system finishes.
 *
 * **Gotchas**
 *
 * - `spawn` reserves the id at once. `isAlive` and `entityCount` count the
 *   entity before `apply`, and it has no component until then.
 * - A spawn left unapplied makes `World.snapshot` and `World.restore` throw.
 * - Call `apply` outside any query's loop and transaction, in a world that
 *   isn't frozen. Inside a loop or a transaction, or in a frozen world, a
 *   queued despawn, add or remove throws, and the queue is empty afterwards,
 *   so that command and the ones after it are lost. A queued spawn is made
 *   there with no error, and a rollback doesn't undo it.
 *
 * @typeParam Id the type of the ids `spawn` returns, `Entity` by default, and
 *   `Spawned` in an app's buffer
 *
 * @category Models
 */
export class CommandBuffer<Id extends Entity | Spawned = Entity> {
  private ops: Command[] = [];

  /** Makes an empty buffer for `world`. */
  constructor(readonly world: World) {}

  /** How many commands are queued. */
  get size(): number {
    return this.ops.length;
  }

  /**
   * Queues a spawn and returns the new entity's id at once. The entity gets
   * its components when the buffer is applied. A component the world refuses,
   * such as a singleton, throws here and not at `apply`.
   */
  spawn<const I extends readonly ComponentInput[]>(
    ...inputs: { readonly [K in keyof I]: I[K] & Targeted<I[K]> }
  ): Id {
    // Checked here, where the mistake is, and not when the queue is applied.
    this.world._registerAll(inputs);
    const entity = this.world._reserve();
    this.ops.push({
      op: "spawn",
      entity,
      inputs,
      fresh: this.world._reservedFresh,
    });
    // The id the buffer is made to give: an app's is `Spawned`.
    return entity as Id;
  }

  /** Queues a despawn, which `apply` makes as `World.despawn` does. */
  despawn(entity: Entity | Id): void {
    this.refuseFrozen("despawn");
    this.ops.push({ op: "despawn", entity: applied(entity) });
  }

  /**
   * Queues adding a component, or overwriting one the entity has, which
   * `apply` makes as `World.add` does. Adding a relation again gives it a new
   * target.
   */
  add<const I extends ComponentInput>(
    entity: Entity | Id,
    input: I & Targeted<I>
  ): void {
    this.refuseFrozen("add");
    this.world._registerAll([input]);
    this.ops.push({ op: "add", entity: applied(entity), input });
  }

  /** Queues removing a component, which `apply` makes as `World.remove` does. */
  remove(entity: Entity | Id, def: ComponentDef): void {
    this.refuseFrozen("remove");
    this.ops.push({ op: "remove", entity: applied(entity), def });
  }

  /** Refuses a command in a frozen world, since it would still change the world later. */
  private refuseFrozen(op: string): void {
    if (this.world._frozen) {
      throw new Error(frozenWrite(`Commands.${op}()`));
    }
  }

  /** Returns a position in the queue, for `rollback`. */
  mark(): number {
    return this.ops.length;
  }

  /**
   * Discards every command queued since `mark`. It gives back the ids of the
   * discarded spawns, newest first. When nothing else was spawned or despawned
   * in the meantime, the next entities get the same ids as if those spawns had
   * never been queued.
   */
  rollback(mark: number): void {
    for (let i = this.ops.length - 1; i >= mark; i--) {
      const cmd = this.ops[i]!;
      if (cmd.op === "spawn") {
        this.world._release(cmd.entity, cmd.fresh);
      }
    }
    this.ops.length = Math.min(this.ops.length, mark);
  }

  /**
   * Makes the queued commands in order, empties the queue, and returns how
   * many commands it ran. A command whose entity is gone by then does nothing,
   * and still counts.
   */
  apply(): number {
    if (this.ops.length === 0) {
      return 0;
    }
    const { ops } = this;
    this.ops = [];
    const { world } = this;
    for (let i = 0; i < ops.length; i++) {
      const cmd = ops[i]!;
      switch (cmd.op) {
        case "spawn": {
          if (world.isAlive(cmd.entity)) world._place(cmd.entity, cmd.inputs);
          break;
        }
        case "despawn": {
          world.despawn(cmd.entity);
          break;
        }
        case "add": {
          world.add(cmd.entity, cmd.input);
          break;
        }
        case "remove": {
          world.remove(cmd.entity, cmd.def);
          break;
        }
      }
    }
    return ops.length;
  }
}
