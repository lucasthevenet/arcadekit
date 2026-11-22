/**
 * What the peers of a session send each other, and its form as text.
 *
 * A peer sends one message for every tick: everything its player issued for
 * that tick, usually nothing, and the checkpoints its log recorded since its
 * last message. Its first message also says what it was made with, `Made`,
 * which the others compare with their own before anything else. A transport carries messages as the text `encode` writes, and
 * a relay passes them on: neither needs a session, a peer or an app.
 */
import { Schema } from "effect";
import type { Exit } from "effect";

import type * as Action from "../Action";

/**
 * An action as a peer issued it: its name, and its payload in JSON form.
 *
 * @category Models
 */
export interface Issued {
  readonly name: string;
  readonly payload: unknown;
}

/**
 * What a peer was made with, which every peer of a game is made with alike,
 * as its first message says it.
 *
 * @category Models
 */
export interface Made {
  /**
   * A hash of what the game simulates: the systems of the tick in the order
   * they run, the hooks of its states, the actions it handles, and its
   * version. What only draws, plays sound or reads the devices is left out, so
   * a peer that draws the game and one that doesn't play it together.
   */
  readonly game: number;
  /** The seconds a tick simulates. */
  readonly delta: number;
  /** Every peer of the game, in order of name. */
  readonly peers: readonly string[];
  /** The tick the peer's game begins at. */
  readonly start: number;
}

/**
 * What peers send each other: everything one peer issued for one tick. Every
 * peer sends one for every tick, usually with no actions in it: it is also how
 * a peer says it has nothing more for that tick.
 *
 * @category Models
 */
export interface Message {
  /** The peer that issued the actions. */
  readonly from: string;
  /**
   * The tick they apply on: the one that runs once this many ticks have
   * completed, on every peer.
   */
  readonly tick: number;
  /** The actions, in the order the peer issued them. */
  readonly actions: readonly Issued[];
  /**
   * The checkpoints the peer's log recorded since its last message: its world's
   * hash, and at which tick. Omitted when there are none.
   */
  readonly checkpoints?: readonly Action.Checkpoint[];
  /**
   * What the peer was made with, in the message for the tick its game begins
   * at alone.
   */
  readonly made?: Made;
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Hash = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
);

const MessageSchema = Schema.fromJsonString(
  Schema.Struct({
    from: Schema.String,
    tick: Count,
    actions: Schema.Array(
      Schema.Struct({ name: Schema.String, payload: Schema.Unknown })
    ),
    checkpoints: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          tick: Count,
          hash: Hash,
        })
      )
    ),
    made: Schema.optionalKey(
      Schema.Struct({
        game: Hash,
        delta: Schema.Finite,
        peers: Schema.Array(Schema.String),
        start: Count,
      })
    ),
  })
);

/**
 * Encodes a message as text, for whatever carries it.
 *
 * @category Codecs
 */
export const encode = (message: Message): string => JSON.stringify(message);

/**
 * Decodes a message from text. It checks the message's own structure; each
 * payload is validated against its action's schema when the action is applied,
 * and a payload that fails is refused by every peer alike.
 *
 * @category Codecs
 */
export const decode = (text: string): Exit.Exit<Message, Schema.SchemaError> =>
  Schema.decodeExit(MessageSchema)(text);
