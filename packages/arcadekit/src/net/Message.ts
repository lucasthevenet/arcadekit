/**
 * What the peers of a session send each other, and its form in bytes.
 *
 * A peer sends one message for every tick: everything its player issued for
 * that tick, usually nothing, and the hash checks its log recorded since its
 * last message. Its first message also says what it was made with, `Made`,
 * which the others compare with their own before anything else. Every message
 * says how far the peer has heard the others, `heard`, so each peer keeps
 * what it sent until every other peer has it.
 *
 * A transport carries messages as the bytes `Message.encode` writes, and a
 * relay passes them on unchanged. Neither needs a session, a peer or an app.
 * A relay also tells a room who joined it and who left it, with a `Notice`,
 * which it sends as text: a message comes as bytes and a notice as text, so
 * what carries them tells the two apart.
 *
 * What peers say to each other that isn't the game's, such as what a lobby
 * agrees on before the game begins, is an `Aside`. It goes as bytes too,
 * which a relay passes on as it passes on a message.
 */
import { Cause, Data, Exit, Schema } from "effect";
import { SchemaBinary } from "effect/encoding";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Hash = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
);

/**
 * What peers send each other: everything one peer issued for one tick. Every
 * peer sends one for every tick, usually with no actions in it. An empty
 * message is how a peer says it has nothing more for that tick.
 *
 * @category Schemas
 */
export const Message = Schema.Struct({
  /** The peer that issued the actions. */
  from: Schema.String,
  /**
   * The tick they apply on: the one that runs once this many ticks have
   * completed, on every peer.
   */
  tick: Count,
  /** The actions, in the order the peer issued them. */
  actions: Schema.Array(
    Schema.Struct({ name: Schema.String, payload: Schema.Unknown })
  ),
  /**
   * The hash checks the peer's log recorded since its last message: its world's
   * hash, and at which tick. Omitted when there are none.
   */
  checkpoints: Schema.optionalKey(
    Schema.Array(Schema.Struct({ tick: Count, hash: Hash }))
  ),
  /**
   * What the peer was made with. Only the message for the tick its game
   * begins at has it.
   */
  made: Schema.optionalKey(
    Schema.Struct({
      /**
       * A hash of what the game simulates: the systems of the tick in the order
       * they run, the hooks of its states, the actions it handles, and its
       * version. What only draws, plays sound or reads the devices is left out, so
       * a peer that draws the game and one that doesn't play it together.
       */
      game: Hash,
      /** The ticks per second the game runs at. */
      hz: Schema.Finite,
      /** Every peer of the game, in order of name. */
      peers: Schema.Array(Schema.String),
      /** The tick the peer's game begins at. */
      start: Count,
    })
  ),
  /**
   * The first tick for which the peer is missing another peer's message. It
   * has every peer's message for each tick before it. A peer keeps what it
   * sent until every other peer has said it heard that far. A message without
   * it says nothing of what its peer heard.
   */
  heard: Schema.optionalKey(Count),
  /**
   * The tick the peer was about to run when it sent this. The others read
   * from it how far behind or ahead of them the peer is.
   */
  at: Schema.optionalKey(Count),
  /**
   * How many ticks the peer found itself ahead of the peer furthest behind
   * it, when it sent this, by the last message it had from each. It counts
   * the time a message takes too, which the others cancel out with their
   * own.
   */
  lead: Schema.optionalKey(Schema.Int),
});

export type Message = typeof Message.Type;

/**
 * An action as a peer issued it: its name, and its payload in JSON form.
 *
 * @category Models
 */
export type Issued = Message["actions"][number];

/**
 * What a peer was made with, as its first message says. Every peer of a game
 * is made alike.
 *
 * @category Models
 */
export type Made = NonNullable<Message["made"]>;

/**
 * What a relay tells the members of a room: that a peer joined it, again or
 * for the first time, or that it left. A peer that joins is told who is
 * there already, with a `joined` for each. `Transport.layerBroadcastChannel`
 * says the same of its own peer, and tells no peer who is there.
 *
 * @category Models
 */
export type Notice = { readonly joined: string } | { readonly left: string };

const codec = SchemaBinary.toCodec(Message, { fingerprint: true });

const NoticeSchema = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ joined: Schema.String }),
    Schema.Struct({ left: Schema.String }),
  ])
);

