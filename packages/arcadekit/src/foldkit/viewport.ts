/**
 * The viewport in a Foldkit app: the element an engine draws a run into and reads input from,
 * rendered by the app's view.
 *
 * The element reports two Messages, one when it enters the document and one when it leaves, and
 * the app keeps them as a Boolean in its Model. The engine entry (`EngineEntry`) reads that
 * Boolean and finds the element by its id: a Mount can't use the app's services, and a
 * Subscription can't see the element, so the Mount's report travels through the Model. Plain on
 * purpose (ADR-0024): this is part of the app's Foldkit `view`, a pure function, and its effect
 * is a Mount.
 *
 * @since 0.7.0
 */
import { Effect } from "effect";
import { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { taggedStruct } from "foldkit/schema";

import { viewportId } from "./internal/viewport-id";

/** The Mount's own result, which `make` turns into the app's `mounted` Message. */
const MountedGameViewport = taggedStruct("MountedGameViewport");

/** Reports that the viewport is in the document. */
const GameViewportMount = Mount.define("GameViewport", {
  messages: [MountedGameViewport],
  execute: () => Effect.succeed(MountedGameViewport()),
});

/**
 * The two Messages the viewport reports, which the app keeps as one Boolean in its Model: true
 * from `mounted` to `unmounted`.
 *
 * **When to use**
 *
 * As the second argument of `Viewport.make`, with two Messages of the app's.
 *
 * **Details**
 *
 * The Boolean they set is what the engine entry's `isViewportMounted` reads, so it is true exactly
 * while the element exists. Each is one of the app's Messages: a value of another type is a type
 * error on its field.
 *
 * **Example** (The two Messages of an app)
 *
 * ```ts
 * import { Viewport } from "arcadekit/foldkit";
 * import { defineMessageUnion } from "foldkit/message";
 *
 * const Message = defineMessageUnion({
 *   MountedViewport: {},
 *   UnmountedViewport: {},
 * });
 * type Message = typeof Message.Type;
 *
 * const messages: Viewport.Messages<Message> = {
 *   mounted: Message.MountedViewport(),
 *   unmounted: Message.UnmountedViewport(),
 * };
 * messages.mounted._tag; // => "MountedViewport"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Messages<Message> {
  /** Dispatched once the element is in the document. */
  readonly mounted: Message;
  /** Dispatched when the element leaves the document. */
  readonly unmounted: Message;
}

/**
 * Renders the viewport: an empty `div.viewport` that the engine fills with its canvas, which
 * reports `messages.mounted` when it enters the document and `messages.unmounted` when it leaves.
 *
 * **When to use**
 *
 * In the app's view, once, on every screen, under the app's UI. Style `.viewport` in the app: it
 * needs a size.
 *
 * **Details**
 *
 * Render one per document: the engine entry finds the element by its id. A screen that leaves
 * it out detaches the engine, and when it comes back the engine attaches to the new element with
 * a new canvas, so a viewport rendered on every screen keeps its canvas for the app's life. Its
 * Mount is named "GameViewport": a Scene test resolves it with
 * `Scene.Mount.resolve({ name: "GameViewport" }, mounted)`.
 *
 * **Example** (A view whose viewport reports that it is in the document)
 *
 * ```ts
 * import { Viewport } from "arcadekit/foldkit";
 * import { Scene } from "foldkit";
 * import type { HtmlBuilder } from "foldkit/html";
 * import { defineMessageUnion } from "foldkit/message";
 *
 * const Message = defineMessageUnion({
 *   MountedViewport: {},
 *   UnmountedViewport: {},
 * });
 * type Message = typeof Message.Type;
 *
 * // The Model is the Boolean the two Messages set.
 * const heard: string[] = [];
 * const update = (_isMounted: boolean, message: Message) => {
 *   heard.push(message._tag);
 *   return { model: message._tag === "MountedViewport" };
 * };
 * const view = (_isMounted: boolean, h: HtmlBuilder<Message>) =>
 *   Viewport.make(h, {
 *     mounted: Message.MountedViewport(),
 *     unmounted: Message.UnmountedViewport(),
 *   });
 *
 * Scene.scene(
 *   { update, view },
 *   Scene.given(false),
 *   Scene.expect(Scene.selector(".viewport")).toBeEmpty(),
 *   Scene.Mount.resolve({ name: "GameViewport" }, Message.MountedViewport())
 * );
 * heard; // => ["MountedViewport"]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <Message>(
  h: HtmlBuilder<Message>,
  messages: Messages<NoInfer<Message>>
): Html =>
  h.div(
    [
      h.Key("viewport"),
      h.Id(viewportId),
      h.Class("viewport"),
      h.OnMount(Mount.mapMessage(GameViewportMount(), () => messages.mounted)),
      h.OnUnmount(messages.unmounted),
    ],
    []
  );
