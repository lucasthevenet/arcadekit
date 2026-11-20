---
title: "Debugging"
description: "See what a game does as it runs. Learn how to trace every tick, frame and system of an app, and send the spans to any OpenTelemetry collector."
---

**Tracing** records what a game does as it runs, as spans: one for each tick and each frame, with a span inside for each system and each action. A tracing tool shows them on a timeline, so you can see which system ran when, how long it took, and which one failed. This guide covers turning tracing on for an app and sending its spans somewhere you can read them.

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
