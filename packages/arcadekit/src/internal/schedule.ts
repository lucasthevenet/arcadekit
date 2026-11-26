/**
 * A game's schedule holds its systems by when they run, each with its turn.
 * It has the tick's systems in the order they run, the frame stage's, the
 * input stage's, and the hooks of each state, which run when the game enters
 * or leaves one of the state's values.
 *
 * An app makes its schedule from its plugins' systems and its own.
 */
import { Effect } from "effect";

import type * as Plugin from "../Plugin.ts";
import type * as State from "../State.ts";
import * as System from "../System.ts";
import { order, spanLevel, unique } from "./system.ts";

/**
 * A system as the app runs it. A turn checks the system's condition, then runs
 * the system or what it does in place of running, in a span of its own when
 * the app traces. A turn is made once, so an app that doesn't trace runs no
 * tracing code. What its last turn was is kept for `app.inspect`.
 *
 * @category Models
 */
export class Turn {
  /**
   * The system's condition, checked before `run`. It is undefined for a system
   * with no condition, and when `run` checks the condition in its span.
   */
  readonly condition: Effect.Effect<boolean, unknown, unknown> | undefined;
  /**
   * What runs in place of `run` when the condition doesn't hold. It is
   * undefined for a system with nothing to run then, and when `run` runs it
   * in its span.
   */
  readonly idle: Effect.Effect<void, unknown, unknown> | undefined;
  /** The system's run, in a span of its own when the app traces. */
  readonly run: Effect.Effect<void, unknown, unknown>;
  /**
   * Whether the system ran on its last turn. It is false when its condition
   * didn't hold, and before its first turn.
   */
  ran = false;
  /**
   * How long the system's last turn took, in milliseconds, its condition and
   * its commands included.
   */
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
      { level: spanLevel }
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
   * the order they are listed. Of the hooks of `State.onTransition`, only
   * those for a move from `from`.
   */
  readonly hooks: (
    state: State.State<string>,
    on: System.Trigger["on"],
    value: string,
    from: string | undefined
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
 * It throws for two systems with one name. It also throws for a hook, made by
 * `State.onEnter` or `State.onExit`, that is for a value its state doesn't
 * have.
 *
 * @category Constructors
 */
export const make = (
  systems: readonly Plugin.AnySystem[],
  trace: boolean
): Schedule => {
  unique(systems);
  const turns = (list: readonly Plugin.AnySystem[]): Turn[] =>
    order(list).map((system) => new Turn(system, trace));
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
    const stranger = [trigger.value, ...(trigger.from ?? [])].find(
      (value) => !state.values.includes(value)
    );
    if (stranger !== undefined) {
      throw new Error(
        `System "${system.name}" is a hook for "${stranger}", which is not a value of the state "${state.name}". Its values are: ${state.values.join(", ")}.`
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
    hooks: (state, on, value, from) =>
      (hooks.get(hookKey(state, on, value)) ?? []).filter(
        ({ system }) =>
          system.trigger?.from === undefined ||
          (from !== undefined && system.trigger.from.includes(from))
      ),
    hooked: [...hooked],
    all: [...tick, ...[...hooks.values()].flat(), ...input, ...frame],
  };
};
