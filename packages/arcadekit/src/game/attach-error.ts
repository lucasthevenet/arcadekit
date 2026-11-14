/**
 * Attach errors: an engine that couldn't attach, because making its view or its input source
 * threw.
 *
 * The view and the input source are a game's plain handlers, which the engine makes on each
 * attach. A throw there, such as Three.js finding no WebGL, is wrapped once, at that boundary,
 * into this typed error, so the app shows it as it shows a failed load.
 *
 * @since 0.7.0
 */
import { Schema } from "effect";
import type { Cause } from "effect";

/** The class `Schema.TaggedError` makes for `AttachError`, written out for isolatedDeclarations. */
type AttachErrorClass = Schema.Class<
  AttachError,
  Schema.TaggedStruct<
    "AttachError",
    { readonly message: Schema.String; readonly cause: Schema.Defect }
  >,
  Cause.YieldableError
>;

// Named so the type files can be made one file at a time (isolatedDeclarations).
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError makes a class; it is not an error being thrown.
const AttachErrorBase: AttachErrorClass = Schema.TaggedError<AttachError>()(
  "AttachError",
  { message: Schema.String, cause: Schema.Defect() }
);

/**
 * An engine that couldn't attach: making its view or its input source threw, such as Three.js
 * finding no WebGL. `cause` is what was thrown.
 *
 * **When to use**
 *
 * Catch it where the app waits on `attach`, by its tag, to tell the player the game can't run
 * here.
 *
 * **Details**
 *
 * Nothing is left attached: what was made before the throw is disposed. `message` is the throw's
 * own message, for the app to show; `cause` is the throw, for a log. A Co-op client
 * (`arcadekit/net/browser`) fails its attach with it too.
 *
 * **Example** (A view that can't be made)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: () => {},
 * }) {}
 * class CountEngine extends Game.Engine("CountEngine", {
 *   simulation: Count,
 *   view: () => {
 *     throw new Error("no WebGL");
 *   },
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * const attached = Effect.gen(function* () {
 *   const engine = yield* CountEngine;
 *   return yield* Effect.flip(engine.attach({} as HTMLElement));
 * });
 * const error = Effect.runSync(attached.pipe(Effect.provide(CountEngine.layer)));
 * error._tag; // => "AttachError"
 * error.message; // => "no WebGL"
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
export class AttachError extends AttachErrorBase {}
