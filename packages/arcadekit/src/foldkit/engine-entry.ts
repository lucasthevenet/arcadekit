/**
 * Engine entries: the Foldkit Subscription entry that keeps an engine attached to the viewport
 * while the viewport is in the document, and turns the engine's events into the app's Messages.
 *
 * An entry is Foldkit's shape, built as Foldkit's `Subscription.animationFrameEntry` is, and goes
 * into `Subscription.make` as an entry's value. Its one dependency is the Boolean the viewport's
 * Messages set, so Foldkit restarts its Stream only when the viewport comes or goes. The Stream is
 * Effect: it reaches the engine, listens, then attaches, and its scope detaches the engine and
 * stops the listening. The listener it hands the engine is plain, since the engine calls it inside
 * its frame, where no Effect runs: it offers each Message to the Stream's queue.
 *
 * @since 0.7.0
 */
import { Effect, Queue, Schema, Stream } from "effect";
import type { Cause, Scope } from "effect";
import type { Subscription } from "foldkit";

import { viewportId } from "./internal/viewport-id";

/**
 * What an engine entry uses of an engine: `attach` and `listen`. A `Game.Engine`'s service has
 * them, and so does a Co-op client, or any client that draws into the viewport and reports
 * events.
 *
 * **When to use**
 *
 * To name what an engine entry can run, as a client that poses as an engine is checked against
 * it. An app hands its engine's class to `EngineEntry.make` and never writes this type.
 *
 * **Details**
 *
 * `attach` may fail with `E`: an engine's fails with `AttachError` when its view can't be made (no
 * WebGL), with `GameCrashed` when a frame throws, and with what one of its `uses` fails with, such
 * as a sprite sheet that can't be loaded.
 *
 * **Example** (A client that tells each listener it listens)
 *
 * ```ts
 * import { EngineEntry } from "arcadekit/foldkit";
 * import { Effect } from "effect";
 *
 * const heard: string[] = [];
 * const client: EngineEntry.Attachable<string> = {
 *   attach: () => Effect.never,
 *   listen: (onEvent) => Effect.sync(() => onEvent("listening")),
 * };
 * Effect.runSync(Effect.scoped(client.listen((event) => heard.push(event))));
 * heard; // => ["listening"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Attachable<Event, E = never> {
  /**
   * Draws into `element` and reads input from it for as long as it runs, and detaches when
   * interrupted. It never succeeds: it fails with `E` if it can't attach, or if it stops
   * drawing on its own (a crash).
   */
  readonly attach: (element: HTMLElement) => Effect.Effect<never, E>;
  /** Calls `onEvent` for every event while the scope is open. */
  readonly listen: (
    onEvent: (event: Event) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/**
 * What `EngineEntry.make` is given: the engine, the Boolean that says the viewport is in the
 * document, the Messages its events become and, when it can fail, the Message its failure
 * becomes.
 *
 * **When to use**
 *
 * As the one argument of `EngineEntry.make`, written in place, so each field takes its types from
 * the engine and from `Subscription.make`.
 *
 * **Details**
 *
 * `E` is what reaching the engine can fail with (its load), and `A` what its `attach` can fail
 * with, at once or while attached. `onError` is required when either can fail, and refused when
 * neither can: a type error on the config.
 *
 * **Example** (The config of an engine that can't fail)
 *
 * ```ts
 * import { EngineEntry } from "arcadekit/foldkit";
 * import { Effect } from "effect";
 *
 * interface Model {
 *   readonly isViewportMounted: boolean;
 * }
 *
 * const client: EngineEntry.Attachable<string> = {
 *   attach: () => Effect.never,
 *   listen: () => Effect.void,
 * };
 * const config: EngineEntry.Config<Model, string, string, never> = {
 *   engine: Effect.succeed(client),
 *   isViewportMounted: (model) => model.isViewportMounted,
 *   toMessage: (event) => `heard ${event}`,
 * };
 * config.toMessage("Scored"); // => "heard Scored"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Config<Model, Message, Event, R, E = never, A = never> = {
  /**
   * The genre's engine. A service key is an Effect that yields its service, so pass the key
   * itself (`MyEngine`), and give `Subscription.make` that service; `resources` must provide it.
   * Only `attach` and `listen` are used: Commands call the rest.
   *
   * An engine's attach can fail (`AttachError` or `GameCrashed`, `arcadekit/game/browser`, or
   * what one of its `uses` fails with), and so can this Effect, when it reaches the engine
   * through a load: pass `onError`.
   */
  readonly engine: Effect.Effect<Attachable<Event, A>, E, R>;
  /** Reads the Boolean that the viewport's `mounted` and `unmounted` Messages set. */
  readonly isViewportMounted: (model: Model) => boolean;
  /**
   * Turns an engine event into a Message, or into undefined to drop it: for a `Game.Engine`, its
   * simulation's `match`, which handles every event by its tag. Foldkit freezes the Model in
   * development, so copy any array or object in the event that the simulation keeps using
   * before putting it in the Message. The app's Message type comes from `Subscription.make`, not
   * from what this returns.
   */
  readonly toMessage: (event: Event) => NoInfer<Message> | undefined;
} & ([E | A] extends [never]
  ? { readonly onError?: never }
  : {
      /**
       * The Message sent, once, if `engine` (or its `attach`) fails: it can't load or attach,
       * or its game crashed. Nothing is attached or listened to after it, and the entry runs
       * again only when its Boolean changes, so it doesn't retry by itself.
       */
      readonly onError: (error: E | A) => NoInfer<Message>;
    });

