import { Context } from "effect";

import type { Sent } from "../View";

/**
 * The actions a UI has sent, for the input stage. Publishing is `View.Port`,
 * which a system of the input stage cannot require.
 *
 * @internal
 */
export class Intake extends Context.Service<
  Intake,
  { readonly take: () => readonly Sent[] }
>()("arcadekit/View.Intake") {}
