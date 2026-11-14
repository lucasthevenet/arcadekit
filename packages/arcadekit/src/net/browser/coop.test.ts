import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Schema,
  Scope,
} from "effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import * as Game from "../../game/browser";
import { ManualFrames } from "../../game/testing/index";
import type { Ticker } from "../scoped";
import {
  AnswerOffer,
  HoldPause,
  NothingOwed,
  OfferOpened,
  RunEnded,
  Score,
  TestGame,
  fakeCoopRooms,
  hashTestState,
  manualTicker,
  onFakeTimers,
  testContent,
} from "../testing/index";
import type { FakeCoopRooms, TestEvent } from "../testing/index";
import { Coop, CoopTicker } from "./coop";
import * as Seat from "./coop-events";
import type { CoopRooms } from "./coop-rooms";

// A `Coop` declared the way a genre declares one, over an engine for the test game
// (`arcadekit/net/testing`), and played through its layer: fake rooms link a host and a guest,
// fake timers tick their runs, and a test runs the frames. What the Co-op client does with a
// game's parts has its own tests, on plain parts (coop-client.test.ts).

/** What the views and the input sources log to: the test's own service, to show the layer hands it over. */
class Log extends Context.Service<Log, string[]>()("test/Log") {}

/** The test game's content, as an app's content service gives it, and how often it was loaded. */
class Levels extends Context.Service<
  Levels,
  { readonly length: number; loads: number }
>()("test/Levels") {}

/**
 * Something an attach acquires and gives back, as what an engine uses may be (a camera's state,
 * a listener): it logs both, to show whose scope holds it.
 */
const lamp = Effect.acquireRelease(
  Log.pipe(
    Effect.map((log) => {
      log.push("lamp on");
      return log;
    })
  ),
  (log) => Effect.sync(() => log.push("lamp off"))
);

class TestEngine extends Game.Engine("TestEngine", {
  simulation: TestGame,
  uses: { log: Log, lamp },
  view: (_container, { log }, { local }) => ({
    render: (state) => {
      log.push(
        `seat ${local.slot} of [${local.names.join(", ")}] draws ${state === null ? "no run" : "a run"}`
      );
    },
    dispose: () => log.push("dispose view"),
  }),
  // One player's run fills slot 0 alone: a Coop doesn't make this source.
  input: () => ({
    read: () => ({ players: [{ add: 1 }], leaving: [] }),
    dispose: () => {},
  }),
}) {}

/** The content each seat loads: the test game's, as long as the app's levels say. */
const levels = Levels.pipe(
  Effect.map((app) => {
    app.loads += 1;
    return { ...testContent, length: app.length };
  })
);

class TestCoop extends Coop("TestCoop", {
  engine: TestEngine,
  input: (_surface, { log }) => {
    log.push("input");
    return {
      read: () => ({ add: 2 }),
      dispose: () => log.push("dispose input"),
    };
  },
  content: levels,
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  maxPlayers: 2,
  hash: hashTestState,
  ends: [RunEnded],
}) {}

/**
 * The same game with lockstep numbers of its own and a hash a test can tell from any other: one
 * more than the steps played, so a hash says which state it is of.
 */
class PacedCoop extends Coop("PacedCoop", {
  engine: TestEngine,
  input: () => ({ read: () => ({ add: 2 }), dispose: () => {} }),
  content: levels,
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  hash: (state) => state.steps + 1,
  lockstep: { inputDelay: 2, hashEvery: 2 },
}) {}

type Event = Seat.CoopEvent<TestEvent>;

const element = {} as HTMLElement;

/** A ticker on the page's timer, which the tests fake. */
const pageTicker: Ticker = (onTick) => {
  const timer = setInterval(onTick, 4);
  return () => clearInterval(timer);
};

let scope: Scope.Closeable;

/** Runs `effect` as the app does: in the app's scope, on the test's Clock and Scheduler. */
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(effect.pipe(Scope.provide(scope), onFakeTimers));

/** As `run`, but on Effect's own Clock and scheduler, which fake timers don't reach. */
const plain: typeof run = (effect) =>
  Effect.runPromise(effect.pipe(Scope.provide(scope)));

/** Lets queued microtasks run, at the current fake time. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Settles until `done`, at most `turns` times: each is a real turn of the event loop too. */
const settledUntil = async (
  done: () => boolean,
  turns = 100
): Promise<void> => {
  if (!done() && turns > 0) {
    await settle();
    await settledUntil(done, turns - 1);
  }
};

/**
 * One player's Co-op client, from the declaration's layer over the app's services. `build` runs
 * the Effect that builds the layer: `run`, unless a test says.
 */
