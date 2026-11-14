/**
 * Key presses: the presses of an app's own keys as Messages, for a Foldkit Subscription. R to
 * restart, Escape to go back: keys the app answers outside the run's input, which the engine's
 * input controller reads.
 *
 * A key is named by its code, the physical key, as `arcadekit/input`'s bindings name it, so it
 * doesn't move with the keyboard layout, and a key held down is one press. The Stream is Effect's
 * own for a DOM event (`Stream.fromEventListener`): each press is a Message an Effect reacts to,
 * and no frame reads it as state, so no listener of the kit's writes it (ADR-0024).
 *
 * @since 0.7.0
 */
import type { Stream } from "effect";

import { pressesOf } from "./internal/presses";

/**
 * A Stream of the presses of `codes`, each as `toMessage` of the key's code, for as long as it
 * runs.
 *
 * **When to use**
 *
 * In a Subscription's `dependenciesToStream`, for keys that mean something on some screens, such
 * as R to restart during a run: return it while the Model says so, and `Stream.empty` otherwise.
 * For a key that works on every screen, such as M to mute, use `ShortcutPresses.make`.
 *
 * **Details**
 *
 * It listens for `keydown` on the window from when the Stream runs to when it stops, so a press
 * reaches it wherever the focus is. A key's auto-repeat is no new press. `toMessage` is given the
 * code as one of `codes`, so it can tell the keys apart by their literal.
 *
 * **Example** (R and Escape as two Messages)
 *
 * ```ts
 * import { KeyPresses } from "arcadekit/foldkit";
 * import { Effect, Fiber, Stream } from "effect";
 *
 * const presses = KeyPresses.make(["KeyR", "Escape"], (code) =>
 *   code === "KeyR" ? "restart" : "back"
 * );
 * const program = Effect.gen(function* () {
 *   const heard = yield* Effect.forkChild(
 *     Stream.runCollect(Stream.take(presses, 2)),
 *     { startImmediately: true }
 *   );
 *   window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR" }));
 *   // Held down: the same press.
 *   window.dispatchEvent(
 *     new KeyboardEvent("keydown", { code: "KeyR", repeat: true })
 *   );
 *   window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyX" }));
 *   window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }));
 *   return yield* Fiber.join(heard);
 * });
 * const messages = await Effect.runPromise(program);
 * messages; // => ["restart", "back"]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <const Code extends string, Message>(
  codes: readonly Code[],
  toMessage: (code: Code) => Message
): Stream.Stream<Message> =>
  pressesOf(codes, toMessage, (event) => !event.repeat);
