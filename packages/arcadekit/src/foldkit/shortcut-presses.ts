/**
 * Shortcut presses: the presses of an app's shortcut, a key that works on any screen, as M mutes,
 * as Messages for a Foldkit Subscription.
 *
 * They are key presses (`KeyPresses`) that also leave the browser's and the system's shortcuts
 * alone, and a player's typing: a press with Ctrl, Cmd or Alt held is none, and neither is one
 * that goes into a text field. The Stream is Effect's own for a DOM event
 * (`Stream.fromEventListener`), and the tests of a press are plain data work over the event's
 * fields.
 *
 * @since 0.7.0
 */
import { Predicate } from "effect";
import type { Stream } from "effect";

import { pressesOf } from "./internal/presses";

/** Whether a key press goes into a text field, rather than to the app. A slider or a checkbox isn't one. */
const isTyping = (target: EventTarget | null): boolean => {
  if (
    !Predicate.hasProperty(target, "tagName") ||
    !Predicate.isString(target.tagName)
  ) {
    return false;
  }
  const type = Predicate.hasProperty(target, "type") ? target.type : undefined;
  return (
    (target.tagName === "INPUT" && type !== "range" && type !== "checkbox") ||
    target.tagName === "TEXTAREA" ||
    (Predicate.hasProperty(target, "isContentEditable") &&
      target.isContentEditable === true)
  );
};

/** Whether a keydown is a shortcut's press: no auto-repeat, no Ctrl, Cmd or Alt, no typing. */
const isShortcutPress = (event: KeyboardEvent): boolean =>
  !event.repeat &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  !isTyping(event.target);

/**
 * A Stream of the presses of `codes` as a shortcut, each as `toMessage` of the key's code, for as
 * long as it runs. Like `KeyPresses.make`, but a press with Ctrl, Cmd or Alt held is none, and
 * neither is one that goes into a text field.
 *
 * **When to use**
 *
 * For a key that works on every screen, such as M to mute: give it to
 * `Subscription.persistentEntry`, so it runs for the app's life.
 *
 * **Details**
 *
 * A text field is an `input` other than a slider or a checkbox, a `textarea`, or an element whose
 * content is editable, so typing a join code with an M in it doesn't mute. With a modifier held,
 * the press is the browser's or the system's (Cmd+M minimizes a window), and with Shift it is
 * still the shortcut. A key's auto-repeat is no new press.
 *
 * **Example** (M mutes, but not with Ctrl or Cmd held)
 *
 * ```ts
 * import { ShortcutPresses } from "arcadekit/foldkit";
 * import { Effect, Fiber, Stream } from "effect";
 *
 * const mutes = ShortcutPresses.make(["KeyM"], () => "mute");
 * const program = Effect.gen(function* () {
 *   const heard = yield* Effect.forkChild(
 *     Stream.runCollect(Stream.take(mutes, 1)),
 *     { startImmediately: true }
 *   );
 *   window.dispatchEvent(
 *     new KeyboardEvent("keydown", { code: "KeyM", ctrlKey: true })
 *   );
 *   window.dispatchEvent(
 *     new KeyboardEvent("keydown", { code: "KeyM", metaKey: true })
 *   );
 *   window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM" }));
 *   return yield* Fiber.join(heard);
 * });
 * const messages = await Effect.runPromise(program);
 * messages; // => ["mute"]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <const Code extends string, Message>(
  codes: readonly Code[],
  toMessage: (code: Code) => Message
): Stream.Stream<Message> => pressesOf(codes, toMessage, isShortcutPress);
