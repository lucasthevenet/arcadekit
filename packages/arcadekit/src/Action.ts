/**
 * Actions are requests to change the game, such as a player's move, a network
 * message or a bot's decision.
 *
 * An action's handler checks it against the current state, then applies it
 * or refuses it with a typed error. A dispatched action fails with the refusal,
 * a typed error of its Effect, and a queued one becomes an event that
 * `Action.rejected` reads. An action declares the schema of the error it may
 * be refused with, as `Rpc.make` does, and each error has a `_tag`.
 *
 *   class NotYourTurn extends Schema.TaggedError<NotYourTurn>()("NotYourTurn", {}) {}
 *   const PlayCard = Action.define("cards/PlayCard", Schema.Struct({ card: EntityId, target: EntityId }), { error: NotYourTurn })
 *
 *   const playCard = Action.handler(PlayCard, function*({ card, target }) {
 *     const turn = yield* Turn
 *     if (turn.player !== owner) return yield* NotYourTurn.make({})
 *     const commands = yield* Commands
 *     commands.despawn(card)
 *     const played = yield* CardPlayed.emits
 *     played.emit({ card, target })
 *   })
 *
 *   yield* app.dispatch(PlayCard, { card, target })  // fails with NotYourTurn | Action.InvalidPayload
 *
 * A refused action changes nothing. Its handler runs in a world transaction,
 * so a refusal at any point rolls back the component writes, the random
 * numbers drawn, the commands queued, the events emitted and the actions
 * enqueued. The events the handler read are unread again. A handler spawns
 * and despawns entities through `Commands`, since the `World` it is handed
 * has no `spawn`, and an `EcsWorld`'s `spawn` and similar methods throw while
 * a handler runs.
 *
 * An action's schema validates its payload on every path into the game. It
 * also gives the payload the JSON form that the log, a save and the other
 * peers hold.
 *
 * `app.actionLog` holds every action from outside the simulation, except a
 * dispatched action that was refused, which changed nothing. Among the
 * actions, it holds a hash check of the world's hash at a regular interval of
 * ticks. An action that a system or a handler issues with the `Actions`
 * service isn't logged, since a replay's own simulation issues it again.
 * Replaying the log into a fresh app reproduces the game, and stops at the
 * first hash check that doesn't match.
 */
import { Context, Effect, Schema } from "effect";

import type { WithSpawned } from "./ecs/spawned.ts";
import * as Event from "./Event.ts";
import type { Sim } from "./Services.ts";
import type * as System from "./System.ts";

/**
 * The payload didn't match the action's schema. The handler didn't run.
 *
 * @category Errors
 */
export class InvalidPayload extends Schema.TaggedError<InvalidPayload>()(
  "ActionInvalidPayload",
  {
    action: Schema.String,
    /** What was wrong, as the schema reported it. */
    message: Schema.String,
  }
) {}

/**
 * An action arrived by name, and the app has no handler for that name.
 *
 * @category Errors
 */
export class Unknown extends Schema.TaggedError<Unknown>()("ActionUnknown", {
  action: Schema.String,
}) {}

/**
 * An action its handler refused, as `Action.rejected` reads it: the payload
 * the handler received, the refusal it failed with, and who issued it.
 *
 * @typeParam P the action's payload
 * @typeParam E the error its action declares
 *
 * @category Models
 */
export interface Refused<P, E> {
  readonly payload: P;
  readonly error: E;
  readonly from: string | undefined;
}

/**
 * An action type, as `Action.define` makes it: its name, the codec of its
 * payload, and the codec of its error.
 *
 * @typeParam N the action's name
 * @typeParam P the payload a handler receives
 * @typeParam E the error its handler may refuse it with
 *
 * @category Models
 */
