/**
 * Views: what draws a run into the viewport, once per browser frame, after the frame's steps.
 *
 * Plain on purpose: a frame draws whole before the browser shows it, so `render` is a
 * plain call inside the frame's one `Effect.try`. A view's lifecycle is its engine's: the engine
 * makes it in an `acquireRelease` on each attach and calls its `dispose` in the release.
 *
 * @since 0.7.0
 */

/**
 * What draws a game: `render`, called once per frame with the run's state, and `dispose`.
 *
 * **When to use**
 *
 * As the result of an engine's `view`: a game's drawing view, its sound view, or one made of
 * several with `combineViews`.
 *
 * **Details**
 *
 * Two rules apply to every view. `render` reads the state and never changes it, and gets no state
 * (null) when no run is active, as in a menu. And each run has its own state object: `render`
 * gets that same object every frame until the run ends, so a view tells runs apart by identity,
 * as push-puzzle's resets when the object changes.
 *
 * **Example** (A view that counts what it drew)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 *
 * const drawn: (number | null)[] = [];
 * const view: Game.View<{ readonly x: number }> = {
 *   render: (runner) => {
 *     drawn.push(runner?.x ?? null);
 *   },
 *   dispose: () => {},
 * };
 * view.render({ x: 2 }, 0);
 * view.render(null, 0.016);
 * drawn; // => [2, null]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface View<State> {
  /** Draws one frame. `state` is null when no run is active (menus). */
  readonly render: (state: State | null, timeSeconds: number) => void;
  readonly dispose: () => void;
}

/**
 * One view made of several, such as a game's drawing view and its sound view: `render` renders
 * each in order, and `dispose` disposes them in reverse.
 *
 * **When to use**
 *
 * In an engine's `view`, when a game draws and plays sound from the same state.
 *
 * **Example** (Two views, in order and in reverse)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 *
 * const log: string[] = [];
 * const named = (name: string): Game.View<number> => ({
 *   render: () => {
 *     log.push(`render ${name}`);
 *   },
 *   dispose: () => {
 *     log.push(`dispose ${name}`);
 *   },
 * });
 * const both = Game.combineViews(named("drawing"), named("sound"));
 * both.render(1, 0);
 * both.dispose();
 * log; // => ["render drawing", "render sound", "dispose sound", "dispose drawing"]
 * ```
 *
 * @category combinators
 * @since 0.7.0
 */
export const combineViews = <State>(
  ...views: readonly View<State>[]
): View<State> => ({
  render: (state, timeSeconds) => {
    for (const view of views) {
      view.render(state, timeSeconds);
    }
  },
  dispose: () => {
    for (let i = views.length - 1; i >= 0; i -= 1) {
      views[i]?.dispose();
    }
  },
});
