import { readFileSync } from "node:fs";

import { survivorsContentDefinition } from "@arcadekit/survivors";
import type { GameContent, World } from "@arcadekit/survivors";
import type { SurvivorsArt } from "@arcadekit/survivors/browser";
import { ContentError, loadContent } from "arcadekit/content";
import type { ContentSource } from "arcadekit/content";
import { RoomError } from "arcadekit/net/browser";
import type {
  PeerLink,
  RoomEvent,
  SignallingRoom,
  TextChannel,
} from "arcadekit/net/browser";
import { GameCrashed } from "arcadekit/runtime/browser";
import type { GameView } from "arcadekit/runtime/browser";
import { manualFrames } from "arcadekit/runtime/testing";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Queue,
  Scheduler,
  Scope,
  Stream,
} from "effect";
import type { Cause } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeCoopClient } from "./client";
import type { CoopClientOptions, CoopEvent, CoopRooms } from "./client";
import { canStart } from "./lobby";
import { workerTicker } from "./ticker";

// The co-op client in Node, with no browser: a fake signalling hub links the host to each guest
// with in-memory channels that keep what arrives until something listens, as the WebRTC ones
// do, and fake timers drive the clients' tickers. Nothing is attached unless a test attaches
// it, so the local input stands still.
//
// Each client is made as the app makes it, on a Clock and a Scheduler of the test's: the Clock
// reads the faked `performance.now()` (Effect's own reads `process.hrtime` in Node, which fake
// timers don't reach), and the Scheduler runs fibers on microtasks, as Foldkit's does in the
// browser, so no fiber waits on a real `setImmediate`.

const contentDir = new URL("../../public/content/", import.meta.url);
const fileSource: ContentSource = (file) =>
  Effect.try({
    try: () =>
      JSON.parse(readFileSync(new URL(file, contentDir), "utf-8")) as unknown,
    catch: (cause) => new ContentError({ message: String(cause) }),
  });

const content: GameContent = await Effect.runPromise(
  loadContent({ ...survivorsContentDefinition, source: fileSource })
);

const nanos = (ms: number) => BigInt(Math.round(ms * 1_000_000));

/** Effect's Clock on the page's timers, which the tests fake. */
const performanceClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => nanos(Date.now()),
  currentTimeNanos: Effect.sync(() => nanos(Date.now())),
  monotonicTimeNanosUnsafe: () => nanos(performance.now()),
  monotonicTimeNanos: Effect.sync(() => nanos(performance.now())),
  sleep: (duration) =>
    Effect.callback((resume) => {
      const timer = setTimeout(
        () => resume(Effect.void),
        Duration.toMillis(duration)
      );
      return Effect.sync(() => clearTimeout(timer));
    }),
};

/** Runs fibers on microtasks, as Foldkit's browser scheduler does. */
const microtasks = new Scheduler.MixedScheduler("async", (task) => {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) {
      task();
    }
  });
  return () => {
    cancelled = true;
  };
});

interface End {
  readonly channel: TextChannel;
  readonly deliver: (text: string) => void;
}

/** One end of an in-memory pipe, sending to `other()`, a microtask later as a network would. */
const end = (other: () => End): End => {
  const handlers = new Set<(text: string) => void>();
  let early: string[] | null = [];
  return {
    channel: {
      send: (text) => queueMicrotask(() => other().deliver(text)),
      listen: (handler) => {
        handlers.add(handler);
        for (const text of early ?? []) {
          handler(text);
        }
        early = null;
        return () => handlers.delete(handler);
      },
      onClose: () => () => {},
      isOpen: () => true,
    },
    deliver: (text) => {
      if (early === null) {
        for (const handler of handlers) {
          handler(text);
        }
      } else {
        early.push(text);
      }
    },
  };
};

/** Both ends of one in-memory pipe. */
const pipe = (): [TextChannel, TextChannel] => {
  const a: End = end(() => b);
  const b: End = end(() => a);
  return [a.channel, b.channel];
};

interface FakeRoom {
  readonly room: SignallingRoom;
  readonly link: (link: PeerLink) => void;
  readonly started: () => void;
}

