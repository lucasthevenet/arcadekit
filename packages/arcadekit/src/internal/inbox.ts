/**
 * A game's inbox is how an action enters the game. An action is queued for the
 * next tick or applied now. Either way its handler runs in a transaction of
 * the world, and a refused action leaves the game as it was.
 *
 * Where an action is issued from says what it is. An action the simulation
 * issues, from a tick, a handler or a plugin's setup, is the game's own doing.
 * It isn't logged, since a replay issues it again. An action issued from
 * anywhere else is input. It is logged in its JSON form, and a session that
 * has taken the app over is handed it in place of the queue.
 *
 * The inbox is the other side of `Outbox`, which holds what a game sends out.
 */
import { Cause, Exit, Option, Schema } from "effect";
import type { Effect, Fiber } from "effect";

import * as Action from "../Action";
import type { CommandBuffer } from "../ecs/commands";
import type { Spawned } from "../ecs/spawned";
import type { World } from "../ecs/world";
import type { EventBus } from "../Event";
import type * as Journal from "../Journal";
import type { Runner } from "./runner";
import { GameTime } from "./stage";

/**
 * What an inbox works with: the parts of an app that an action touches.
 *
 * @category Models
 */
export interface Parts {
  readonly world: World;
  readonly commands: CommandBuffer<Spawned>;
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
 * Returns a game's handlers by the name of their action, which is how an inbox
 * finds them. It throws for two handlers of one action.
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

/** An action whose payload its schema took, ready for its handler. */
interface Parsed {
  readonly handler: Action.AnyHandler;
  /** The payload as its handler works with it. */
  readonly value: unknown;
  /** The payload in its JSON form. */
  readonly json: unknown;
}

const InvalidJson = Schema.toCodecJson(Action.InvalidPayload);
const UnknownJson = Schema.toCodecJson(Action.UnknownAction);
const isRejected = Schema.is(Action.Rejected.codec);
const isUnknown = Schema.is(Action.UnknownAction);

/**
 * An app's inbox. The app's `enqueue`, `dispatch` and their by-name forms
 * are its methods, and a tick drains it before time advances.
 *
 * @category Models
 */
export class Inbox {
  /**
   * Whoever has taken over what comes from outside, which is a session, or
   * undefined. It is handed each action issued from outside, by name and in
   * its JSON form, in place of the queue.
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
   * Queues an action that arrived as data for the next tick, and logs it. It
   * takes what came from outside, and what a session hands back.
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
   * Queues an action with its payload as a value for the next tick, as
   * `app.enqueue` and `Actions.enqueue` do. Where it is called from says what
   * it is. Outside the simulation, a payload the action's schema can't encode
   * fails with `Action.InvalidPayload`. An action the game has no handler for
   * throws.
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
        Action.InvalidPayload.make({
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
   * Queues an action for `Actions.enqueue`, whose payload the compiler has
   * checked. Outside the simulation, `Actions.enqueue` is called only from the
   * frame and input stages, and a payload the schema can't encode throws there.
   */
  issue(action: Action.AnyActionDef, payload: unknown): void {
    const exit = this.enqueue(action, payload);
    if (Exit.isFailure(exit)) {
      throw new Error(
        `A system of the frame or input stage issued the action "${action.name}" with a payload its schema does not take: ${Action.said(Cause.squash(exit.cause))}. It runs on one machine, so no other peer could hear of it: issue a payload the schema takes.`
      );
    }
  }

  /**
   * Queues an action as data for the next tick, as `app.enqueueByName` does.
   */
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
   * Applies an action now, between ticks, with its payload as a value, as
   * `app.dispatch` does, and logs it if it is accepted. Returns what its
   * handler returned or failed with. It throws during a tick, a stage or a
   * handler, and on an app that a session has taken over.
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
    return this.apply(action.name, payload, "value", undefined);
  }

  /**
   * Applies an action now, with the action as data, as `app.dispatchByName`
   * does. It otherwise works as `dispatch` does.
   */
  dispatchByName(
    name: string,
    payload: unknown,
    from?: string
  ): Exit.Exit<unknown, unknown> {
    this.betweenTicks(name);
    return this.apply(name, payload, "json", from);
  }

