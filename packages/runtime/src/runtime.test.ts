import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeGameEngine } from "./index";
import type { GameDefinition } from "./index";

// A tiny game: a counter that reports when it is bumped past a threshold.
interface State {
  value: number;
  seed: number;
  events: string[];
}

const counterGame: GameDefinition<{ start: number }, State, number, string> = {
  create: ({ start }, seed) => ({
    value: start,
    seed,
    events: [`started at ${start}`],
  }),
  step: (state, input) => {
    state.value += input;
  },
  drainEvents: (state) => state.events.splice(0),
  sample: { everyMs: 100, read: (state) => `value ${state.value}` },
  createInput: () => ({ read: () => 1, dispose: () => {} }),
  createView: () => ({ render: () => {}, dispose: () => {} }),
};

const collect = (
  run: (
    engine: ReturnType<
      typeof makeGameEngine<{ start: number }, State, number, string>
    >
  ) => Effect.Effect<void>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = makeGameEngine(counterGame);
        const events: string[] = [];
        yield* engine.listen((event) => events.push(event));
        yield* run(engine);
        return events;
      })
    )
  );

describe(makeGameEngine, () => {
  it("reports creation events and a first sample when a run starts", async () => {
    const events = await collect((engine) => engine.start({ start: 5 }, 42));
    expect(events).toStrictEqual(["started at 5", "value 5"]);
  });

  it("reports events produced by modify", async () => {
    const events = await collect((engine) =>
      Effect.gen(function* () {
        yield* engine.start({ start: 0 }, 1);
        yield* engine.modify((state) => {
          state.value = 10;
          state.events.push("jumped to 10");
        });
      })
    );
    expect(events).toStrictEqual(["started at 0", "value 0", "jumped to 10"]);
  });

  it("ignores modify when no run is active", async () => {
    let called = false;
    const events = await collect((engine) =>
      engine.modify(() => {
        called = true;
      })
    );
    expect(called).toBe(false);
    expect(events).toStrictEqual([]);
  });

  it("stops reporting to a listener once its scope closes", async () => {
    const engine = makeGameEngine(counterGame);
    const events: string[] = [];
    await Effect.runPromise(
      Effect.scoped(engine.listen((event) => events.push(event)))
    );
    await Effect.runPromise(engine.start({ start: 1 }, 1));
    expect(events).toStrictEqual([]);
  });
});
