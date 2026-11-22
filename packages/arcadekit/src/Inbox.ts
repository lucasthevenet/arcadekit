/**
 * A game's inbox: how an action enters it. An action is queued for the next
 * tick or applied now, and either way its handler runs in a transaction of
 * the world: one that is refused leaves the game as it was.
 *
 * Where an action is issued from says what it is. From the simulation, which
 * is a tick, a handler or a plugin's setup, it is the game's own doing and
 * isn't logged, since a replay does it again. From anywhere else it is input:
 * it is logged in its JSON form, and a session that has taken the app over
 * is handed it in place of the queue.
 *
 * It is the other side of `Outbox`, which is what a game sends out.
 */
import { Cause, Exit, Schema } from "effect";
import type { Effect, Fiber } from "effect";

import * as Action from "./Action";
import type { CommandBuffer } from "./ecs/commands";
import type { World } from "./ecs/world";
import type { EventBus } from "./Event";
import type * as Journal from "./Journal";
import type { Runner } from "./Runner";

/**
 * What an inbox works with: the parts of an app that an action touches.
 *
 * @category Models
 */
export interface Parts {
  readonly world: World;
  readonly commands: CommandBuffer;
  readonly events: EventBus;
  /** The actions queued for the next tick, a store of the world. */
  readonly intake: Action.Intake;
  readonly log: Journal.Log;
  readonly runner: Runner;
  readonly time: { readonly tick: number };
  /** The game's handlers, by the name of their action. */
  readonly handlers: ReadonlyMap<string, Action.AnyHandler>;
  /** Starts what a handler returned, with the app's services. */
  readonly run: (
    name: string,
    handled: Effect.Effect<unknown, unknown, unknown>
  ) => Fiber.Fiber<unknown, unknown>;
}

/**
 * A game's handlers by the name of their action, which is what an inbox
 * finds them by. Two for one action is a mistake of the program.
 *
 * @category Constructors
 */
export const handlersOf = (
  handlers: readonly Action.AnyHandler[]
): Map<string, Action.AnyHandler> => {
  const named = new Map<string, Action.AnyHandler>();
  for (const handler of handlers) {
    if (named.has(handler.action.name)) {
      throw new Error(`Two handlers for action "${handler.action.name}"`);
    }
    named.set(handler.action.name, handler);
  }
  return named;
};

/** Why an action was refused, as `Action.Rejected` carries it. */
const refusal = (error: unknown): { _tag: string; message: string } => {
  const tag =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
      ? error._tag
      : error instanceof Error
        ? error.name
        : "Error";
  return {
    _tag: tag,
    message: error instanceof Error ? error.message : String(error),
  };
};

/**
 * An app's inbox. The app's `enqueue`, `dispatch` and their by-name forms
 * are its methods, and a tick drains it before time advances.
 *
 * @category Models
 */
export class Inbox {
  /**
   * Who has taken over what comes from outside, if anyone has: a session,
   * with `app.divert`. It is handed each action issued from outside, by name
   * and in its JSON form, in place of the queue.
   */
  diverted: ((name: string, payload: unknown) => void) | undefined;
  private readonly parts: Parts;

  constructor(parts: Parts) {
    this.parts = parts;
  }

  /** Whether the game has a handler for an action. */
  handles(action: Action.AnyActionDef): boolean {
    return this.parts.handlers.has(action.name);
  }

  /**
   * Queues an action that arrived as data for the next tick, and logs it:
   * what came from outside, and what a session hands back.
   */
  deliver(name: string, payload: unknown, from?: string): void {
    const { intake, log } = this.parts;
    intake.queued.push({
      name,
      payload,
      codec: undefined,
      entry: log.arrived(name, payload, from),
      from,
    });
  }