/**
 * A signalling worker and WebRTC in one: rooms whose peers link the moment a guest joins.
 * `log` records each room opened and released; `content` holds every client's content load.
 */
const fakeHub = () => {
  const CODE = "K7MQ2X";
  const log: string[] = [];
  let host: FakeRoom | null = null;
  const guests: FakeRoom[] = [];

  // A room as the scope of whoever opens it owns it, so the test sees it released.
  const fakeRoom = (
    role: "host" | "guest",
    self: string
  ): Effect.Effect<FakeRoom, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<
          RoomEvent,
          RoomError | Cause.Done
        >();
        const links: PeerLink[] = [];
        // A microtask later, as the room's own fiber would.
        const report = (event: RoomEvent, last = false) =>
          queueMicrotask(() => {
            Queue.offerUnsafe(events, event);
            if (last) {
              Queue.endUnsafe(events);
            }
          });
        log.push(`open ${self}`);
        return {
          room: {
            role,
            code: CODE,
            self,
            host: "host",
            events: Stream.fromQueue(events),
            links: () => [...links],
            start: Effect.sync(() => {
              for (const peer of [host!, ...guests]) {
                peer.started();
              }
            }),
          },
          link: (link: PeerLink) => {
            links.push(link);
            report({ type: "peer-connected", peer: link.peer, link });
          },
          started: () => report({ type: "started" }, true),
        };
      }),
      () => Effect.sync(() => log.push(`release ${self}`))
    );

  const rooms: CoopRooms = {
    host: fakeRoom("host", "host").pipe(
      Effect.map((made) => {
        host = made;
        return made.room;
      })
    ),
    join: (code) =>
      Effect.suspend(() => {
        expect(code).toBe(CODE);
        return fakeRoom("guest", `guest-${guests.length + 1}`);
      }).pipe(
        Effect.map((guest) => {
          guests.push(guest);
          const [hostLockstep, guestLockstep] = pipe();
          const [hostMessages, guestMessages] = pipe();
          host!.link({
            peer: guest.room.self,
            lockstep: hostLockstep,
            messages: hostMessages,
            closed: Effect.never,
          });
          guest.link({
            peer: "host",
            lockstep: guestLockstep,
            messages: guestMessages,
            closed: Effect.never,
          });
          return guest.room;
        })
      ),
  };
  return { rooms, log };
};

let scope: Scope.Closeable;

/** Runs `effect` as the app does: in the app's scope, on the test's Clock and Scheduler. */
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Scope.provide(scope),
      Effect.provideService(Clock.Clock, performanceClock),
      Effect.provideService(Scheduler.Scheduler, microtasks)
    )
  );

const client = async (
  hub: ReturnType<typeof fakeHub>,
  options: Partial<CoopClientOptions> = {}
) => {
  const events: CoopEvent[] = [];
  const coop = await run(
    Effect.gen(function* () {
      const made = yield* makeCoopClient({
        rooms: hub.rooms,
        content: Effect.succeed(content),
        ...options,
      });
      yield* made.listen((event) => events.push(event));
      return made;
    })
  );
  return { coop, events };
};

const started = (events: readonly CoopEvent[]) =>
  events.find((event) => event.type === "started");

const ended = (events: readonly CoopEvent[]) =>
  events.some((event) => event.type === "runEnded");

const lastLobby = (events: readonly CoopEvent[]) =>
  events.findLast((event) => event.type === "lobby");

/** Lets queued microtasks run, at the current fake time. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

/** A host and a guest in one lobby, the guest playing `ember`. */
const lobbyOfTwo = async (
  hub: ReturnType<typeof fakeHub>,
  options: Partial<CoopClientOptions> = {}
) => {
  const host = await client(hub, options);
  const guest = await client(hub, options);
  await run(host.coop.host("spark"));
  await settle();
  await run(guest.coop.join("K7MQ2X", "ember"));
  await settle();
  return { host, guest };
};

