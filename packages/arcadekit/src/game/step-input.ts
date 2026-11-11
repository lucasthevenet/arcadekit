/** Where each step's input comes from: a device, a script, or a buffer of confirmed inputs. */
export interface StepInput<Input> {
  /**
   * Called once per simulation step, before `step`. `step` is the run's index of the step about
   * to run (0 for the first step after `start`). A device source ignores it; a script or a
   * lockstep buffer indexes by it. It runs inside the step loop, so returning the same object
   * each time, refilled, keeps the loop free of allocation.
   */
  readonly read: (step: number) => Input;
  /**
   * Called after every step. Reset "just pressed" state here, so one press reaches exactly
   * one step even on a slow frame that runs several catch-up steps (a press that makes one
   * turn, a jump). `InputController.consumePresses` does this.
   */
  readonly endStep?: () => void;
  /**
   * Called once after each frame that ran at least one step, after its last `endStep`.
   * For per-frame work, like `InputController.endFrame`, which polls gamepads. A source that
   * resets presses here instead of in `endStep` lets one press reach every step of a frame:
   * fine for a game that reads only held state and axes.
   */
  readonly endFrame?: () => void;
}

/** A StepInput that owns resources (listeners, devices): what a `Game.Engine`'s `input` returns. */
export interface InputSource<Input> extends StepInput<Input> {
  readonly dispose: () => void;
}