const seat = async (
  hub: FakeCoopRooms,
  length = 1_000_000,
  build: typeof run = run
) => {
  const frames = ManualFrames.make();
  const log: string[] = [];
  const app = { length, loads: 0 };
  const events: Event[] = [];
  const coop = await build(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        TestCoop.layer.pipe(
          Layer.provide(hub.layer),
          Layer.provide(Layer.succeed(CoopTicker, Effect.succeed(pageTicker))),
          Layer.provide(Layer.succeed(Game.Frames, frames)),
          Layer.provide(Layer.succeed(Log, log)),
          Layer.provide(Layer.succeed(Levels, app))
        )
      );
      const made = Context.get(context, TestCoop);
      yield* made.listen((event) => events.push(event));
      return made;
    })
  );
  return { coop, events, frames, log, app };
};

/** A host and a guest in one lobby, with their picks. */
const lobbyOfTwo = async (hub: FakeCoopRooms, length?: number) => {
  const host = await seat(hub, length);
  const guest = await seat(hub, length);
  await run(host.coop.host("red"));
  await settle();
  await run(guest.coop.join(hub.code, "green"));
  await settle();
  return { host, guest };
};

/** The run's own events a seat heard, without its samples. */
const reported = (events: readonly Event[]): TestEvent[] =>
  events.flatMap((event) =>
    event._tag === "RunEvent" && event.event._tag !== "Score"
      ? [event.event]
      : []
  );