/**
 * An engine entry: Foldkit's Subscription entry, whose one dependency is whether the viewport is
 * in the document.
 *
 * **When to use**
 *
 * To name what `EngineEntry.make` returns, as a value of an app's `Subscription.make`. An app
 * writes it in place and never names this type.
 *
 * **Details**
 *
 * It is Foldkit's `Subscription.EntryWithoutKeepAlive`, with no `keepAliveEquivalence`: Foldkit
 * restarts its Stream whenever its dependency changes, and leaves it running otherwise.
 *
 * **Example** (An entry's dependency)
 *
 * ```ts
 * import { EngineEntry } from "arcadekit/foldkit";
 * import { Effect } from "effect";
 *
 * interface Model {
 *   readonly isViewportMounted: boolean;
 *   readonly score: number;
 * }
 *
 * const client: EngineEntry.Attachable<string> = {
 *   attach: () => Effect.never,
 *   listen: () => Effect.void,
 * };
 * const entry: EngineEntry.EngineEntry<Model, string, never> = EngineEntry.make({
 *   engine: Effect.succeed(client),
 *   isViewportMounted: (model: Model) => model.isViewportMounted,
 *   toMessage: (event: string) => `heard ${event}`,
 * });
 * const mounted = entry.modelToDependencies({ isViewportMounted: true, score: 3 });
 * mounted; // => { isViewportMounted: true }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type EngineEntry<Model, Message, R> = Subscription.EntryWithoutKeepAlive<
  Model,
  Message,
  { readonly isViewportMounted: boolean },
  R
>;

/**
 * Makes the engine entry of `config.engine`: while the viewport is in the document, the engine
 * draws into it and reads input from it, and each of its events becomes a Message. When the
 * viewport leaves, or the app stops, the engine stops listening and detaches.
 *
 * **When to use**
 *
 * As an entry's value in the app's `Subscription.make`, once per engine or Co-op client the app
 * draws with, as Foldkit's `Subscription.animationFrameEntry` is used.
 *
 * **Details**
 *
 * Its one dependency is a Boolean, so Foldkit restarts its Stream only when the viewport comes or
 * goes. Foldkit starts the next Stream before it stops the previous one, and an engine attaches to
 * one element at a time, so the Boolean passes through false, whose Stream is empty, between two
 * attachments.
 *
 * Events the engine emits while the viewport isn't mounted are not delivered, and `start` emits
 * the first sample at once, so start a run after the viewport mounts. A true Boolean with no
 * viewport in the document is a mistake in the app's view: the Stream dies with an `Error` that
 * says so, and Foldkit shows its crash view.
 *
 * An engine can fail to attach (`AttachError`: no WebGL, say; or what one of its `uses` fails
 * with: a sheet that can't be loaded) or crash while attached (`GameCrashed`: a step or a render
 * threw), and an engine reached through a load (an `engine` Effect that can fail) can fail to
 * load. `onError` turns any of these into a Message, sent once, and is required then. Keep the
 * Boolean false until the app's own load has succeeded: the entry runs again only when the
 * Boolean changes, so it won't retry by itself.
 *
 * **Example** (An engine that stays detached while the viewport is out of the document)
 *
 * ```ts
 * import { EngineEntry } from "arcadekit/foldkit";
 * import * as Game from "arcadekit/game/browser";
 * import { Effect, Schema, Stream } from "effect";
 *
 * class Scored extends Game.Event("Scored", { score: Schema.Number }) {}
 * class Counting extends Game.Simulation("Counting", {
 *   input: Schema.Null,
 *   events: [Scored],
 *   create: () => ({}),
 *   step: () => {},
 * }) {}
 * class CountingEngine extends Game.Engine("CountingEngine", {
 *   simulation: Counting,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => null, dispose: () => {} }),
 * }) {}
 *
 * interface Model {
 *   readonly isViewportMounted: boolean;
 * }
 *
 * const entry = EngineEntry.make({
 *   engine: CountingEngine,
 *   isViewportMounted: (model: Model) => model.isViewportMounted,
 *   toMessage: Counting.match({ Scored: ({ score }) => `scored ${score}` }),
 *   // An engine's attach can fail: with no WebGL, or when a frame throws.
 *   onError: (error) => `failed: ${error.message}`,
 * });
 *
 * const unmounted = entry.modelToDependencies({ isViewportMounted: false });
 * const heard = Effect.runSync(
 *   Stream.runCollect(entry.dependenciesToStream(unmounted)).pipe(
 *     Effect.provide(CountingEngine.layer)
 *   )
 * );
 * heard; // => []
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <Model, Message, Event, R, E = never, A = never>(
  config: Config<Model, Message, Event, R, E, A>
): EngineEntry<Model, Message, R> => ({
  dependenciesSchema: Schema.Struct({ isViewportMounted: Schema.Boolean }),
  modelToDependencies: (model) => ({
    isViewportMounted: config.isViewportMounted(model),
  }),
  dependenciesToStream: ({ isViewportMounted }) =>
    isViewportMounted ? attached(config) : Stream.empty,
});

/**
 * Attaches the engine to the viewport and emits a Message per engine event, until the Stream is
 * stopped. A failure to reach or attach the engine, or a crash, emits `onError`'s Message and
 * nothing after it.
 */
