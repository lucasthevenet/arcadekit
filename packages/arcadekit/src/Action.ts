/**
 * Actions are requests to change the game, such as a player's move, a network
 * message or a bot's decision.
 *
 * An action's handler checks it against the current state, then applies it
 * or refuses it with a typed error. A dispatched action returns the refusal
 * to its caller as a typed failure, and a queued one becomes an
 * `Action.Rejected` event.
 *
 *   const PlayCard = Action.define("cards/PlayCard", Schema.Struct({ card: EntityId, target: EntityId }))
 *
 *   const playCard = Action.handler(PlayCard, function*({ card, target }) {
 *     const turn = yield* Turn
 *     if (turn.player !== owner) return yield* new NotYourTurn()
 *     const commands = yield* Commands
 *     commands.despawn(card)
 *     const played = yield* CardPlayed.emits
 *     played.emit({ card, target })
 *   })
 *
 *   app.dispatch(PlayCard, { card, target })  // Exit<void, NotYourTurn | Action.InvalidPayload>
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
 * actions, it holds a checkpoint of the world's hash at a regular interval of
 * ticks. An action that a system or a handler issues with the `Actions`
 * service isn't logged, since a replay's own simulation issues it again.
 * Replaying the log into a fresh app reproduces the game, and stops at the
 * first checkpoint that doesn't match.
 */
import { Context, Data, Effect, Schema } from "effect";

import type { WithSpawned } from "./ecs/spawned";
import * as Event from "./Event";
import type { Sim } from "./Services";
import type * as System from "./System";

/**
 * The payload didn't match the action's schema. The handler didn't run.
 *
 * @category Errors
 */
export class InvalidPayload extends Data.TaggedError("InvalidPayload")<{
  readonly action: string;
  /** What was wrong, as the schema reported it. */
  readonly message: string;
}> {}

/**
 * An action arrived by name, and the app has no handler for that name.
 *
 * @category Errors
 */
export class UnknownAction extends Data.TaggedError("UnknownAction")<{
  readonly action: string;
}> {}

/**
 * An action type, as `Action.define` makes it: its name, and the codec of its
 * payload.
 *
 * @typeParam N the action's name
 * @typeParam P the payload a handler receives
 *
 * @category Models
 */
export interface ActionDef<N extends string, P> {
  readonly name: N;
  /**
   * Validates the payload and converts it to and from JSON. Derived from the
   * action's schema.
   */
  readonly codec: Schema.Codec<P, unknown>;
  /** Holds no value. It keeps the payload type on the action, invariant. */
  readonly _P?: (payload: P) => P;
}

/**
 * Defines an action, with the schema of its payload. The payload type is
 * inferred from the schema, and every payload is validated against it:
 * `Action.define("duel/Strike", Schema.Struct({ ... }))`. An action with no
 * payload takes only its name, `Action.define("duel/Pass")`, and is issued
 * with `undefined`.
 *
 * **Details**
 *
 * The log and a save hold a payload in its JSON form, and the other peers
 * receive that form, so a bigint or a date in it is converted along the way.
 * The JSON form of an action with no payload is `null`.
 *
 * @category Constructors
 */
export function define<const N extends string>(name: N): ActionDef<N, void>;
export function define<
  const N extends string,
  S extends Schema.Codec<unknown, unknown>,
>(name: N, payload: S): ActionDef<N, S["Type"]>;
export function define(
  name: string,
  payload: Schema.Codec<unknown, unknown> = Schema.Void
): AnyActionDef {
  // The JSON codec turns values such as dates and bigints into JSON on the
  // way out and back on the way in, so the log is always safe to serialize.
  return { codec: Schema.toCodecJson(payload), name };
}

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
  readonly action: ActionDef<N, P>;
  readonly handle: (payload: P, origin: Origin) => Effect.Effect<A, E, R>;
}

/**
 * Any action, whatever its name and payload. A function that asks about the
 * action itself takes it, such as `handles` of the `Actions` service.
 *
 * @category Type-level
 */
export interface AnyActionDef {
  readonly name: string;
  readonly codec: Schema.Codec<unknown, unknown>;
}

/**
 * Any handler, whatever its action, result and requirements. Its payload is
 * `never`, since only code that checked a payload against the handler's
 * action may hand it one.
 *
 * @category Type-level
 */
export interface AnyHandler {
  readonly action: AnyActionDef;
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
 *     if (turn.player !== from) return yield* new NotYourTurn()
 *     ...
 *   })
 *
 * **Gotchas**
 *
 * - A handler can't dispatch another action, since `dispatch` throws there.
 *   It issues one with `Actions.enqueue` instead, and a refusal rolls that
 *   back too.
 * - A refusal rolls back what the handler did to the world, and nothing
 *   outside it, such as a variable of a module that the handler changed. A
 *   value a field holds is read-only, so the handler replaces it, and the
 *   refusal puts the old value back.
 *
 * @category Constructors
 */
export function handler<
  N extends string,
  P,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  A,
>(
  action: ActionDef<N, P>,
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
  action: ActionDef<N, P>,
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
export interface Checkpoint {
  /** The number of ticks completed when the hash was taken. */
  readonly tick: number;
  /** `world.hash()` at that point. */
  readonly hash: number;
}

/**
 * An entry of `app.actionLog`: an applied action, or a checkpoint.
 *
 * @category Models
 */
export type LogEntry = Logged | Checkpoint;

/**
 * Returns whether a log entry is a checkpoint, the world's hash at a tick,
 * rather than an action.
 *
 * @category Guards
 */
export const isCheckpoint = (entry: LogEntry): entry is Checkpoint =>
  "hash" in entry;

/**
 * Emitted when a queued action is refused. A dispatched action returns its
 * failure to the caller instead.
 *
 * **Details**
 *
 * The event's payload has these fields:
 *
 * - `action`: the action's name.
 * - `payload`: the payload in its JSON form, or `null` when its schema didn't
 *   take it.
 * - `error`: why it was refused, as the error's `_tag` and `message`, so the
 *   event is the same on every peer and in a save.
 * - `from`: the peer that issued it, as its handler would have received it.
 *
 * @category Events
 */
export const Rejected = Event.define(
  "Action.Rejected",
  Schema.Struct({
    action: Schema.String,
    payload: Schema.Unknown,
    error: Schema.Struct({ _tag: Schema.String, message: Schema.String }),
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
      action: ActionDef<N, P>,
      payload: WithSpawned<P>
    ) => void;
    /**
     * Returns whether the game has a handler for an action. An action without
     * one can't be issued: `enqueue` throws.
     */
    readonly handles: (action: AnyActionDef) => boolean;
  }
>()("arcadekit/Actions") {}

/**
 * The name of the store that holds an app's queued actions, as a snapshot
 * lists it in `readSnapshot(save.world).stores`. The store holds
 * `{ queued }`, the actions queued for the next tick, each
 * `{ name, payload, from? }` with its payload in JSON form.
 *
 * @category Constants
 */
export const INTAKE = "arcadekit/actions";
