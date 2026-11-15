import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as Game from "../../src/game/index";
import * as Scenario from "../../src/game/scenario";

/** A tank that burns what each step's input says: below empty is a bug. */
class Tank extends Game.Simulation("Tank", {
  input: Schema.Number,
  create: (config: { readonly litres: number }) => ({ litres: config.litres }),
  step: (tank, burn) => {
    tank.litres -= burn;
  },
  invariants: {
    neverBelowEmpty: (tank) => tank.litres >= 0,
    neverOverfull: (tank) => tank.litres <= 100,
  },
}) {}

const scenario = Scenario.make(Tank);

/** Never called: each invariant in it is checked by the compiler, which must refuse it. */
const refusedInvariants = () =>
  class Refused extends Game.Simulation("Refused", {
    input: Schema.Null,
    create: () => ({ litres: 0 }),
    step: () => {},
    invariants: {
      // @ts-expect-error -- an invariant reads the state, and can't write it
      refills: (tank) => (tank.litres = 1) > 0,
      // @ts-expect-error -- an invariant says whether it holds
      says: (tank) => tank.litres,
    },
  }) {};

describe("a simulation's invariants", () => {
  it("are checked by a scenario after every step, which names the one that broke, the step and the seed", () => {
    expect(() =>
      scenario(Scenario.given({ litres: 5 }, { seed: 3 }), Scenario.step(2, 4))
    ).toThrow(
      new Scenario.ScenarioError(
        'Simulation "Tank" breaks its invariant "neverBelowEmpty" at step 2 of the run with seed 3: the step, or a command it applied, left the state where it doesn\'t hold.'
      )
    );
  });

  it("are checked by a scenario as its run starts", () => {
    expect(() =>
      scenario(Scenario.given({ litres: 120 }, { seed: 4 }))
    ).toThrow(
      new Scenario.ScenarioError(
        'Simulation "Tank" breaks its invariant "neverOverfull" as its run starts, with seed 4: create made a state where it doesn\'t hold.'
      )
    );
  });

  it("let a scenario pass while they hold", () => {
    expect(() =>
      scenario(Scenario.given({ litres: 5 }), Scenario.step(1, 5))
    ).not.toThrow();
  });

  it("are not checked by a loop that wasn't asked to", () => {
    const loop = Game.makeLoop(Tank);
    loop.start({ litres: 1 }, 1, 0);
    loop.frame({ read: () => 3 }, { steps: 2 }, 0);
    expect(loop.state).toStrictEqual({ litres: -5 });
  });

  it("are checked by a loop made with checkInvariants, at the step that broke one inside a frame", () => {
    const loop = Game.makeLoop(Tank, { checkInvariants: true });
    loop.start({ litres: 5 }, 9, 0);
    expect(() => loop.frame({ read: () => 2 }, { steps: 5 }, 0)).toThrow(
      new Error(
        'Simulation "Tank" breaks its invariant "neverBelowEmpty" at step 2 of the run with seed 9: the step, or a command it applied, left the state where it doesn\'t hold.'
      )
    );
  });

  it("refuse a run whose create breaks one, and the run before goes on", () => {
    const loop = Game.makeLoop(Tank, { checkInvariants: true });
    loop.start({ litres: 50 }, 1, 0);
    const before = loop.state;
    expect(() => loop.start({ litres: 101 }, 2, 0)).toThrow(
      'Simulation "Tank" breaks its invariant "neverOverfull" as its run starts, with seed 2'
    );
    expect(loop.state).toBe(before);
  });

  it("are refused when declared as anything but a function", () => {
    expect(
      () =>
        class Broken extends Game.Simulation("Broken", {
          input: Schema.Null,
          create: () => ({ n: 0 }),
          step: () => {},
          invariants: { positive: true } as unknown as Record<
            string,
            () => boolean
          >,
        }) {}
    ).toThrow(
      'Simulation "Broken" declares the invariant "positive" as boolean. Write it as a function of the state that returns true while it holds.'
    );
  });

  it("are given the state read-only, and must say true or false", () => {
    type Check = NonNullable<
      Game.Definition<
        null,
        { litres: number },
        typeof Schema.Number,
        [],
        [],
        never
      >["invariants"]
    >[string];
    expectTypeOf<Parameters<Check>[0]>().toEqualTypeOf<
      Game.ReadonlyState<{ litres: number }>
    >();
    expectTypeOf(refusedInvariants).toBeFunction();
  });
});
