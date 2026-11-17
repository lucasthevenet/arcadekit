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
 *     if (turn.player !== owner) return yield* Effect.fail(new NotYourTurn())
 *     (yield* Commands).despawn(card)
 *     (yield* CardPlayed).emit({ card, target })
 *   })
 *
 *   const result = app.dispatch(PlayCard, { card, target })   // Exit<void, NotYourTurn>
 *
 * A refused action changes nothing. Its handler runs in a transaction of the
 * world, so a refusal at any point takes back what it wrote to components,
 * the random numbers it drew, the commands it queued, the events it emitted
 * and the actions it enqueued, and unreads the events it read. A handler
 * changes which entities exist
 * through Commands; calling `world.spawn` and the like in one is an error.
 *
 * Give an action a schema and its payload is checked on every path into the
 * game, and stored in the log in a form that is safe to turn into JSON:
 *
 *   const PlayCard = Action.define("PlayCard", Schema.Struct({ card: EntityId, target: EntityId }))
 *
 * Every action that comes from outside goes into `app.actionLog`, with a
 * checkpoint of the world's hash every so many ticks. An action a system or
 * a script issues itself, with the `Actions` service, does not: a replay's
 * own simulation issues it again. Replaying the log into a fresh
 * app reproduces the game, and stops at the first checkpoint that does not
 * match.
 */
import { Context, Data, Effect, Schema } from "effect";
import type { Exit } from "effect";

import * as Event from "./Event";

/** The payload did not match the action's schema. The handler was not run. */
export class InvalidPayload extends Data.TaggedError("InvalidPayload")<{
  readonly action: string;
  /** What was wrong, as reported by the schema. */
  readonly message: string;
}> {}

/** An action arrived by name and the app has no handler for that name. */
export class UnknownAction extends Data.TaggedError("UnknownAction")<{
  readonly action: string;
}> {}

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

/**
 * Where an action came from, which a handler is told beside its payload.
 *
 * It is stamped on the way in by whatever brought the action, and is no
 * part of the payload, so whoever issued the action does not get to say:
 * a session stamps each peer's actions with that peer's name. (bevy_replicon
 * hands a server its clients' messages the same way, wrapped in a
 * `FromClient` that holds the sender's id, and bevy_ggrs gives each
 * player's input under that player's handle.)
 */
export interface Origin {
  /**
   * Who issued the action: the name of a peer of the session, or whatever
   * name it was given with `enqueueByName` or `dispatchByName`. Undefined
   * for an action this program issued itself: one enqueued or dispatched
   * through the app in a game of one, or issued by the simulation with
   * `Actions`.
   */
  readonly from: string | undefined;
}

export interface Handler<N extends string, P, A, E, R> {
  readonly action: ActionDef<N, P, unknown>;
  readonly handle: (payload: P, origin: Origin) => Effect.Effect<A, E, R>;
}

/**
 * Defines how an action is checked against the rules and applied. Must finish
 * synchronously. For an action with a schema, the payload it receives has
 * already been validated.
 *
 * Beside the payload it is told where the action came from, `{ from }`:
 * in a game of several peers, the peer that issued it.
 *
 *   const pass = Action.handler(Pass, function* (_, { from }) {
 *     const turn = yield* Turn
 *     if (turn.player !== from) return yield* Effect.fail(new NotYourTurn())
 *     ...
 *   })
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
 * One action that came from outside the simulation, as recorded in
 * `app.actionLog`: one that was dispatched and accepted, or one that was
 * enqueued.
 */
export interface Logged {
  /** How many ticks had completed when the action was dispatched or enqueued. */
  readonly tick: number;
  readonly name: string;
  /** For an action with a schema, the payload in its JSON form. */
  readonly payload: unknown;
  /**
   * Who issued it, when it came with a name: a peer of the session. Absent
   * on an action this program issued itself.
   */
  readonly from?: string;
  /**
   * Present on an action that was enqueued: it was applied at the start of
   * the next tick, and a replay enqueues it again. Absent on one that was
   * dispatched.
   */
  readonly queued?: true;
  /**
   * Present on an enqueued action that was refused when its turn came: why,
   * in a few words. A refused action that was dispatched is not logged.
   */
  readonly refused?: string;
}

/**
 * What the world's hash was at one point of the game, as recorded in
 * `app.actionLog`. A replay compares its own world against it, which is how
 * it notices that it has gone another way.
 */
export interface Checkpoint {
  /** How many ticks had completed when the hash was taken. */
  readonly tick: number;
  /** `world.hash()` at that point. */
  readonly hash: number;
}

/** An entry of `app.actionLog`: an applied action, or a checkpoint. */
export type LogEntry = Logged | Checkpoint;

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

/** Turns an action log into text, for a save file or the network. */
export const encodeLog = (log: readonly LogEntry[]): string =>
  JSON.stringify(log);

/**
 * Reads an action log back from text. This checks the log's own shape; each
 * payload is checked against its action's schema, and each checkpoint
 * against the world, when the log is replayed.
 */
export const decodeLog = (
  text: string
): Exit.Exit<readonly LogEntry[], Schema.SchemaError> =>
  Schema.decodeUnknownExit(LogSchema)(text) as Exit.Exit<
    readonly LogEntry[],
    Schema.SchemaError
  >;

/**
 * Emitted when a queued action is refused. (An action dispatched directly
 * returns its failure to the caller instead.)
 */
export const Rejected = Event.define<{
  readonly action: string;
  readonly payload: unknown;
  readonly error: unknown;
  /** Who had issued it, as its handler would have been told. */
  readonly from: string | undefined;
}>("Action.Rejected");

/**
 * Lets systems, scripts and handlers issue actions, so AI plays by the same
 * rules as players. The action is applied at the start of the next tick. It
 * is not logged: it is the simulation's own doing, and a replay does it
 * again. Code outside the simulation uses `app.dispatch` or `app.enqueue`.
 */
export class Actions extends Context.Service<
  Actions,
  {
    readonly enqueue: <N extends string, P>(
      action: ActionDef<N, P, unknown>,
      payload: P
    ) => void;
    /**
     * Whether the game has a handler for an action. One it has none for
     * cannot be issued: `enqueue` throws.
     */
    readonly handles: (action: ActionDef<string, any, unknown>) => boolean;
  }
>()("arcadekit/Actions") {}
