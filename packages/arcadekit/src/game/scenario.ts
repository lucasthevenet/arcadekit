/**
 * `arcadekit/game/scenario`: scenarios, the specifications of a simulation that run it. Given a
 * run, after these steps and commands, it reported these events and refused these commands.
 *
 * A scenario steps the real simulation through a loop, the loop the browser engine runs, so what
 * it describes is what the game does. The entry is one module, which a test imports whole as
 * `Scenario`, so a step reads `Scenario.given(...)`. Plain code, like the loop (ADR-0024): a
 * scenario runs its script in one call, and a failed expectation is a test's throw.
 *
 * @since 0.7.0
 */
import { CommandDropped } from "./command";
import { resolve } from "./internal/resolved";
import { makeLoop } from "./loop";
import type { RefusalOf, SimulationClass } from "./simulation";

/**
 * What a scenario's steps drive: one run of the simulation, and what it has reported. Each step
 * is a function of the part of the runner it uses.
 *
 * **When to use**
 *
 * Rarely: a game's own step helper names it, through `Scenario.Step`, when it is generic over the
 * simulation it checks.
 *
 * **Example** (A step written against the runner)
 *
 * ```ts
 * import * as Scenario from "arcadekit/game/scenario";
 *
 * const told: string[] = [];
 * const runner: Pick<Scenario.Runner<null, null, null, never, never>, "given"> = {
 *   given: (_config, seed) => {
 *     told.push(`given, seed ${seed}`);
 *   },
 * };
 * Scenario.given(null, { seed: 3 })(runner);
 * told; // => ["given, seed 3"]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Runner<
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
 * One step of a scenario: a function of the part of the runner it uses, so a scenario's steps are
 * checked against its simulation's types where the scenario is written.
 *
 * **When to use**
 *
 * To type a step a game makes of its own, such as one that checks a HUD.
 *
 * **Example** (A step of a game's own)
 *
 * ```ts
 * import * as Scenario from "arcadekit/game/scenario";
 *
 * const nothingReported: Scenario.Step<{
 *   readonly reported: (expected: readonly never[]) => void;
 * }> = Scenario.reported();
 * typeof nothingReported; // => "function"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Step<R> = (runner: R) => void;

/**
 * A step, or a list of them: a game's own helper, such as one tap, is a list.
 *
 * **When to use**
 *
 * To type a helper that returns several steps, which a scenario takes as one.
 *
 * **Example** (One tap, as two steps)
 *
 * ```ts
 * import * as Scenario from "arcadekit/game/scenario";
 *
 * const tap = (direction: string): Scenario.Steps<{
 *   readonly step: (input: { readonly pressed: string | null }, count: number) => void;
 * }> => [Scenario.step({ pressed: direction }), Scenario.step({ pressed: null })];
 * const steps = tap("right");
 * Array.isArray(steps); // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Steps<R> = Step<R> | readonly Steps<R>[];

/**
 * A scenario that failed: an expectation that didn't hold, or a step out of place. It is a test's
 * throw, as an assertion's is.
 *
 * **When to use**
 *
 * Never by hand: a scenario throws it at the first expectation that fails, and the test runner
 * reports its message, which shows what was expected and what the run did.
 *
 * **Example** (A scenario that expected an event)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class Ding extends Game.Event("Ding") {}
 * class Quiet extends Game.Simulation("Quiet", {
 *   input: Schema.Null,
 *   events: [Ding],
 *   create: () => ({}),
 *   step: () => {},
 * }) {}
 *
 * let failure: unknown;
 * try {
 *   Scenario.make(Quiet)(Scenario.given(null), Scenario.step(null), Scenario.reported(new Ding()));
 * } catch (error) {
 *   failure = error;
 * }
 * failure instanceof Scenario.ScenarioError; // => true
 * ```
 *
 * @category errors
 * @since 0.7.0
 */
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
): Runner<Config, State, Input, Event, Command, RefusalOf<Refusals>> & {
  readonly end: () => void;
} => {
  const { sample, stepSeconds } = resolve(simulation);
  const loop = makeLoop(simulation);
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
 * Makes the scenario runner of `simulation`: a function that runs one scenario per call, from a
 * `Scenario.given` to its last step, and throws a `ScenarioError` at the first expectation that
 * doesn't hold.
 *
 * **When to use**
 *
 * Once per simulation, in its test file: each test then states one rule as a scenario.
 *
 * **Details**
 *
 * A passing scenario accounts for everything: it fails if the run reported an event no
 * `Scenario.reported` checked, if the rules refused a command no `Scenario.refused` checked, or
 * if a command was sent and no step applied it. Samples are the exception, since a real-time game
 * reports one every few steps: check the latest with `Scenario.sampled`. The run's time is its
 * own: each step is one frame, at the time that step ends.
 *
 * **Example** (A door that opens once its lever is held)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class Opened extends Game.Event("Opened", { atStep: Schema.Int }) {}
 * class Door extends Game.Simulation("Door", {
 *   input: Schema.Boolean,
 *   events: [Opened],
 *   create: () => ({ held: 0, open: false }),
 *   step: (door, lever, { step, report }) => {
 *     door.held = lever ? door.held + 1 : 0;
 *     if (!door.open && door.held === 3) {
 *       door.open = true;
 *       report(new Opened({ atStep: step }));
 *     }
 *   },
 * }) {}
 *
 * const scenario = Scenario.make(Door);
 * const run = () =>
 *   scenario(
 *     Scenario.given(null),
 *     Scenario.step(true, 2),
 *     Scenario.reported(),
 *     Scenario.step(true),
 *     Scenario.reported(new Opened({ atStep: 2 }))
 *   );
 * run(); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
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
    ...steps: readonly Steps<
      Runner<Config, State, Input, Event, Command, RefusalOf<Refusals>>
    >[]
  ) => void) =>
  (...steps) => {
    const runner = makeRunner(simulation);
    const run = (
      step: Steps<
        Runner<Config, State, Input, Event, Command, RefusalOf<Refusals>>
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
 * A step that starts the run the scenario is about, with `config`. The seed is 0 unless the
 * scenario says otherwise: the same seed, steps and commands always give the same run.
 *
 * **When to use**
 *
 * First in every scenario; a later one starts a new run, and refuses to while a command sent to
 * the run before is still waiting.
 *
 * **Example** (Starting with a seed)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class Seeded extends Game.Simulation("Seeded", {
 *   input: Schema.Null,
 *   create: (_config: null, { seed }) => ({ seed }),
 *   step: () => {},
 * }) {}
 *
 * let seen = -1;
 * Scenario.make(Seeded)(
 *   Scenario.given(null, { seed: 7 }),
 *   Scenario.state((run) => {
 *     seen = run.seed;
 *   })
 * );
 * seen; // => 7
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const given =
  <Config>(
    config: Config,
    options?: { readonly seed?: number }
  ): Step<{ readonly given: (config: Config, seed: number) => void }> =>
  (runner) =>
    runner.given(config, options?.seed ?? 0);

/**
 * A step that runs `count` steps of the simulation (1 unless given) with `input` held for each.
 *
 * **When to use**
 *
 * After `Scenario.given`, and after a `Scenario.send`, whose command the next step applies.
 *
 * **Example** (Ten steps with a button held)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Boolean,
 *   create: () => ({ held: 0 }),
 *   step: (count, held) => {
 *     count.held += held ? 1 : 0;
 *   },
 * }) {}
 *
 * let held = 0;
 * Scenario.make(Count)(
 *   Scenario.given(null),
 *   Scenario.step(true, 10),
 *   Scenario.state((count) => {
 *     held = count.held;
 *   })
 * );
 * held; // => 10
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const step =
  <Input>(
    input: Input,
    count?: number
  ): Step<{ readonly step: (input: Input, count: number) => void }> =>
  (runner) =>
    runner.step(input, count ?? 1);

/**
 * A step that sends a command, as `player` (slot 0 unless given). The next step applies it.
 *
 * **When to use**
 *
 * To check how the rules take a command: send it, step, then check what was reported or refused.
 *
 * **Example** (A command from the second player)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class Ready extends Game.Command("Ready") {}
 * class Lobby extends Game.Simulation("Lobby", {
 *   input: Schema.Null,
 *   commands: [Ready],
 *   create: () => ({ ready: [false, false] }),
 *   step: () => {},
 *   apply: {
 *     Ready: (lobby, _ready, { player }) => {
 *       lobby.ready[player] = true;
 *     },
 *   },
 * }) {}
 *
 * let ready: boolean[] = [];
 * Scenario.make(Lobby)(
 *   Scenario.given(null),
 *   Scenario.send(new Ready(), 1),
 *   Scenario.step(null),
 *   Scenario.state((lobby) => {
 *     ready = lobby.ready;
 *   })
 * );
 * ready; // => [false, true]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const send =
  <Command>(
    command: Command,
    player?: number
  ): Step<{
    readonly send: (command: Command, player: number) => void;
  }> =>
  (runner) =>
    runner.send(command, player ?? 0);

/**
 * A step that checks what the run reported since the last `reported` (or since `given`): exactly
 * these events, in this order. With no events, it checks that nothing was reported. Samples
 * aren't counted.
 *
 * **When to use**
 *
 * After the steps that should report, and wherever a scenario says nothing happened.
 *
 * **Example** (One event, then nothing)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class Started extends Game.Event("Started") {}
 * class Once extends Game.Simulation("Once", {
 *   input: Schema.Null,
 *   events: [Started],
 *   create: (_config: null, { report }) => {
 *     report(new Started());
 *     return {};
 *   },
 *   step: () => {},
 * }) {}
 *
 * const run = () =>
 *   Scenario.make(Once)(
 *     Scenario.given(null),
 *     Scenario.reported(new Started()),
 *     Scenario.step(null, 5),
 *     Scenario.reported()
 *   );
 * run(); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const reported =
  <const Events extends readonly unknown[]>(
    ...events: Events
  ): Step<{
    readonly reported: (expected: readonly Events[number][]) => void;
  }> =>
  (runner) =>
    runner.reported(events);

/**
 * A step that checks what the rules refused since the last `refused` (or since `given`): exactly
 * these rejections, in this order. A command is refused at the step after it is sent, so step
 * first.
 *
 * **When to use**
 *
 * After the step that applies a command the rules should turn down.
 *
 * **Example** (A pick of a closed offer)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed") {}
 * class Pick extends Game.Command("Pick", {}, { rejects: [OfferClosed] }) {}
 * class Shop extends Game.Simulation("Shop", {
 *   input: Schema.Null,
 *   commands: [Pick],
 *   create: () => ({ open: false }),
 *   step: () => {},
 *   apply: {
 *     Pick: (shop) => (shop.open ? undefined : new OfferClosed()),
 *   },
 * }) {}
 *
 * const run = () =>
 *   Scenario.make(Shop)(
 *     Scenario.given(null),
 *     Scenario.send(new Pick()),
 *     Scenario.step(null),
 *     Scenario.refused(new OfferClosed())
 *   );
 * run(); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const refused =
  <const Rejections extends readonly unknown[]>(
    ...rejections: Rejections
  ): Step<{
    readonly refused: (expected: readonly Rejections[number][]) => void;
  }> =>
  (runner) =>
    runner.refused(rejections);

/**
 * A step that checks the run's latest sample.
 *
 * **When to use**
 *
 * To check what a HUD shows after some steps, without listing every sample the run made.
 *
 * **Example** (The HUD after three steps)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class Hud extends Game.Event("Hud", { steps: Schema.Int }) {}
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: (count) => {
 *     count.steps += 1;
 *   },
 *   sample: { event: Hud, version: (count) => count.steps, read: (count) => ({ steps: count.steps }) },
 * }) {}
 *
 * const run = () =>
 *   Scenario.make(Count)(
 *     Scenario.given(null),
 *     Scenario.step(null, 3),
 *     Scenario.sampled(new Hud({ steps: 3 }))
 *   );
 * run(); // => undefined
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const sampled =
  <Event>(
    sample: Event
  ): Step<{ readonly sampled: (expected: Event) => void }> =>
  (runner) =>
    runner.sampled(sample);

/**
 * A step that reads the run's state: `check` asserts on it with the test's own `expect`.
 *
 * **When to use**
 *
 * For what the run's events don't show, such as a quiet change a refused command must not make.
 *
 * **Example** (Reading the state)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import * as Scenario from "arcadekit/game/scenario";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: (count) => {
 *     count.steps += 1;
 *   },
 * }) {}
 *
 * const seen: number[] = [];
 * Scenario.make(Count)(
 *   Scenario.given(null),
 *   Scenario.step(null, 2),
 *   Scenario.state((count) => {
 *     seen.push(count.steps);
 *   })
 * );
 * seen; // => [2]
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const state =
  <State>(
    check: (state: State) => void
  ): Step<{
    readonly state: (check: (state: State) => void) => void;
  }> =>
  (runner) =>
    runner.state(check);
