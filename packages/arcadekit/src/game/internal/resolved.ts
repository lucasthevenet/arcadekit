// A simulation's definition as its hosts run it, which no game names: `Game.Loop` and a scenario
// read it through `resolve`, typed by the simulation's own types.

import type { Duration, Schema } from "effect";

import type { AnyCommand } from "../command";
import type { AnyEvent } from "../event";
import type {
  CommandContext,
  RunContext,
  SimulationClass,
  StepContext,
} from "../simulation";

/**
 * A simulation's definition as the loop runs it: defaults filled, and the declarations' classes
 * replaced by what the loop needs of them.
 */
export interface Resolved<Config, State, Input, Event, Command> {
  readonly stepSeconds: number;
  readonly input: Schema.Top;
  readonly events: readonly AnyEvent[];
  readonly commands: readonly AnyCommand[];
  readonly create: (config: Config, run: RunContext<Event>) => State;
  // What a handler returned is the loop's to judge, whatever its type said.
  readonly step: (
    state: State,
    input: Input,
    context: StepContext<Event>
  ) => unknown;
  readonly apply: Readonly<
    Record<
      string,
      (
        state: State,
        command: Command,
        context: CommandContext<Event>
      ) => unknown
    >
  >;
  readonly sample:
    | {
        readonly make: (payload: unknown) => Event;
        readonly tag: string;
        readonly every: Duration.Input | undefined;
        readonly version: ((state: State) => number) | undefined;
        readonly read: (state: State) => unknown;
      }
    | undefined;
}

/** `simulation`'s definition, typed for the loop that runs it. */
export const resolve = <Config, State, Input, Event, Command, Refusals>(
  simulation: SimulationClass<
    string,
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >
): Resolved<Config, State, Input, Event, Command> =>
  simulation.definition as unknown as Resolved<
    Config,
    State,
    Input,
    Event,
    Command
  >;
