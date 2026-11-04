import type { GameSimulation, InputSource } from "./simulation";

/** The browser half of a game: how it reads input from the viewport and draws into it. */
export interface GamePresentation<State, Input> {
  /** Creates the input source that reads input from the viewport element. Called once per attach, after `createView`. */
  readonly createInput: (surface: HTMLElement) => InputSource<Input>;
  /**
   * Creates the view that draws into the viewport element. Called once per attach. It is
   * synchronous: load assets before, and pass them in by closure.
   */
  readonly createView: (container: HTMLElement) => GameView<State>;
}

/**
 * Everything the runtime needs to run a game in the browser: its simulation, plus its
 * presentation. A genre builds it in its `./browser` entry as
 * `{ ...mySimulation, createInput, createView }`.
 */
export type GameDefinition<Config, State, Input, Event> = GameSimulation<
  Config,
  State,
  Input,
  Event
> &
  GamePresentation<State, Input>;

/**
 * Draws a game. Two rules apply to every view:
 *
 * - `render` reads the state and never changes it.
 * - Each run has its own state object: `start` calls `create` for every run. `render` gets that
 *   same object every frame until `stop` or the next `start`, so a view can tell runs apart by
 *   identity. Push-puzzle's view resets when the object changes, and survivors' view keys its
 *   color cache on it.
 */
export interface GameView<State> {
  /** Draws one frame. `state` is null when no run is active (menus). */
  readonly render: (state: State | null, timeSeconds: number) => void;
  readonly dispose: () => void;
}

/**
 * One view made of several, such as a game's drawing view and its sound view. `render` renders
 * each in order; `dispose` disposes them in reverse.
 */
export const combineViews = <State>(
  ...views: readonly GameView<State>[]
): GameView<State> => ({
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
