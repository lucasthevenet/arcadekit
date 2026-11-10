import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import * as Game from "./index";
import * as Story from "./story";

// A small game: a door that opens when the lever has been held for three steps in a row, and a
// command that locks it for good.

class DoorOpened extends Game.Event("DoorOpened", { atStep: Schema.Int }) {}
class DoorLocked extends Game.Event("DoorLocked") {}
class Gauge extends Game.Event("Gauge", { held: Schema.Int }) {}
class Lock extends Game.Command("Lock") {}

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
  step: (door, input, { emit, step }) => {
    door.held = input.lever && !door.locked ? door.held + 1 : 0;
    if (!door.open && door.held === door.needed) {
      door.open = true;
      emit(new DoorOpened({ atStep: step }));
    }
  },
  apply: {
    Lock: (door, _command, { emit }) => {
      door.locked = true;
      emit(new DoorLocked());
    },
  },
  sample: {
    event: Gauge,
    version: (door) => door.held,
    read: (door) => ({ held: door.held }),
  },
}) {}

const story = Story.make(Door);
const HELD = { lever: true };
const RELEASED = { lever: false };

/** A story that names the wrong step for the door's opening. */
const wrongStep = () =>
  story(
    Story.given({ needed: 1 }),
    Story.step(HELD),
    Story.reported(new DoorOpened({ atStep: 5 }))
  );

describe("a story", () => {
  it("passes when the run reports what the story says, step by step", () => {
    story(
      Story.given({ needed: 3 }),
      Story.step(HELD, 2),
      Story.reported(),
      Story.step(HELD),
      Story.reported(new DoorOpened({ atStep: 2 })),
      Story.sampled(new Gauge({ held: 3 }))
    );
  });

  it("sends a command, which the next step applies", () => {
    story(
      Story.given({ needed: 3 }),
      Story.send(new Lock()),
      Story.step(HELD, 5),
      Story.reported(new DoorLocked()),
      Story.state((door) => {
        expect(door.open).toBe(false);
      })
    );
  });

  it("takes a list of steps as one, so a game can name its own", () => {
    const pump = [Story.step(HELD), Story.step(RELEASED)];
    story(
      Story.given({ needed: 1 }),
      pump,
      Story.reported(new DoorOpened({ atStep: 0 })),
      [pump, pump],
      Story.reported()
    );
  });

  it("fails when the run reported other events than the story's", () => {
    expect(wrongStep).toThrow(Story.StoryError);
    expect(wrongStep).toThrow(
      'Expected:\n  {"_tag":"DoorOpened","atStep":5}\nReported:\n  {"_tag":"DoorOpened","atStep":0}'
    );
  });

  it("fails when it ends with an event nothing checked", () => {
    expect(() => story(Story.given({ needed: 1 }), Story.step(HELD))).toThrow(
      'no Story.reported checked:\n  {"_tag":"DoorOpened","atStep":0}'
    );
  });

  it("fails when the latest sample is not the story's", () => {
    expect(() =>
      story(
        Story.given({ needed: 9 }),
        Story.step(HELD, 2),
        Story.sampled(new Gauge({ held: 1 }))
      )
    ).toThrow('Sampled:\n  {"_tag":"Gauge","held":2}');
  });

  it("refuses a step before the run is given", () => {
    expect(() => story(Story.step(HELD))).toThrow(
      "Story.step needs a run: start the story with Story.given(config)"
    );
  });

  it("starts each story from a fresh run", () => {
    story(
      Story.given({ needed: 1 }),
      Story.step(HELD),
      Story.reported(new DoorOpened({ atStep: 0 }))
    );
    story(
      Story.given({ needed: 1 }),
      Story.state((door) => {
        expect(door.open).toBe(false);
      })
    );
  });

  it("checks a story's steps against the simulation's types", () => {
    const mistyped = [
      // @ts-expect-error -- the config has no `need`.
      () => story(Story.given({ need: 3 })),
      // @ts-expect-error -- the input's lever is a Boolean.
      () => story(Story.given({ needed: 3 }), Story.step({ lever: "down" })),
      // @ts-expect-error -- a string is no event of Door.
      () => story(Story.given({ needed: 3 }), Story.reported("opened")),
      () =>
        story(
          Story.given({ needed: 3 }),
          // @ts-expect-error -- DoorOpened is no command.
          Story.send(new DoorOpened({ atStep: 0 })),
          Story.step(HELD)
        ),
    ];
    // Each is refused where it is written; none is run.
    expect(mistyped).toHaveLength(4);
  });
});