  /**
   * `app.enqueue` and `Actions.enqueue`: an action with its payload as a
   * value, for the next tick. Where it is called from says what it is.
   */
  enqueue(
    action: Action.AnyActionDef,
    payload: unknown
  ): Exit.Exit<void, Action.InvalidPayload> {
    const { handlers, intake, log, runner } = this.parts;
    const handler = handlers.get(action.name);
    if (handler === undefined) {
      throw new Error(`No handler for action "${action.name}"`);
    }
    const { name } = action;
    const { codec } = handler.action;
    // The simulation's own move: not logged, because a replay's own
    // systems and handlers issue it again.
    if (runner.simulating) {
      intake.queued.push({
        name,
        payload,
        codec,
        entry: undefined,
        from: undefined,
      });
      return Exit.void;
    }
    // Input from outside. The log holds the JSON form, and the other
    // peers are sent it. A payload that has none is refused here, in a
    // game of one too: queued, it would be refused on this machine alone.
    const json = Schema.encodeUnknownExit(codec)(payload);
    if (Exit.isFailure(json)) {
      return Exit.fail(
        new Action.InvalidPayload({
          action: name,
          message: Action.said(Cause.squash(json.cause)),
        })
      );
    }
    if (this.diverted !== undefined) {
      this.diverted(name, json.value);
      return Exit.void;
    }
    intake.queued.push({
      name,
      payload,
      codec,
      entry: log.arrived(name, json.value, undefined),
      from: undefined,
    });
    return Exit.void;
  }

  /**
   * `Actions.enqueue`, whose payload the compiler has checked. Outside the
   * simulation, that is only the frame and input stages.
   */
  issue(action: Action.AnyActionDef, payload: unknown): void {
    const exit = this.enqueue(action, payload);
    if (Exit.isFailure(exit)) {
      throw new Error(
        `A system of the frame or input stage issued the action "${action.name}" with a payload its schema does not take: ${Action.said(Cause.squash(exit.cause))}. It runs on one machine, so no other peer could hear of it: issue a payload the schema takes.`
      );
    }
  }

  /** `app.enqueueByName`: an action as data, for the next tick. */
  enqueueByName(name: string, payload: unknown, from?: string): void {
    const { intake, runner } = this.parts;
    if (runner.simulating) {
      if (from !== undefined) {
        throw new Error(
          `enqueueByName("${name}") was given who issued it, "${from}", by the simulation. What the simulation issues is its own doing, on every peer alike, and nobody issued it.`
        );
      }
      intake.queued.push({
        name,
        payload,
        codec: undefined,
        entry: undefined,
        from,
      });
      return;
    }
    if (this.diverted === undefined) {
      this.deliver(name, payload, from);
      return;
    }
    if (from !== undefined) {
      throw new Error(
        `enqueueByName("${name}") was given who issued it, "${from}", on an app that a session has taken over. What a peer issues is stamped with that peer's own name, by its session, and nobody speaks for another.`
      );
    }
    this.diverted(name, payload);
  }

  /**
   * `app.dispatch`: applies an action now, between ticks, with its payload
   * as a value, and logs it if it is accepted. Returns what its handler
   * returned or failed with.
   */
  dispatch(
    action: Action.AnyActionDef,
    payload: unknown
  ): Exit.Exit<unknown, unknown> {
    this.betweenTicks(action.name);
    // A typed dispatch of an action nobody handles is a programming error.
    if (!this.handles(action)) {
      throw new Error(`No handler for action "${action.name}"`);
    }
    return this.apply(action.name, payload, "value", true, undefined);
  }

  /** `app.dispatchByName`: the same, with the action as data. */
  dispatchByName(
    name: string,
    payload: unknown,
    from?: string
  ): Exit.Exit<unknown, unknown> {
    this.betweenTicks(name);
    return this.apply(name, payload, "json", true, from);
  }

