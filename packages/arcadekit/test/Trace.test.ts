import { Data, Effect, Exit, Option, Schema, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import {
  Action,
  App,
  Commands,
  Component,
  Field,
  Plugin,
  Query,
  Random,
  State,
  System,
  World,
} from "../src/index.ts";

/** A tracer that keeps every span it makes, in the order it made them. */
const recorder = () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

const traced = <A, E>(tracer: Tracer.Tracer, effect: Effect.Effect<A, E>): A =>
  Effect.runSync(effect.pipe(Effect.provideService(Tracer.Tracer, tracer)));

const parentOf = (span: Tracer.NativeSpan): string | undefined =>
  Option.getOrUndefined(span.parent)?.spanId;

/** The names of the spans whose parent is `span`, in the order they began. */
const childrenOf = (
  spans: readonly Tracer.NativeSpan[],
  span: Tracer.NativeSpan
): string[] =>
  spans.filter((s) => parentOf(s) === span.spanId).map((s) => s.name);

const Count = Component.define("tr/Count", { n: Field.i32 });
const Counted = Query.all(Count).pipe(Query.writes(Count));
const Phase = State.define("tr/Phase", ["title", "playing"]);
const Add = Action.define("tr/Add", Schema.Struct({ by: Schema.Int }));
const Refused = Action.define("tr/Refused", Schema.Struct({}));
const Begin = Action.define("tr/Begin", Schema.Struct({}));

class NotNow extends Data.TaggedError("tr/NotNow") {}

const Grow = System.tick("tr/Grow", function* () {
  (yield* Counted).each((count) => {
    count.n += 1;
  });
});
const Roll = System.tick("tr/Roll", function* () {
  const random = yield* Random;
  (yield* Counted).each((count) => {
    count.n += random.int(0, 10);
  });
});
const Asleep = System.tick("tr/Asleep", function* () {}).pipe(
  System.runIf(Effect.succeed(false))
);
const Opening = State.onEnter(Phase, "playing", "tr/Opening", function* () {});
const Draw = System.frame("tr/Draw", function* () {});
const Read = System.input("tr/Read", function* () {});

const handlers = [
  Action.handler(Add, function* ({ by }) {
    (yield* Counted).each((count) => {
      count.n += by;
    });
  }),
  Action.handler(Refused, function* () {
    return yield* new NotNow();
  }),
  Action.handler(Begin, function* () {
    (yield* Phase.sets).set("playing");
  }),
] as const;

const Start = Plugin.make("tr/Start", {
  setup: Effect.gen(function* () {
    (yield* Commands.spawns(Count)).spawn(Count.of({ n: 0 }));
  }),
});

const game = () =>
  App.make(
    App.define({
      plugins: [Start],
      systems: [Grow, Roll, Asleep, Opening, Draw, Read],
      handlers,
    }),
    { seed: 7 }
  );

describe("tracing an app", () => {
  it("makes a span for each tick, holding the actions applied in it and a span for each system's turn", () => {
    const { spans, tracer } = recorder();
    const app = traced(tracer, game());
    app.enqueue(Begin, {});
    app.enqueue(Add, { by: 2 });
    app.enqueue(Refused, {});
    app.tick(1 / 60);

    const ticks = spans.filter((span) => span.name === "arcadekit/tick");
    expect(ticks).toHaveLength(1);
    const tick = ticks[0]!;
    expect(tick.parent).toEqual(Option.none());
    expect(tick.attributes.get("arcadekit.tick")).toBe(1);
    // The hook runs when the state is entered, before the other systems;
    // a system whose condition doesn't hold still had its turn.
    expect(childrenOf(spans, tick)).toEqual([
      "action:tr/Begin",
      "action:tr/Add",
      "action:tr/Refused",
      "tr/Opening",
      "tr/Grow",
      "tr/Roll",
      "tr/Asleep",
    ]);
    for (const span of spans) {
      expect(span.status._tag).toBe("Ended");
      expect(span.traceId).toBe(tick.traceId);
    }
    const refused = spans.find((span) => span.name === "action:tr/Refused")!;
    expect(
      refused.status._tag === "Ended" && Exit.isFailure(refused.status.exit)
    ).toBe(true);
    const ended = tick.status;
    expect(ended._tag === "Ended" && Exit.isSuccess(ended.exit)).toBe(true);
  });

  it("gives an action dispatched between two ticks a span of its own, and not the last tick's", () => {
    const { spans, tracer } = recorder();
    const app = traced(tracer, game());
    app.tick(1 / 60);
    app.dispatch(Add, { by: 2 });
    const added = spans.find((span) => span.name === "action:tr/Add")!;
    expect(added.parent).toEqual(Option.none());
  });

  it("makes a span for each run of the frame stage and of the input stage, holding their systems'", () => {
    const { spans, tracer } = recorder();
    const app = traced(tracer, game());
    app.input();
    app.tick(1 / 60);
    app.frame(0.5);
    app.frame(0.75);

    expect(
      spans.filter((span) => span.parent._tag === "None").map((s) => s.name)
    ).toEqual([
      "arcadekit/input",
      "arcadekit/tick",
      "arcadekit/frame",
      "arcadekit/frame",
    ]);
    const [input, , first, second] = spans.filter(
      (span) => span.parent._tag === "None"
    );
    expect(childrenOf(spans, input!)).toEqual(["tr/Read"]);
    expect(childrenOf(spans, first!)).toEqual(["tr/Draw"]);
    expect(first!.attributes.get("arcadekit.frame")).toBe(1);
    expect(second!.attributes.get("arcadekit.frame")).toBe(2);
    expect(first!.traceId).not.toBe(second!.traceId);
  });

  it("starts a trace of its own for each tick and each stage, whatever span the app was made in", () => {
    const { spans, tracer } = recorder();
    const app = traced(tracer, game().pipe(Effect.withSpan("made")));
    app.input();
    app.tick(1 / 60);
    app.frame(0.5);
    const roots = spans.filter((span) => span.name.startsWith("arcadekit/"));
    expect(roots.map((span) => [span.name, span.parent._tag])).toEqual([
      ["arcadekit/input", "None"],
      ["arcadekit/tick", "None"],
      ["arcadekit/frame", "None"],
    ]);
  });

  it("makes a span of its own for an action dispatched between ticks", () => {
    const { spans, tracer } = recorder();
    const app = traced(tracer, game());
    expect(Exit.isSuccess(app.dispatch(Add, { by: 1 }))).toBe(true);
    expect(spans.map((span) => [span.name, span.parent._tag])).toEqual([
      ["action:tr/Add", "None"],
    ]);
  });

  it("ends a tick's span with the failure of the system that failed it", () => {
    const { spans, tracer } = recorder();
    const Fails = System.tick("tr/Fails", function* () {
      return yield* new NotNow();
    });
    const app = traced(tracer, App.make(App.define({ systems: [Fails] })));
    const exit = app.tickExit(1 / 60);
    expect(Exit.isFailure(exit)).toBe(true);
    const [tick, fails] = spans;
    expect(tick!.name).toBe("arcadekit/tick");
    expect(fails!.name).toBe("tr/Fails");
    for (const span of [tick!, fails!]) {
      const status = span.status;
      expect(status._tag === "Ended" && Exit.isFailure(status.exit)).toBe(true);
    }
  });

  it("plays the same game as an app that doesn't trace", () => {
    const { spans, tracer } = recorder();
    const tracing = traced(tracer, game());
    const quiet = Effect.runSync(game());
    const tracingWorld = Effect.runSync(tracing.read(World));
    const quietWorld = Effect.runSync(quiet.read(World));
    for (let tick = 0; tick < 30; tick++) {
      for (const app of [tracing, quiet]) {
        app.enqueue(Add, { by: tick });
        app.tick(1 / 60);
        app.frame(0.5);
      }
      expect(tracingWorld.hash()).toBe(quietWorld.hash());
    }
    expect(spans.length).toBeGreaterThan(0);
  });
});

describe("whether an app traces", () => {
  /**
   * Whether a system of an app runs inside a span, and the names of the
   * spans the tracer was given, when the program provides `tracer`, if
   * any, and runs `wrap` around making the app.
   */
  const look = (
    tracer: Tracer.Tracer | undefined,
    wrap: <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R> = (effect) => effect
  ): boolean => {
    let seen: boolean | undefined;
    const Look = System.tick("tr/Look", function* () {
      seen = Option.isSome(yield* Effect.option(Effect.currentSpan));
    });
    const made = wrap(App.make(App.define({ systems: [Look] })));
    const app =
      tracer === undefined ? Effect.runSync(made) : traced(tracer, made);
    app.tick(1 / 60);
    return seen!;
  };

  it("traces when the program provides a tracer, at the Debug level", () => {
    const { spans, tracer } = recorder();
    expect(look(tracer)).toBe(true);
    expect(spans.map((span) => span.name)).toEqual([
      "arcadekit/tick",
      "tr/Look",
    ]);
    expect(spans.every((span) => span.sampled)).toBe(true);
  });

  it("doesn't trace when the program provides no tracer", () => {
    expect(look(undefined)).toBe(false);
  });

  it("doesn't trace when the minimum level leaves Debug out, and the program's own spans still go", () => {
    const { spans, tracer } = recorder();
    const atInfo = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.tap(() => Effect.void.pipe(Effect.withSpan("own"))),
        Effect.provideService(Tracer.MinimumTraceLevel, "Info")
      );
    expect(look(tracer, atInfo)).toBe(false);
    expect(spans.map((span) => [span.name, span.sampled])).toEqual([
      ["own", true],
    ]);
  });

  it("doesn't trace under Effect.withTracerEnabled(false)", () => {
    const { spans, tracer } = recorder();
    const off = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.withTracerEnabled(false));
    expect(look(tracer, off)).toBe(false);
    expect(spans).toEqual([]);
  });
});
