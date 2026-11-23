/**
 * Actions are the rules layer: actions in, events out.
 *
 * An action is a request to change the game from outside the simulation: a
 * player's move, a network message, an AI decision. A handler validates it
 * against the current state, and either applies it or refuses it with a typed
 * error.
 *
 *   const PlayCard = Action.define("PlayCard", Schema.Struct({ card: EntityId, target: EntityId }))
 *
 *   const playCard = Action.handler(PlayCard, function*({ card, target }) {
 *     const turn = yield* Turn
 *     if (turn.player !== owner) return yield* new NotYourTurn()
 *     (yield* Commands).despawn(card)
 *     (yield* CardPlayed.emits).emit({ card, target })
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
 * An action's schema validates its payload on every path into the game, and
 * gives the payload the JSON form that the log, a save and the other peers
 * hold.
 *
 * Every action from outside the simulation goes into `app.actionLog`, except a
 * dispatched action that was refused, which changed nothing, along with a
 * checkpoint of the world's hash at a regular interval of ticks. An action a
 * system or a handler issues itself, with the `Actions` service, isn't logged: a
 * replay's own simulation issues it again. Replaying the log into a fresh app
 * reproduces the game, and stops at the first checkpoint that doesn't match.
 */
import { Cause, Context, Data, Effect, Exit, Schema } from "effect";

import { SnapshotError } from "./ecs/snapshot";
import { isPlain } from "./ecs/store";
import type { Store } from "./ecs/store";
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
 * @param N the action's name
 * @param P the payload a handler receives
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
  /** Type-only: keeps the payload type attached and invariant. */
  readonly _P?: (payload: P) => P;
}

/**
 * Defines an action, with the schema of its payload. The payload type is
 * inferred from the schema, and every payload is validated:
 * `Action.define("Strike", Schema.Struct({ ... }))`. The log and saves hold the
 * payload in its JSON form, and that form is what other peers receive, so a
 * bigint or a date in it is converted along the way.
 *
 * An action with no payload takes only its name, `Action.define("Pass")`, and
 * is issued with `undefined`, which its JSON form holds as `null`.
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
  readonly action: ActionDef<N, P>;
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
  readonly codec: Schema.Codec<unknown, unknown>;
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
 * complete synchronously. The payload it receives is already validated, and a
 * payload the action's schema refuses fails with `InvalidPayload` before it
 * runs.
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
 *   game's own service, and not a fiber it forked.
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

/**
 * Emitted when a queued action is refused. A directly dispatched action returns
 * its failure to the caller instead.
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
 * Lets systems and handlers issue actions, so AI plays by the same
 * rules as players. The action is applied at the start of the next tick.
 * `enqueue` is `app.enqueue`, for code that has no app at hand.
 *
 * Where it is called decides whether it is logged, as for `app.enqueue`. From
 * a tick, a handler or a plugin's setup, it is the simulation's own
 * doing and isn't logged, since a replay does it again. From a frame-stage or
 * input-stage system, which a replay runs neither of, it is input, and is
 * logged.
 *
 * **Gotchas**
 *
 * A payload its schema does not take throws in the frame or input stage, where
 * `app.enqueue` returns the failure.
 *
 * @category Services
 */
export class Actions extends Context.Service<
  Actions,
  {
    readonly enqueue: <N extends string, P>(
      action: ActionDef<N, P>,
      payload: P
    ) => void;
    /**
     * Returns whether the game has a handler for an action. An action without
     * one can't be issued: `enqueue` throws.
     */
    readonly handles: (action: AnyActionDef) => boolean;
  }
>()("arcadekit/Actions") {}

/**
 * Summarizes an error in a few words, for a log entry or a message.
 *
 * @internal
 */
export const said = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

/**
 * An action waiting for the next tick.
 *
 * @internal
 */
export interface QueuedAction {
  readonly name: string;
  readonly payload: unknown;
  /**
   * The action's codec, while the payload is the value a handler works with.
   * Undefined for one in the JSON form that arrives from outside, which is
   * checked when it is applied.
   */
  readonly codec: Schema.Codec<unknown, unknown> | undefined;
  /**
   * The log entry of an action enqueued from outside the simulation, told
   * its fate when it is applied. One that a system or a handler issued has
   * none.
   */
  readonly entry: { refused?: string } | undefined;
  /** The issuer, if it came with a name. */
  readonly from: string | undefined;
}

/**
 * A queued action's payload in its JSON form, or `null` when its action's
 * schema doesn't take it.
 *
 * @internal
 */
export const jsonOf = ({ codec, payload }: QueuedAction): unknown => {
  if (codec === undefined) {
    return payload;
  }
  const json = Schema.encodeUnknownExit(codec)(payload);
  return Exit.isSuccess(json) ? json.value : null;
};