  /**
   * Applies every queued action, for the tick that begins. For each refused
   * action it emits `Action.Rejected`, and the action's own event of
   * refusals when its handler refused it, and the action's log entry says
   * why. A handler that dies, or fails with an error its action doesn't
   * declare, is a bug: what it did is undone, and the returned failure holds
   * the defect, for the tick to fail with.
   */
  drain(): Exit.Exit<void, unknown> {
    const { events, intake } = this.parts;
    if (intake.queued.length === 0) {
      return Exit.void;
    }
    const defects: Exit.Exit<void, unknown>[] = [];
    for (const action of intake.take()) {
      const { codec, entry, from, name, payload } = action;
      const parsed = this.parse(
        name,
        payload,
        codec === undefined ? "json" : "value"
      );
      const exit = Exit.isSuccess(parsed)
        ? this.run(name, parsed.value, false, from)
        : parsed;
      if (Exit.isSuccess(exit)) {
        continue;
      }
      if (entry !== undefined) {
        entry.refused = Action.said(Cause.squash(exit.cause));
      }
      const error =
        Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)
          ? Option.none()
          : Cause.findErrorOption(exit.cause);
      if (Option.isNone(error)) {
        defects.push(Exit.asVoid(exit));
        continue;
      }
      const json = Schema.encodeUnknownExit(
        Exit.isSuccess(parsed)
          ? parsed.value.handler.action.error
          : isUnknown(error.value)
            ? UnknownJson
            : InvalidJson
      )(error.value);
      const rejected = Exit.isSuccess(json)
        ? {
            action: name,
            payload: Action.jsonOf(action),
            error: json.value,
            from,
          }
        : undefined;
      if (!isRejected(rejected)) {
        defects.push(
          Exit.die(
            new Error(
              `The handler for "${name}" failed with ${Action.said(error.value)}, which the error schema of its action does not take. Declare it in Action.define(name, payload, { error }), as a class made with Schema.TaggedError.`
            )
          )
        );
        continue;
      }
      events._emit(Action.Rejected, rejected);
      if (Exit.isSuccess(parsed)) {
        events._emit(parsed.value.handler.action.rejected, {
          payload: parsed.value.value,
          error: error.value,
          from,
        });
      }
    }
    return Exit.asVoidAll(defects);
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

  /** Validates a dispatched payload and runs its handler, as `run` does. */
  private apply(
    name: string,
    payload: unknown,
    form: "json" | "value",
    from: string | undefined
  ): Exit.Exit<unknown, unknown> {
    const parsed = this.parse(name, payload, form);
    return Exit.isSuccess(parsed)
      ? this.run(name, parsed.value, true, from)
      : parsed;
  }

  /**
   * Finds an action's handler and validates its payload, which is in the form
   * `form` says: the value a handler works with, or its JSON form.
   */
  private parse(
    name: string,
    payload: unknown,
    form: "json" | "value"
  ): Exit.Exit<Parsed, Action.InvalidPayload | Action.UnknownAction> {
    const { handlers, log } = this.parts;
    const handler = handlers.get(name);
    if (handler === undefined) {
      return Exit.fail(Action.UnknownAction.make({ action: name }));
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
        Action.InvalidPayload.make({
          action: name,
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
    return Exit.succeed({
      handler,
      value: form === "json" ? converted.value : payload,
      json: form === "json" ? payload : converted.value,
    });
  }

  /**
   * Runs a parsed action's handler to completion. The handler runs in a world
   * transaction: a refusal rolls back its component writes, the random
   * numbers it drew, what it read of events and changes, and what it queued,
   * emitted and enqueued. With `dispatched`, an accepted action is logged; an
   * enqueued one was logged on arrival, if it came from outside.
   */
  private run(
    name: string,
    { handler, json, value }: Parsed,
    dispatched: boolean,
    from: string | undefined
  ): Exit.Exit<unknown, unknown> {
    const { commands, events, log, run, runner, time, world } = this.parts;
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
      // ends; an action applied between two is of the tick to come, which
      // a game that rests then wants, to follow it up.
      if (!runner.ticking) {
        events.told(time.tick + 1);
        const { intake } = this.parts;
        intake.wanted = true;
        // The next tick is held to the game as the action left it.
        if (intake.rest !== undefined) {
          intake.rest = world._frameHash(false, GameTime.component);
        }
      }
      if (dispatched) {
        log.accepted(name, json, from);
      }
    }
    return exit;
  }
}
