import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Action, App, System } from "../src/index";
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
});
