import { Cause, Effect, Exit, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Defect,
  Event,
  Frame,
  Plugin,
  State,
  System,
  Ticks,
  Timeline,
} from "../src/index";
import { withApp } from "./peers";

/** What a call throws: a test of a refusal looks at the thing, not its words. */
const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Nothing was thrown.");
};

/** What making an app dies with. */
const diedMaking = <E>(
  make: Effect.Effect<unknown, E, Scope.Scope>
): unknown => {
  const exit = Effect.runSyncExit(Effect.scoped(make));
  if (Exit.isSuccess(exit)) {
    throw new Error("The app was made.");
  }
  return Cause.squash(exit.cause);
};

const Fire = Action.define("df/Fire", Schema.Struct({}));
const fire = Action.handler(Fire, function* () {});
const Banged = Event.define("df/Banged", Schema.Struct({}));

describe("a mistake of the program", () => {
  it("is a WrongPhase, with what was called and what the app was running", () => {
    // A dispatch from a system of the tick.
    let app: App.Any | undefined;
    const Meddle = System.make("df/Meddle", function* () {
      yield* Effect.sync(() => app?.dispatchByName("df/Fire", {}));
    });
    withApp(App.make({ systems: [Meddle], handlers: [fire] }), (made) => {
      app = made;
      const refused = thrownBy(() => made.tick(1));
      expect(refused).toBeInstanceOf(Defect.WrongPhase);
      expect(refused).toMatchObject({
        _tag: "WrongPhase",
        call: "dispatch",
        phase: "tick",
      });
      // It is an error like any other to what only catches errors.
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toMatch(/Use enqueue/u);
    });

    // A frame read by a system of the tick, and a tick asked for by one of
    // each stage between ticks.
    const Reads = System.make("df/Reads", function* () {
      void (yield* Frame).alpha;
    });
    withApp(App.make({ systems: [Reads] }), (made) => {
      expect(thrownBy(() => made.tick(1))).toMatchObject({
        _tag: "WrongPhase",
        call: "Frame",
        phase: "tick",
      });
    });
    for (const stage of ["frame", "input"] as const) {
      const Asks = System.make(`df/Asks:${stage}`, function* () {
        (yield* Ticks).more();
      }).pipe(System.inStage(stage));
      withApp(App.make({ systems: [Asks] }), (made) => {
        const run = stage === "frame" ? () => made.frame(0) : made.input;
        expect(thrownBy(run)).toMatchObject({
          _tag: "WrongPhase",
          call: "Ticks.more",
          phase: stage,
        });
      });
    }
  });

  it("says a plugin's setup is what was running, before there is an app to ask", () => {
    const Early = Plugin.make("df/Early", {
      setup: Effect.gen(function* () {
        void (yield* Frame).count;
      }),
    });
    expect(diedMaking(App.make({ plugins: [Early] }))).toMatchObject({
      _tag: "WrongPhase",
      call: "Frame",
      phase: "setup",
    });
  });

  it("says nothing was running when an event is emitted from outside the game", () => {
    const Bang = System.make("df/Bang", function* () {
      yield* Banged;
    });
    withApp(App.make({ systems: [Bang] }), (made) => {
      made.tick(1);
      expect(
        thrownBy(() => {
          made.events.emit(Banged, {});
        })
      ).toMatchObject({ _tag: "WrongPhase", call: "emit", phase: "idle" });
    });
  });

  it("is an InvalidDefinition, with the kind of thing and its name", () => {
    const One = System.make("df/Same", function* () {});
    const Other = System.make("df/Same", function* () {});
    const twice = diedMaking(App.make({ systems: [One, Other] }));
    expect(twice).toBeInstanceOf(Defect.InvalidDefinition);
    expect(twice).toMatchObject({
      _tag: "InvalidDefinition",
      kind: "system",
      named: "df/Same",
    });
    expect(diedMaking(App.make({ version: 1.5 }))).toMatchObject({
      _tag: "InvalidDefinition",
      kind: "option",
      named: "version",
    });
    expect(
      thrownBy(() =>
        // @ts-expect-error not one of the state's values
        State.define("df/Phase", ["menu", "playing"], "paused")
      )
    ).toMatchObject({
      _tag: "InvalidDefinition",
      kind: "state",
      named: "df/Phase",
    });
  });

  it("is an InvalidArgument, with what was called", () => {
    const moment = withApp(App.make({}), (made) => {
      const captured = Timeline.capture(made);
      if (Exit.isFailure(captured)) {
        throw new Error("The game could not be captured.");
      }
      return captured.value;
    });
    withApp(App.make({}), (made) => {
      const foreign = thrownBy(() => {
        Timeline.rewind(made, moment);
      });
      expect(foreign).toBeInstanceOf(Defect.InvalidArgument);
      expect(foreign).toMatchObject({
        _tag: "InvalidArgument",
        call: "Timeline.rewind",
      });
      // An action nobody handles, queued and applied: the types refuse
      // both, and so does the app for a caller they did not stop.
      expect(
        thrownBy(() =>
          // @ts-expect-error the app has no handler for it
          made.enqueue(Fire, {})
        )
      ).toMatchObject({ _tag: "InvalidArgument", call: "enqueue" });
      expect(
        thrownBy(() =>
          // @ts-expect-error the app has no handler for it
          made.dispatch(Fire, {})
        )
      ).toMatchObject({ _tag: "InvalidArgument", call: "dispatch" });
    });
  });

  it("is a TakenOver, when an app a session steps is stepped or changed by itself", () => {
    withApp(App.make({ handlers: [fire] }), (made) => {
      made.divert(() => {});
      const stepped = thrownBy(() => made.tick(1));
      expect(stepped).toBeInstanceOf(Defect.TakenOver);
      expect(stepped).toMatchObject({ _tag: "TakenOver", call: "App.tick" });
      expect(thrownBy(() => made.dispatch(Fire, {}))).toMatchObject({
        _tag: "TakenOver",
        call: "dispatch",
      });
      expect(thrownBy(() => made.divert(() => {}))).toMatchObject({
        _tag: "TakenOver",
        call: "divert",
      });
    });
  });

  it("is a NotSynchronous, with what was running, when a game's code outlives its run", () => {
    const Waits = System.make("df/Waits", function* () {
      yield* Effect.sleep("1 second");
    });
    withApp(App.make({ systems: [Waits] }), (made) => {
      const waited = thrownBy(() => made.tick(1));
      expect(waited).toBeInstanceOf(Defect.NotSynchronous);
      expect(waited).toMatchObject({
        _tag: "NotSynchronous",
        what: "Tick 1",
      });
    });
    const Leaves = System.make("df/Leaves", function* () {
      yield* Effect.forkDetach(Effect.never);
    });
    withApp(App.make({ systems: [Leaves] }), (made) => {
      expect(thrownBy(() => made.tick(1))).toMatchObject({
        _tag: "NotSynchronous",
        what: "Tick 1",
      });
    });
    const slow = Action.handler(Fire, function* () {
      yield* Effect.sleep("1 second");
    });
    withApp(App.make({ handlers: [slow] }), (made) => {
      expect(thrownBy(() => made.dispatch(Fire, {}))).toMatchObject({
        _tag: "NotSynchronous",
        what: 'The handler for "df/Fire"',
      });
    });
  });
});

describe("Defect.said", () => {
  it("says an error in a few words, whatever it is given", () => {
    expect(Defect.said(new Error("It broke."))).toBe("It broke.");
    expect(Defect.said(new TypeError(""))).toBe("TypeError");
    expect(Defect.said("a word")).toBe("a word");
    expect(Defect.said(undefined)).toBe("undefined");
  });
});
