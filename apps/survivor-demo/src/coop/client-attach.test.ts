import { AttachError, GameCrashed } from "@arcadekit/runtime/browser";
import type { GameView } from "@arcadekit/runtime/browser";
import { manualFrames } from "@arcadekit/runtime/testing";
import type { World } from "@arcadekit/survivors";
import type { SurvivorsArt } from "@arcadekit/survivors/browser";
import { Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeCoopClient } from "./client";
import type { CoopClient, CoopClientOptions } from "./client";

// Attaching and detaching in Node, with no browser and no room: an EventTarget stands in for
// the window and for the surface, so the input controller's listeners can be counted, the view
// is a fake, and the test runs the frames.

/** An EventTarget that counts the listeners on it. */
const countingTarget = () => {
  const target = new EventTarget();
  let listening = 0;
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (...args: Parameters<typeof add>) => {
    listening += 1;
    add(...args);
  };
  target.removeEventListener = (...args: Parameters<typeof remove>) => {
    listening -= 1;
    remove(...args);
  };
  return { target, listening: () => listening };
};

const art = {} as SurvivorsArt;

const fakeView = (parts: Partial<GameView<World>> = {}): GameView<World> => ({
  render: () => {},
  dispose: () => {},
  ...parts,
});

const noRooms = {
  host: Effect.never,
  join: () => Effect.never,
};

let window: ReturnType<typeof countingTarget>;
let surface: ReturnType<typeof countingTarget>;
let element: HTMLElement;
let scope: Scope.Closeable;

const client = (options: Partial<CoopClientOptions>): CoopClient =>
  Effect.runSync(
    Scope.provide(
      makeCoopClient({ rooms: noRooms, content: Effect.never, ...options }),
      scope
    )
  );

const listening = () => [window.listening(), surface.listening()];

describe("attaching a co-op client", () => {
  beforeEach(() => {
    window = countingTarget();
    surface = countingTarget();
    element = Object.assign(surface.target, {
      style: {},
    }) as unknown as HTMLElement;
    vi.stubGlobal("window", window.target);
    scope = Effect.runSync(Scope.make());
  });

  afterEach(() => {
    Effect.runSync(Scope.close(scope, Exit.void));
    vi.unstubAllGlobals();
  });

  it("fails with an AttachError, leaving no input listening, when the view can't be made", async () => {
    const noWebGl = new Error("no WebGL");
    const coop = client({
      frames: manualFrames(),
      createView: () => {
        throw noWebGl;
      },
    });
    const error = await Effect.runPromise(
      Effect.flip(coop.attach(element, art))
    );
    expect([error, listening()]).toStrictEqual([
      new AttachError({ message: "no WebGL", cause: noWebGl }),
      [0, 0],
    ]);
  });

  it("draws on each frame until detached, then cancels its frame and releases the input", async () => {
    const frames = manualFrames();
    const drawn: number[] = [];
    const coop = client({
      frames,
      createView: () =>
        fakeView({ render: (_state, seconds) => drawn.push(seconds) }),
    });
    const attach = Effect.runFork(coop.attach(element, art));
    await Effect.runPromise(Effect.yieldNow);
    const attached = listening();
    frames.runFrameAt(500);
    frames.runFrameAt(1000);
    await Effect.runPromise(Fiber.interrupt(attach));
    expect([attached, drawn, frames.waiting(), listening()]).toStrictEqual([
      [3, 4],
      [0.5, 1],
      false,
      [0, 0],
    ]);
  });

  it("releases the input and can attach again when the view's dispose throws", async () => {
    const views: GameView<World>[] = [];
    const coop = client({
      frames: manualFrames(),
      createView: () => {
        const view = fakeView(
          views.length === 0
            ? {
                dispose: () => {
                  throw new Error("lost context");
                },
              }
            : {}
        );
        views.push(view);
        return view;
      },
    });
    const first = Effect.runFork(coop.attach(element, art));
    await Effect.runPromise(Effect.yieldNow);
    const detached = await Effect.runPromise(
      Fiber.interrupt(first).pipe(Effect.andThen(Fiber.await(first)))
    );
    const afterFirst = listening();
    const second = Effect.runFork(coop.attach(element, art));
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Fiber.interrupt(second));
    expect([
      Exit.hasDies(detached),
      afterFirst,
      views.length,
      listening(),
    ]).toStrictEqual([true, [0, 0], 2, [0, 0]]);
  });

  it("crashes with GameCrashed when a frame throws, asking for no other frame, with nothing left attached", async () => {
    const frames = manualFrames();
    const bug = new Error("lost context");
    let renders = 0;
    const coop = client({
      frames,
      createView: () =>
        fakeView({
          render: () => {
            renders += 1;
            if (renders === 2) {
              throw bug;
            }
          },
        }),
    });
    const attach = Effect.runFork(coop.attach(element, art));
    await Effect.runPromise(Effect.yieldNow);
    frames.runFrameAt(16);
    frames.runFrameAt(33);
    frames.runFrameAt(50);
    const exit = await Effect.runPromise(Fiber.await(attach));
    expect([exit, renders, frames.waiting(), listening()]).toStrictEqual([
      Exit.fail(new GameCrashed({ message: "lost context", cause: bug })),
      2,
      false,
      [0, 0],
    ]);
  });

  it("dies when attached twice at once", async () => {
    const coop = client({
      frames: manualFrames(),
      createView: () => fakeView(),
    });
    const first = Effect.runFork(coop.attach(element, art));
    await Effect.runPromise(Effect.yieldNow);
    const second = await Effect.runPromise(
      Effect.exit(coop.attach(element, art))
    );
    await Effect.runPromise(Fiber.interrupt(first));
    expect([Exit.hasDies(second), listening()]).toStrictEqual([true, [0, 0]]);
  });
});
