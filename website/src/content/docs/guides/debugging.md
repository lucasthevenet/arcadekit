---
title: "Debugging"
description: "See what a game does as it runs. Learn how to inspect an app's entities, systems and events, and trace every tick, frame and system to any OpenTelemetry collector."
---

You can look at what a game does in two ways. **Inspecting** an app copies what it holds now and what it did in its last tick: its entities and their components, its systems and how long each took, and the events of the last tick. **Tracing** records what it does as it runs, as spans that a tracing tool shows on a timeline. This guide covers both.

## Inspecting an app

`app.inspect()` returns what the game holds and what it did last, as plain data. In a page, keep the app where the browser's console can reach it:

```ts
import { App, Driver, Plugin } from "arcadekit";
import * as Browser from "arcadekit/Browser";
import { Effect } from "effect";

const Game = Plugin.make("game/Game", {});

Browser.runMain(
  Driver.run(
    App.make(App.define({ plugins: [Game] })).pipe(
      Effect.tap((app) =>
        Effect.sync(() => {
          Object.assign(globalThis, { app });
        })
      )
    ),
    { hz: 60 }
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
| `stores` | What the game holds beside its entities and singletons, by store name: the actions queued for the next tick under `Action.INTAKE`, as `{ queued, heard }`, and the events waiting to be read under `Event.STORE`, by event name |
| `systems` | Every system, as `{ name, stage, ran, ms }`: the tick's in the order they run, then the hooks, the input stage's and the frame stages'. `ran` is whether its last turn ran it, and `ms` how long that turn took |
| `events` | The events emitted in the last tick, by event name, each in the order it was emitted |

- Every value is a copy. Writing to one changes nothing in the game.
- `ran` is false for a system whose `System.runIf` condition didn't hold, and for one that hasn't had a turn yet, such as a hook whose state was never entered.
- `ms` includes the system's condition and applying its commands. It is measured on every turn, whether or not you inspect.
- `events` holds what the last tick's actions, hooks and systems emitted, including an `Action.Rejected` for each refusal, and what was emitted since the tick before it ended. An event a refused handler emitted is not there: a refusal takes it back.
- `inspect` copies the whole world, so call it when you look rather than every frame. It throws if called from inside a tick or a frame.

## Tracing an app

Provide a tracer to the program, and the app traces itself:

```ts
import { App, Driver, System } from "arcadekit";
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
  Driver.run(App.make(App.define({ systems: [Move, Draw] })), { hz: 60 }).pipe(
    Effect.provide(Tracing)
  ),
  { target: document.querySelector("canvas")! }
);
```

`OtlpTracer.layer`, from Effect, sends spans to an [OpenTelemetry](https://opentelemetry.io) collector, such as a local [Jaeger](https://www.jaegertracing.io) or Grafana. The spans are Effect's, so any tracer you provide to the program receives them.

An app made where a tracer is provided makes these spans, at the "Debug" level:

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

## Turning tracing off

An app makes its spans at the "Debug" level, and makes none, costing nothing, when:

- the program provides no tracer,
- it runs under `Effect.withTracerEnabled(false)`, which turns off every span, the program's own too,
- or the program's `Tracer.MinimumTraceLevel` is above "Debug".

A span costs about 3 µs, so a traced tick of 10 systems takes about 30 µs more, and a tracer receives a span for every system on every tick. A program that provides a tracer for spans of its own, such as a game's server, and doesn't want the game's, raises the minimum level. Its own spans are at "Info" unless it says otherwise, so they still go:

```ts sketch
import { Tracer } from "effect";

Driver.run(App.make(App.define({ plugins: [Game] })), { hz: 60 }).pipe(
  Effect.provideService(Tracer.MinimumTraceLevel, "Info"),
  Effect.provide(Tracing)
);
```

The app chooses once, when it is made, from what the program provides there.

## Read more

- [Testing](testing.md), to step an app by hand and check what it does.
- [Performance](performance.md), for the cost of the parts of a tick.
- Effect's [example of tracing with OTLP](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/08_observability/20_otlp-tracing.ts), for the layers it provides.
