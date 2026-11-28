import { Context } from "effect";

import type * as Action from "../Action.ts";
import type { Bridge } from "../View.ts";

/** @internal An action the UI requested, waiting for the input stage. */
export interface Sent {
  readonly action: Action.Any;
  readonly payload: unknown;
}

/**
 * The actions a UI has sent, for the input stage. Publishing is `View.Port`,
 * which a system of the input stage cannot require.
 * @internal
 */
export class Intake extends Context.Service<
  Intake,
  { readonly take: () => readonly Sent[] }
>()("arcadekit/View.Intake") {}

/** @internal What the UI of an app is handed its bridge by, if it has a UI. */
export type Mount = (ui: Bridge<Action.Any>) => void | (() => void);

/** @internal The UI an app hands its bridge to: `View.mount` and `Test.make` provide it. */
export const Ui = Context.Reference<Mount | undefined>("arcadekit/View.Ui", {
  defaultValue: () => undefined,
});
