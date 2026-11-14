import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import { Scene, Subscription } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as Game from "../game/browser";
import { ManualFrames } from "../game/testing/index";
import { EngineEntry, Viewport } from "./index";

// No DOM here. Scene renders the view as VNodes and resolves the viewport's Mount; `document` is
// stubbed; the engine is a declared `Game.Engine` for a tiny game whose view logs the element it
// draws into, on frames that run only when a test runs them. The host app wires the viewport the
// way the demos do.

const Message = defineMessageUnion({
  MountedViewport: {},
  UnmountedViewport: {},
  HidViewport: {},
  GotEvent: { name: Schema.String },
  FailedToLoad: { error: Schema.String },
});
type Message = typeof Message.Type;

interface Model {
  readonly isViewportMounted: boolean;
  readonly showsViewport: boolean;
}

const update = (model: Model, message: Message): { model: Model } =>
  Message.match(message, {
    MountedViewport: () => ({ model: { ...model, isViewportMounted: true } }),
    UnmountedViewport: () => ({
      model: { ...model, isViewportMounted: false },
    }),
    HidViewport: () => ({ model: { ...model, showsViewport: false } }),
    GotEvent: () => ({ model }),
    FailedToLoad: () => ({ model }),
  });

const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [],
    [
      model.showsViewport
        ? Viewport.make(h, {
            mounted: Message.MountedViewport(),
            unmounted: Message.UnmountedViewport(),
          })
        : h.empty,
      h.p([], [model.isViewportMounted ? "engine on" : "engine off"]),
    ]
  );

const unmounted: Model = { isViewportMounted: false, showsViewport: true };
const mounted: Model = { isViewportMounted: true, showsViewport: true };

// A game whose run reports that it started, some noise, and a sample.
class Started extends Game.Event("Started") {}
class Noise extends Game.Event("Noise") {}
class Sampled extends Game.Event("Sampled") {}

class Quiet extends Game.Simulation("Quiet", {
  input: Schema.Null,
  events: [Started, Noise],
  create: (_config: null, { report }) => {
    report(new Started());
    report(new Noise());
    return {};
  },
  step: () => {},
  sample: { event: Sampled, every: "1 second", read: () => ({}) },
}) {}

type GameEvent = Game.EventOf<typeof Quiet>;

/** What one test's engine logs to, and what the test makes go wrong in it. */
class Setup extends Context.Service<
  Setup,
  {
    readonly log: string[];
    readonly noWebGl: boolean;
    readonly renderBug: boolean;
  }
>()("test/Setup") {}

class TestEngine extends Game.Engine("TestEngine", {
  simulation: Quiet,
  uses: { setup: Setup },
  view: (container, { setup }) => {
    if (setup.noWebGl) {
      throw new Error("no WebGL");
    }
    setup.log.push(`attach ${container.title}`);
    return {
      render: () => {
        if (setup.renderBug) {
          throw new Error("render bug");
        }
      },
      dispose: () => {
        setup.log.push("detach");
      },
    };
  },
  input: () => ({ read: () => null, dispose: () => {} }),
}) {}

/**
 * The engine's layer for one test, with the log its view writes to. With `noWebGl`, making the
 * view throws, as Three.js does without WebGL; with `renderBug`, drawing a frame throws. Its
 * frames run only when the test runs them on `frames`.
 */
const testEngine = ({ noWebGl = false, renderBug = false } = {}) => {
  const log: string[] = [];
  const frames = ManualFrames.make();
  const layer = TestEngine.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Game.Frames, frames),
        Layer.succeed(Setup, { log, noWebGl, renderBug })
      )
    )
  );
  return { layer, frames, log };
};

/** Starts a run of the test's engine. */
const startRun = Effect.gen(function* () {
  const engine = yield* TestEngine;
  yield* engine.start(null);
});

const entry = EngineEntry.make({
  engine: TestEngine,
  isViewportMounted: (model: Model) => model.isViewportMounted,
  toMessage: Quiet.match({
    Started: (): Message | undefined => Message.GotEvent({ name: "started" }),
    Noise: () => undefined,
    Sampled: () => Message.GotEvent({ name: "sample" }),
  }),
  onError: (error) => Message.FailedToLoad({ error: error.message }),
});

