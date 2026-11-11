import { Effect, Exit, Fiber, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachError, GameCrashed } from "../../runtime/browser";
import type { GameView } from "../../runtime/browser";
import { manualFrames } from "../../runtime/testing";
import type { TestState } from "../testing/index";
import type { CoopPresented } from "./coop-client";
import { testCoopClient, testCoopParts, testPresentation } from "./test-client";
import type { TestCoopClient } from "./test-client";

// Attaching and detaching in Node, with no browser, no room and no seat: the input and the view
// are fakes that count what is made and disposed, and the test runs the frames.

const element = {} as HTMLElement;

const fakeView = (
  parts: Partial<GameView<TestState>> = {}
): GameView<TestState> => ({
  render: () => {},
  dispose: () => {},
  ...parts,
});

const noRooms = {
  host: Effect.never,
  join: () => Effect.never,
};

let scope: Scope.Closeable;
/** How many inputs are made and not disposed. */
let inputs: number;
/** How many times the presentation Effect ran. */
let presentations: number;

const client = (
  frames: ReturnType<typeof manualFrames>,
  view: CoopPresented<TestState, unknown>["view"]
): TestCoopClient =>
  Effect.runSync(
    Scope.provide(
      testCoopClient(
        testCoopParts({
          presentation: Effect.sync(() => {
            presentations += 1;
            return testPresentation({
              input: () => {
                inputs += 1;
                return {
                  read: () => ({ add: 0 }),
                  dispose: () => {
                    inputs -= 1;
                  },
                };
              },
              view,
            });
          }),
        }),
        { rooms: noRooms, frames }
      ),
      scope
    )
  );

describe("attaching a co-op client", () => {
  beforeEach(() => {
    inputs = 0;
    presentations = 0;
    scope = Effect.runSync(Scope.make());
  });

  afterEach(() => {
    Effect.runSync(Scope.close(scope, Exit.void));
  });

  it("fails with an AttachError, leaving no input, when the view can't be made", async () => {
    const noWebGl = new Error("no WebGL");
    const coop = client(manualFrames(), () => {
      throw noWebGl;
    });
    const error = await Effect.runPromise(Effect.flip(coop.attach(element)));
    expect([error, inputs]).toStrictEqual([
      new AttachError({ message: "no WebGL", cause: noWebGl }),
      0,
    ]);
  });

  it("fails with an AttachError, disposing the view it made, when the input can't be made", async () => {
    const noPointer = new Error("no pointer");
    let views = 0;
    const coop = Effect.runSync(
      Scope.provide(
        testCoopClient(
          testCoopParts({
            presentation: Effect.succeed(
              testPresentation({
                input: () => {
                  throw noPointer;
                },
                view: () => {
                  views += 1;
                  return fakeView({
                    dispose: () => {
                      views -= 1;
                    },
                  });
                },
              })
            ),
          }),
          { rooms: noRooms, frames: manualFrames() }
        ),
        scope
      )
    );
    const error = await Effect.runPromise(Effect.flip(coop.attach(element)));
    expect([error, views]).toStrictEqual([
      new AttachError({ message: "no pointer", cause: noPointer }),
      0,
    ]);
  });

  it("draws no run on each frame until detached, then cancels its frame and releases the input", async () => {
    const frames = manualFrames();
    const drawn: [TestState | null, number][] = [];
    const coop = client(frames, (_container, { local }) =>
      fakeView({
        render: (state, seconds) => drawn.push([state, seconds + local.slot]),
      })
    );
    const attach = Effect.runFork(coop.attach(element));
    await Effect.runPromise(Effect.yieldNow);
    const attached = inputs;
    frames.runFrameAt(500);
    frames.runFrameAt(1000);
    await Effect.runPromise(Fiber.interrupt(attach));
    expect([attached, drawn, frames.waiting(), inputs]).toStrictEqual([
      1,
      [
        [null, 0.5],
        [null, 1],
      ],
      false,
      0,
    ]);
  });

  it("runs the presentation once per attach, then makes the view, then the input, as an engine does", async () => {
    const order: string[] = [];
    const coop = client(manualFrames(), () => {
      order.push(`view after ${presentations} presentation, ${inputs} input`);
      return fakeView();
    });
    for (let i = 0; i < 2; i++) {
      const attach = Effect.runFork(coop.attach(element));
      // oxlint-disable-next-line no-await-in-loop -- one attach at a time.
      await Effect.runPromise(Effect.yieldNow);
      // oxlint-disable-next-line no-await-in-loop -- one attach at a time.
      await Effect.runPromise(Fiber.interrupt(attach));
    }
    expect(order).toStrictEqual([
      "view after 1 presentation, 0 input",
      "view after 2 presentation, 0 input",
    ]);
  });

  it("releases the input and can attach again when the view's dispose throws", async () => {
    const views: GameView<TestState>[] = [];
    const coop = client(manualFrames(), () => {
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
    });
    const first = Effect.runFork(coop.attach(element));
    await Effect.runPromise(Effect.yieldNow);
    const detached = await Effect.runPromise(
      Fiber.interrupt(first).pipe(Effect.andThen(Fiber.await(first)))
    );
    const afterFirst = inputs;
    const second = Effect.runFork(coop.attach(element));
    await Effect.runPromise(Effect.yieldNow);
    await Effect.runPromise(Fiber.interrupt(second));
    expect([
      Exit.hasDies(detached),
      afterFirst,
      views.length,
      inputs,
    ]).toStrictEqual([true, 0, 2, 0]);
  });

  it("crashes with GameCrashed when a frame throws, asking for no other frame, with nothing left attached", async () => {
    const frames = manualFrames();
    const bug = new Error("lost context");
    let renders = 0;
    const coop = client(frames, () =>
      fakeView({
        render: () => {
          renders += 1;
          if (renders === 2) {
            throw bug;
          }
        },
      })
    );
    const attach = Effect.runFork(coop.attach(element));
    await Effect.runPromise(Effect.yieldNow);
    frames.runFrameAt(16);
    frames.runFrameAt(33);
    frames.runFrameAt(50);
    const exit = await Effect.runPromise(Fiber.await(attach));
    expect([exit, renders, frames.waiting(), inputs]).toStrictEqual([
      Exit.fail(new GameCrashed({ message: "lost context", cause: bug })),
      2,
      false,
      0,
    ]);
  });

  it("dies when attached twice at once", async () => {
    const coop = client(manualFrames(), () => fakeView());
    const first = Effect.runFork(coop.attach(element));
    await Effect.runPromise(Effect.yieldNow);
    const second = await Effect.runPromise(Effect.exit(coop.attach(element)));
    await Effect.runPromise(Fiber.interrupt(first));
    expect([Exit.hasDies(second), inputs]).toStrictEqual([true, 0]);
  });
});
