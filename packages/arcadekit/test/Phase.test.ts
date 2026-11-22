import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Action, App, Defect, System, Timeline } from "../src/index";
import { withApp } from "./peers";

describe("what an app is running", () => {
  it("is told by its phase, in each stage and handler", () => {
    const seen: [string, App.Phase][] = [];
    let app: App.Any | undefined;
    const note = (where: string) =>
      Effect.sync(() => {
        seen.push([where, app!.phase]);
      });
    const Note = Action.define("ph/Note", Schema.Struct({ by: Schema.String }));
    const noted = Action.handler(Note, function* ({ by }) {
      yield* note(`handler from ${by}`);
    });
    const Step = System.make("ph/Step", function* () {
      yield* note("tick");
    });
    const Draw = System.make("ph/Draw", function* () {
      yield* note("frame");
    }).pipe(System.inStage("frame"));
    const Hear = System.make("ph/Hear", function* () {
      yield* note("input");
    }).pipe(System.inStage("input"));
    withApp(
      App.make({ systems: [Step, Draw, Hear], handlers: [noted] }),
      (made) => {
        app = made;
        expect(made.phase).toBe("idle");
        made.dispatch(Note, { by: "dispatch" });
        made.enqueue(Note, { by: "a tick" });
        made.tick(1);
        made.frame(0);
        expect(made.phase).toBe("idle");
      }
    );
    expect(seen).toEqual([
      ["handler from dispatch", "handler"],
      ["input", "input"],
      ["handler from a tick", "tick"],
      ["tick", "tick"],
      ["frame", "frame"],
    ]);
  });

  it("refuses, from a handler that dispatch runs, what is for between ticks", () => {
    // Each would act on a game halfway through an action, which the action
    // may yet take back.
    const named = 'a handler of "ph/Call"';
    const calls: [string, (app: App.Any) => unknown, string][] = [
      ["App.tick", (app) => app.tick(1), named],
      ["App.frame", (app) => app.frame(0), named],
      ["App.input", (app) => app.input(), named],
      ["save()", (app) => app.save(), named],
      // Another module's: it knows a handler is running, and not which.
      [
        "Timeline.capture()",
        (app) => Timeline.capture(app),
        "an action's handler",
      ],
      ["record()", (app) => app.record(), named],
      ["checkpoint()", (app) => app.checkpoint(), named],
      ["inspect()", (app) => app.inspect(), named],
    ];
    for (const [name, call, busy] of calls) {
      let app: App.Any | undefined;
      const Call = Action.define("ph/Call", Schema.Struct({}));
      const calling = Action.handler(Call, function* () {
        yield* Effect.sync(() => call(app!));
      });
      withApp(App.make({ handlers: [calling] }), (made) => {
        app = made;
        made.tick(1);
        const log = made.actionLog.length;
        const exit = made.dispatch(Call, {});
        const refused = Exit.isFailure(exit)
          ? Cause.squash(exit.cause)
          : undefined;
        // By its class and what it says of itself, whatever its words.
        expect(refused, name).toBeInstanceOf(Defect.WrongPhase);
        expect(refused, name).toMatchObject({
          _tag: "WrongPhase",
          call: name.replace("()", ""),
          phase: "handler",
        });
        expect((refused as Defect.WrongPhase).message, name).toMatch(
          new RegExp(
            `^${name.replace(/[.()]/gu, "\\$&")} was called (?:during|from inside) ${busy}`,
            "u"
          )
        );
        // Nothing of what it was asked to do was left behind.
        expect(made.time.tick, name).toBe(1);
        expect(made.actionLog.length, name).toBe(log);
        expect(made.phase, name).toBe("idle");
      });
    }
  });
});
