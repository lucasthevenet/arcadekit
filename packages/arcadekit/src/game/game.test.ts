import { Effect, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as Game from "./index";

// A small game: each step adds what the input holds to a count, and reports when the count
// first reaches the run's target. A command adds a bonus, once, at a step.

class Reached extends Game.Event("Reached", { count: Schema.Int }) {}
class Started extends Game.Event("Started") {}
class Tally extends Game.Event("Tally", {
  count: Schema.Int,
  bonus: Schema.Int,
}) {}
class AddBonus extends Game.Command("AddBonus", { amount: Schema.Int }) {}

const CounterInput = Schema.Struct({ add: Schema.Int });

interface CounterState {
  readonly target: number;
  readonly seed: number;
  count: number;
  bonus: number;
  reached: boolean;
  /** What happened, in order: each command and each step. */
  readonly log: string[];
}

class Counter extends Game.Simulation("Counter", {
  // 1/64 s steps: the frame times below are exact in floating point.
  stepSeconds: 1 / 64,
  input: CounterInput,
  events: [Started, Reached],
  commands: [AddBonus],
  create: (config: { readonly target: number }, { seed, emit }) => {
    emit(new Started());
    const state: CounterState = {
      target: config.target,
      seed,
      count: 0,
      bonus: 0,
      reached: false,
      log: [],
    };
    return state;
  },
  step: (state, input, { dt, emit, step }) => {
    state.count += input.add;
    state.log.push(`step ${step} dt ${dt}`);
    if (!state.reached && state.count + state.bonus >= state.target) {
      state.reached = true;
      emit(new Reached({ count: state.count + state.bonus }));
    }
  },
  apply: {
    AddBonus: (state, command, { player, step }) => {
      state.bonus += command.amount;
      state.log.push(`bonus ${command.amount} from ${player} at ${step}`);
    },
  },
  sample: {
    event: Tally,
    version: (state) => state.count + state.bonus,
    read: (state) => ({ count: state.count, bonus: state.bonus }),
  },
}) {}

const holding = (add: number) => ({ read: () => ({ add }) });

/** Starts a run of `simulation` and runs one step of it. */
const runOneStep = <Input>(
  simulation: Game.SimulationClass<
    string,
    unknown,
    unknown,
    Input,
    unknown,
    unknown
  >,
  input: { readonly read: () => Input }
) => {
  const loop = new Game.Loop(simulation);
  loop.start(undefined, 1, 0);
  loop.frame(input, { steps: 1 }, 0);
};

/** Declares a simulation whose command has no handler. */
const declareWithoutHandler = () =>
  Game.Simulation("Broken", {
    input: Schema.Null,
    commands: [AddBonus],
    create: () => ({}),
    step: () => {},
    // @ts-expect-error -- `apply` has no AddBonus.
    apply: {},
  });

/** A started loop of the counter game, and every event it reports. */
const startCounter = (target = 3) => {
  const loop = new Game.Loop(Counter);
  const heard: Game.EventOf<typeof Counter>[] = [];
  loop.subscribe((event) => heard.push(event));
  loop.start({ target }, 7, 0);
  return { loop, heard };
};

describe("Game.Event", () => {
  it("makes values with its tag and payload, and is their Schema", () => {
    const reached = new Reached({ count: 3 });
    expect(reached._tag).toBe("Reached");
    expect(reached.count).toBe(3);
    expect(Reached.tag).toBe("Reached");
    expect(Schema.is(Reached)(reached)).toBe(true);
    expect(Schema.encodeSync(Reached)(reached)).toStrictEqual({
      _tag: "Reached",
      count: 3,
    });
    expectTypeOf(reached).toExtend<{
      readonly _tag: "Reached";
      readonly count: number;
    }>();
  });

  it("refuses a payload its fields don't allow", () => {
    expect(() => new Reached({ count: 1.5 })).toThrow("Schema validation");
  });

  it("needs no fields", () => {
    expect(new Started()._tag).toBe("Started");
  });
});

describe("Game.Simulation", () => {
  it("names its config, state, input, events and commands", () => {
    expectTypeOf<Game.ConfigOf<typeof Counter>>().toEqualTypeOf<{
      readonly target: number;
    }>();
    expectTypeOf<Game.StateOf<typeof Counter>>().toEqualTypeOf<CounterState>();
    expectTypeOf<Game.InputOf<typeof Counter>>().toEqualTypeOf<{
      readonly add: number;
    }>();
    // Each is the declared class's value, both ways.
    expectTypeOf<Game.EventOf<typeof Counter>>().toExtend<
      Started | Reached | Tally
    >();
    expectTypeOf<Started | Reached | Tally>().toExtend<
      Game.EventOf<typeof Counter>
    >();
    expectTypeOf<Game.CommandOf<typeof Counter>>().toExtend<AddBonus>();
    expectTypeOf<AddBonus>().toExtend<Game.CommandOf<typeof Counter>>();
  });

  it("refuses a command with no handler when it is declared", () => {
    expect(declareWithoutHandler).toThrow(/declares the command "AddBonus"/u);
  });

  it("matches every event by its tag", () => {
    const describeEvent = Counter.match({
      Started: () => "started",
      Reached: ({ count }) => `reached ${count}`,
      Tally: ({ count, bonus }) => count + bonus,
    });
    expectTypeOf(describeEvent).returns.toEqualTypeOf<string | number>();
    expect(describeEvent(new Reached({ count: 4 }))).toBe("reached 4");
    expect(describeEvent(new Tally({ count: 1, bonus: 2 }))).toBe(3);
  });
});

describe("Game.Loop", () => {
  it("starts a run with its seed, and reports create's events, then the first sample", () => {
    const { loop, heard } = startCounter();
    expect(loop.state?.seed).toBe(7);
    expect(heard).toStrictEqual([
      new Started(),
      new Tally({ count: 0, bonus: 0 }),
    ]);
  });

  it("steps with the input, numbering steps from 0, and reports the step's events then a sample", () => {
    const { loop, heard } = startCounter(2);
    heard.length = 0;
    expect(loop.frame(holding(1), { steps: 2 }, 0)).toBe(2);
    expect(loop.state?.log).toStrictEqual([
      "step 0 dt 0.015625",
      "step 1 dt 0.015625",
    ]);
    expect(loop.stepIndex).toBe(2);
    expect(heard).toStrictEqual([
      new Reached({ count: 2 }),
      new Tally({ count: 2, bonus: 0 }),
    ]);
  });

  it("applies a command at the start of the next step, in the order sent", () => {
    const { loop } = startCounter(100);
    loop.frame(holding(1), { steps: 1 }, 0);
    loop.send(new AddBonus({ amount: 5 }));
    loop.send(new AddBonus({ amount: 2 }), 1);
    // Nothing is applied until a step runs.
    expect(loop.state?.bonus).toBe(0);
    loop.frame(holding(1), { steps: 2 }, 0);
    expect(loop.state?.log).toStrictEqual([
      "step 0 dt 0.015625",
      "bonus 5 from 0 at 1",
      "bonus 2 from 1 at 1",
      "step 1 dt 0.015625",
      "step 2 dt 0.015625",
    ]);
  });

  it("holds commands while paused, and applies them when it steps again", () => {
    const { loop } = startCounter(100);
    loop.setPaused(true);
    loop.send(new AddBonus({ amount: 5 }));
    expect(loop.frame(holding(1), { steps: 1 }, 0)).toBe(0);
    expect(loop.state?.bonus).toBe(0);
    loop.setPaused(false);
    loop.frame(holding(1), { steps: 1 }, 0);
    expect(loop.state?.bonus).toBe(5);
  });

  it("drops a command sent with no run, and the commands a stopped run hadn't applied", () => {
    const loop = new Game.Loop(Counter);
    loop.send(new AddBonus({ amount: 5 }));
    loop.start({ target: 100 }, 1, 0);
    loop.send(new AddBonus({ amount: 3 }));
    loop.stop();
    loop.start({ target: 100 }, 1, 0);
    loop.frame(holding(0), { steps: 1 }, 0);
    expect(loop.state?.bonus).toBe(0);
  });

  it("reports a sample only when its version moved", () => {
    const { loop, heard } = startCounter(100);
    heard.length = 0;
    loop.frame(holding(0), { steps: 3 }, 0);
    expect(heard).toStrictEqual([]);
    loop.frame(holding(2), { steps: 1 }, 0);
    expect(heard).toStrictEqual([new Tally({ count: 2, bonus: 0 })]);
  });

  it("reports a sample every `every`, on the time its caller passes", () => {
    class Ticked extends Game.Event("Ticked", { steps: Schema.Int }) {}
    class Ticker extends Game.Simulation("Ticker", {
      stepSeconds: 1 / 64,
      input: Schema.Null,
      create: () => ({ steps: 0 }),
      step: (state) => {
        state.steps += 1;
      },
      sample: {
        event: Ticked,
        every: "100 millis",
        read: (state) => ({ steps: state.steps }),
      },
    }) {}
    const loop = new Game.Loop(Ticker);
    const heard: Ticked[] = [];
    loop.subscribe((event) => heard.push(event));
    loop.start(undefined, 1, 0);
    const input = { read: () => null };
    loop.frame(input, { steps: 1 }, 50);
    loop.frame(input, { steps: 1 }, 100);
    loop.frame(input, { steps: 1 }, 150);
    expect(heard).toStrictEqual([
      new Ticked({ steps: 0 }),
      new Ticked({ steps: 2 }),
    ]);
  });

  it("refuses a step that returns anything: an async step, an Effect, the next state", async () => {
    const steps = { waited: 0, effects: 0 };
    class Late extends Game.Simulation("Late", {
      input: Schema.Null,
      create: () => ({ n: 0 }),
      // Compiles: a handler typed `=> void` accepts any return.
      step: async (state) => {
        await Promise.resolve();
        state.n += 1;
        steps.waited += 1;
      },
    }) {}
    class Lazy extends Game.Simulation("Lazy", {
      input: Schema.Null,
      create: () => ({ n: 0 }),
      step: (state) =>
        Effect.sync(() => {
          state.n += 1;
          steps.effects += 1;
        }),
    }) {}
    class Folded extends Game.Simulation("Folded", {
      input: Schema.Null,
      create: () => ({ n: 0 }),
      step: (state) => ({ n: state.n + 1 }),
    }) {}
    const input = { read: () => null };
    const stepOnce = (simulation: Parameters<typeof runOneStep>[0]) => () =>
      runOneStep(simulation, input);
    expect(stepOnce(Late)).toThrow(
      'Simulation "Late": step returned a promise. A handler changes the state in place and returns nothing'
    );
    expect(stepOnce(Lazy)).toThrow(
      'Simulation "Lazy": step returned an Effect.'
    );
    expect(stepOnce(Folded)).toThrow(
      'Simulation "Folded": step returned a value.'
    );
    // The Effect was never run. The async step had already started; it finishes on its own.
    await Promise.resolve();
    expect(steps).toStrictEqual({ waited: 1, effects: 0 });
  });

  it("refuses an apply handler that returns the events to report, as a reference `decide` does", () => {
    class Decided extends Game.Simulation("Decided", {
      input: Schema.Null,
      events: [Reached],
      commands: [AddBonus],
      create: () => ({ bonus: 0 }),
      step: () => {},
      apply: {
        AddBonus: (_state, command) => [new Reached({ count: command.amount })],
      },
    }) {}
    const loop = new Game.Loop(Decided);
    loop.start(undefined, 1, 0);
    loop.send(new AddBonus({ amount: 2 }));
    expect(() => loop.frame({ read: () => null }, { steps: 1 }, 0)).toThrow(
      'Simulation "Decided": apply.AddBonus returned an array.'
    );
  });

  it("refuses a create that returns a promise or an Effect in place of the state", () => {
    class Loading extends Game.Simulation("Loading", {
      input: Schema.Null,
      create: async () => {
        await Promise.resolve();
        return { n: 0 };
      },
      step: () => {},
    }) {}
    const loop = new Game.Loop(Loading);
    expect(() => loop.start(undefined, 1, 0)).toThrow(
      'Simulation "Loading": create returned a promise.'
    );
  });

  it("turns frame time into whole steps on the simulation's fixed clock", () => {
    const { loop } = startCounter(100);
    // 62.5 ms is four 1/64 s steps.
    expect(loop.frame(holding(1), { seconds: 0.0625 }, 62.5)).toBe(4);
    expect(loop.state?.count).toBe(4);
  });

  it("gives each run its own state", () => {
    const { loop } = startCounter();
    const first = loop.state;
    loop.start({ target: 3 }, 8, 0);
    expect(loop.state).not.toBe(first);
    expect(loop.state?.seed).toBe(8);
    loop.stop();
    expect(loop.state).toBeNull();
  });
});
