/**
 * How a recording is laid out in bytes: each field and what it holds, which
 * `Replay.encode` writes and `Replay.decode` reads before it checks that the
 * recording holds together.
 */
import { Schema, SchemaTransformation } from "effect";

const Tick = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Hash = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 })
);

// Written as a pair, since two entries of one log in bytes must differ in kind.
const HashCheck = Schema.Tuple([Tick, Hash]).pipe(
  Schema.decodeTo(
    Schema.Struct({ tick: Tick, hash: Hash }),
    SchemaTransformation.transform({
      decode: ([tick, hash]) => ({ tick, hash }),
      encode: ({ hash, tick }) => [tick, hash] as const,
    })
  )
);

/**
 * The fields of a recording, each checked on its own and none against another.
 *
 * @internal
 */
export const Layout = Schema.Struct({
  seed: Schema.optionalKey(Tick),
  save: Schema.optionalKey(Schema.Uint8Array),
  start: Tick,
  end: Tick,
  endHash: Hash,
  deltas: Schema.Array(Schema.Struct({ tick: Tick, delta: Schema.Finite })),
  log: Schema.Array(
    Schema.Union([
      Schema.Struct({
        tick: Tick,
        name: Schema.String,
        payload: Schema.Unknown,
        from: Schema.optionalKey(Schema.String),
        queued: Schema.optionalKey(Schema.Literal(true)),
        refused: Schema.optionalKey(Schema.String),
      }),
      HashCheck,
    ])
  ),
});
