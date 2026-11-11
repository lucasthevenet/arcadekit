import { Effect, Exit, Schema } from "effect";
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
  create: (config: { readonly target: number }, { seed, report }) => {
    report(new Started());
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
  step: (state, input, { dt, report, step }) => {
    state.count += input.add;
    state.log.push(`step ${step} dt ${dt}`);
    if (!state.reached && state.count + state.bonus >= state.target) {
      state.reached = true;
      report(new Reached({ count: state.count + state.bonus }));
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

/** Simulations whose handlers return what a handler can't: each is a type error. */
const declareMistyped = () => [
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Game.Simulation("Late", {
    input: Schema.Null,
    create: () => ({ n: 0 }),
    // @ts-expect-error -- a step can't be async: it would return a promise.
    // oxlint-disable-next-line declaration/plain-handler -- The async step is what the types must refuse.
    step: async () => {},
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Game.Simulation("Lazy", {
    input: Schema.Null,
    create: () => ({ n: 0 }),
    // @ts-expect-error -- a step returns no Effect: nothing would run it.
    step: () => Effect.void,
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Game.Simulation("Folded", {
    input: Schema.Null,
    create: () => ({ n: 0 }),
    // @ts-expect-error -- a step changes the state in place; it returns no next state.
    step: (state) => ({ n: state.n + 1 }),
  }),
  // oxlint-disable-next-line declaration/class -- A test declares what the types must refuse.
  Game.Simulation("Decided", {
    input: Schema.Null,
    events: [Reached],
    commands: [AddBonus],
    create: () => ({ bonus: 0 }),
    step: () => {},
    apply: {
      // @ts-expect-error -- a handler reports with `report`; it returns no events.
      AddBonus: (_state, command) => [new Reached({ count: command.amount })],
    },
  }),
];

/** A handler with its return type cast away, as a cast or plain JavaScript would pass it. */
const unchecked = <Args extends readonly unknown[]>(
  handler: (...args: Args) => unknown
) => handler as (...args: Args) => undefined;

/** Starts a run of `simulation` and runs one step of it. */
const runOneStep = <Input>(
  simulation: Game.SimulationClass<
    string,
    unknown,
    unknown,
    Input,
    unknown,
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
  // oxlint-disable-next-line declaration/class -- A test declares what a builder or its host must refuse.
  Game.Simulation("Broken", {
    input: Schema.Null,
    commands: [AddBonus],
    create: () => ({}),
    step: () => {},
    // @ts-expect-error -- `apply` has no AddBonus.
    apply: {},
  });

/** Declares a simulation with a handler in `apply` and no command for it. */
const declareWithoutCommand = () =>
  // oxlint-disable-next-line declaration/class -- A test declares what a builder or its host must refuse.
  Game.Simulation("Idle", {
    input: Schema.Null,
    create: () => ({ bonus: 0 }),
    step: () => {},
    apply: {
      // @ts-expect-error -- no command is declared, so `apply` takes no handler.
      AddBonus: (state) => {
        state.bonus += 1;
      },
    },
  });

// `apply` is written directly under `create` here, and `step` last: with `create` the first of
// the handlers, each takes the state it returns wherever it is written. Typecheck holds it.
class Ordered extends Game.Simulation("Ordered", {
  input: Schema.Null,
  commands: [AddBonus],
  create: (config: { readonly start: number }, { seed }) => ({
    total: config.start + seed,
  }),
  apply: {
    AddBonus: (state, command) => {
      state.total += command.amount;
    },
  },
  step: (state) => {
    state.total += 1;
  },
}) {}

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

  it("types an apply handler from create when create is the first of the handlers", () => {
    expectTypeOf<Game.StateOf<typeof Ordered>>().toEqualTypeOf<{
      total: number;
    }>();
    const loop = new Game.Loop(Ordered);
    loop.start({ start: 1 }, 2, 0);
    loop.send(new AddBonus({ amount: 4 }));
    loop.frame({ read: () => null }, { steps: 1 }, 0);
    expect(loop.state).toStrictEqual({ total: 8 });
  });

  it("types a handler with its command when the command's tag is not one literal", () => {
    // A tag typed `string`, as a command has it when a function made its class from a name.
    // Typecheck holds the handler's `command`.
    class Nudge extends Game.Command("Nudge" as string, { by: Schema.Int }) {}
    class Loose extends Game.Simulation("Loose", {
      input: Schema.Null,
      commands: [Nudge],
      create: () => ({ total: 0 }),
      step: () => {},
      apply: {
        Nudge: (state, command) => {
          state.total += command.by;
        },
      },
    }) {}
    expectTypeOf(Nudge.tag).toEqualTypeOf<string>();
    const loop = new Game.Loop(Loose);
    loop.start(undefined, 1, 0);
    loop.send(new Nudge({ by: 3 }));
    loop.frame({ read: () => null }, { steps: 1 }, 0);
    expect(loop.state).toStrictEqual({ total: 3 });
  });

  it("asks a tag typed as a union for a handler under each member, and refuses the one with no command", () => {
    // Only "Left" is the class's tag when it runs, so no definition of it both typechecks and
    // declares: a command has a tag of one literal.
    class Left extends Game.Command("Left" as "Left" | "Right") {}
    expect(() =>
      // oxlint-disable-next-line declaration/class -- A test declares what a builder or its host must refuse.
      Game.Simulation("Turning", {
        input: Schema.Null,
        commands: [Left],
        create: () => ({ turns: 0 }),
        step: () => {},
        // @ts-expect-error -- the tag's other member, "Right", has no handler.
        apply: { Left: () => {} },
      })
    ).not.toThrow();
    expect(() =>
      // oxlint-disable-next-line declaration/class -- A test declares what a builder or its host must refuse.
      Game.Simulation("Turning", {
        input: Schema.Null,
        commands: [Left],
        create: () => ({ turns: 0 }),
        step: () => {},
        apply: { Left: () => {}, Right: () => {} },
      })
    ).toThrow('has apply.Right but declares no command "Right"');
  });

  it("refuses a command with no handler when it is declared", () => {
    expect(declareWithoutHandler).toThrow(/declares the command "AddBonus"/u);
  });

  it("refuses a handler with no command when it is declared", () => {
    // An `Error` holds the whole message: a string would only have to be a part of it.
    expect(declareWithoutCommand).toThrow(
      new Error(
        'Simulation "Idle" has apply.AddBonus but declares no command "AddBonus". List the command\'s class in `commands`, or remove the handler.'
      )
    );
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

  it("refuses a case for an event it doesn't report, when match is called", () => {
    // The types let an extra case through: one a renamed event left behind would never run.
    expect(() =>
      Counter.match({
        Started: () => "started",
        Reached: () => "reached",
        Tally: () => "tally",
        Finished: () => "finished",
      })
    ).toThrow(
      'Simulation "Counter" has a case "Finished", which it doesn\'t report (Started, Reached, Tally). Remove it, or name it after the event it handles.'
    );
  });

  it("refuses a missing case when match is called, not when its event comes", () => {
    expect(() =>
      // @ts-expect-error -- Tally, the sample, has no case
      Counter.match({ Started: () => "started", Reached: () => "reached" })
    ).toThrow(
      'Simulation "Counter" has no case for the event "Tally". `match` takes a case for everything the simulation reports (Started, Reached, Tally).'
    );
  });

  it("refuses an event the simulation doesn't declare, when it comes", () => {
    const describeEvent = Counter.match({
      Started: () => "started",
      Reached: () => "reached",
      Tally: () => "tally",
    });
    expect(() =>
      // @ts-expect-error -- not one of the simulation's events
      describeEvent({ _tag: "Undeclared" })
    ).toThrow('Simulation "Counter" has no case for the event "Undeclared".');
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

  it("applies a command its input source sends from read at that same step, before the step", () => {
    const { loop } = startCounter(100);
    const told: string[] = [];
    // A command sent before the frame waits for its first step; the source's own are sent as it
    // reads steps 1 and 2, as a lockstep session hands over what a confirmed step carries.
    loop.send(new AddBonus({ amount: 1 }));
    const source = {
      read: (step: number) => {
        if (step === 0) {
          // After the one that was already waiting.
          loop.send(new AddBonus({ amount: 3 }), 1);
        }
        if (step === 1) {
          loop.send(new AddBonus({ amount: 5 }), 2, () =>
            told.push(`told after ${loop.stepIndex} steps`)
          );
          loop.send(new AddBonus({ amount: 7 }), 1);
        }
        if (step === 2) {
          loop.send(new AddBonus({ amount: 9 }), 3);
        }
        return { add: 1 };
      },
    };
    expect(loop.frame(source, { steps: 4 }, 0)).toBe(4);
    expect(loop.state?.log).toStrictEqual([
      "bonus 1 from 0 at 0",
      "bonus 3 from 1 at 0",
      "step 0 dt 0.015625",
      "bonus 5 from 2 at 1",
      "bonus 7 from 1 at 1",
      "step 1 dt 0.015625",
      "bonus 9 from 3 at 2",
      "step 2 dt 0.015625",
      "step 3 dt 0.015625",
    ]);
    // The sender hears once the frame's steps are over, as for any other command.
    expect(told).toStrictEqual(["told after 4 steps"]);
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

  it("refuses, as a type error, a handler that returns what it shouldn't", () => {
    // Declaring them is no run-time error: the next test shows what the loop does with each.
    expect(declareMistyped).not.toThrow();
  });

  it("refuses at run time what a cast got past the types: a promise, an Effect, the next state", async () => {
    const steps = { waited: 0, effects: 0 };
    class Late extends Game.Simulation("Late", {
      input: Schema.Null,
      create: () => ({ n: 0 }),
      step: unchecked(async (state: { n: number }) => {
        await Promise.resolve();
        state.n += 1;
        steps.waited += 1;
      }),
    }) {}
    class Lazy extends Game.Simulation("Lazy", {
      input: Schema.Null,
      create: () => ({ n: 0 }),
      step: unchecked((state: { n: number }) =>
        Effect.sync(() => {
          state.n += 1;
          steps.effects += 1;
        })
      ),
    }) {}
    class Folded extends Game.Simulation("Folded", {
      input: Schema.Null,
      create: () => ({ n: 0 }),
      step: unchecked((state: { n: number }) => ({ n: state.n + 1 })),
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
        AddBonus: unchecked((_state: unknown, command: AddBonus) => [
          new Reached({ count: command.amount }),
        ]),
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
      // oxlint-disable-next-line declaration/plain-handler -- A test declares what a builder or its host must refuse.
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

// A jar that takes coins up to a limit, and a command the rules refuse past it.
class JarFull extends Game.Rejection("JarFull", { room: Schema.Int }) {}
class Deposit extends Game.Command(
  "Deposit",
  { coins: Schema.Int },
  { rejects: [JarFull] }
) {}
class Empty extends Game.Command("Empty") {}

const JAR_LIMIT = 10;

class Jar extends Game.Simulation("Jar", {
  input: Schema.Null,
  commands: [Deposit, Empty],
  create: () => ({ coins: 0, emptied: 0 }),
  step: () => {},
  apply: {
    Deposit: (jar, command) => {
      // Decide first, then change: a refused command leaves the state as it was.
      if (jar.coins + command.coins > JAR_LIMIT) {
        return new JarFull({ room: JAR_LIMIT - jar.coins });
      }
      jar.coins += command.coins;
    },
    Empty: (jar) => {
      jar.coins = 0;
      jar.emptied += 1;
    },
  },
}) {}

const IDLE = { read: () => null };

/** A started jar, and how each command sent through `send` ended, in order. */
const startJar = () => {
  const loop = new Game.Loop(Jar);
  loop.start(undefined, 1, 0);
  const outcomes: unknown[] = [];
  return {
    loop,
    outcomes,
    send: (command: Deposit | Empty) =>
      loop.send(command, 0, (outcome) => outcomes.push(outcome)),
    step: () => loop.frame(IDLE, { steps: 1 }, 0),
  };
};

describe("a command the rules may refuse", () => {
  it("is a value with its tag and payload, and an error an Effect can fail with", () => {
    const full = new JarFull({ room: 2 });
    expect({ tag: full._tag, room: full.room }).toStrictEqual({
      tag: "JarFull",
      room: 2,
    });
    expect(full).toBeInstanceOf(Error);
    expect([Deposit.rejects, Empty.rejects]).toStrictEqual([[JarFull], []]);
    expect(Effect.runSyncExit(Effect.fail(full))).toStrictEqual(
      Exit.fail(new JarFull({ room: 2 }))
    );
  });

  it("tells the sender its handler took the command, at the step that applies it", () => {
    const { loop, outcomes, send, step } = startJar();
    send(new Deposit({ coins: 4 }));
    expect(outcomes).toStrictEqual([]);
    step();
    expect(outcomes).toStrictEqual([undefined]);
    expect(loop.state?.coins).toBe(4);
  });

  it("gives the sender the rejection the handler returned, and goes on to the next command", () => {
    const { loop, outcomes, send, step } = startJar();
    send(new Deposit({ coins: 8 }));
    send(new Deposit({ coins: 5 }));
    send(new Deposit({ coins: 2 }));
    step();
    expect(outcomes).toStrictEqual([
      undefined,
      new JarFull({ room: 2 }),
      undefined,
    ]);
    // The refused deposit changed nothing; the one after it was still applied.
    expect(loop.state?.coins).toBe(10);
  });

  it("drops a command sent with no run, at once", () => {
    const loop = new Game.Loop(Jar);
    const outcomes: unknown[] = [];
    loop.send(new Empty(), 0, (outcome) => outcomes.push(outcome));
    expect(outcomes).toStrictEqual([
      new Game.CommandDropped({ command: "Empty", reason: "noRun" }),
    ]);
  });

  it("drops the commands a run hadn't applied when it stops or a new one starts", () => {
    const { loop, outcomes, send, step } = startJar();
    send(new Empty());
    loop.stop();
    loop.start(undefined, 1, 0);
    send(new Deposit({ coins: 1 }));
    loop.start(undefined, 1, 0);
    step();
    expect(outcomes).toStrictEqual([
      new Game.CommandDropped({ command: "Empty", reason: "runEnded" }),
      new Game.CommandDropped({ command: "Deposit", reason: "runEnded" }),
    ]);
    expect(loop.state).toStrictEqual({ coins: 0, emptied: 0 });
  });

  it("takes a command back before it is applied, and then tells no one", () => {
    const { loop, outcomes, send, step } = startJar();
    const unsend = send(new Deposit({ coins: 3 }));
    send(new Deposit({ coins: 1 }));
    unsend();
    step();
    // Taking it back again, after the step, does nothing.
    unsend();
    expect(outcomes).toStrictEqual([undefined]);
    expect(loop.state?.coins).toBe(1);
  });

  it("refuses a rejection the command doesn't declare: its command is dropped, and those after it wait", () => {
    class Undeclared extends Game.Simulation("Undeclared", {
      input: Schema.Null,
      commands: [Empty, Deposit],
      create: () => ({ coins: 0 }),
      step: () => {},
      apply: {
        // Empty declares no rejection, so this is one it can't return.
        Empty: unchecked(() => new JarFull({ room: 0 })),
        Deposit: (jar, command) => {
          jar.coins += command.coins;
        },
      },
    }) {}
    const start = () => {
      const loop = new Game.Loop(Undeclared);
      loop.start(undefined, 1, 0);
      const outcomes: unknown[] = [];
      loop.send(new Empty(), 0, (outcome) => outcomes.push(outcome));
      loop.send(new Deposit({ coins: 1 }), 0, (outcome) =>
        outcomes.push(outcome)
      );
      expect(() => loop.frame(IDLE, { steps: 1 }, 0)).toThrow(
        'Simulation "Undeclared": apply.Empty returned the rejection "JarFull", which the command "Empty" doesn\'t declare. List it in the command\'s `rejects`.'
      );
      // A frame that throws tells nobody.
      expect(outcomes).toStrictEqual([]);
      return { loop, outcomes };
    };
    const emptyDropped = new Game.CommandDropped({
      command: "Empty",
      reason: "runEnded",
    });

    // Whoever catches the throw ends the run, and the senders hear then.
    const stopped = start();
    stopped.loop.stop();
    expect(stopped.outcomes).toStrictEqual([
      emptyDropped,
      new Game.CommandDropped({ command: "Deposit", reason: "runEnded" }),
    ]);

    // Or goes on stepping: the command behind the one that threw is applied by the next step.
    const steppedOn = start();
    steppedOn.loop.frame(IDLE, { steps: 1 }, 0);
    expect(steppedOn.outcomes).toStrictEqual([emptyDropped, undefined]);
    expect(steppedOn.loop.state).toStrictEqual({ coins: 1 });
  });

  it("refuses a rejection made by another class than the one the command declares", () => {
    // oxlint-disable-next-line declaration/named -- Another class under the declared tag is the case.
    class Impostor extends Game.Rejection("JarFull", { room: Schema.Int }) {}
    class Mixed extends Game.Simulation("Mixed", {
      input: Schema.Null,
      commands: [Deposit],
      create: () => ({ coins: 0 }),
      step: () => {},
      apply: { Deposit: unchecked(() => new Impostor({ room: 0 })) },
    }) {}
    const loop = new Game.Loop(Mixed);
    loop.start(undefined, 1, 0);
    loop.send(new Deposit({ coins: 1 }));
    expect(() => loop.frame(IDLE, { steps: 1 }, 0)).toThrow(
      'Simulation "Mixed": apply.Deposit returned a rejection "JarFull" made by another class than the one the command "Deposit" declares under that tag. Return a value of the class in the command\'s `rejects`.'
    );
  });

  it("refuses a handler that reports an event and then refuses its command", () => {
    class Noted extends Game.Event("Noted") {}
    class Telling extends Game.Simulation("Telling", {
      input: Schema.Null,
      events: [Noted],
      commands: [Deposit],
      create: () => ({ coins: 0 }),
      step: () => {},
      apply: {
        Deposit: (_jar, _command, { report }) => {
          report(new Noted());
          return new JarFull({ room: 0 });
        },
      },
    }) {}
    const loop = new Game.Loop(Telling);
    loop.start(undefined, 1, 0);
    loop.send(new Deposit({ coins: 1 }));
    expect(() => loop.frame(IDLE, { steps: 1 }, 0)).toThrow(
      'Simulation "Telling": apply.Deposit reported an event and then refused its command. A handler decides before it changes anything: a refused command changed nothing in the run, so it has nothing to report.'
    );
  });

  it("refuses two commands with one tag, when the simulation is declared", () => {
    // oxlint-disable-next-line declaration/named -- A second command under one tag is the case.
    class Twin extends Game.Command("Deposit") {}
    expect(() =>
      // oxlint-disable-next-line declaration/class -- A test declares what a builder or its host must refuse.
      Game.Simulation("Twins", {
        input: Schema.Null,
        commands: [Deposit, Twin],
        create: () => ({ coins: 0 }),
        step: () => {},
        apply: { Deposit: () => {} },
      })
    ).toThrow(
      'Simulation "Twins" lists two commands with the tag "Deposit". A command is told from another by its tag: give each its own.'
    );
  });

  it("refuses a handler for a command the simulation doesn't list, when it is declared", () => {
    expect(() =>
      // oxlint-disable-next-line declaration/class -- A test declares what a builder or its host must refuse.
      Game.Simulation("Forgetful", {
        input: Schema.Null,
        commands: [Deposit],
        create: () => ({ coins: 0 }),
        step: () => {},
        // A cast gets Empty's handler past the types, as handlers held in a variable would.
        apply: { Deposit: () => {}, Empty: () => {} } as {
          Deposit: () => void;
        },
      })
    ).toThrow(
      new Error(
        'Simulation "Forgetful" has apply.Empty but declares no command "Empty". List the command\'s class in `commands`, or remove the handler.'
      )
    );
  });

  it("tells a sender after the step, so it may start a new run: that run begins at step 0", () => {
    const { loop, outcomes, send, step } = startJar();
    const applied: number[] = [];
    loop.send(new Deposit({ coins: 1 }), 0, () => {
      // Both commands of the step were applied to the run that was current, before this.
      applied.push((loop.state as { coins: number }).coins);
      loop.start(undefined, 2, 0);
    });
    send(new Deposit({ coins: 2 }));
    step();
    expect(applied).toStrictEqual([3]);
    expect(outcomes).toStrictEqual([undefined]);
    expect(loop.state).toStrictEqual({ coins: 0, emptied: 0 });
    expect(loop.stepIndex).toBe(0);
  });

  it("tells a sender after the listeners heard its frame: the events of every step of it, then its sample", () => {
    const { loop } = startCounter(6);
    const order: string[] = [];
    loop.subscribe((event) => order.push(event._tag));
    loop.send(new AddBonus({ amount: 5 }), 0, (outcome) =>
      order.push(outcome === undefined ? "told: taken" : "told: not taken")
    );
    // Two steps in one frame. The first applies the bonus and reaches the target; the sample
    // is the frame's, read after both.
    loop.frame(holding(1), { steps: 2 }, 0);
    expect(order).toStrictEqual(["Reached", "Tally", "told: taken"]);
    expect(loop.state?.log[0]).toBe("bonus 5 from 0 at 0");
  });

  it("tells a sender a new run dropped after the listeners heard that run's start", () => {
    const { loop } = startCounter();
    const order: string[] = [];
    loop.subscribe((event) => order.push(event._tag));
    loop.send(new AddBonus({ amount: 1 }), 0, (outcome) =>
      order.push(
        outcome instanceof Game.CommandDropped
          ? `told: dropped, ${outcome.reason}`
          : "told: answered"
      )
    );
    loop.start({ target: 3 }, 8, 0);
    expect(order).toStrictEqual([
      "Started",
      "Tally",
      "told: dropped, runEnded",
    ]);
  });

  it("lets a sender send again when it is told, and applies that at the next step", () => {
    const { loop, outcomes, send, step } = startJar();
    loop.send(new Deposit({ coins: 20 }), 0, () => {
      send(new Deposit({ coins: 2 }));
    });
    step();
    expect(loop.state).toStrictEqual({ coins: 0, emptied: 0 });
    step();
    expect(outcomes).toStrictEqual([undefined]);
    expect(loop.state).toStrictEqual({ coins: 2, emptied: 0 });
  });

  it("doesn't tell a sender that took its command back before it was told", () => {
    const { loop, outcomes, send, step } = startJar();
    // The first sender, when told, takes back the second's command: it was applied in the same
    // step, so that stands, and its sender hears nothing.
    const second: { takeBack?: () => void } = {};
    loop.send(new Deposit({ coins: 1 }), 0, () => second.takeBack?.());
    second.takeBack = send(new Deposit({ coins: 2 }));
    step();
    expect(loop.state).toStrictEqual({ coins: 3, emptied: 0 });
    expect(outcomes).toStrictEqual([]);
  });

  it("tells every sender when one of them throws, then throws that", () => {
    const { loop, outcomes, send } = startJar();
    loop.send(new Deposit({ coins: 1 }), 0, () => {
      throw new Error("a sender threw");
    });
    send(new Deposit({ coins: 2 }));
    expect(() => loop.frame(IDLE, { steps: 1 }, 0)).toThrow("a sender threw");
    expect(outcomes).toStrictEqual([undefined]);
    expect(loop.state).toStrictEqual({ coins: 3, emptied: 0 });
  });

  it("keeps the run and its waiting commands when a new run's create throws", () => {
    class Opened extends Game.Event("Opened", { name: Schema.String }) {}
    class Fragile extends Game.Simulation("Fragile", {
      input: Schema.Null,
      events: [Opened],
      commands: [Empty],
      create: (name: string, { report }) => {
        report(new Opened({ name }));
        if (name === "broken") {
          throw new Error("create threw");
        }
        return { name, emptied: 0, steps: 0 };
      },
      step: (jar) => {
        jar.steps += 1;
      },
      apply: {
        Empty: (jar) => {
          jar.emptied += 1;
        },
      },
    }) {}
    const loop = new Game.Loop(Fragile);
    const heard: string[] = [];
    loop.subscribe((event) => heard.push(event.name));
    loop.start("first", 1, 0);
    const outcomes: unknown[] = [];
    loop.send(new Empty(), 0, (outcome) => outcomes.push(outcome));
    expect(() => loop.start("broken", 2, 0)).toThrow("create threw");
    // The first run goes on: its command still waits, and it hears nothing of the other.
    expect(outcomes).toStrictEqual([]);
    loop.frame(IDLE, { steps: 1 }, 0);
    expect(outcomes).toStrictEqual([undefined]);
    expect(loop.state).toStrictEqual({ name: "first", emptied: 1, steps: 1 });
    expect(heard).toStrictEqual(["first"]);
  });

  it("discards the events a frame that threw had not reported", () => {
    class Noted extends Game.Event("Noted", { coins: Schema.Int }) {}
    class Crashing extends Game.Simulation("Crashing", {
      input: Schema.Null,
      events: [Noted],
      commands: [Deposit, Empty],
      create: () => ({ coins: 0 }),
      step: () => {},
      apply: {
        Deposit: (jar, command, { report }) => {
          jar.coins += command.coins;
          report(new Noted({ coins: jar.coins }));
        },
        Empty: () => {
          throw new Error("a handler threw");
        },
      },
    }) {}
    const loop = new Game.Loop(Crashing);
    const heard: number[] = [];
    loop.subscribe((event) => heard.push(event.coins));
    loop.start(undefined, 1, 0);
    loop.send(new Deposit({ coins: 4 }));
    loop.send(new Empty());
    expect(() => loop.frame(IDLE, { steps: 1 }, 0)).toThrow("a handler threw");
    loop.stop();
    loop.start(undefined, 2, 0);
    loop.frame(IDLE, { steps: 1 }, 0);
    expect(heard).toStrictEqual([]);
  });

  // The one frame whose sender hears of a command no listener heard reported: the rules took
  // it, so its sender is told so, and what the frame reported went with the run.
  it("tells a sender the rules took its command in a frame that then threw, at the stop that follows, though no listener heard that frame", () => {
    class Noted extends Game.Event("Noted", { coins: Schema.Int }) {}
    class Tripping extends Game.Simulation("Tripping", {
      input: Schema.Null,
      events: [Noted],
      commands: [Deposit],
      create: () => ({ coins: 0 }),
      step: () => {
        throw new Error("a step threw");
      },
      apply: {
        Deposit: (jar, command, { report }) => {
          jar.coins += command.coins;
          report(new Noted({ coins: jar.coins }));
        },
      },
    }) {}
    const loop = new Game.Loop(Tripping);
    const order: string[] = [];
    loop.subscribe((event) => order.push(`heard ${event.coins}`));
    loop.start(undefined, 1, 0);
    loop.send(new Deposit({ coins: 4 }), 0, (outcome) =>
      order.push(outcome === undefined ? "told: taken" : "told: not taken")
    );
    expect(() => loop.frame(IDLE, { steps: 1 }, 0)).toThrow("a step threw");
    expect(order).toStrictEqual([]);
    loop.stop();
    expect(order).toStrictEqual(["told: taken"]);
  });

  it("refuses a command the simulation doesn't declare, where it is sent", () => {
    const loop = new Game.Loop(Jar);
    loop.start(undefined, 1, 0);
    expect(() =>
      // @ts-expect-error -- AddBonus is no command of Jar.
      loop.send(new AddBonus({ amount: 1 }))
    ).toThrow('Simulation "Jar" has no command "AddBonus"');
  });

  it("types what each command can be refused with", () => {
    const loop = new Game.Loop(Jar);
    // A rejection's type is its class, so what a sender gets is the error it is.
    loop.send(new Deposit({ coins: 1 }), 0, (outcome) => {
      expectTypeOf(outcome).toEqualTypeOf<
        JarFull | Game.CommandDropped | undefined
      >();
    });
    loop.send(new Empty(), 0, (outcome) => {
      expectTypeOf(outcome).toEqualTypeOf<Game.CommandDropped | undefined>();
    });
    expectTypeOf<Game.RejectionOf<typeof Jar>>().toEqualTypeOf<JarFull>();
    // A loop of a simulation whose rejections aren't known can't say what a send ends with.
    const anyLoop = loop as unknown as Game.Loop<
      undefined,
      unknown,
      null,
      never,
      Deposit,
      unknown
    >;
    anyLoop.send(new Deposit({ coins: 1 }), 0, (outcome) => {
      expectTypeOf(outcome).toBeUnknown();
    });
    const lookAlike = () =>
      // oxlint-disable-next-line declaration/class -- A test declares what a builder or its host must refuse.
      Game.Simulation("LookAlike", {
        input: Schema.Null,
        commands: [Deposit],
        create: () => ({ coins: 0 }),
        step: () => {},
        apply: {
          // @ts-expect-error -- An object shaped like the rejection is not a value of its class.
          Deposit: () => ({ _tag: "JarFull" as const, room: 0 }),
        },
      });
    expect(lookAlike).not.toThrow();
    const declare = () =>
      // oxlint-disable-next-line declaration/class -- A test declares what a builder or its host must refuse.
      Game.Simulation("Wrong", {
        input: Schema.Null,
        commands: [Empty],
        create: () => ({ coins: 0 }),
        step: () => {},
        apply: {
          // @ts-expect-error -- Empty declares no rejection, so its handler can't return one.
          Empty: () => new JarFull({ room: 0 }),
        },
      });
    expect(declare).not.toThrow();
  });
});