/** The Stream Foldkit's runtime runs for `model`: the entry's dependencies, then its Stream. */
const streamFor = (model: Model) =>
  entry.dependenciesToStream(entry.modelToDependencies(model));

/**
 * `stream` until 30 ms after its first Message, so a second one sent with it shows up. The wait
 * starts at that Message, so a slow test can't end the Stream before a frame it runs.
 */
const throughFirstMessage = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Stream.unwrap(
    Effect.map(Deferred.make<boolean>(), (first) =>
      stream.pipe(
        Stream.tap(() => Deferred.succeed(first, true)),
        Stream.interruptWhen(
          Effect.andThen(Deferred.await(first), Effect.sleep(30))
        )
      )
    )
  );

/** The id `Viewport.make` renders, read from the rendered tree rather than assumed. */
const renderedViewportId = (): string => {
  let id = "";
  Scene.scene(
    { update, view },
    Scene.given(unmounted),
    Scene.tap((simulation) => {
      id = Option.getOrThrow(
        Option.flatMap(
          Scene.selector(".viewport")(simulation.html),
          Scene.attr("id")
        )
      );
    }),
    Scene.Mount.resolve({ name: "GameViewport" }, Message.MountedViewport())
  );
  return id;
};

const element = (title: string) => ({ title }) as HTMLElement;

const waitUntil = (isDone: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100 && !isDone(); turn++) {
      yield* Effect.yieldNow;
    }
  });

describe("EngineEntry.make", () => {
  let viewportId: string;
  let elements: Map<string, HTMLElement>;
  let lookups: string[];

  beforeEach(() => {
    viewportId = renderedViewportId();
    elements = new Map([[viewportId, element("first")]]);
    lookups = [];
    vi.stubGlobal("document", {
      getElementById: (lookedUp: string) => {
        lookups.push(lookedUp);
        return elements.get(lookedUp) ?? null;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing while the viewport isn't mounted", async () => {
    const { layer, log } = testEngine();
    const messages = await Effect.runPromise(
      Stream.runCollect(streamFor(unmounted)).pipe(Effect.provide(layer))
    );
    expect(messages).toStrictEqual([]);
    expect(lookups).toStrictEqual([]);
    expect(log).toStrictEqual([]);
  });

  it("draws into the element Viewport.make rendered and reports a run started right after", async () => {
    const { layer, log } = testEngine();
    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(streamFor(mounted), 2))
        );
        yield* waitUntil(() => log.length > 0);
        yield* startRun;
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layer))
    );
    expect(log).toStrictEqual(["attach first", "detach"]);
    // The first event and the first sample arrive; "noise" maps to undefined and is dropped.
    expect(messages).toStrictEqual([
      Message.GotEvent({ name: "started" }),
      Message.GotEvent({ name: "sample" }),
    ]);
  });

  it("keeps the engine on one element at a time as the viewport unmounts and remounts", async () => {
    // Models go through the operators Foldkit's runtime applies to an entry
    // (foldkit/dist/runtime/subscriptionFibers.js): changesWith, then switchMap. switchMap
    // starts the next Stream before it stops the previous one, and a second attach of one
    // engine dies, so an overlap fails this test.
    const { layer, log } = testEngine();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const models = yield* Queue.unbounded<Model>();
          const messages = yield* Stream.toQueue(
            Stream.fromQueue(models).pipe(
              Stream.map(entry.modelToDependencies),
              Stream.changesWith(
                Schema.toEquivalence(entry.dependenciesSchema)
              ),
              Stream.switchMap(entry.dependenciesToStream)
            ),
            { capacity: "unbounded" }
          );
          yield* Queue.offerAll(models, [unmounted, mounted]);
          yield* waitUntil(() => log.length === 1);
          // Other Model changes while mounted (a HUD sample, a click) leave the engine attached.
          yield* Queue.offerAll(models, [{ ...mounted }, { ...mounted }]);
          yield* Effect.sleep("20 millis");
          expect(log).toStrictEqual(["attach first"]);
          // Replacing the element in one patch reports its unmount, then the new mount.
          elements.set(viewportId, element("second"));
          yield* Queue.offerAll(models, [unmounted, mounted]);
          yield* waitUntil(() => log.length === 3);
          yield* startRun;
          expect(yield* Queue.take(messages)).toStrictEqual(
            Message.GotEvent({ name: "started" })
          );
        }).pipe(Effect.provide(layer))
      )
    );
    expect(log).toStrictEqual([
      "attach first",
      "detach",
      "attach second",
      "detach",
    ]);
  });

  it("sends onError's Message once when the engine can't make its view, and doesn't fail", async () => {
    const { layer } = testEngine({ noWebGl: true });
    const messages = await Effect.runPromise(
      Stream.runCollect(throughFirstMessage(streamFor(mounted))).pipe(
        Effect.provide(layer)
      )
    );
    expect(messages).toStrictEqual([
      Message.FailedToLoad({ error: "no WebGL" }),
    ]);
  });

  it("sends onError's Message once when the game crashes, and detaches", async () => {
    const { layer, frames, log } = testEngine({ renderBug: true });
    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(throughFirstMessage(streamFor(mounted)))
        );
        yield* waitUntil(() => log.length > 0);
        ManualFrames.runFrameAt(frames, 16);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layer))
    );
    expect(messages).toStrictEqual([
      Message.FailedToLoad({ error: "render bug" }),
    ]);
    expect({ log, waiting: ManualFrames.waiting(frames) }).toStrictEqual({
      log: ["attach first", "detach"],
      waiting: false,
    });
  });

  it("fails loudly when the viewport isn't in the document", async () => {
    elements.clear();
    const { layer } = testEngine();
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(streamFor(mounted)).pipe(Effect.provide(layer))
    );
    const cause = Exit.isFailure(exit) ? exit.cause : Cause.empty;
    expect(Cause.hasDies(cause)).toBe(true);
    expect(Cause.pretty(cause)).toContain(
      "render Viewport.make(h, …) in the view"
    );
  });
});

