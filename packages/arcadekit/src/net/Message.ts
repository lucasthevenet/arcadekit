/**
 * What the peers of a session send each other, and its form as text.
 *
 * A peer sends one message for every tick: everything its player issued for
 * that tick, usually nothing, and the checkpoints its log recorded since its
 * last message. Its first message also says what it was made with, `Made`,
 * which the others compare with their own before anything else. Every message
 * says how far the peer has heard the others, `heard`, so each peer keeps
 * what it sent until every other peer has it.
 *
 * A transport carries messages as the text `Message.encode` writes, and a
 * relay passes them on. Neither needs a session, a peer or an app. A relay
 * also tells a room who joined it and who left it, with a `Notice`.
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
 * What a peer was made with, as its first message says. Every peer of a game
 * is made alike.
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
 * peer sends one for every tick, usually with no actions in it. An empty
 * message is how a peer says it has nothing more for that tick.
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
   * What the peer was made with. Only the message for the tick its game
   * begins at has it.
   */
  readonly made?: Made;
  /**
   * The first tick for which the peer is missing another peer's message. It
   * has every peer's message for each tick before it. A peer keeps what it
   * sent until every other peer has said it heard that far. A message without
   * it says nothing of what its peer heard.
   */
  readonly heard?: number;
}

/**
 * What a relay tells the members of a room: that a peer joined it, again or
 * for the first time, or that it left. A peer that joins is told who is
 * there already, with a `joined` for each. `Transport.layerBroadcastChannel`
 * says the same of its own peer, and tells no peer who is there.
 *
 * @category Models
 */
export type Notice = { readonly joined: string } | { readonly left: string };

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
    heard: Schema.optionalKey(Count),
  })
);

const NoticeSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ joined: Schema.String }),
    Schema.Struct({ left: Schema.String }),
  ])
);

/**
 * Encodes a message as text, for whatever carries it.
 *
 * @category Codecs
 */
export const encode = (message: Message): string => JSON.stringify(message);

/**
 * Decodes a message from text, and fails with a `Schema.SchemaError` on text
 * that isn't one. It checks the message's own structure. Each payload is
 * checked against its action's schema when the action is applied, and every
 * peer refuses a payload that fails.
 *
 * @category Codecs
 */
export const decode = (text: string): Exit.Exit<Message, Schema.SchemaError> =>
  Schema.decodeExit(MessageSchema)(text);

/**
 * Encodes a relay's notice as text.
 *
 * @category Codecs
 */
export const encodeNotice = (notice: Notice): string => JSON.stringify(notice);

/**
 * Decodes a relay's notice from text, and fails on a message or anything
 * else that isn't a notice.
 *
 * @category Codecs
 */
export const decodeNotice = (
  text: string
): Exit.Exit<Notice, Schema.SchemaError> =>
  Schema.decodeExit(NoticeSchema)(text);