describe("a declared Coop", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "performance"],
    });
    scope = Effect.runSync(Scope.make());
  });

  afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    vi.useRealTimers();
  });

  it("is the key of a Co-op client, named for the declaration, and keeps its engine", () => {
    expect([
      TestCoop.kind,
      TestCoop.coopName,
      TestCoop.key,
      TestCoop.engine === TestEngine,
    ]).toStrictEqual(["Coop", "TestCoop", "arcadekit/net/Coop/TestCoop", true]);
  });

  it("plays its engine's simulation from a lobby, and hears the run's own events", async () => {
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub, 60);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(3000);
    const [hostRun, guestRun] = [host.coop.debug(), guest.coop.debug()];
    const common = Object.keys(hostRun.hashes).filter(
      (step) => step in guestRun.hashes
    );
    expect([
      host.events.find((event) => event._tag === "RunStarted"),
      guest.events.find((event) => event._tag === "RunStarted"),
      [hostRun.error, guestRun.error],
      hostRun.state?.picks,
      common.length > 0,
      common.map((step) => hostRun.hashes[Number(step)]),
      // The simulation's events, as it reported them: its sample, and the end of the run.
      guest.events.some(
        (event) => event._tag === "RunEvent" && event.event instanceof Score
      ),
      reported(host.events),
      reported(guest.events),
      // Each comes with the local player of the seat that heard it.
      [host, guest].map(({ events }) => {
        const heard = events.findLast((event) => event._tag === "RunEvent");
        return heard && [heard.local.slot, heard.local.names];
      }),
    ]).toStrictEqual([
      new Seat.RunStarted({ slot: 0, names: ["Host", "Guest 1"] }),
      new Seat.RunStarted({ slot: 1, names: ["Host", "Guest 1"] }),
      [null, null],
      ["red", "green"],
      true,
      common.map((step) => guestRun.hashes[Number(step)]),
      true,
      [new RunEnded({ totals: [0, 0] })],
      [new RunEnded({ totals: [0, 0] })],
      [
        [0, ["Host", "Guest 1"]],
        [1, ["Host", "Guest 1"]],
      ],
    ]);
  });

  // An app may keep an event and match it later (a queue, a log): by then the player may have
  // left, or taken another seat, and the event must still say whose it was.
  it("gives a seat's run events the seat's own local player, which a later seat doesn't change", async () => {
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    const kept = guest.events.filter((event) => event._tag === "RunEvent");
    const whenHeard = kept.map(({ local }) => [local.slot, local.names]);
    await run(guest.coop.leave);
    // Its next seat is another room's host, at slot 0.
    await run(guest.coop.host("blue"));
    await settle();
    expect([
      kept.length > 0,
      new Set(whenHeard.map((local) => JSON.stringify(local))),
      kept.map(({ local }) => [local.slot, local.names]),
      // One object for the seat: an event allocates none.
      new Set(kept.map(({ local }) => local)).size,
    ]).toStrictEqual([true, new Set(['[1,["Host","Guest 1"]]']), whenHeard, 1]);
  });

  it("ticks a run on a worker's timer unless a test provides its own, as it draws on Game.Frames", async () => {
    const hub = fakeCoopRooms();
    const ticks = manualTicker();
    const manual = () =>
      run(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            TestCoop.layer.pipe(
              Layer.provide(hub.layer),
              Layer.provide(ticks.layer),
              Layer.provide(Layer.succeed(Log, [])),
              Layer.provide(
                Layer.succeed(Levels, { length: 1_000_000, loads: 0 })
              )
            )
          );
          return Context.get(context, TestCoop);
        })
      );
    const [host, guest] = [await manual(), await manual()];
    await run(host.host("red"));
    await settle();
    await run(guest.join(hub.code, "green"));
    await settle();
    await run(host.start);
    await vi.advanceTimersByTimeAsync(1000);
    // No timer ticks these runs: they step when the test's ticker says so.
    const untouched = [ticks.ticking(), host.debug().stepIndex];
    for (let i = 0; i < 50; i++) {
      ticks.tick();
      // oxlint-disable-next-line no-await-in-loop -- each tick's messages cross before the next.
      await vi.advanceTimersByTimeAsync(20);
    }
    expect([untouched, host.debug().stepIndex > 10]).toStrictEqual([
      [2, 0],
      true,
    ]);
  });

  // Why a test on fake timers runs the Effect that builds the layer through `onFakeTimers`: the
  // client reads its time there, and what it forks later runs as that Effect did.
  it("runs on the Clock and the scheduler of the Effect that built its layer, whatever its calls run on", async () => {
    /**
     * A lobby of two started, then a second of faked time: whether the host's seat heard its
     * run start, the steps that run took, and the steps the real time since had room for.
     */
    const play = async (build: typeof run, call: typeof run) => {
      const hub = fakeCoopRooms();
      const host = await seat(hub, undefined, build);
      const guest = await seat(hub, undefined, build);
      const heard = (isIt: (event: Event) => boolean) => () =>
        host.events.some(isIt);
      const started = heard((event) => event._tag === "RunStarted");
      await call(host.coop.host("red"));
      await settle();
      await call(guest.coop.join(hub.code, "green"));
      // A client built on Effect's own scheduler goes on at real moments, not at the one a
      // test names: after a single `settle` its lobby can't start yet, and a start asked of
      // it then starts nothing.
      await settledUntil(
        heard((event) => event._tag === "LobbyChanged" && event.canStart)
      );
      // `Date` is not faked: it measures the real time the run has.
      const realFromMs = Date.now();
      await call(host.coop.start);
      await settledUntil(started);
      await vi.advanceTimersByTimeAsync(1000);
      return {
        started: started(),
        steps: host.coop.debug().stepIndex,
        realSteps:
          (Date.now() - realFromMs) / (TestGame.definition.stepSeconds * 1000),
      };
    };
    const builtOnFakeTimers = await play(run, plain);
    const calledOnFakeTimers = await play(plain, run);
    expect([
      // A second at 60 Hz, less the start.
      [builtOnFakeTimers.started, builtOnFakeTimers.steps > 50],
      // Built on Effect's own Clock, the run steps by the real time that passed, to a step,
      // however long the machine took: not by the faked second its ticker's timer ran through.
      [
        calledOnFakeTimers.started,
        calledOnFakeTimers.steps <= calledOnFakeTimers.realSteps + 1,
      ],
    ]).toStrictEqual([
      [true, true],
      [true, true],
    ]);
  });

  it("makes the engine's view for the seat the lobby gave, and its own input source for one player", async () => {
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub);
    const attach = Effect.runFork(onFakeTimers(guest.coop.attach(element)));
    await settle();
    ManualFrames.runFrameAt(guest.frames, 100);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    ManualFrames.runFrameAt(guest.frames, 600);
    await Effect.runPromise(Fiber.interrupt(attach));
    const totals = host.coop.debug().state?.totals ?? [];
    expect([
      guest.log,
      // Only the guest was attached: what its source read rode its steps, at 2 a step, to
      // the host's run too.
      [totals[0], (totals[1] ?? 0) > 0, (totals[1] ?? 0) % 2],
    ]).toStrictEqual([
      [
        "lamp on",
        "input",
        "seat 0 of [] draws no run",
        "seat 1 of [Host, Guest 1] draws a run",
        "dispose input",
        "dispose view",
        "lamp off",
      ],
      [0, true, 0],
    ]);
  });

  // What the engine uses is run in each attach's own scope, not in the layer's, which is the
  // app's: a view's listeners and what it loaded for one mount go when it is unmounted.
  it("gives back what an attach acquired when it detaches, and acquires it again for the next", async () => {
    const hub = fakeCoopRooms();
    const { coop, log, frames } = await seat(hub);
    const attach = () => Effect.runFork(onFakeTimers(coop.attach(element)));
    const first = attach();
    await settle();
    ManualFrames.runFrameAt(frames, 100);
    await Effect.runPromise(Fiber.interrupt(first));
    // The app's scope, which the layer was built in, is still open.
    const detached = [...log];
    const second = attach();
    await settle();
    await Effect.runPromise(Fiber.interrupt(second));
    expect([detached, log.slice(detached.length)]).toStrictEqual([
      [
        "lamp on",
        "input",
        "seat 0 of [] draws no run",
        "dispose input",
        "dispose view",
        "lamp off",
      ],
      ["lamp on", "input", "dispose input", "dispose view", "lamp off"],
    ]);
  });

  it("tells the lobby the most players it declares, and takes no start above it", async () => {
    const hub = fakeCoopRooms();
    const { host } = await lobbyOfTwo(hub);
    const lobby = (canStart: boolean, guests: number) =>
      new Seat.LobbyChanged({
        role: "host",
        code: hub.code,
        self: "host",
        players: [
          { id: "host", name: "Host", pick: "red" },
          ...Array.from({ length: guests }, (_, index) => ({
            id: `guest-${index + 1}`,
            name: `Guest ${index + 1}`,
            pick: "green",
          })),
        ],
        maxPlayers: 2,
        canStart,
      });
    const two = host.events.at(-1);
    const third = await seat(hub);
    await run(third.coop.join(hub.code, "green"));
    await settle();
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(200);
    // TestCoop declares 2 where a room's default is 4: three players can't start.
    expect([
      two,
      host.events.at(-1),
      host.coop.debug().stepIndex,
    ]).toStrictEqual([lobby(true, 1), lobby(false, 2), 0]);
  });

  it("loads its content again for each seat", async () => {
    const hub = fakeCoopRooms();
    const { coop, app } = await seat(hub);
    const built = app.loads;
    await run(coop.host("red"));
    await settle();
    await run(coop.leave);
    await run(coop.host("blue"));
    await settle();
    // Building the layer loaded nothing: each host did.
    expect([built, app.loads]).toStrictEqual([0, 2]);
  });

  it("runs on the lockstep numbers it declares, and compares the hash it declares", async () => {
    const hub = fakeCoopRooms();
    const paced = () =>
      run(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            PacedCoop.layer.pipe(
              Layer.provide(hub.layer),
              Layer.provide(
                Layer.succeed(CoopTicker, Effect.succeed(pageTicker))
              ),
              Layer.provide(Layer.succeed(Log, [])),
              Layer.provide(
                Layer.succeed(Levels, { length: 1_000_000, loads: 0 })
              )
            )
          );
          return Context.get(context, PacedCoop);
        })
      );
    const [host, guest] = [await paced(), await paced()];
    await run(host.host("red"));
    await settle();
    await run(guest.join(hub.code, "green"));
    await settle();
    await run(host.start);
    await vi.advanceTimersByTimeAsync(1000);
    const hashes = Object.entries(host.debug().hashes).map(
      ([step, hash]) => [Number(step), hash] as const
    );
    const steps = hashes.map(([step]) => step);
    expect([
      [host.debug().error, guest.debug().error],
      // A hash every 2 steps, where the default is every 60.
      steps.length > 10,
      steps.map((step) => step % 2),
      steps.slice(1).map((step, index) => step - steps[index]!),
      // Each is the declared hash of the state after that many steps.
      hashes.map(([, hash]) => hash),
      Object.keys(guest.debug().hashes).length > 10,
    ]).toStrictEqual([
      [null, null],
      true,
      steps.map(() => 0),
      steps.slice(1).map(() => 2),
      steps.map((step) => step + 1),
      true,
    ]);
  });

  it("sends a command of the engine's simulation, and fails with the rejection the rules refused it with", async () => {
    const hub = fakeCoopRooms();
    const { host } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(200);
    const held = Effect.runFork(
      Effect.result(host.coop.send(new HoldPause({ held: true })))
    );
    const answered = Effect.runFork(
      Effect.result(host.coop.send(new AnswerOffer({ offer: 1, value: 3 })))
    );
    await vi.advanceTimersByTimeAsync(500);
    expect([
      await Effect.runPromise(Fiber.join(held)),
      await Effect.runPromise(Fiber.join(answered)),
      host.coop.debug().state?.held,
    ]).toStrictEqual([
      Result.succeed(undefined),
      Result.fail(new NothingOwed({ offer: 1 })),
      [true, false],
    ]);
  });

  it("stops quietly when the others leave a run that one of its `ends` events ended", async () => {
    const hub = fakeCoopRooms();
    const { host, guest } = await lobbyOfTwo(hub, 30);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(2000);
    await run(host.coop.leave);
    await vi.advanceTimersByTimeAsync(12_000);
    expect([
      reported(guest.events),
      guest.events.filter((event) => event._tag === "SeatFailed"),
    ]).toStrictEqual([[new RunEnded({ totals: [0, 0] })], []]);
  });

  it("takes its types from the engine's simulation and from what it uses", () => {
    expectTypeOf(TestCoop.layer).toEqualTypeOf<
      Layer.Layer<TestCoop, never, CoopRooms | Log | Levels>
    >();
    const program = Effect.gen(function* () {
      const coop = yield* TestCoop;
      expectTypeOf(
        coop.send(new AnswerOffer({ offer: 1, value: 3 }))
      ).toEqualTypeOf<Effect.Effect<void, NothingOwed | Game.CommandDropped>>();
      expectTypeOf(coop.send(new HoldPause({ held: true }))).toEqualTypeOf<
        Effect.Effect<void, Game.CommandDropped>
      >();
      expectTypeOf(coop.debug().state).toEqualTypeOf<Game.StateOf<
        typeof TestGame
      > | null>();
      // @ts-expect-error -- not a command of the engine's simulation
      void coop.send(new RunEnded({ totals: [] }));
    });
    expect(Effect.isEffect(program)).toBe(true);
  });

  // `picks` and `config` take their `content` from the `content` field. An Effect piped where
  // it is given still tells them; one made by a data-first call, here `Effect.map` given the
  // Effect and the function together, does not, on any TypeScript tried (5.6 to 7.0).
  // `CoopDefinition.content`'s doc comment and the guide say so: if the second block ever
  // compiles, they are out of date.
  it("takes its content's type from an Effect piped in the definition, but not from a data-first call", () => {
    class Piped extends Coop("Piped", {
      engine: TestEngine,
      input: () => ({ read: () => ({ add: 2 }), dispose: () => {} }),
      content: Levels.pipe(
        Effect.map(({ length }) => ({ ...testContent, length }))
      ),
      picks: (content) => content.picks,
      config: (content, picks) => ({ content, picks }),
      hash: hashTestState,
    }) {}
    class DataFirst extends Coop("DataFirst", {
      engine: TestEngine,
      input: () => ({ read: () => ({ add: 2 }), dispose: () => {} }),
      // oxlint-disable-next-line unicorn/no-array-method-this-argument -- no array's map: Effect.map given the Effect and the function together, the form this test is about.
      content: Effect.map(Levels, ({ length }) => ({ ...testContent, length })),
      // @ts-expect-error -- `content` is unknown here
      picks: (content) => content.picks,
      // @ts-expect-error -- and here, so this is no config of the test game
      config: (content, picks) => ({ content, picks }),
      hash: hashTestState,
    }) {}
    // The piped Effect told the declaration its content, and what loading it needs.
    expectTypeOf(Piped.layer).toEqualTypeOf<
      Layer.Layer<Piped, never, CoopRooms | Log | Levels>
    >();
    // Only the types differ: both are declared, and would play.
    expect([
      Piped.definition.picks({ ...testContent, length: 1 }),
      DataFirst.coopName,
    ]).toStrictEqual([testContent.picks, "DataFirst"]);
  });
});

