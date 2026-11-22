/**
 * A game's schedule: its systems, each with its turn, by when it runs. The
 * tick's systems in the order they run, the frame stage's and the input
 * stage's, and the hooks of each state, which run when the game enters or
 * leaves it.
 *
 * An app makes one from the systems of its plugins and its own, and gives
 * each list its turns.
 */
import { Effect } from "effect";

import type * as Plugin from "./Plugin";
import type * as State from "./State";
import * as System from "./System";

/**
 * A system as the app runs it: its condition, then its run or what it
 * does in place of running, in a span of its own when the app traces.
 * Made once, so an app that doesn't trace runs what it would without.
 * What its last turn was is kept for `app.inspect`.
 *
 * @category Models
 */
export class Turn {
  /** Asked before `run`, unless the span holds it. */
  readonly condition: Effect.Effect<boolean, unknown, unknown> | undefined;
  readonly idle: Effect.Effect<void, unknown, unknown> | undefined;
  readonly run: Effect.Effect<void, unknown, unknown>;
  ran = false;
  ms = 0;
  constructor(
    readonly system: Plugin.AnySystem,
    trace: boolean
  ) {
    const { condition, idle, run } = system;
    if (!trace) {
      // Asked in the loop, which is cheaper than a flatMap each tick.
      this.condition = condition;
      this.idle = idle;
      this.run = run;
      return;
    }
    this.condition = undefined;
    this.idle = undefined;
    this.run = Effect.withSpan(
      condition === undefined
        ? run
        : Effect.flatMap(condition, (holds) => {
            this.ran = holds;
            return holds ? run : (idle ?? Effect.void);
          }),
      system.name,
      { level: System.spanLevel }
    );
  }
}
/**
 * A game's systems, each with its turn, by when it runs.
 *
 * @category Models
 */
export interface Schedule {
  /** The systems of the tick, in the order they run. */
  readonly tick: readonly Turn[];
  /** The systems of the frame's three stages, one after the other. */
  readonly frame: readonly Turn[];
  /** The systems of the input stage. */
  readonly input: readonly Turn[];
  /**
   * The hooks that run when the game enters or leaves a value of a state, in
   * order: `System.after` and `System.before` order the hooks of one moment
   * among themselves.
   */
  readonly hooks: (
    state: State.State<string>,
    on: System.Trigger["on"],
    value: string
  ) => readonly Turn[];
  /** The states that have a hook. */
  readonly hooked: readonly State.State<string>[];
  /** Every turn: the tick's, then the hooks', the input stage's and the frame's. */
  readonly all: readonly Turn[];
}

const hookKey = (
  state: State.State<string>,
  on: System.Trigger["on"],
  value: string
): string => `${state.name}\n${on}\n${value}`;

/**
 * Makes the schedule of a list of systems. With `trace`, each turn runs in a
 * span of its own.
 *
 * It throws for two systems with one name, for an order that cannot be, and
 * for a hook that is in the frame stage or the input stage, or is for a value
 * its state doesn't have.
 *
 * @category Constructors
 */
export const make = (
  systems: readonly Plugin.AnySystem[],
  trace: boolean
): Schedule => {
  System.unique(systems);
  const turns = (list: readonly Plugin.AnySystem[]): Turn[] =>
    System.order(list).map((system) => new Turn(system, trace));
  // A hook runs when its state is entered or left, not with the rest.
  const staged = systems.filter((system) => system.trigger === undefined);
  const tick = turns(
    staged.filter(
      (system) => !System.isFrameStage(system.stage) && system.stage !== "input"
    )
  );
  // A frame's three stages, one after the other, are one list.
  const frame = turns(
    staged.filter((system) => System.isFrameStage(system.stage))
  );
  const input = turns(staged.filter((system) => system.stage === "input"));
  const groups = new Map<string, Plugin.AnySystem[]>();
  const hooked = new Set<State.State<string>>();
  for (const system of systems) {
    const { trigger } = system;
    if (trigger === undefined) {
      continue;
    }
    const state = trigger.state as State.State<string>;
    if (System.isFrameStage(system.stage)) {
      throw new Error(
        `System "${system.name}" is a hook and is in the frame stage. A hook runs at the start of a tick, when the game enters or leaves a state; the frame stage runs between ticks. Draw what a state looks like from a frame system with System.runIf(State.is(...)).`
      );
    }
    if (system.stage === "input") {
      throw new Error(
        `System "${system.name}" is a hook and is in the input stage. A hook runs at the start of a tick, when the game enters or leaves a state; the input stage runs before the tick. Read the devices only in some states with System.runIf(State.is(...)).`
      );
    }
    if (!state.values.includes(trigger.value)) {
      throw new Error(
        `System "${system.name}" is a hook for "${trigger.value}", which is not a value of the state "${state.name}". Its values are: ${state.values.join(", ")}.`
      );
    }
    hooked.add(state);
    const key = hookKey(state, trigger.on, trigger.value);
    groups.set(key, [...(groups.get(key) ?? []), system]);
  }
  const hooks = new Map<string, Turn[]>();
  for (const [key, group] of groups) {
    hooks.set(key, turns(group));
  }
  return {
    tick,
    frame,
    input,
    hooks: (state, on, value) => hooks.get(hookKey(state, on, value)) ?? [],
    hooked: [...hooked],
    all: [...tick, ...[...hooks.values()].flat(), ...input, ...frame],
  };
};