const attached = <Model, Message, Event, R, E, A>(
  config: Config<Model, Message, Event, R, E, A>
): Stream.Stream<Message, never, R> => {
  // Present exactly when `E | A` isn't never, as the config's type says.
  const { onError } = config as {
    readonly onError?: (error: E | A) => Message;
  };
  return Stream.callback<Message, never, R>(
    Effect.fnUntraced(
      function* (queue: Queue.Queue<Message, Cause.Done>) {
        const engine = yield* config.engine;
        // oxlint-disable-next-line unicorn/prefer-query-selector -- attach needs the HTMLElement this returns.
        const element = document.getElementById(viewportId);
        if (element === null) {
          return yield* Effect.die(
            new Error(
              `#${viewportId} is not in the document: render Viewport.make(h, …) in the view`
            )
          );
        }
        // Listen first, so no event the attached engine emits is missed. The engine calls this
        // inside its frame, where no Effect runs, so it offers to the queue as a plain call.
        yield* engine.listen((event) => {
          const message = config.toMessage(event);
          if (message !== undefined) {
            Queue.offerUnsafe(queue, message);
          }
        });
        // Runs until the Stream is stopped, or fails if the engine can't attach or crashes.
        return yield* engine.attach(element);
      },
      // Its own scope: a failed attach also ends the listening, so no event follows the error.
      Effect.scoped,
      // A failed load, a failed attach or a crash becomes the app's Message, sent once. The
      // Stream stays open after it, with nothing more to send.
      (run, queue) =>
        run.pipe(
          Effect.catch((error) =>
            onError === undefined
              ? Effect.void
              : Queue.offer(queue, onError(error))
          )
        )
    )
  );
};