/** What a snapshot holds of the intake: `Intake.save`. */
const IntakeData = Schema.Struct({
  queued: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      payload: Schema.Unknown,
      from: Schema.optionalKey(Schema.String),
    })
  ),
  heard: Schema.Boolean,
});

/** What the intake holds at a moment: the actions as they are, with no schema. */
interface IntakeMoment {
  readonly queued: readonly QueuedAction[];
  readonly heard: boolean;
  readonly wanted: boolean;
}

/**
 * The name of the store that holds an app's queued actions, as a snapshot
 * has it: `readSnapshot(save.world).stores`. It holds `{ queued, heard }`:
 * the actions queued for the next tick, each `{ name, payload, from? }` with
 * its payload in JSON form, and whether the input stage has run since the
 * last tick.
 *
 * @category Constants
 */
export const INTAKE = "arcadekit/actions";

/**
 * What a game has taken in for its next tick: the actions queued for it,
 * whether the input stage has run since the last one, so that a game that
 * is saved, loaded or rewound between the two doesn't hear its devices
 * twice, and whether it asked for the tick. The world holds them, as a
 * store: a rewind puts them back, a refused action's own enqueues and asking
 * are taken back with the rest of it, and the actions are in its snapshot
 * and its hash, as much the game's as its components are.
 *
 * @internal
 */
export class Intake implements Store<IntakeMoment> {
  readonly name = INTAKE;
  // The stages between ticks are there to issue actions.
  readonly betweenTicks = true;
  queued: QueuedAction[] = [];
  heard = false;
  /**
   * Whether the game asked for its next tick, with `Ticks.more`. A game that
   * has not ticked yet has not been asked, and is taken to want one. It goes
   * back with a rewind and with a refused action, and is neither hashed nor
   * saved: a game that ticks in real time is the same game whether or not
   * its systems ask, and a loaded game's first tick always runs.
   */
  wanted = true;
  private txLength = 0;
  private txWanted = true;

  /** Takes every queued action, for the tick that applies them. */
  take(): QueuedAction[] {
    const { queued } = this;
    this.queued = [];
    return queued;
  }

  save(): unknown {
    if (this.queued.length === 0 && !this.heard) {
      return undefined;
    }
    const queued = this.queued.map(({ codec, from, name, payload }) => {
      let json = payload;
      if (codec !== undefined) {
        const exit = Schema.encodeUnknownExit(codec)(payload);
        if (Exit.isFailure(exit)) {
          throw new SnapshotError(
            "cannot be saved",
            `Can't save the actions queued for the next tick: the action "${name}" has a payload its schema does not take: ${said(Cause.squash(exit.cause))}`
          );
        }
        json = exit.value;
      }
      if (!isPlain(json)) {
        throw new SnapshotError(
          "cannot be saved",
          `Can't save the actions queued for the next tick: the payload of the action "${name}" is not plain data.`
        );
      }
      return from === undefined
        ? { name, payload: json }
        : { name, payload: json, from };
    });
    return { queued, heard: this.heard };
  }

  load(data: unknown): void {
    const saved = Schema.decodeUnknownExit(IntakeData)(data);
    if (Exit.isFailure(saved)) {
      throw new SnapshotError(
        "store changed",
        `Can't load the actions queued for the next tick: they are not { queued, heard }, with each action { name, payload, from? }: ${said(Cause.squash(saved.cause))}`
      );
    }
    // In the JSON form they were saved in, checked again when applied.
    this.queued = saved.value.queued.map(({ from, name, payload }) => ({
      name,
      payload,
      codec: undefined,
      entry: undefined,
      from,
    }));
    this.heard = saved.value.heard;
  }

  hashed(): unknown {
    // Not whether the devices were heard: hearing them changes nothing of
    // the game but what it queues.
    return this.queued.length === 0
      ? undefined
      : this.queued.map((action) => ({
          name: action.name,
          payload: jsonOf(action),
          from: action.from ?? null,
        }));
  }

  capture(): IntakeMoment {
    return {
      queued: this.queued.slice(),
      heard: this.heard,
      wanted: this.wanted,
    };
  }

  rewind(moment: IntakeMoment): void {
    this.queued = moment.queued.slice();
    this.heard = moment.heard;
    this.wanted = moment.wanted;
    for (const action of this.queued) {
      // It is waiting again: what became of it has not happened.
      if (action.entry !== undefined) {
        delete action.entry.refused;
      }
    }
  }

  clear(): void {
    this.queued = [];
    this.heard = false;
    this.wanted = true;
  }

  begin(): void {
    this.txLength = this.queued.length;
    this.txWanted = this.wanted;
  }

  rollback(): void {
    this.queued.length = this.txLength;
    this.wanted = this.txWanted;
  }

  commit(): void {}

  contents(): unknown {
    return this.queued.length === 0 && !this.heard
      ? undefined
      : { queued: this.hashed() ?? [], heard: this.heard };
  }
}