// How an app hears a seat: one `match` for the client's own events and the run's.
describe("a Coop's match", () => {
  /** What an app would make of each event: here, a line of text. */
  const toLine = TestCoop.match({
    LobbyChanged: ({ code, players }) => `lobby ${code}: ${players.length}`,
    RunStarted: ({ slot }) => `started at ${slot}`,
    WaitingChanged: ({ waitingFor }) => `waiting for ${waitingFor.join("+")}`,
    SeatFailed: ({ reason }) => `failed: ${reason}`,
    run: {
      Score: () => undefined,
      OfferOpened: ({ offer, slot }, { local }) =>
        slot === local.slot ? `offer ${offer} is mine` : undefined,
      RunEnded: ({ totals }, { local }) =>
        `ended with ${totals[local.slot]} for ${local.names[local.slot]}`,
    },
  });
  const local = { slot: 1, names: ["Host", "Guest 1"] };
  const heard = (event: TestEvent): Event => ({
    _tag: "RunEvent",
    event,
    local,
  });

  it("handles the client's own events by their tags", () => {
    expect(
      [
        new Seat.LobbyChanged({
          role: "host",
          code: "K7MQ2X",
          self: "host",
          players: [{ id: "host", name: "Host", pick: "red" }],
          maxPlayers: 2,
          canStart: false,
        }),
        new Seat.RunStarted({ slot: 1, names: local.names }),
        new Seat.WaitingChanged({ waitingFor: ["Host"] }),
        new Seat.SeatFailed({ reason: "hostLost", message: "Lost the host." }),
      ].map(toLine)
    ).toStrictEqual([
      "lobby K7MQ2X: 1",
      "started at 1",
      "waiting for Host",
      "failed: hostLost",
    ]);
  });

  it("handles the run's events under `run`, each with the local player", () => {
    expect(
      [
        heard(new Score({ steps: 3, totals: [1, 2], owes: [false, false] })),
        heard(new OfferOpened({ offer: 1, slot: 0 })),
        heard(new OfferOpened({ offer: 1, slot: 1 })),
        heard(new RunEnded({ totals: [5, 6] })),
      ].map(toLine)
    ).toStrictEqual([
      undefined,
      undefined,
      "offer 1 is mine",
      "ended with 6 for Guest 1",
    ]);
    expectTypeOf(toLine).toEqualTypeOf<
      (event: Seat.CoopEvent<TestEvent>) => string | undefined
    >();
  });

  it("reserves no tag: a run may report events named as the client's own are", () => {
    class LobbyChanged extends Game.Event("LobbyChanged", {
      door: Schema.Int,
    }) {}
    class RunEvent extends Game.Event("RunEvent", { lap: Schema.Int }) {}
    class Doors extends Game.Simulation("Doors", {
      input: Game.PlayerInputs(Schema.Null),
      events: [LobbyChanged, RunEvent],
      create: () => ({ doors: 0 }),
      step: () => {},
    }) {}
    class DoorsEngine extends Game.Engine("DoorsEngine", {
      simulation: Doors,
      view: () => ({ render: () => {}, dispose: () => {} }),
      input: () => ({
        read: () => ({ players: [], leaving: [] }),
        dispose: () => {},
      }),
    }) {}
    class DoorsCoop extends Coop("DoorsCoop", {
      engine: DoorsEngine,
      input: () => ({ read: () => null, dispose: () => {} }),
      content: Effect.succeed(null),
      picks: () => ["one"],
      config: () => undefined,
      hash: (state) => state.doors,
    }) {}
    const toDoor = DoorsCoop.match({
      LobbyChanged: ({ code }) => `the client's lobby ${code}`,
      RunStarted: () => "started",
      WaitingChanged: () => "waiting",
      SeatFailed: () => "failed",
      run: {
        LobbyChanged: ({ door }) => `the game's door ${door}`,
        RunEvent: ({ lap }) => `the game's lap ${lap}`,
      },
    });
    expect([
      toDoor(
        new Seat.LobbyChanged({
          role: "guest",
          code: "K7MQ2X",
          self: "guest-1",
          players: [],
          maxPlayers: 4,
          canStart: false,
        })
      ),
      toDoor({
        _tag: "RunEvent",
        event: new LobbyChanged({ door: 3 }),
        local,
      }),
      toDoor({ _tag: "RunEvent", event: new RunEvent({ lap: 2 }), local }),
    ]).toStrictEqual([
      "the client's lobby K7MQ2X",
      "the game's door 3",
      "the game's lap 2",
    ]);
  });

  const own = {
    LobbyChanged: () => 1,
    RunStarted: () => 2,
    WaitingChanged: () => 3,
    SeatFailed: () => 4,
  };
  const everyRun = {
    Score: () => 5,
    OfferOpened: () => 6,
    RunEnded: () => 7,
  };

  it("refuses cases that leave an event out, by type and when it is called", () => {
    const { SeatFailed: _, ...noFailure } = own;
    expect(() =>
      // @ts-expect-error -- the run's events have no cases: `run` is missing
      TestCoop.match(own)
    ).toThrow(
      'Coop "TestCoop" has no case under `run` for the run\'s event "OfferOpened". `match` takes one there for everything the simulation "TestGame" reports (OfferOpened, RunEnded, Score).'
    );
    expect(() =>
      TestCoop.match({
        ...own,
        // @ts-expect-error -- RunEnded has no case
        run: { Score: () => 5, OfferOpened: () => 6 },
      })
    ).toThrow(
      'Coop "TestCoop" has no case under `run` for the run\'s event "RunEnded". `match` takes one there for everything the simulation "TestGame" reports (OfferOpened, RunEnded, Score).'
    );
    expect(() =>
      // @ts-expect-error -- SeatFailed has no case
      TestCoop.match({ ...noFailure, run: everyRun })
    ).toThrow(
      'Coop "TestCoop" has no case for the event "SeatFailed". `match` takes a case for each of the Co-op client\'s own events (LobbyChanged, RunStarted, WaitingChanged, SeatFailed), and the run\'s under `run`.'
    );
  });

  // A case that no event reaches is dead code nobody is told about: one left behind by a
  // renamed event, or written in the wrong place. The types take it, so `match` refuses it when
  // it is called, which is as the app's module loads.
  it("refuses a case for an event that doesn't exist, when it is called", () => {
    expect(() =>
      TestCoop.match({ ...own, run: { ...everyRun, PlayerLeft: () => 8 } })
    ).toThrow(
      'Coop "TestCoop" has a case "PlayerLeft" under `run`, which the simulation "TestGame" doesn\'t report (OfferOpened, RunEnded, Score). Remove it, or name it after the event it handles.'
    );
    expect(() =>
      TestCoop.match({ ...own, RunStopped: () => 0, run: everyRun })
    ).toThrow(
      'Coop "TestCoop" has a case "RunStopped", which is none of the Co-op client\'s own events (LobbyChanged, RunStarted, WaitingChanged, SeatFailed). Remove it, or name it after the event it handles; a case for one of the run\'s events goes under `run`.'
    );
  });

  it("takes no case under `run` for a simulation that reports nothing, and says so", () => {
    class Quiet extends Game.Simulation("Quiet", {
      input: Game.PlayerInputs(Schema.Null),
      create: () => ({ steps: 0 }),
      step: () => {},
    }) {}
    class QuietEngine extends Game.Engine("QuietEngine", {
      simulation: Quiet,
      view: () => ({ render: () => {}, dispose: () => {} }),
      input: () => ({
        read: () => ({ players: [], leaving: [] }),
        dispose: () => {},
      }),
    }) {}
    class QuietCoop extends Coop("QuietCoop", {
      engine: QuietEngine,
      input: () => ({ read: () => null, dispose: () => {} }),
      content: Effect.succeed(null),
      picks: () => ["one"],
      config: () => undefined,
      hash: (state) => state.steps,
    }) {}
    const toNumber = QuietCoop.match({ ...own, run: {} });
    expect(toNumber(new Seat.RunStarted({ slot: 0, names: [] }))).toBe(2);
    expect(() =>
      QuietCoop.match({ ...own, run: { Stepped: () => 5 } })
    ).toThrow(
      'Coop "QuietCoop" has a case "Stepped" under `run`, which the simulation "Quiet" doesn\'t report: it reports nothing. Remove it, or name it after the event it handles.'
    );
    expect(() =>
      toNumber({
        _tag: "RunEvent",
        event: { _tag: "Stepped" } as never,
        local,
      })
    ).toThrow(
      'Coop "QuietCoop" has no case under `run` for the run\'s event "Stepped". `match` takes one there for everything the simulation "Quiet" reports.'
    );
  });

  it("refuses a case in the wrong place, and says where it goes", () => {
    const { RunEnded: ended, ...noEnd } = everyRun;
    const { SeatFailed: failed, ...noFailure } = own;
    expect(() =>
      // @ts-expect-error -- RunEnded's case is beside the client's own, so `run` lacks it
      TestCoop.match({ ...own, RunEnded: ended, run: noEnd })
    ).toThrow(
      'Coop "TestCoop" has a case "RunEnded" beside the Co-op client\'s own, and "RunEnded" is one of the run\'s events. Its case goes under `run`.'
    );
    expect(() =>
      // @ts-expect-error -- SeatFailed's case is under `run`, so the client's own lack it
      TestCoop.match({ ...noFailure, run: { ...everyRun, SeatFailed: failed } })
    ).toThrow(
      'Coop "TestCoop" has a case "SeatFailed" under `run`, and "SeatFailed" is one of the Co-op client\'s own events. Its case goes beside `run`, not under it.'
    );
  });

  it("still refuses an event its cases don't cover when one comes: one the simulation never declared", () => {
    const toNumber = TestCoop.match({ ...own, run: everyRun });
    const undeclared = { _tag: "Undeclared" } as unknown as TestEvent;
    expect(() => toNumber(heard(undeclared))).toThrow(
      'Coop "TestCoop" has no case under `run` for the run\'s event "Undeclared".'
    );
    expect(() =>
      toNumber({ _tag: "SeatMoved" } as unknown as Seat.SeatFailed)
    ).toThrow('Coop "TestCoop" has no case for the event "SeatMoved".');
  });
});

