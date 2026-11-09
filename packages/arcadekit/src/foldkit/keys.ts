import { Effect, Queue, Stream } from "effect";

/**
 * A Stream for a Foldkit Subscription: emits `toMessage(code)` on each keydown whose
 * `KeyboardEvent.code` is in `codes`, ignoring auto-repeat. Codes name physical keys
 * (`"KeyR"`, `"Escape"`), as `arcadekit/input` bindings do, so they don't move with the
 * keyboard layout.
 */
export const keyPresses = <Message>(
  codes: readonly string[],
  toMessage: (code: string) => Message
): Stream.Stream<Message> =>
  Stream.callback<Message>((queue) => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.repeat && codes.includes(event.code)) {
        Queue.offerUnsafe(queue, toMessage(event.code));
      }
    };
    return Effect.acquireRelease(
      Effect.sync(() => window.addEventListener("keydown", onKey)),
      () => Effect.sync(() => window.removeEventListener("keydown", onKey))
    ).pipe(Effect.andThen(Effect.never));
  });

/** Whether a key press goes into a text field, rather than to the game. A slider or checkbox isn't one. */
const isTyping = (target: EventTarget | null): boolean => {
  const element = target as Partial<HTMLInputElement> | null;
  if (element === null || typeof element.tagName !== "string") {
    return false;
  }
  return (
    (element.tagName === "INPUT" &&
      element.type !== "range" &&
      element.type !== "checkbox") ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable === true
  );
};

/**
 * Like `keyPresses`, for an app shortcut that works on any screen (M to mute): it also ignores
 * presses with Ctrl, Cmd or Alt held, so the browser's and the system's shortcuts don't trigger
 * it, and presses that go into a text field.
 */
export const shortcutPresses = <Message>(
  codes: readonly string[],
  toMessage: (code: string) => Message
): Stream.Stream<Message> =>
  Stream.callback<Message>((queue) => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        codes.includes(event.code) &&
        !isTyping(event.target)
      ) {
        Queue.offerUnsafe(queue, toMessage(event.code));
      }
    };
    return Effect.acquireRelease(
      Effect.sync(() => window.addEventListener("keydown", onKey)),
      () => Effect.sync(() => window.removeEventListener("keydown", onKey))
    ).pipe(Effect.andThen(Effect.never));
  });