export interface Action<N extends string, P, E = unknown> {
  readonly name: N;
  /**
   * Validates the payload and converts it to and from JSON. Derived from the
   * action's schema.
   */
  readonly codec: Schema.Codec<P, unknown>;
  /**
   * Validates a refusal and converts it to and from JSON. Derived from the
   * action's error schema.
   */
  readonly error: Schema.Codec<E, unknown>;
  /** The event of the action's refusals, which `Action.rejected` returns. */
  readonly rejected: Event.Event<Refused<P, E>>;
  /** Holds no value. It keeps the payload type on the action, invariant. */
  readonly _P?: (payload: P) => P;
}

/** A schema whose values and encoded form each have a `_tag`. */
type Tagged = Schema.Codec<
  { readonly _tag: string },
  { readonly _tag: string }
>;

/**
 * Defines an action, with the schema of its payload. The payload type is
 * inferred from the schema, and every payload is validated against it:
 * `Action.define("duel/Strike", Schema.Struct({ ... }))`. An action with no
 * payload takes only its name, `Action.define("duel/Pass")`, and is issued
 * with `undefined`.
 *
 * The third argument declares the schema of the error its handler refuses
 * the action with, as `Rpc.make` does: `{ error: NotYourTurn }`, or
 * `{ error: Schema.Union([NotYourTurn, TooTired]) }` for several. Without it
 * the error is `Schema.Never`, and the handler can't refuse the action. A
 * handler that fails with an error outside the schema doesn't compile. An
 * action with no payload and an error takes `Schema.Void` as its payload.
 *
 * The error is tagged: each value it takes, and its encoded form, has a
 * `_tag`, as a class made with `Schema.TaggedError` or a `Schema.TaggedStruct`
 * has. `Action.Rejected` reads the tag of any action's refusal.
 *
 * **Details**
 *
 * The log and a save hold a payload in its JSON form, and the other peers
 * receive that form, so a bigint or a date in it is converted along the way.
 * The JSON form of an action with no payload is `null`. The world's hash and a
 * save hold a refusal in its JSON form too, so every peer reads the same one.
 *
 * @category Constructors
 */
export function define<const N extends string>(name: N): Action<N, void, never>;
export function define<
  const N extends string,
  S extends Schema.Codec<unknown, unknown>,
  Err extends Tagged = typeof Schema.Never,
>(
  name: N,
  payload: S,
  options?: { readonly error?: Err }
): Action<N, S["Type"], Err["Type"]>;
export function define(
  name: string,
  payload: Schema.Codec<unknown, unknown> = Schema.Void,
  options?: { readonly error?: Tagged }
): Any {
  const error = options?.error ?? Schema.Never;
  // The JSON codec turns values such as dates and bigints into JSON on the
  // way out and back on the way in, so the log is always safe to serialize.
  return {
    codec: Schema.toCodecJson(payload),
    name,
    error: Schema.toCodecJson(error),
    rejected: Event.define(
      `Action.Rejected(${name})`,
      Schema.Struct({
        payload,
        error,
        from: Schema.UndefinedOr(Schema.String),
      })
    ),
  };
}

/**
 * Returns the event of an action's refusals, whose reader gives each time its
 * handler refused it, with the payload and the refusal typed:
 *
 *   for (const { error, from } of (yield* Action.rejected(PlayCard)).read()) {
 *     if (error._tag === "NotYourTurn") ...
 *   }
 *
 * **Details**
 *
 * The event is named `Action.Rejected(<the action's name>)`. The world's hash
 * and a save hold its refusals in their JSON form, so every peer reads the
 * same one. A payload that the action's schema doesn't take never reaches the
 * handler, and `Action.Rejected` alone reports it.
 *
 * @category Events
 */
export const rejected = <N extends string, P, E>(
  action: Action<N, P, E>
): Event.Event<Refused<P, E>> => action.rejected;

/**
 * Where an action came from, which a handler receives alongside its payload.
 *
 * **Details**
 *
 * Whatever delivered the action stamps its origin on the way in. The origin
 * isn't part of the payload, so the issuer can't claim another identity in
 * it. A session stamps each peer's actions with that peer's name.
 *
 * @category Models
 */
