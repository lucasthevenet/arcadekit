// What the viewport and the engine entry share, and no app reads: the id of the viewport's
// element. `Viewport.make` renders the element with it, and the engine entry finds the element
// by it, since a Mount can't use the app's services and a Subscription can't see the element.

/** The id of the viewport's element: one viewport per document. */
export const viewportId = "game-viewport";
