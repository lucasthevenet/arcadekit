import { Cause, Exit, Schema } from "effect";

import { INTAKE } from "../Action.ts";
import { SnapshotError } from "../ecs/snapshot.ts";
import { isPlain } from "../ecs/store.ts";
import type { Store } from "../ecs/store.ts";

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
  rests: Schema.optionalKey(Schema.Literal(true)),
});

/** What the intake holds at a moment: the actions as they are, with no schema. */
interface IntakeMoment {
  readonly queued: readonly QueuedAction[];
  readonly wanted: boolean;
  readonly rest: number | undefined;
}

/**
 * What a game has taken in for its next tick: the actions queued for it,
 * and whether it asked for the tick. The world holds them, as a
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
  /**
   * Whether the game wants its next tick: its last tick changed more than its
   * time, or an action was dispatched since. A game that has not ticked yet
   * is taken to want one. It goes back with a rewind and with a refused
   * action. It is not hashed, since a game that ticks in real time is the
   * same game whether or not it would rest. A save holds that it was not
   * wanted, so that a game loaded from a save of one at rest is at rest,
   * and runs no tick its player didn't ask for.
   */
  wanted = true;
  /**
   * The world's hash after the last tick, without its time and what the
   * stages between ticks change, once the app is asked whether it rests.
   */
  rest: number | undefined = undefined;

  /** Notes the world after a tick: it wants another if it changed. */
  ticked(rest: number | undefined): void {
    if (rest === undefined || rest !== this.rest) {
      this.wanted = true;
    }
    this.rest = rest;
  }

  private txLength = 0;
  private txWanted = true;

  /** Takes every queued action, for the tick that applies them. */
  take(): QueuedAction[] {
    const { queued } = this;
    this.queued = [];
    return queued;
  }

  save(): unknown {
    if (this.queued.length === 0) {
      return this.wanted ? undefined : { queued: [], rests: true };
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
    return this.wanted ? { queued } : { queued, rests: true };
  }

  load(data: unknown): void {
    const saved = Schema.decodeUnknownExit(IntakeData)(data);
    if (Exit.isFailure(saved)) {
      throw new SnapshotError(
        "store changed",
        `Can't load the actions queued for the next tick: they are not { queued }, with each action { name, payload, from? }: ${said(Cause.squash(saved.cause))}`
      );
    }
    this.wanted = saved.value.rests !== true;
    // In the JSON form they were saved in, checked again when applied.
    this.queued = saved.value.queued.map(({ from, name, payload }) => ({
      name,
      payload,
      codec: undefined,
      entry: undefined,
      from,
    }));
  }

  hashed(): unknown {
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
      wanted: this.wanted,
      rest: this.rest,
    };
  }

  rewind(moment: IntakeMoment): void {
    this.queued = moment.queued.slice();
    this.wanted = moment.wanted;
    this.rest = moment.rest;
    // What became of each, which has not happened again yet, is the log's to
    // take back, and to keep for a rewind forward.
  }

  clear(): void {
    this.queued = [];
    this.wanted = true;
    this.rest = undefined;
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
    return this.queued.length === 0 ? undefined : { queued: this.hashed() };
  }
}