  /**
   * Applies every action queued, for the tick that begins. One that is
   * refused is told to the game as `Action.Rejected`, and its log entry
   * says why.
   */
  drain(): void {
    const { events, intake } = this.parts;
    if (intake.queued.length === 0) {
      return;
    }
    for (const action of intake.take()) {
      const { codec, entry, from, name, payload } = action;
      const exit = this.apply(
        name,
        payload,
        codec === undefined ? "json" : "value",
        false,
        from
      );
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        if (entry !== undefined) {
          entry.refused = Action.said(error);
        }
        events._emit(Action.Rejected, {
          action: name,
          payload: Action.jsonOf(action),
          error: refusal(error),
          from,
        });
      }
    }
  }

  /** Refuses a dispatch that isn't made between ticks, on an app of one. */
  private betweenTicks(name: string): void {
    if (this.diverted !== undefined) {
      throw new Error(
        `dispatch("${name}") was called on an app that a session has taken over. It would apply the action on this machine alone, and the peers would no longer be playing the same game. Use enqueue: the session has every peer apply it on the same tick.`
      );
    }
    const now = this.parts.runner.phase;
    if (now === "tick") {
      throw new Error(
        `dispatch("${name}") was called during a tick. Use enqueue: it applies the action at the start of the next tick.`
      );
    }
    if (now === "frame" || now === "input") {
      throw new Error(
        `dispatch("${name}") was called during the ${now} stage, which must not change the game. Issue it with Actions.enqueue: it is applied at the start of the next tick.`
      );
    }
  }

  /**
   * Rolls back everything a handler did since the command buffer's mark was
   * taken: the world's rollback takes back what it wrote, emitted, read and
   * enqueued.
   */
  private undo(mark: number): void {
    const { commands, world } = this.parts;
    world.rollback();
    commands.rollback(mark);
  }

  /**
   * Validates a payload and runs its handler to completion. `payload` is in
   * the form `form` says: the value a handler works with, or its JSON form.
   * The handler runs in a world transaction: a refusal rolls back its
   * component writes, the random numbers it drew, what it read of events and
   * changes, and what it queued, emitted and enqueued. With `dispatched`, an
   * accepted action is logged; an enqueued one was logged on arrival, if it
   * came from outside.
   */
  private apply(
    name: string,
    payload: unknown,
    form: "json" | "value",
    dispatched: boolean,
    from: string | undefined
  ): Exit.Exit<unknown, unknown> {
    const { commands, events, handlers, log, run, runner, time, world } =
      this.parts;
    const handler = handlers.get(name);
    if (handler === undefined) {
      return Exit.fail(new Action.UnknownAction({ action: name }));
    }
    log.start();

    // Work out both forms of the payload: the value for the handler and the
    // JSON form for the log. Converting between them is what validates it.
    const { codec } = handler.action;
    const converted =
      form === "json"
        ? Schema.decodeUnknownExit(codec)(payload)
        : Schema.encodeUnknownExit(codec)(payload);
    if (Exit.isFailure(converted)) {
      const error = Cause.squash(converted.cause);
      return Exit.fail(
        new Action.InvalidPayload({
          action: name,
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
    const value = form === "json" ? converted.value : payload;
    const logged = form === "json" ? payload : converted.value;

    if (runner.phase === "handler") {
      throw new Error(
        `dispatch("${name}") was called from the handler of "${runner.applying}". A handler issues another action with Actions.enqueue, which applies it on the next tick.`
      );
    }
    const mark = commands.mark();
    world.begin();
    runner.applying = name;
    events.reader = `action:${name}`;
    world.reader = events.reader;
    let exit: Exit.Exit<unknown, unknown>;
    try {
      exit = runner.finish(
        // The payload is the action's: its schema decoded it, or the
        // compiler checked it in a typed dispatch.
        () => run(name, handler.handle(value as never, { from })),
        `The handler for "${name}"`,
        () =>
          `The handler for "${name}" did not finish synchronously. Handlers must not wait.`,
        false
      );
    } catch (error) {
      this.undo(mark);
      throw error;
    } finally {
      runner.applying = undefined;
    }
    // A refusal, and a handler that died of a bug half-way, both leave the
    // game as it was.
    if (Exit.isFailure(exit)) {
      this.undo(mark);
    } else {
      world.commit();
      commands.apply();
      // A tick tells the stages between ticks what it emitted when it
      // ends; an action applied between two is of the tick to come.
      if (!runner.ticking) {
        events.told(time.tick + 1);
      }
      if (dispatched) {
        log.accepted(name, logged, from);
      }
    }
    return exit;
  }
}
