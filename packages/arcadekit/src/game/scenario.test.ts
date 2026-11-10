import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as Game from "./index";
import * as Scenario from "./scenario";

// A small game: a door that opens when the lever has been held for three steps in a row, and a
// command that locks it for good, which the rules refuse once it is locked.

class DoorOpened extends Game.Event("DoorOpened", { atStep: Schema.Int }) {}
class DoorLocked extends Game.Event("DoorLocked") {}
class Gauge extends Game.Event("Gauge", { held: Schema.Int }) {}
class AlreadyLocked extends Game.Rejection("AlreadyLocked") {}
class Lock extends Game.Command("Lock", {}, { rejects: [AlreadyLocked] }) {}

class Door extends Game.Simulation("Door", {
  input: Schema.Struct({ lever: Schema.Boolean }),
  events: [DoorOpened, DoorLocked],
  commands: [Lock],
  create: (config: { readonly needed: number }) => ({
    needed: config.needed,
    held: 0,
    open: false,
    locked: false,
  }),
  step: (door, input, { report, step }) => {
    door.held = input.lever && !door.locked ? door.held + 1 : 0;
    if (!door.open && door.held === door.needed) {
      door.open = true;
      report(new DoorOpened({ atStep: step }));
    }
  },
  apply: {
    Lock: (door, _command, { report }) => {
      if (door.locked) {
        return new AlreadyLocked();
      }
      door.locked = true;
      report(new DoorLocked());
    },
  },
  sample: {
    event: Gauge,
    version: (door) => door.held,
    read: (door) => ({ held: door.held }),
  },
}) {}

const scenario = Scenario.make(Door);
const HELD = { lever: true };
const RELEASED = { lever: false };

/** A scenario that names the wrong step for the door's opening. */
const wrongStep = () =>
  scenario(
    Scenario.given({ needed: 1 }),
    Scenario.step(HELD),
    Scenario.reported(new DoorOpened({ atStep: 5 }))
  );

