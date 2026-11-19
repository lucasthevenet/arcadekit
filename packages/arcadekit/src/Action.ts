/**
 * Actions are the rules layer: actions in, events out.
 *
 * An action is a request to change the game from outside the simulation: a
 * player's move, a network message, an AI decision. A handler validates it
 * against the current state, and either applies it or refuses it with a typed
 * error.
 *
 *   const PlayCard = Action.define<{ card: Entity; target: Entity }>()("PlayCard")
 *
 *   const playCard = Action.handler(PlayCard, function*({ card, target }) {
 *     const turn = yield* Turn
 *     if (turn.player !== owner) return yield* new NotYourTurn()
 *     (yield* Commands).despawn(card)
 *     (yield* CardPlayed).emit({ card, target })
 *   })
 *
 *   const result = app.dispatch(PlayCard, { card, target })   // Exit<void, NotYourTurn>
 *
 * A refused action changes nothing. Its handler runs in a world transaction, so
 * a refusal at any point rolls back the component writes, the random numbers
 * drawn, the commands queued, the events emitted and the actions enqueued, and
 * marks the events it read as unread. A handler spawns and despawns entities
 * through `Commands`; calling `world.spawn` and similar methods in one throws.
 *
 * Give an action a schema and its payload is validated on every path into the
 * game, and stored in the log in a JSON-safe form:
 *
 *   const PlayCard = Action.define("PlayCard", Schema.Struct({ card: EntityId, target: EntityId }))
 *
 * Every action from outside the simulation goes into `app.actionLog`, except a
 * dispatched action that was refused, which changed nothing, along with a
 * checkpoint of the world's hash at a regular interval of ticks. An action a
 * system or a script issues itself, with the `Actions` service, isn't logged: a
 * replay's own simulation issues it again. Replaying the log into a fresh app
 * reproduces the game, and stops at the first checkpoint that doesn't match.
 */
import { Context, Data, Effect, Schema } from "effect";
import type { Exit } from "effect";

import * as Event from "./Event";

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
 * @param N  the action's name
 * @param P  the payload a handler receives
 * @param VE `InvalidPayload` when the action has a schema, otherwise `never`
 *
 * @category Models
 */
export interface ActionDef<N extends string, P, VE = never> {
  readonly name: N;
  /**
   * Validates the payload and converts it to and from JSON. Derived from the
   * action's schema; undefined for an action defined with only a type.
   */
  readonly codec: Schema.Codec<P, unknown> | undefined;
  /** Type-only: keeps the payload type attached and invariant. */
  readonly _P?: (payload: P) => P;
  /** Type-only. */
  readonly _VE?: VE;
}

/**
 * Defines an action.
 *
 * With a schema, the payload type is inferred from it and every payload is
 * validated: `Action.define("Strike", Schema.Struct({ ... }))`. The log and
 * saves hold the payload in its JSON form, and that form is what other peers
 * receive, so a bigint or a date in it is converted along the way.
 *
 * Without one, only the compiler checks the payload, which is fine for actions
 * that never leave the program. It is curried so you can pass the payload type
 * while the name is inferred: `Action.define<Payload>()("Strike")`.
 *
 * **Gotchas**
 *
 * An action without a schema can't be saved while it waits for a tick:
 * `app.save()` fails with `SaveRefused`. It can't be sent to the other peers of
 * a session either: `app.enqueue` throws.
 *
 * @category Constructors
 */
export function define<P = void>(): <const N extends string>(
  name: N
) => ActionDef<N, P>;
export function define<
  const N extends string,
  S extends Schema.Codec<unknown, unknown>,
>(name: N, payload: S): ActionDef<N, S["Type"], InvalidPayload>;
export function define(
  name?: string,
  payload?: Schema.Codec<unknown, unknown>
): unknown {
  if (name === undefined || payload === undefined) {
    return (typeOnlyName: string) => ({
      codec: undefined,
      name: typeOnlyName,
    });
  }
  // The JSON codec turns values such as dates and bigints into JSON on the
  // way out and back on the way in, so the log is always safe to serialize.
  return { codec: Schema.toCodecJson(payload), name };
}

/**
 * Where an action came from, which a handler receives alongside its payload.
 *
 * Whatever delivered the action stamps it on the way in. It isn't part of the
 * payload, so the issuer can't claim another identity: a session stamps each
 * peer's actions with that peer's name.
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
 * How an action is applied: the action, and what it does with a payload and its
 * issuer. Made with `Action.handler`.
 *
 * @category Models
 */
export interface Handler<N extends string, P, A, E, R> {
  readonly action: ActionDef<N, P, unknown>;
  readonly handle: (payload: P, origin: Origin) => Effect.Effect<A, E, R>;
}