describe("a co-op run", () => {
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

  it("gathers a lobby, starts everyone with their heroes and steps the same run", async () => {
    const hub = fakeHub();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(guest.coop.chooseHero("tide"));
    await settle();
    const lobby = {
      type: "lobby",
      code: "K7MQ2X",
      players: [
        { id: "host", heroId: "spark" },
        { id: "guest-1", heroId: "tide" },
      ],
    };
    const hostLobby = lastLobby(host.events);
    expect([
      hostLobby?.type === "lobby" && canStart(hostLobby.players),
      hostLobby,
      lastLobby(guest.events),
    ]).toMatchObject([
      true,
      { ...lobby, role: "host", self: "host" },
      { ...lobby, role: "guest", self: "guest-1" },
    ]);

    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(5000);
    const [hostRun, guestRun] = [host.coop.debug(), guest.coop.debug()];
    expect([started(host.events), started(guest.events)]).toStrictEqual([
      { type: "started", slot: 0, players: ["Host", "Guest 1"] },
      { type: "started", slot: 1, players: ["Host", "Guest 1"] },
    ]);
    // Both stepped most of the 5 s, and agree on the state at every step both hashed.
    const common = Object.keys(hostRun.hashes).filter(
      (step) => step in guestRun.hashes
    );
    expect([
      hostRun.error,
      guestRun.error,
      hostRun.stepIndex > 200,
      common.length > 2,
      common.map((step) => hostRun.hashes[Number(step)]),
    ]).toStrictEqual([
      null,
      null,
      true,
      true,
      common.map((step) => guestRun.hashes[Number(step)]),
    ]);
  });

  it("shows who it waits on, then stops with a clear error when the host goes quiet", async () => {
    const hub = fakeHub();
    const { host, guest } = await lobbyOfTwo(hub);
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    await run(host.coop.leave);
    await vi.advanceTimersByTimeAsync(12_000);
    const waited = guest.events.some(
      (event) => event.type === "waiting" && event.waitingFor.includes("Host")
    );
    expect([waited, guest.events.at(-1)]).toStrictEqual([
      true,
      {
        type: "failed",
        message: "Lost the host: nothing heard for 10 s. The run is over.",
      },
    ]);
  });

  it("closes the room and the worker before it reports a run that stopped", async () => {
    const hub = fakeHub();
    const ticker = Effect.acquireRelease(workerTicker({ everyMs: 4 }), () =>
      Effect.sync(() => hub.log.push("release worker"))
    );
    const { host, guest } = await lobbyOfTwo(hub, { ticker });
    await run(
      guest.coop.listen((event) => {
        if (event.type === "failed") {
          hub.log.push("failed");
        }
      })
    );
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    await run(host.coop.leave);
    const left = hub.log.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(hub.log.slice(left)).toStrictEqual([
      "release worker",
      "release guest-1",
      "failed",
    ]);
  });

  it("keeps the summary when the others leave a run that has ended", async () => {
    const short: GameContent = {
      ...content,
      rules: { ...content.rules, runLength: 1 },
    };
    const hub = fakeHub();
    const { host, guest } = await lobbyOfTwo(hub, {
      content: Effect.succeed(short),
    });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(3000);
    expect([ended(host.events), ended(guest.events)]).toStrictEqual([
      true,
      true,
    ]);
    await run(host.coop.leave);
    await vi.advanceTimersByTimeAsync(12_000);
    // The guest's session lost the host, but the run had ended: no failure, no waiting banner,
    // and its room closed as it stopped.
    const afterEnd = guest.events.slice(
      guest.events.findIndex((event) => event.type === "runEnded")
    );
    expect([
      guest.coop.debug().error,
      afterEnd
        .filter((event) => event.type !== "hud")
        .map((event) => event.type),
      hub.log.filter((line) => line.endsWith("guest-1")),
    ]).toStrictEqual([
      "Lost the host host: nothing heard for 10000 ms",
      ["runEnded"],
      ["open guest-1", "release guest-1"],
    ]);
  });
});