export interface Origin {
  /**
   * The peer that issued the action: a peer name of the session, or the name
   * passed to `enqueueByName` or `dispatchByName`. Undefined for an action this
   * program issued itself: one enqueued or dispatched through the app in a
   * single-player game, or issued by the simulation with `Actions`.
   */
  readonly from: string | undefined;
}

/**
 * How an action is applied, as `Action.handler` makes it: the action, and
 * what the handler does with a payload and its origin.
 *
 * @category Models
 */
export interface Handler<N extends string, P, A, E, R> {
  readonly action: Action<N, P>;
  readonly handle: (payload: P, origin: Origin) => Effect.Effect<A, E, R>;
}

/**
 * Any action, whatever its name and payload. A function that asks about the
 * action itself takes it, such as `handles` of the `Actions` service.
 *
 * @category Type-level
 */
export interface Any {
  readonly name: string;
  readonly codec: Schema.Codec<unknown, unknown>;
  readonly error: Schema.Codec<unknown, unknown>;
  readonly rejected: Event.Event<Refused<unknown, unknown>>;
}

/**
 * Any handler, whatever its action, result and requirements. Its payload is
 * `never`, since only code that checked a payload against the handler's
 * action may hand it one.
 *
 * @category Type-level
 */
export interface AnyHandler {
  readonly action: Any;
  readonly handle: (
    payload: never,
    origin: Origin
  ) => Effect.Effect<unknown, unknown, unknown>;
}

/**
 * Defines how an action is checked against the game's rules and applied. The
 * handler must finish synchronously. It receives a payload that is already
 * validated, since a payload that the action's schema refuses fails with
 * `InvalidPayload` before the handler runs. Alongside the payload, it
 * receives the action's `Origin`, `{ from }`, which in a multiplayer game
 * names the peer that issued the action.
 *
 *   const pass = Action.handler(Pass, function* (_, { from }) {
 *     const turn = yield* Turn
 *     if (turn.player !== from) return yield* NotYourTurn.make({})
 *     ...
 *   })
 *
 * **Gotchas**
 *
 * - A handler can't dispatch another action, since `dispatch` dies there.
 *   It issues one with `Actions.enqueue` instead, and a refusal rolls that
 *   back too.
 * - A refusal rolls back what the handler did to the world, and nothing
 *   outside it, such as a variable of a module that the handler changed. A
 *   value a field holds is read-only, so the handler replaces it, and the
 *   refusal puts the old value back.
 * - A handler fails only with the error its action declares in
 *   `Action.define`. Any other error doesn't compile, and the compiler names
 *   it.
 *
 * @category Constructors
 */
export function handler<
  N extends string,
  P,
  E,
  Eff extends Effect.Effect<unknown, E, unknown>,
  A,
>(
  action: Action<N, P, E>,
  body: System.TickGated<
    Eff,
    (payload: P, origin: Origin) => Generator<Eff, A, never>
  >
): Handler<
  N,
  P,
  A,
  Effect.Error<Eff> | InvalidPayload,
  Exclude<Effect.Services<Eff>, Sim>
>;
export function handler<
  N extends string,
  P,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  A,
>(
  action: Action<N, P>,
  body: (payload: P, origin: Origin) => Generator<Eff, A, never>
): Handler<
  N,
  P,
  A,
  Effect.Error<Eff> | InvalidPayload,
  Exclude<Effect.Services<Eff>, Sim>
> {
  return {
    action,
    // Built once: `fnUntraced` runs the generator itself on each call, with no
    // closure around the payload and no stack trace captured.
    handle: Effect.fnUntraced(body) as (
      payload: P,
      origin: Origin
    ) => Effect.Effect<
      A,
      Effect.Error<Eff> | InvalidPayload,
      Exclude<Effect.Services<Eff>, Sim>
    >,
  };
}

/**
 * One action from outside the simulation, as recorded in `app.actionLog`: a
 * dispatched action that was accepted, or an enqueued one.
 *
 * @category Models
 */