/**
 * Any action, whatever its name and payload: what a question about the action
 * itself, such as whether it has a handler, takes.
 *
 * @category Type-level
 */
export interface AnyActionDef {
  readonly name: string;
  readonly codec: Schema.Codec<unknown, unknown> | undefined;
}

/**
 * Any handler, whatever its action, result and requirements. Its payload is
 * `never`, since only whoever checked a payload against the handler's action
 * may hand it one.
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
 * Defines how an action is validated against the rules and applied. It must
 * complete synchronously. For an action with a schema, the payload it receives
 * is already validated.
 *
 * Alongside the payload, it receives where the action came from, `{ from }`: in
 * a multiplayer game, the peer that issued it.
 *
 *   const pass = Action.handler(Pass, function* (_, { from }) {
 *     const turn = yield* Turn
 *     if (turn.player !== from) return yield* new NotYourTurn()
 *     ...
 *   })
 *
 * **Gotchas**
 *
 * - A handler can't dispatch another action, which throws. It issues one with
 *   `Actions.enqueue` instead, and a refusal rolls that back too.
 * - A refusal rolls back what the handler did to the world, and nothing outside
 *   it: not an object held in a field and mutated in place, not a call to your
 *   game's own service, and not a script it started.
 *
 * @category Constructors
 */
export const handler = <
  N extends string,
  P,
  VE,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  A,
>(
  action: ActionDef<N, P, VE>,
  body: (payload: P, origin: Origin) => Generator<Eff, A, never>
): Handler<N, P, A, Effect.Error<Eff> | VE, Effect.Services<Eff>> => ({
  action,
  // Built once: `fnUntraced` runs the generator itself on each call, with no
  // closure around the payload and no stack trace captured.
  handle: Effect.fnUntraced(body) as (
    payload: P,
    origin: Origin
  ) => Effect.Effect<A, Effect.Error<Eff> | VE, Effect.Services<Eff>>,
});

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
  /** For an action with a schema, the payload in its JSON form. */
  readonly payload: unknown;
  /**
   * The peer that issued it, when it came with a name. Absent for an action
   * this program issued itself.
   */
  readonly from?: string;
  /**
   * Present on an enqueued action: it was applied at the start of the next
   * tick, and a replay enqueues it again. Absent on a dispatched one.
   */
  readonly queued?: true;
  /**
   * Present on an enqueued action that was refused when its turn came, with a
   * short reason. A dispatched action that was refused isn't logged.
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

const Tick = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const LogSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Union([
      Schema.Struct({
        tick: Tick,
        name: Schema.String,
        payload: Schema.Unknown,
        from: Schema.optionalKey(Schema.String),
        queued: Schema.optionalKey(Schema.Literal(true)),
        refused: Schema.optionalKey(Schema.String),
      }),
      Schema.Struct({
        tick: Tick,
        hash: Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
        ),
      }),
    ])
  )
);

/**
 * Encodes an action log as text, for a save file or the network.
 *
 * @category Codecs
 */
export const encodeLog = (log: readonly LogEntry[]): string =>
  JSON.stringify(log);

/**
 * Decodes an action log from text. It checks the log's own structure; each
 * payload is validated against its action's schema, and each checkpoint against
 * the world, when the log is replayed.
 *
 * @category Codecs
 */
export const decodeLog = (
  text: string
): Exit.Exit<readonly LogEntry[], Schema.SchemaError> =>
  Schema.decodeExit(LogSchema)(text);

/**
 * Emitted when a queued action is refused. A directly dispatched action returns
 * its failure to the caller instead.
 *
 * @category Events
 */
export const Rejected = Event.define<{
  readonly action: string;
  readonly payload: unknown;
  readonly error: unknown;
  /** The peer that issued it, as its handler would have received it. */
  readonly from: string | undefined;
}>("Action.Rejected");

/**
 * Lets systems, scripts and handlers issue actions, so AI plays by the same
 * rules as players. The action is applied at the start of the next tick. It
 * isn't logged, since it is the simulation's own doing and a replay does it
 * again. Code outside the simulation uses `app.dispatch` or `app.enqueue`.
 *
 * **Gotchas**
 *
 * A frame-stage or input-stage system is outside the simulation, and a replay
 * runs neither stage, so what it issues here is logged, as `app.enqueue` logs
 * it.
 *
 * @category Services
 */
export class Actions extends Context.Service<
  Actions,
  {
    readonly enqueue: <N extends string, P>(
      action: ActionDef<N, P, unknown>,
      payload: P
    ) => void;
    /**
     * Returns whether the game has a handler for an action. An action without
     * one can't be issued: `enqueue` throws.
     */
    readonly handles: (action: AnyActionDef) => boolean;
  }
>()("arcadekit/Actions") {}