describe("a scenario", () => {
  it("passes when the run reports what the scenario says, step by step", () => {
    scenario(
      Scenario.given({ needed: 3 }),
      Scenario.step(HELD, 2),
      Scenario.reported(),
      Scenario.step(HELD),
      Scenario.reported(new DoorOpened({ atStep: 2 })),
      Scenario.sampled(new Gauge({ held: 3 }))
    );
  });

  it("sends a command, which the next step applies", () => {
    scenario(
      Scenario.given({ needed: 3 }),
      Scenario.send(new Lock()),
      Scenario.step(HELD, 5),
      Scenario.reported(new DoorLocked()),
      Scenario.state((door) => {
        expect(door.open).toBe(false);
      })
    );
  });

  it("checks what the rules refused, at the step after the command was sent", () => {
    scenario(
      Scenario.given({ needed: 3 }),
      Scenario.send(new Lock()),
      Scenario.step(RELEASED),
      Scenario.reported(new DoorLocked()),
      Scenario.refused(),
      Scenario.send(new Lock()),
      Scenario.step(RELEASED),
      Scenario.refused(new AlreadyLocked()),
      Scenario.reported()
    );
  });

  it("fails when it ends with a refused command nothing checked", () => {
    expect(() =>
      scenario(
        Scenario.given({ needed: 3 }),
        Scenario.send(new Lock()),
        Scenario.send(new Lock()),
        Scenario.step(RELEASED),
        Scenario.reported(new DoorLocked())
      )
    ).toThrow(
      'a refused command no Scenario.refused checked:\n  {"_tag":"AlreadyLocked"}'
    );
  });

  it("says which command was refused, and whose", () => {
    expect(() =>
      scenario(
        Scenario.given({ needed: 3 }),
        Scenario.send(new Lock()),
        Scenario.send(new Lock(), 1),
        Scenario.step(RELEASED),
        Scenario.reported(new DoorLocked())
      )
    ).toThrow(
      'a refused command no Scenario.refused checked:\n  {"_tag":"AlreadyLocked"}, refusing Lock from player 1'
    );
  });

  it("fails when it ends with a command no step applied, whatever the rules would say of it", () => {
    expect(() =>
      scenario(
        Scenario.given({ needed: 3 }),
        Scenario.send(new Lock()),
        Scenario.refused(),
        Scenario.reported()
      )
    ).toThrow(
      "The scenario ended with Scenario.send(Lock) never applied. A command is applied by the step after it is sent: add a Scenario.step after the send."
    );
  });

  it("fails when a new run is given while a command still waits, and counts no drop as a refusal", () => {
    expect(() =>
      scenario(
        Scenario.given({ needed: 3 }),
        Scenario.send(new Lock()),
        Scenario.given({ needed: 3 }),
        Scenario.step(RELEASED)
      )
    ).toThrow(
      "Scenario.given started a new run with Scenario.send(Lock) never applied."
    );
  });

  it("fails when the rules refused something else than the scenario says", () => {
    expect(() =>
      scenario(
        Scenario.given({ needed: 3 }),
        Scenario.send(new Lock()),
        Scenario.step(RELEASED),
        Scenario.refused(new AlreadyLocked())
      )
    ).toThrow('Expected:\n  {"_tag":"AlreadyLocked"}\nRefused:\n  (nothing)');
  });

  it("takes a list of steps as one, so a game can name its own", () => {
    const pump = [Scenario.step(HELD), Scenario.step(RELEASED)];
    scenario(
      Scenario.given({ needed: 1 }),
      pump,
      Scenario.reported(new DoorOpened({ atStep: 0 })),
      [pump, pump],
      Scenario.reported()
    );
  });

  it("fails when the run reported other events than the scenario's", () => {
    expect(wrongStep).toThrow(Scenario.ScenarioError);
    expect(wrongStep).toThrow(
      'Expected:\n  {"_tag":"DoorOpened","atStep":5}\nReported:\n  {"_tag":"DoorOpened","atStep":0}'
    );
  });

  it("fails when it ends with an event nothing checked", () => {
    expect(() =>
      scenario(Scenario.given({ needed: 1 }), Scenario.step(HELD))
    ).toThrow(
      'no Scenario.reported checked:\n  {"_tag":"DoorOpened","atStep":0}'
    );
  });

  it("fails when the latest sample is not the scenario's", () => {
    expect(() =>
      scenario(
        Scenario.given({ needed: 9 }),
        Scenario.step(HELD, 2),
        Scenario.sampled(new Gauge({ held: 1 }))
      )
    ).toThrow('Sampled:\n  {"_tag":"Gauge","held":2}');
  });

  it("refuses a step before the run is given", () => {
    expect(() => scenario(Scenario.step(HELD))).toThrow(
      "Scenario.step needs a run: start the scenario with Scenario.given(config)"
    );
  });

  it("starts each scenario from a fresh run", () => {
    scenario(
      Scenario.given({ needed: 1 }),
      Scenario.step(HELD),
      Scenario.reported(new DoorOpened({ atStep: 0 }))
    );
    scenario(
      Scenario.given({ needed: 1 }),
      Scenario.state((door) => {
        expect(door.open).toBe(false);
      })
    );
  });

  it("checks a scenario's steps against the simulation's types", () => {
    const run = { needed: 3 };
    const mistyped = [
      // @ts-expect-error -- the config has no `need`.
      () => scenario(Scenario.given({ need: 3 })),
      () =>
        scenario(
          Scenario.given(run),
          // @ts-expect-error -- the input's lever is a Boolean.
          Scenario.step({ lever: "down" })
        ),
      () =>
        scenario(
          Scenario.given(run),
          // @ts-expect-error -- a string is no event of Door.
          Scenario.reported("opened")
        ),
      () =>
        scenario(
          Scenario.given(run),
          // @ts-expect-error -- DoorOpened is no command.
          Scenario.send(new DoorOpened({ atStep: 0 })),
          Scenario.step(HELD)
        ),
      () =>
        scenario(
          Scenario.given(run),
          // @ts-expect-error -- DoorLocked is an event, not a rejection of Door's commands.
          Scenario.refused(new DoorLocked())
        ),
    ];
    // Each is refused where it is written; none is run.
    expect(mistyped).toHaveLength(5);
  });
});
