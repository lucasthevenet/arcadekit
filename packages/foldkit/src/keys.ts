import { Effect, Queue, Stream } from "effect";

/**
 * A Stream for a Foldkit Subscription: emits `toMessage(code)` on each keydown whose
 * `KeyboardEvent.code` is in `codes`, ignoring auto-repeat. Codes name physical keys
 * (`"KeyR"`, `"Escape"`), as `@gamekit/input` bindings do, so they don't move with the
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
