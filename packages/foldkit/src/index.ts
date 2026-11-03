import type { GameEngine } from "@gamekit/runtime";
import { Effect, Queue, Stream } from "effect";

// Helpers for connecting a @gamekit/runtime engine to a Foldkit app.
//
// The pattern, in the app:
// 1. The view always renders the game's container element, with a Mount that
//    reports a `MountedViewport` Message once the element exists.
// 2. `update` stores that fact in the Model (e.g. `isViewportMounted: true`).
// 3. A Subscription gated on that flag returns `engineMessages(...)`: it attaches
//    the engine to the element and turns engine events into Messages.
// 4. Commands call the engine's methods (start, modify, setPaused, stop).

export interface EngineMessagesOptions<Event, Message, R> {
  /** Gets the engine, usually by yielding the game's engine service. */
  readonly engine: Effect.Effect<GameEngine<any, any, Event>, never, R>;
  /** Id of the element the engine renders into. It must exist when the stream starts. */
  readonly elementId: string;
  /** Maps an engine event to a Message. Return undefined to drop the event. */
  readonly toMessage: (event: Event) => Message | undefined;
}

/**
 * A Stream for a Foldkit Subscription: attaches the engine to the element and emits a Message
 * per engine event. When the Subscription ends, the engine detaches and stops rendering.
 */
export const engineMessages = <Event, Message, R>(
  options: EngineMessagesOptions<Event, Message, R>
): Stream.Stream<Message, never, R> =>
  Stream.callback<Message, never, R>((queue) =>
    Effect.gen(function* () {
      const engine = yield* options.engine;
      const element = document.getElementById(options.elementId);
      if (!element)
        return yield* Effect.die(
          new Error(`#${options.elementId} is not in the document`)
        );
      yield* engine.listen((event) => {
        const message = options.toMessage(event);
        if (message !== undefined) Queue.offerUnsafe(queue, message);
      });
      yield* engine.attach(element);
      return yield* Effect.never;
    })
  );

/** A Stream for a Foldkit Subscription: emits `toMessage()` on each keydown whose `code` is in `codes`. */
export const keyPresses = <Message>(
  codes: ReadonlyArray<string>,
  toMessage: (code: string) => Message
): Stream.Stream<Message> =>
  Stream.callback<Message>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const onKey = (event: KeyboardEvent) => {
          if (!event.repeat && codes.includes(event.code))
            Queue.offerUnsafe(queue, toMessage(event.code));
        };
        window.addEventListener("keydown", onKey);
        return onKey;
      }),
      (onKey) => Effect.sync(() => window.removeEventListener("keydown", onKey))
    ).pipe(Effect.andThen(Effect.never))
  );
