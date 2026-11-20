---
title: "Debugging"
description: "See what a game does as it runs. Learn how to inspect an app's entities, systems and events, and trace every tick, frame and system to any OpenTelemetry collector."
---

You can look at what a game does in two ways. **Inspecting** an app copies what it holds now and what it did in its last tick: its entities and their components, its systems and how long each took, and the events of the last tick. **Tracing** records what it does as it runs, as spans that a tracing tool shows on a timeline. This guide covers both.

## Inspecting an app

`app.inspect()` returns what the game holds and what it did last, as plain data. In a page, keep the app where the browser's console can reach it:

```ts
import { App, Plugin } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});

Browser.runMain(
  App.run(
    { plugins: [Game] },
    {
      hz: 60,
      ready: (app) =>
        Effect.sync(() => {
          Object.assign(globalThis, { app });
        }),
    }
  ),
  { target: document.querySelector("canvas")! }
);
```

Then type `app.inspect()` in the console, or `console.table(app.inspect().systems)` for the systems. A game's own UI can show the same data, and a test can check it.

| Field | What it holds |
| --- | --- |
| `tick` | The number of ticks run |
| `entities` | Every live entity in order of id, as `{ id, components }`, with each component's fields by component name |
| `singletons` | Each singleton the world holds, by name |
| `systems` | Every system, as `{ name, stage, ran, ms }`: the tick's in the order they run, then the hooks, the input stage's and the frame stages'. `ran` is whether its last turn ran it, and `ms` how long that turn took |
| `events` | The events emitted in the last tick, by event name, each in the order it was emitted |

- Every value is a copy. Writing to one changes nothing in the game.
- `ran` is false for a system whose `System.runIf` condition didn't hold, and for one that hasn't had a turn yet, such as a hook whose state was never entered.
- `ms` includes the system's condition and applying its commands. It is measured on every turn, whether or not you inspect.
- `events` holds what the last tick's actions, hooks and systems emitted, including an `Action.Rejected` for each refusal, and what was emitted since the tick before it ended. An event a refused handler emitted is not there: a refusal takes it back.
- `inspect` copies the whole world, so call it when you look rather than every frame. It throws if called from inside a tick or a frame.

## Tracing an app

Create the app with `trace: true`, and provide a tracer to the program:

```ts
import { App, System } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";

const Move = System.make("game/Move", function* () {});
const Draw = System.make("game/Draw", function* () {}).pipe(
  System.inStage("frame")
);

const Tracing = OtlpTracer.layer({
  url: "http://localhost:4318/v1/traces",
  resource: { serviceName: "my-game" },
}).pipe(
  Layer.provide(OtlpSerialization.layerJson),
  Layer.provide(FetchHttpClient.layer)
);

Browser.runMain(
  App.run({ systems: [Move, Draw], trace: true }, { hz: 60 }).pipe(
    Effect.provide(Tracing)
  ),
  { target: document.querySelector("canvas")! }
);
```

`OtlpTracer.layer`, from Effect, sends spans to an [OpenTelemetry](https://opentelemetry.io) collector, such as a local [Jaeger](https://www.jaegertracing.io) or Grafana. The spans are Effect's, so any tracer you provide to the program receives them.

An app made with `trace: true` makes these spans:

| Span | When | Inside it |
| --- | --- | --- |
| `arcadekit/tick` | Each tick, with its number as `arcadekit.tick` | A span for each action applied at its start, `action:<name>`, then one for each system, named after the system |
| `arcadekit/frame` | Each run of the frame stage, with its number as `arcadekit.frame` | A span for each system of the frame stages |
| `arcadekit/input` | Each run of the input stage | A span for each system of the input stage |

- Each of the three starts a trace of its own, so a tracing tool lists the ticks and frames one by one.
- A system's span holds its condition and whichever of its run or `System.otherwise` follows. A system whose condition doesn't hold still has a span, a short one.
- A hook, run when a state is entered or left, has a span inside the tick it runs in.
- A span that failed carries its error, and so does the tick or frame it was in.
- An action applied with `app.dispatch`, between ticks, has a span of its own, `action:<name>`.

Tracing doesn't change what the game does. A span reads the real clock, and its ids are drawn from `Math.random`, never from the game's `Random`. A traced game plays the same as one that isn't, and its replays and peers agree with it.

## What tracing costs

`trace` defaults to `false`, and an app made without it makes no span and runs exactly what it would otherwise. With it, every system and action makes a span on every tick, whether or not a tracer is provided. Turn it on in development, or for a session you want to look at:

```ts sketch
App.run({ plugins: [Game], trace: import.meta.env.DEV }, { hz: 60 });
```

## Read more

- [Testing](testing.md), to step an app by hand and check what it does.
- [Performance](performance.md), for the cost of the parts of a tick.
- Effect's [example of tracing with OTLP](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/08_observability/20_otlp-tracing.ts), for the layers it provides.
