/**
 * The rules layer: "action in, events out".
 *
 * An action is a request to change the game that comes from outside the
 * simulation: a player's move, a network message, an AI decision. A handler
 * validates it against the current state and either applies it or refuses it
 * with a typed error.
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
 * A refused action changes nothing: the commands it queued and the events it
 * emitted are discarded. (Direct writes to component data are not undone, so
 * validate first and write last.)
 *
 * Give an action a schema and its payload is checked on every path into the
 * game, and stored in the log in a form that is safe to turn into JSON:
 *
 *   const PlayCard = Action.define("PlayCard", Schema.Struct({ card: EntityId, target: EntityId }))
 *
 * Every action that is applied goes into `app.actionLog`. Replaying the log
 * into a fresh app reproduces the game.
 */
import { Context, Data, Effect, Schema } from "effect";
import type { Exit } from "effect";

import * as Event from "./event";
import type { TaggedErrorClass } from "./tagged-error";

interface InvalidPayloadFields {
  readonly action: string;
  /** What was wrong, as reported by the schema. */
  readonly message: string;
}

const InvalidPayloadError: TaggedErrorClass<
  "InvalidPayload",
  InvalidPayloadFields
> = Data.TaggedError("InvalidPayload");

/** The payload did not match the action's schema. The handler was not run. */
export class InvalidPayload extends InvalidPayloadError {}

interface UnknownActionFields {
  readonly action: string;
}

const UnknownActionError: TaggedErrorClass<
  "UnknownAction",
  UnknownActionFields
> = Data.TaggedError("UnknownAction");

/** An action arrived by name and the app has no handler for that name. */
export class UnknownAction extends UnknownActionError {}

/**
 * @param N  the action's name
 * @param P  the payload a handler receives
 * @param VE `InvalidPayload` when the action has a schema, otherwise `never`
 */
export interface ActionDef<N extends string, P, VE = never> {
  readonly name: N;
  /**
   * Checks the payload and converts it to and from JSON. Derived from the
   * schema the action was defined with; undefined for a type-only action.
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
 * validated: `Action.define("Strike", Schema.Struct({ ... }))`.
 *
 * Without one, only the compiler checks the payload, which is fine for
 * actions that never leave the program. Curried so the payload type can be
 * given while the name is inferred: `Action.define<Payload>()("Strike")`.
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

export interface Handler<N extends string, P, A, E, R> {
  readonly action: ActionDef<N, P, unknown>;
  readonly handle: (payload: P) => Effect.Effect<A, E, R>;
}

/**
 * Defines how an action is checked against the rules and applied. Must finish
 * synchronously. For an action with a schema, the payload it receives has
 * already been validated.
 */
export const handler = <
  N extends string,
  P,
  VE,
  Eff extends Effect.Effect<unknown, unknown, unknown>,
  A,
>(
  action: ActionDef<N, P, VE>,
  body: (payload: P) => Generator<Eff, A, never>
): Handler<N, P, A, Effect.Error<Eff> | VE, Effect.Services<Eff>> => ({
  action,
  handle: (payload) =>
    Effect.gen(() => body(payload)) as Effect.Effect<
      A,
      Effect.Error<Eff> | VE,
      Effect.Services<Eff>
    >,
});

/** One applied action, as recorded in `app.actionLog`. */
export interface Logged {
  /** How many ticks had completed when the action was applied. */
  readonly tick: number;
  readonly name: string;
  /** For an action with a schema, the payload in its JSON form. */
  readonly payload: unknown;
}

const LogSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      tick: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      name: Schema.String,
      payload: Schema.Unknown,
    })
  )
);

/** Turns an action log into text, for a save file or the network. */
export const encodeLog = (log: readonly Logged[]): string =>
  JSON.stringify(log);

/**
 * Reads an action log back from text. This checks the log's own shape; each
 * payload is checked against its action's schema when the log is replayed.
 */
export const decodeLog = (
  text: string
): Exit.Exit<readonly Logged[], Schema.SchemaError> =>
  Schema.decodeUnknownExit(LogSchema)(text) as Exit.Exit<
    readonly Logged[],
    Schema.SchemaError
  >;

export interface Rejection {
  readonly action: string;
  readonly payload: unknown;
  readonly error: unknown;
}

/**
 * Emitted when a queued action is refused. (An action dispatched directly
 * returns its failure to the caller instead.)
 */
export const Rejected: Event.EventDef<Rejection> =
  Event.define<Rejection>("Action.Rejected");

export interface ActionsApi {
  readonly enqueue: <N extends string, P>(
    action: ActionDef<N, P, unknown>,
    payload: P
  ) => void;
}

const ActionsService: Context.ServiceClass<Actions, "ecs/Actions", ActionsApi> =
  Context.Service<Actions, ActionsApi>()("ecs/Actions");

/**
 * Lets systems and scripts issue actions, so AI plays by the same rules as
 * players. The action is applied at the start of the next tick.
 */
export class Actions extends ActionsService {}