describe("hosting, joining and leaving", () => {
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

  it("opens no room when the player leaves while the content still loads", async () => {
    const hub = fakeHub();
    const loaded = Effect.runSync(Deferred.make<GameContent, ContentError>());
    const { coop, events } = await client(hub, {
      content: Deferred.await(loaded),
    });
    await run(coop.host("spark"));
    await settle();
    await run(coop.leave);
    Effect.runSync(Deferred.succeed(loaded, content));
    await settle();
    expect([hub.log, events]).toStrictEqual([[], []]);
  });

  it("closes the room it hosted as it hosts the next, whose lobby alone is reported", async () => {
    const hub = fakeHub();
    const { coop, events } = await client(hub);
    await run(coop.host("spark"));
    await settle();
    await run(coop.host("ember"));
    const atSwap = [...hub.log];
    await settle();
    // The next room opens first, then the one before it closes, before `host` returns.
    expect([atSwap, hub.log, events.map((event) => event.type)]).toStrictEqual([
      ["open host", "open host", "release host"],
      ["open host", "open host", "release host"],
      ["lobby", "lobby"],
    ]);
    expect(lastLobby(events)).toMatchObject({
      players: [{ id: "host", heroId: "ember" }],
    });
  });

  it("closes the room, the session and the worker when the player leaves the run", async () => {
    const hub = fakeHub();
    const tickers: string[] = [];
    // The default ticker, with its release seen.
    const ticker = Effect.acquireRelease(workerTicker({ everyMs: 4 }), () =>
      Effect.sync(() => tickers.push("released"))
    ).pipe(Effect.tap(() => Effect.sync(() => tickers.push("made"))));
    const { host, guest } = await lobbyOfTwo(hub, { ticker });
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    const stepping = guest.coop.debug().stepIndex > 30;
    await run(guest.coop.leave);
    const afterLeave = guest.coop.debug();
    const quiet = guest.events.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect([
      stepping,
      hub.log.filter((line) => line.endsWith("guest-1")),
      tickers,
      afterLeave,
      guest.events.length - quiet,
    ]).toStrictEqual([
      true,
      ["open guest-1", "release guest-1"],
      ["made", "made", "released"],
      { stepIndex: 0, error: null, hashes: {} },
      0,
    ]);
  });

  it("reports a room that can't be opened, and content that can't be loaded", async () => {
    const unreachable = new RoomError({
      reason: "unreachable",
      message: "Couldn't reach the signalling server at ws://unused.",
    });
    const hub = fakeHub();
    const offline = await client(hub, {
      rooms: { ...hub.rooms, host: Effect.fail(unreachable) },
    });
    const broken = await client(hub, {
      content: Effect.fail(new ContentError({ message: "heroes.json: 404" })),
    });
    await run(offline.coop.host("spark"));
    await run(broken.coop.join("K7MQ2X", "spark"));
    await settle();
    expect([offline.events, broken.events, hub.log]).toStrictEqual([
      [{ type: "failed", message: unreachable.message }],
      [{ type: "failed", message: "heroes.json: 404" }],
      [],
    ]);
  });

  it("reports a bug in a seat as its failure, and logs it", async () => {
    const hub = fakeHub();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { coop, events } = await client(hub, {
      content: Effect.die(new Error("no heroes")),
    });
    await run(coop.host("spark"));
    await settle();
    expect([events, logged.mock.calls.length > 0]).toStrictEqual([
      [{ type: "failed", message: "Co-op stopped on a bug: no heroes" }],
      true,
    ]);
    logged.mockRestore();
  });

  it("reports a bug in its room as its failure, and logs it", async () => {
    const hub = fakeHub();
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const buggy: SignallingRoom = {
      role: "host",
      code: "K7MQ2X",
      self: "host",
      host: "host",
      events: Stream.die(new Error("room bug")),
      links: () => [],
      start: Effect.void,
    };
    const { coop, events } = await client(hub, {
      rooms: { ...hub.rooms, host: Effect.succeed(buggy) },
    });
    await run(coop.host("spark"));
    await settle();
    expect([
      events.map((event) => event.type),
      events.at(-1),
      logged.mock.calls.length > 0,
    ]).toStrictEqual([
      ["lobby", "failed"],
      { type: "failed", message: "Co-op stopped on a bug: room bug" },
      true,
    ]);
    logged.mockRestore();
  });

  it("fails a guest whose link to the host closes after the start, before the host's start message", async () => {
    const hub = fakeHub();
    // The host dropped this guest at the start: its room started, then its link closed.
    const hostLeft = Effect.runSync(Deferred.make<undefined>());
    const [, lockstep] = pipe();
    const [, messages] = pipe();
    const link: PeerLink = {
      peer: "host",
      lockstep,
      messages,
      closed: Deferred.await(hostLeft),
    };
    const dropped: SignallingRoom = {
      role: "guest",
      code: "K7MQ2X",
      self: "guest-1",
      host: "host",
      events: Stream.make(
        { type: "peer-connected", peer: "host", link },
        { type: "started" }
      ),
      links: () => [link],
      start: Effect.void,
    };
    const { coop, events } = await client(hub, {
      rooms: { ...hub.rooms, join: () => Effect.succeed(dropped) },
    });
    await run(coop.join("K7MQ2X", "ember"));
    await settle();
    const beforeClose = events.map((event) => event.type);
    Effect.runSync(Deferred.succeed(hostLeft, undefined));
    await settle();
    expect([beforeClose, events.at(-1)]).toStrictEqual([
      ["lobby"],
      { type: "failed", message: "Lost the host before the run started." },
    ]);
  });

  it("refuses to start a lobby of one, or a guest's start", async () => {
    const hub = fakeHub();
    const host = await client(hub);
    await run(host.coop.host("spark"));
    await settle();
    await run(host.coop.start);
    await settle();
    const alone = started(host.events);
    const guest = await client(hub);
    await run(guest.coop.join("K7MQ2X", "ember"));
    await settle();
    await run(guest.coop.start);
    await vi.advanceTimersByTimeAsync(1000);
    expect([alone, started(host.events), started(guest.events)]).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("drawing a co-op run", () => {
  const art = {} as SurvivorsArt;
  const element = Object.assign(new EventTarget(), {
    style: {},
  }) as unknown as HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "performance"],
    });
    vi.stubGlobal("window", new EventTarget());
    scope = Effect.runSync(Scope.make());
  });

  afterEach(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A guest attached on frames the test runs, making its views with `createView`. */
  const attachedGuest = async (
    createView: (localHero: number) => GameView<World>
  ) => {
    const frames = manualFrames();
    const hub = fakeHub();
    const { host, guest } = await lobbyOfTwo(hub, {
      frames,
      createView: (_element, _art, localHero) => createView(localHero),
    });
    const attach = Effect.runFork(guest.coop.attach(element, art));
    await settle();
    await run(host.coop.start);
    await vi.advanceTimersByTimeAsync(500);
    return { frames, attach, guest };
  };

  it("draws from the guest's own hero once the run starts", async () => {
    const views: string[] = [];
    const drawn: (World | null)[] = [];
    const { frames, attach } = await attachedGuest((localHero) => {
      views.push(`make ${localHero}`);
      return {
        render: (state) => drawn.push(state),
        dispose: () => views.push(`dispose ${localHero}`),
      };
    });
    frames.runFrameAt(600);
    await Effect.runPromise(Fiber.interrupt(attach));
    expect([views, drawn.at(-1)?.heroes.length]).toStrictEqual([
      ["make 0", "dispose 0", "make 1", "dispose 1"],
      2,
    ]);
  });

  it("crashes, with nothing left attached, when the view can't be made again for the run", async () => {
    const { frames, attach } = await attachedGuest((localHero) => {
      if (localHero === 1) {
        throw new Error("lost context");
      }
      return { render: () => {}, dispose: () => {} };
    });
    frames.runFrameAt(600);
    const exit = await Effect.runPromise(Fiber.await(attach));
    expect([Exit.isFailure(exit), frames.waiting()]).toStrictEqual([
      true,
      false,
    ]);
    expect(exit).toMatchObject(
      Exit.fail(
        new GameCrashed({
          message: "lost context",
          cause: new Error("lost context"),
        })
      )
    );
  });
});
