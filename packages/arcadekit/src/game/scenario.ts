import { CommandDropped } from "./command";
import { Loop } from "./loop";
import { resolve } from "./simulation";
import type { RefusalOf, SimulationClass } from "./simulation";

// A scenario is a specification you can run: given a run, after these steps and commands, it
// reported these events. It steps the real simulation through `Game.Loop`, the loop the browser engine
// runs, so what a scenario describes is what the game does. Plain code, like the loop: a scenario is
// synchronous and needs no Effect. Import the entry as a namespace named `Scenario`, so a step reads
// `Scenario.given(...)`.

/** What a scenario's steps drive: one run of the simulation, and what it has reported. */
export interface ScenarioRunner<
  Config,
  State,
  Input,
  Event,
  Command,
  Rejection = never,
> {
  readonly given: (config: Config, seed: number) => void;
  readonly step: (input: Input, count: number) => void;
  readonly send: (command: Command, player: number) => void;
  readonly reported: (expected: readonly Event[]) => void;
  readonly refused: (expected: readonly Rejection[]) => void;
  readonly sampled: (expected: Event) => void;
  readonly state: (check: (state: State) => void) => void;
}

/**
 * One line of a scenario: a function of the part of the runner it uses, so a scenario's steps are
 * checked against its simulation's types where the scenario is written.
 */
export type ScenarioStep<Runner> = (runner: Runner) => void;

/** A step, or a list of them: a game's own helper, such as one tap, is a list. */
export type ScenarioSteps<Runner> =
  | ScenarioStep<Runner>
  | readonly ScenarioSteps<Runner>[];

/** A scenario that failed: an expectation that didn't hold, or a step out of place. */
export class ScenarioError extends Error {
  override readonly name = "ScenarioError";
}

const show = (value: unknown): string => JSON.stringify(value);

const showAll = (values: readonly unknown[]): string =>
  values.length === 0
    ? "  (nothing)"
    : values.map((value) => `  ${show(value)}`).join("\n");

/** A command the rules refused: what they refused it with, the command's tag and its sender's slot. */
interface Refusal {
  readonly rejection: unknown;
  readonly command: string;
  readonly player: number;
}

const showRefusals = (refusals: readonly Refusal[]): string =>
  refusals.length === 0
    ? "  (nothing)"
    : refusals
        .map(
          ({ rejection, command, player }) =>
            `  ${show(rejection)}, refusing ${command} from player ${player}`
        )
        .join("\n");

/** Whether two events carry the same data: the same tag and payload, compared by value. */
const sameData = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) {
    return true;
  }
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameData(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key]
        )
    )
  );
};

const makeRunner = <Config, State, Input, Event, Command, Refusals>(
  simulation: SimulationClass<
    string,
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >
): ScenarioRunner<Config, State, Input, Event, Command, RefusalOf<Refusals>> & {
  readonly end: () => void;
} => {
  const { sample, stepSeconds } = resolve(simulation);
  const loop = new Loop(simulation);
  // Events reported since the last check, and the latest sample: a sample is a read of the
  // state, not something that happened, so `Scenario.reported` never has to list one.
  let unchecked: Event[] = [];
  let lastSample: Event | undefined;
  // What the rules refused since the last check, in the order they refused it, each with the
  // command it refused and who sent it.
  let refusals: Refusal[] = [];
  // The commands sent that no step has applied yet, by tag.
  const waiting: string[] = [];
  const neverApplied = (when: string): void => {
    if (waiting.length > 0) {
      throw new ScenarioError(
        `${when} with ${waiting.map((tag) => `Scenario.send(${tag})`).join(", ")} never applied. A command is applied by the step after it is sent: add a Scenario.step after the send.`
      );
    }
  };
  loop.subscribe((event) => {
    if ((event as { readonly _tag: string })._tag === sample?.tag) {
      lastSample = event;
    } else {
      unchecked.push(event);
    }
  });
  const running = (step: string): State => {
    const { state } = loop;
    if (state === null) {
      throw new ScenarioError(
        `Scenario.${step} needs a run: start the scenario with Scenario.given(config)`
      );
    }
    return state;
  };
  return {
    given: (config, seed) => {
      neverApplied("Scenario.given started a new run");
      unchecked = [];
      refusals = [];
      lastSample = undefined;
      loop.start(config, seed, 0);
    },
    step: (input, count) => {
      running("step");
      const source = { read: () => input };
      for (let i = 0; i < count; i++) {
        // One frame per step, on the run's own time: a sample's `every` counts simulated time.
        const nowMs = (loop.stepIndex + 1) * stepSeconds * 1000;
        loop.frame(source, { steps: 1 }, nowMs);
      }
    },
    send: (command, player) => {
      running("send");
      const { _tag: tag } = command as { readonly _tag: string };
      waiting.push(tag);
      loop.send(command, player, (outcome) => {
        waiting.splice(waiting.indexOf(tag), 1);
        // A command that was dropped never reached the rules: they didn't refuse it.
        if (outcome !== undefined && !(outcome instanceof CommandDropped)) {
          refusals.push({ rejection: outcome, command: tag, player });
        }
      });
    },
    refused: (expected) => {
      const actual = refusals;
      refusals = [];
      if (
        actual.length !== expected.length ||
        !actual.every(({ rejection }, i) => sameData(rejection, expected[i]))
      ) {
        throw new ScenarioError(
          `The rules refused other commands than the scenario says.\nExpected:\n${showAll(expected)}\nRefused:\n${showRefusals(actual)}`
        );
      }
    },
    reported: (expected) => {
      const actual = unchecked;
      unchecked = [];
      if (
        actual.length !== expected.length ||
        !actual.every((event, i) => sameData(event, expected[i]))
      ) {
        throw new ScenarioError(
          `The run reported other events than the scenario's.\nExpected:\n${showAll(expected)}\nReported:\n${showAll(actual)}`
        );
      }
    },
    sampled: (expected) => {
      if (!sameData(lastSample, expected)) {
        throw new ScenarioError(
          `The run's latest sample is not the scenario's.\nExpected:\n  ${show(expected)}\nSampled:\n  ${lastSample === undefined ? "(no sample)" : show(lastSample)}`
        );
      }
    },
    state: (check) => check(running("state")),
    end: () => {
      neverApplied("The scenario ended");
      if (refusals.length > 0) {
        throw new ScenarioError(
          `The scenario ended with a refused command no Scenario.refused checked:\n${showRefusals(refusals)}`
        );
      }
      if (unchecked.length > 0) {
        throw new ScenarioError(
          `The scenario ended with events no Scenario.reported checked:\n${showAll(unchecked)}`
        );
      }
    },
  };
};

