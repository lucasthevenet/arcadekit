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
 * Queues structural changes so they can be made from inside query loops, and
 * applied in one pass at a known point in the tick.
 *
 * @category Models
 */
export class CommandBuffer<Id extends Entity | Spawned = Entity> {
  private ops: Command[] = [];

  constructor(readonly world: World) {}

  get size(): number {
    return this.ops.length;
  }

  /** Returns the new entity's id immediately; it receives its components on apply. */
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

  despawn(entity: Entity | Id): void {
    this.refuseFrozen("despawn");
    this.ops.push({ op: "despawn", entity: applied(entity) });
  }

  add<const I extends ComponentInput>(
    entity: Entity | Id,
    input: I & Targeted<I>
  ): void {
    this.refuseFrozen("add");
    this.world._registerAll([input]);
    this.ops.push({ op: "add", entity: applied(entity), input });
  }

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
   * Discards every command queued since `mark`. The ids of entities whose spawn
   * is discarded are returned to the pool, newest first, so the world is left
   * as if they were never requested: the next entities get the same ids either
   * way.
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

  /** Applies queued commands in order, and returns how many were applied. */
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