/**
 * What a peer says to the others that isn't the game's: its name, what it is
 * about, and a body in JSON form, which whatever reads it checks. A session
 * never sees one: `Transport.connect` drops it. `Lobby` speaks this way.
 *
 * @category Schemas
 */
export const Aside = Schema.Struct({
  /** The peer that says it. */
  from: Schema.String,
  /** What it is about, prefixed as a name is: `"arcadekit/Lobby"`. */
  topic: Schema.String,
  /** What it says, in JSON form. */
  body: Schema.Unknown,
});

export type Aside = typeof Aside.Type;

const asideCodec = SchemaBinary.toCodec(Aside, { fingerprint: true });

/**
 * A message that can't be written as bytes, or bytes or text that aren't a
 * message, an aside or a notice. `problem` names which: `"not a message"`,
 * `"not an aside"` or `"not a notice"`.
 *
 * @category Errors
 */
export class Invalid extends Data.TaggedError("MessageInvalid")<{
  readonly problem: "not a message" | "not an aside" | "not a notice";
  readonly message: string;
}> {}

/** What a failed encoding or decoding says, as Effect's `Schema` found it. */
const invalid = (
  problem: Invalid["problem"],
  cause: Cause.Cause<unknown>
): Invalid => {
  const error = Cause.squash(cause);
  return new Invalid({
    problem,
    message: error instanceof Error ? error.message : String(error),
  });
};

/**
 * Encodes a message in bytes, for whatever carries it. The bytes are the
 * message's own, in a buffer of their own, so a carrier may keep them or hand
 * their buffer on.
 *
 * Fails with `Message.Invalid`, `"not a message"`, when it is given what
 * isn't one: a session writes every tick and hash as a whole number, 0 or
 * more, and every payload in its JSON form.
 *
 * **Gotchas**
 *
 * The bytes carry a fingerprint of how a message is laid out, and a peer whose
 * arcadekit lays one out otherwise refuses them.
 *
 * @category Codecs
 */
export const encode = (
  message: Message
): Exit.Exit<Uint8Array<ArrayBuffer>, Invalid> => {
  const bytes = Schema.encodeExit(codec)(message);
  return Exit.isFailure(bytes)
    ? Exit.fail(invalid("not a message", bytes.cause))
    : Exit.succeed(bytes.value.slice());
};

/**
 * Decodes a message from bytes, and fails with `Message.Invalid`,
 * `"not a message"`, on bytes that aren't one, whole and nothing more. It
 * checks the message's own structure. Each payload is checked against its
 * action's schema when the action is applied, and every peer refuses a payload
 * that fails.
 *
 * @category Codecs
 */
export const decode = (bytes: Uint8Array): Exit.Exit<Message, Invalid> =>
  Exit.mapError(Schema.decodeUnknownExit(codec)(bytes), (error) =>
    invalid("not a message", Cause.fail(error))
  );

/**
 * Encodes an aside in bytes, in a buffer of their own, as `Message.encode`
 * does a message. Fails with `Message.Invalid`, `"not an aside"`, when its
 * body has no JSON form.
 *
 * @category Codecs
 */
export const encodeAside = (
  aside: Aside
): Exit.Exit<Uint8Array<ArrayBuffer>, Invalid> => {
  const bytes = Schema.encodeExit(asideCodec)(aside);
  return Exit.isFailure(bytes)
    ? Exit.fail(invalid("not an aside", bytes.cause))
    : Exit.succeed(bytes.value.slice());
};

/**
 * Decodes an aside from bytes, and fails with `Message.Invalid`,
 * `"not an aside"`, on bytes that aren't one, a message's among them. It
 * checks the aside's own structure, and not its body.
 *
 * @category Codecs
 */
export const decodeAside = (bytes: Uint8Array): Exit.Exit<Aside, Invalid> =>
  Exit.mapError(Schema.decodeUnknownExit(asideCodec)(bytes), (error) =>
    invalid("not an aside", Cause.fail(error))
  );

/**
 * Encodes a relay's notice as text.
 *
 * @category Codecs
 */
export const encodeNotice = (notice: Notice): string => JSON.stringify(notice);

/**
 * Decodes a relay's notice from text, and fails with `Message.Invalid`,
 * `"not a notice"`, on text that isn't one.
 *
 * @category Codecs
 */
export const decodeNotice = (text: string): Exit.Exit<Notice, Invalid> =>
  Exit.mapError(Schema.decodeExit(NoticeSchema)(text), (error) =>
    invalid("not a notice", Cause.fail(error))
  );
