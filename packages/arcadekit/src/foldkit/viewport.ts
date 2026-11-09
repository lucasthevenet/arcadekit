import { Effect, Queue, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { Mount } from "foldkit";
import type { Subscription } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { taggedStruct } from "foldkit/schema";

// The viewport is the element an engine draws a run into and reads input from. In a Foldkit
// app:
// - the view renders `gameViewport(h, { mounted, unmounted })`;
// - `update` stores those two Messages as a Boolean in the Model;
// - `Subscription.make` gets `engineEntry({ engine, isViewportMounted, toMessage })`, which
//   attaches the engine while that Boolean is true and turns its events into Messages.
//
// A Mount can't use the app's services and a Subscription can't see the element, so the
// Mount's report travels through the Model to the Subscription, which finds the element by
// its id.

/** Id of the viewport element: one viewport per document. */
const VIEWPORT_ID = "game-viewport";

/** The Mount's own result. `gameViewport` turns it into the app's `mounted` Message. */
const MountedGameViewport = taggedStruct("MountedGameViewport");

/** Reports that the viewport is in the document. */
const GameViewportMount = Mount.define("GameViewport", {
  messages: [MountedGameViewport],
  execute: () => Effect.succeed(MountedGameViewport()),
});

/** The facts `gameViewport` reports. Keep them as the Boolean `engineEntry` reads. */
export interface GameViewportMessages<Message> {
  /** Dispatched once the element is in the document. */
  readonly mounted: Message;
  /** Dispatched when the element leaves the document. */
  readonly unmounted: Message;
}

/**
 * The element the engine draws into and reads input from: an empty `div.viewport` that the
 * engine fills with its canvas. Style `.viewport` in the app (it needs a size). Render one per
 * document.
 *
 * It reports `mounted` when it enters the document and `unmounted` when it leaves, so the
 * Boolean those Messages set is true exactly while the element exists. Render it on every
 * screen, under the app's UI: a viewport left out of a screen detaches the engine, and when
 * it comes back the engine attaches to the new element with a new canvas.
 *
 * Its Mount is named "GameViewport": a Scene test resolves it with
 * `Scene.Mount.resolve({ name: "GameViewport" }, mounted)`.
 */
export const gameViewport = <Message>(
  h: HtmlBuilder<Message>,
  messages: GameViewportMessages<NoInfer<Message>>
): Html =>
  h.div(
    [
      h.Key("viewport"),
      h.Id(VIEWPORT_ID),
      h.Class("viewport"),
      h.OnMount(Mount.mapMessage(GameViewportMount(), () => messages.mounted)),
      h.OnUnmount(messages.unmounted),
    ],
    []
  );

/**
 * What `engineEntry` uses of an engine: `attach` and `listen`. A `GameEngine` is one; so is any
 * client that draws into the viewport and reports events, such as a co-op client. `attach` may
 * fail with `E`: a `GameEngine`'s fails with `AttachError` when its view can't be made (no
 * WebGL) and `GameCrashed` when a frame throws, and a client's may also fail when what it draws
 * with comes through a load.
 */
export interface AttachableEngine<Event, E = never> {
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
 * `engineEntry`'s config. `E` is what reaching the engine can fail with (its load), and `A` what
 * its `attach` can fail with, at once or while attached.
 */
export type EngineEntryConfig<
  Model,
  Message,
  Event,
  R,
  E = never,
  A = never,
> = {
  /**
   * The genre's engine. A service key is an Effect that yields its service, so pass the key
   * itself (`MyEngine`), and give `Subscription.make` that service; `resources` must
   * provide it. Only `attach` and `listen` are used: Commands call the rest.
   *
   * A `GameEngine`'s attach can fail (`AttachError` or `GameCrashed`,
   * `arcadekit/runtime/browser`), and so can an engine reached through a load
   * (`engineOf(MyEngine)`): pass `onError`.
   */
  readonly engine: Effect.Effect<AttachableEngine<Event, A>, E, R>;
  /** Reads the Boolean that `gameViewport`'s `mounted` and `unmounted` Messages set. */
  readonly isViewportMounted: (model: Model) => boolean;
  /**
   * Turns an engine event into a Message, or into undefined to drop it. Foldkit freezes the
   * Model in development, so copy any array or object in the event that the simulation keeps
   * using before putting it in the Message.
   */
  readonly toMessage: (event: Event) => Message | undefined;
} & ([E | A] extends [never]
  ? { readonly onError?: never }
  : {
      /**
       * The Message sent, once, if `engine` (or its `attach`) fails: it can't load or attach,
       * or its game crashed. Nothing is attached or listened to after it, and the entry runs
       * again only when its Boolean changes, so it doesn't retry by itself.
       */
      readonly onError: (error: E | A) => Message;
    });

/**
 * A Subscription entry, built like `Subscription.animationFrameEntry`: pass it as an entry
 * value inside `Subscription.make`. While the viewport is in the document, the engine draws
 * into it and reads input from it, and each of its events becomes a Message. When the viewport
 * leaves, or the app stops, the engine stops listening and detaches.
 *
 * Events the engine emits while the viewport isn't mounted are not delivered (`start` emits
 * the first sample at once), so start runs after the viewport mounts. If the Boolean is true
 * but no `gameViewport` is in the document, the Subscription dies and Foldkit shows its crash
 * view: that is a programming error.
 *
 * A `GameEngine` can fail to attach (`AttachError`: no WebGL, say) or crash while attached
 * (`GameCrashed`: a step or a render threw), and an engine reached through a load
 * (`engineOf(loader)`) can fail to load. Pass `onError`, which turns any of these into a
 * Message, and keep `isViewportMounted` false until the app's own load has succeeded. The
 * entry runs again only when its Boolean changes, so it won't retry by itself.
 */
export const engineEntry = <Model, Message, Event, R, E = never, A = never>(
  config: EngineEntryConfig<Model, Message, Event, R, E, A>
): Subscription.EntryWithoutKeepAlive<
  Model,
  Message,
  { readonly isViewportMounted: boolean },
  R
> => ({
  // Keep the dependency a single Boolean. Foldkit restarts the Stream with `Stream.switchMap`,
  // which starts the next Stream before it stops the previous one, and an engine attaches to
  // one element at a time (a second `attach` dies). A Boolean passes through false, whose
  // Stream is empty, between two attachments.
  dependenciesSchema: Schema.Struct({ isViewportMounted: Schema.Boolean }),
  modelToDependencies: (model) => ({
    isViewportMounted: config.isViewportMounted(model),
  }),
  dependenciesToStream: ({ isViewportMounted }) =>
    isViewportMounted ? engineMessages(config) : Stream.empty,
});

/**
 * Attaches the engine to the viewport and emits a Message per engine event, until the Stream
 * is stopped or the engine fails.
 */
const engineMessages = <Model, Message, Event, R, E, A>(
  config: EngineEntryConfig<Model, Message, Event, R, E, A>
): Stream.Stream<Message, never, R> =>
  Stream.callback<Message, never, R>((queue) =>
    Effect.gen(function* () {
      const engine = yield* config.engine;
      // oxlint-disable-next-line unicorn/prefer-query-selector -- attach needs the HTMLElement this returns.
      const element = document.getElementById(VIEWPORT_ID);
      if (!element) {
        return yield* Effect.die(
          new Error(
            `#${VIEWPORT_ID} is not in the document: render gameViewport(h, …) in the view`
          )
        );
      }
      // Listen first, so no event the attached engine emits is missed.
      yield* engine.listen((event) => {
        const message = config.toMessage(event);
        if (message !== undefined) {
          Queue.offerUnsafe(queue, message);
        }
      });
      // Runs until the Stream is stopped, or fails if the engine can't attach or crashes.
      return yield* engine.attach(element);
    }).pipe(
      // Its own scope: a failed attach also ends the listening, so no event follows the error.
      Effect.scoped,
      // A failed load, a failed attach or a crash becomes the app's Message, sent once. It can
      // only happen with `onError`: without it, `E` and `A` are never.
      Effect.catch((error: E | A) =>
        Effect.sync(() => {
          const { onError } = config as {
            onError?: (error: E | A) => Message;
          };
          if (onError !== undefined) {
            Queue.offerUnsafe(queue, onError(error));
          }
        }).pipe(Effect.andThen(Effect.never))
      )
    )
  );