/**
 * A scenario runner for `simulation`. Each call runs one scenario, from a `Scenario.given` to the last
 * step, and throws a `ScenarioError` at the first expectation that doesn't hold.
 *
 * ```ts
 * const scenario = Scenario.make(PushPuzzle);
 *
 * it("reports the solve on the move that fills the last goal", () =>
 *   scenario(
 *     Scenario.given({ content, levelId: "one-push" }),
 *     Scenario.step({ held: "right", pressed: "right", undo: false }),
 *     Scenario.reported(new LevelSolved({ moves: 1 })),
 *     Scenario.sampled(new Hud({ moves: 1, boxesLeft: 0 }))
 *   ));
 * ```
 *
 * A passing scenario accounts for everything: it fails if the run reported an event no
 * `Scenario.reported` checked, or the rules refused a command no `Scenario.refused` checked.
 * Samples are the exception, since a real-time game reports one every few steps: check the
 * latest with `Scenario.sampled`.
 */
export const make =
  <Config, State, Input, Event, Command, Refusals>(
    simulation: SimulationClass<
      string,
      Config,
      State,
      Input,
      Event,
      Command,
      Refusals
    >
  ): ((
    ...steps: readonly ScenarioSteps<
      ScenarioRunner<Config, State, Input, Event, Command, RefusalOf<Refusals>>
    >[]
  ) => void) =>
  (...steps) => {
    const runner = makeRunner(simulation);
    const run = (
      step: ScenarioSteps<
        ScenarioRunner<
          Config,
          State,
          Input,
          Event,
          Command,
          RefusalOf<Refusals>
        >
      >
    ): void => {
      if (typeof step === "function") {
        step(runner);
      } else {
        for (const inner of step) {
          run(inner);
        }
      }
    };
    run(steps);
    runner.end();
  };

/**
 * Starts the run the scenario is about, with `config`. The seed is 0 unless the scenario says
 * otherwise: the same seed, steps and commands always give the same run.
 */
export const given =
  <Config>(
    config: Config,
    options?: { readonly seed?: number }
  ): ScenarioStep<{ readonly given: (config: Config, seed: number) => void }> =>
  (runner) =>
    runner.given(config, options?.seed ?? 0);

/** Runs `count` steps (1 unless given) with `input` held for each. */
export const step =
  <Input>(
    input: Input,
    count?: number
  ): ScenarioStep<{ readonly step: (input: Input, count: number) => void }> =>
  (runner) =>
    runner.step(input, count ?? 1);

/** Sends a command, as `player` (slot 0 unless given). The next step applies it. */
export const send =
  <Command>(
    command: Command,
    player?: number
  ): ScenarioStep<{
    readonly send: (command: Command, player: number) => void;
  }> =>
  (runner) =>
    runner.send(command, player ?? 0);

/**
 * Checks what the run reported since the last `reported` (or since `given`): exactly these
 * events, in this order. With no events, it checks that nothing was reported. Samples aren't
 * counted.
 */
export const reported =
  <const Events extends readonly unknown[]>(
    ...events: Events
  ): ScenarioStep<{
    readonly reported: (expected: readonly Events[number][]) => void;
  }> =>
  (runner) =>
    runner.reported(events);

/**
 * Checks what the rules refused since the last `refused` (or since `given`): exactly these
 * rejections, in this order. A command is refused at the step after it is sent, so step first.
 */
export const refused =
  <const Rejections extends readonly unknown[]>(
    ...rejections: Rejections
  ): ScenarioStep<{
    readonly refused: (expected: readonly Rejections[number][]) => void;
  }> =>
  (runner) =>
    runner.refused(rejections);

/** Checks the run's latest sample. */
export const sampled =
  <Event>(
    sample: Event
  ): ScenarioStep<{ readonly sampled: (expected: Event) => void }> =>
  (runner) =>
    runner.sampled(sample);

/** Reads the run's state: `check` asserts on it with the test's own `expect`. */
export const state =
  <State>(
    check: (state: State) => void
  ): ScenarioStep<{
    readonly state: (check: (state: State) => void) => void;
  }> =>
  (runner) =>
    runner.state(check);