export interface Logged {
  /** The number of ticks completed when the action was dispatched or enqueued. */
  readonly tick: number;
  readonly name: string;
  /** The payload in its JSON form. */
  readonly payload: unknown;
  /**
   * The peer that issued it, when it came with a name. Absent for an action
   * this program issued itself.
   */
  readonly from?: string;
  /**
   * Present on an enqueued action, which was applied at the start of the next
   * tick and which a replay enqueues again. Absent on a dispatched one.
   */
  readonly queued?: true;
  /**
   * Present on an enqueued action that was refused when it was applied, with
   * a short reason. A dispatched action that was refused isn't logged.
   */
  readonly refused?: string;
}

/**
 * The world's hash at one point in the game, as recorded in `app.actionLog`. A
 * replay compares its own world against it to detect divergence.
 *
 * @category Models
 */
export interface HashCheck {
  /** The number of ticks completed when the hash was taken. */
  readonly tick: number;
  /** `world.hash()` at that point. */
  readonly hash: number;
}

/**
 * An entry of `app.actionLog`: an applied action, or a hash check.
 *
 * @category Models
 */
export type LogEntry = Logged | HashCheck;

/**
 * Returns whether a log entry is a hash check, the world's hash at a tick,
 * rather than an action.
 *
 * @category Guards
 */
export const isHashCheck = (entry: LogEntry): entry is HashCheck =>
  "hash" in entry;

/**
 * Emitted when a queued action is refused, whatever the action. A dispatched
 * action returns its failure to the caller instead. `Action.rejected` reads
 * the refusals of one action, typed.
 *
 * **Details**
 *
 * The event's payload has these fields:
 *
 * - `action`: the action's name.
 * - `payload`: the payload in its JSON form, or `null` when its schema didn't
 *   take it.
 * - `error`: why it was refused, in its JSON form: a refusal the action
 *   declares, `Action.InvalidPayload` or `Action.Unknown`, each with its `_tag`. It is
 *   the same on every peer and in a save.
 * - `from`: the peer that issued it, as its handler would have received it.
 *
 * @category Events
 */
export const Rejected = Event.define(
  "Action.Rejected",
  Schema.Struct({
    action: Schema.String,
    payload: Schema.Unknown,
    error: Schema.StructWithRest(Schema.Struct({ _tag: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
    from: Schema.UndefinedOr(Schema.String),
  })
);

/**
 * The service through which systems and handlers issue actions, so a bot
 * plays by the same rules as players. An action it enqueues is applied at the
 * start of the next tick. Its `enqueue` is `app.enqueue`, for code that has no
 * app at hand.
 *
 * **Details**
 *
 * Where `enqueue` is called decides whether the action is logged, as for
 * `app.enqueue`. From a system of the tick, a handler or a plugin's setup, the
 * action is the simulation's own and isn't logged, since a replay issues it
 * again. From a system of the frame or input stage, the action is input and
 * is logged, since a replay runs neither stage.
 *
 * **Gotchas**
 *
 * - In the frame or input stage, `enqueue` throws on a payload that the
 *   action's schema does not take, where `app.enqueue` returns the failure.
 * - `enqueue` throws for an action that the game has no handler for, and
 *   `handles` says whether it has one.
 *
 * @category Services
 */
export class Actions extends Context.Service<
  Actions,
  {
    readonly enqueue: <N extends string, P>(
      action: Action<N, P>,
      payload: WithSpawned<P>
    ) => void;
    /**
     * Returns whether the game has a handler for an action. An action without
     * one can't be issued: `enqueue` throws.
     */
    readonly handles: (action: Any) => boolean;
  }
>()("arcadekit/Action.Actions") {}

/**
 * The name of the store that holds an app's queued actions, as a snapshot
 * lists it in `readSnapshot(save.world).stores`. The store holds
 * `{ queued, rests? }`: the actions queued for the next tick, each
 * `{ name, payload, from? }` with its payload in JSON form, and
 * `rests: true` when the game's last tick changed nothing but its time, so
 * that a game loaded from it is at rest.
 *
 * @category Constants
 */
export const INTAKE = "arcadekit/actions";