interface LoadError {
  readonly _tag: "LoadError";
  readonly message: string;
}
const loadError = (message: string): LoadError => ({
  _tag: "LoadError",
  message,
});

/** An entry for an engine reached through a load that can fail. */
const failingEntry = (
  engine: Effect.Effect<EngineEntry.Attachable<GameEvent, LoadError>, LoadError>
) =>
  EngineEntry.make({
    engine,
    isViewportMounted: (model: Model) => model.isViewportMounted,
    toMessage: (event: GameEvent): Message =>
      Message.GotEvent({ name: event._tag }),
    onError: (error) => Message.FailedToLoad({ error: error.message }),
  });

/** The entry's Stream while mounted, up to its first Message, or every Message in `ms`. */
const firstMessages = (
  entryForTest: ReturnType<typeof failingEntry>,
  ms: number
) =>
  Effect.runPromise(
    Stream.runCollect(
      entryForTest
        .dependenciesToStream(entryForTest.modelToDependencies(mounted))
        .pipe(Stream.interruptWhen(Effect.sleep(ms)))
    )
  );

describe("an engine reached through a load", () => {
  beforeEach(() => {
    const viewportId = renderedViewportId();
    vi.stubGlobal("document", {
      getElementById: (lookedUp: string) =>
        lookedUp === viewportId ? element("viewport") : null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends onError's Message once when the load fails, and doesn't fail", async () => {
    const messages = await firstMessages(
      failingEntry(Effect.fail(loadError("no sheet"))),
      30
    );
    expect(messages).toStrictEqual([
      Message.FailedToLoad({ error: "no sheet" }),
    ]);
  });

  it("sends onError's Message when attach fails, as a co-op client's can", async () => {
    const engine: EngineEntry.Attachable<GameEvent, LoadError> = {
      attach: () => Effect.fail(loadError("no art")),
      listen: () => Effect.void,
    };
    const messages = await firstMessages(
      failingEntry(Effect.succeed(engine)),
      30
    );
    expect(messages).toStrictEqual([Message.FailedToLoad({ error: "no art" })]);
  });

  it("stops listening when attach fails, so no event follows the error", async () => {
    const listeners = new Set<(event: GameEvent) => void>();
    const engine: EngineEntry.Attachable<GameEvent, LoadError> = {
      attach: () => Effect.fail(loadError("no art")),
      listen: (onEvent) =>
        Effect.acquireRelease(
          Effect.sync(() => listeners.add(onEvent)),
          () => Effect.sync(() => listeners.delete(onEvent))
        ),
    };
    const emitLater = Effect.sleep("10 millis").pipe(
      Effect.andThen(
        Effect.sync(() => {
          for (const onEvent of listeners) {
            onEvent(new Noise());
          }
        })
      )
    );
    const [messages] = await Effect.runPromise(
      Effect.all(
        [
          Effect.promise(() =>
            firstMessages(failingEntry(Effect.succeed(engine)), 30)
          ),
          emitLater,
        ],
        { concurrency: "unbounded" }
      )
    );
    expect({ messages, listeners: listeners.size }).toStrictEqual({
      messages: [Message.FailedToLoad({ error: "no art" })],
      listeners: 0,
    });
  });
});

// Miswired on purpose: each @ts-expect-error must be a real type error, and `pnpm typecheck`
// checks this file, so a change that loosens the wiring's types fails there.
const withoutEngineService = Subscription.make<Model, Message>()(() => ({
  // @ts-expect-error TestEngine is not among these Subscriptions' services.
  engine: entry,
}));
const engineWithOtherEvents = EngineEntry.make({
  // @ts-expect-error This engine's events are GameEvents, not the strings toMessage takes.
  engine: TestEngine,
  isViewportMounted: (model: Model) => model.isViewportMounted,
  toMessage: (event: string) => Message.GotEvent({ name: event }),
});
const eventToNonMessage = Subscription.make<Model, Message, TestEngine>()(
  () => ({
    engine: EngineEntry.make({
      engine: TestEngine,
      isViewportMounted: (model) => model.isViewportMounted,
      // @ts-expect-error A string is not one of the app's Messages.
      toMessage: (event: GameEvent) => event._tag,
    }),
  })
);
const attachFailingWithoutOnError = EngineEntry.make(
  // @ts-expect-error An engine's attach can fail, so it needs onError.
  {
    engine: TestEngine,
    isViewportMounted: (model: Model) => model.isViewportMounted,
    toMessage: (event: GameEvent) => Message.GotEvent({ name: event._tag }),
  }
);
const failingWithoutOnError = EngineEntry.make(
  // @ts-expect-error An engine whose load can fail needs onError.
  {
    engine: Effect.fail(loadError("")) as Effect.Effect<
      EngineEntry.Attachable<GameEvent, LoadError>,
      LoadError
    >,
    isViewportMounted: (model: Model) => model.isViewportMounted,
    toMessage: (event: GameEvent) => Message.GotEvent({ name: event._tag }),
  }
);
const onErrorWithoutFailure = EngineEntry.make({
  engine: Effect.succeed<EngineEntry.Attachable<GameEvent>>({
    attach: () => Effect.never,
    listen: () => Effect.void,
  }),
  isViewportMounted: (model: Model) => model.isViewportMounted,
  toMessage: (event: GameEvent) => Message.GotEvent({ name: event._tag }),
  // @ts-expect-error An engine that can't fail takes no onError.
  onError: () => Message.FailedToLoad({ error: "" }),
});
describe("miswired apps", () => {
  it("fail to compile (see the @ts-expect-error lines above)", () => {
    expect([
      withoutEngineService,
      engineWithOtherEvents,
      eventToNonMessage,
      failingWithoutOnError,
      attachFailingWithoutOnError,
      onErrorWithoutFailure,
    ]).toHaveLength(6);
  });
});