// What a `Coop` refuses: a type error first, then a throw as the game's module loads, for what
// a cast or plain JavaScript gets past the types.
describe("declaring a Coop", () => {
  const Move = Schema.Struct({ n: Schema.Number });
  class Counted extends Game.Event("Counted", { steps: Schema.Int }) {}
  class Elsewhere extends Game.Event("Elsewhere", { at: Schema.Int }) {}
  class Stepped extends Game.Event("Stepped", { steps: Schema.Int }) {}

  class Shared extends Game.Simulation("Shared", {
    input: Game.PlayerInputs(Move),
    events: [Counted],
    create: () => ({ steps: 0 }),
    step: (state) => {
      state.steps += 1;
    },
    sample: {
      event: Stepped,
      every: "100 millis",
      read: (state) => ({ steps: state.steps }),
    },
  }) {}
  class SharedEngine extends Game.Engine("SharedEngine", {
    simulation: Shared,
    view: () => ({ render: () => {}, dispose: () => {} }),
    input: () => ({
      read: () => ({ players: [], leaving: [] }),
      dispose: () => {},
    }),
  }) {}

  /** The rest of a definition over `SharedEngine`, with nothing to refuse. */
  const rest = {
    input: () => ({ read: () => ({ n: 1 }), dispose: () => {} }),
    content: Effect.succeed(null),
    picks: () => ["one"],
    config: () => undefined,
    hash: (state: { readonly steps: number }) => state.steps,
  };

  it("refuses an engine whose simulation one player plays", () => {
    class Solo extends Game.Simulation("Solo", {
      input: Move,
      create: () => ({ steps: 0 }),
      step: () => {},
    }) {}
    class SoloEngine extends Game.Engine("SoloEngine", {
      simulation: Solo,
      view: () => ({ render: () => {}, dispose: () => {} }),
      input: () => ({ read: () => ({ n: 1 }), dispose: () => {} }),
    }) {}
    expect(() =>
      // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
      Coop("SoloCoop", {
        // @ts-expect-error -- Solo's input was not declared with Game.PlayerInputs
        engine: SoloEngine,
        // @ts-expect-error -- so there is no one player's input to read
        input: () => ({ read: () => ({ n: 1 }), dispose: () => {} }),
        content: Effect.succeed(null),
        picks: () => ["one"],
        config: () => undefined,
        hash: () => 0,
      })
    ).toThrow(
      'Coop "SoloCoop" is declared with the engine "SoloEngine", whose simulation several players can\'t play. Simulation "Solo" can\'t seat several players: its `input` was not declared with Game.PlayerInputs. Declare `input: Game.PlayerInputs(OnePlayersInput)`, from the Schema of one player\'s input for one step.'
    );
  });

  it("refuses a players' input written by hand, which has no one-player Schema to read", () => {
    class ByHand extends Game.Simulation("ByHand", {
      input: Schema.Struct({
        players: Schema.Array(Schema.NullOr(Move)),
        leaving: Schema.Array(Schema.Int),
      }),
      create: () => ({ steps: 0 }),
      step: () => {},
    }) {}
    class ByHandEngine extends Game.Engine("ByHandEngine", {
      simulation: ByHand,
      view: () => ({ render: () => {}, dispose: () => {} }),
      input: () => ({
        read: () => ({ players: [], leaving: [] }),
        dispose: () => {},
      }),
    }) {}
    expect(() =>
      // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
      Coop("ByHandCoop", {
        // @ts-expect-error -- a struct with `players` and `leaving` is not a Game.PlayerInputs
        engine: ByHandEngine,
        // @ts-expect-error -- so there is no one player's input to read
        input: () => ({ read: () => ({ n: 1 }), dispose: () => {} }),
        content: Effect.succeed(null),
        picks: () => ["one"],
        config: () => undefined,
        hash: () => 0,
      })
    ).toThrow(
      'Coop "ByHandCoop" is declared with the engine "ByHandEngine", whose simulation several players can\'t play. Simulation "ByHand" can\'t seat several players'
    );
  });

  it("refuses an input source that reads the whole step's input: the engine's does that", () => {
    // oxlint-disable-next-line declaration/class -- declares what the types refuse; nothing is thrown, since a source is only made on attach.
    const declared = Coop("WholeStep", {
      ...rest,
      engine: SharedEngine,
      input: () => ({
        // @ts-expect-error -- one player's input is { n }, not { players, leaving }
        read: () => ({ players: [], leaving: [] }),
        dispose: () => {},
      }),
    });
    expect(declared.coopName).toBe("WholeStep");
  });

  it("refuses an `ends` entry the simulation doesn't report", () => {
    expect(() =>
      // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
      Coop("EndsElsewhere", {
        ...rest,
        engine: SharedEngine,
        // @ts-expect-error -- Elsewhere is not one of Shared's events
        ends: [Elsewhere],
      })
    ).toThrow(
      'Coop "EndsElsewhere" lists "Elsewhere" in `ends`, which the simulation "Shared" doesn\'t report. List the event a run ends with, one of the simulation\'s `events` (Counted).'
    );
  });

  it("refuses the simulation's sample in `ends`, which the types take for one of its events", () => {
    expect(() =>
      // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
      Coop("EndsAtOnce", { ...rest, engine: SharedEngine, ends: [Stepped] })
    ).toThrow(
      'Coop "EndsAtOnce" lists "Stepped" in `ends`, which is the sample of the simulation "Shared": a run reports it all the time, so every run would count as over at once. List the event a run ends with, one of the simulation\'s `events`.'
    );
  });

  it.each([1, 17, 2.5])(
    "refuses maxPlayers %s, a size no room has",
    (maxPlayers) => {
      expect(() =>
        // oxlint-disable-next-line declaration/class -- declares what the builder refuses, to read its message.
        Coop("Crowd", { ...rest, engine: SharedEngine, maxPlayers })
      ).toThrow(
        `Coop "Crowd" has maxPlayers ${maxPlayers}, a size no room has: a signalling room holds 2 to 16 players. Write a whole number from 2 to 16, or leave it out for 4.`
      );
    }
  );

  it("takes an `ends` entry the simulation reports, and every room size from 2 to 16", () => {
    // oxlint-disable-next-line declaration/class -- the same definition at each size, which a class statement can't loop over.
    const sizes = [2, 16].map(
      (maxPlayers) =>
        Coop("Sized", {
          ...rest,
          engine: SharedEngine,
          maxPlayers,
          ends: [Counted],
        }).coopName
    );
    expect(sizes).toStrictEqual(["Sized", "Sized"]);
  });
});
