import { Cause, Effect, Exit, Fiber, Option, Result, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachError, GameCrashed } from "../../game/browser";
import type { View as GameView } from "../../game/browser";
import { ManualFrames } from "../../game/testing/index";
import type { TestGame } from "../testing/index";
import { CoopRooms } from "./index";
import type { CoopPresented } from "./internal/coop-client";
import {
  testCoopClient,
  testCoopParts,
  testPresentation,
} from "./internal/test-client";
import type { TestCoopClient } from "./internal/test-client";

/**
 * The reasons an exit failed with, each a `Fail`'s error or the reason itself. The frame loop the
 * client draws on is traced, so a crash carries its span as an annotation, which this leaves out.
 */
const failures = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? "succeeded"
    : exit.cause.reasons.map((reason) =>
        Cause.isFailReason(reason) ? reason.error : reason
      );

// Attaching and detaching in Node, with no browser, no room and no seat: the input and the view
// are fakes that count what is made and disposed, and the test runs the frames.

const element = {} as HTMLElement;

const fakeView = (
  parts: Partial<GameView<TestGame.State>> = {}
): GameView<TestGame.State> => ({
  render: () => {},
  dispose: () => {},
  ...parts,
});

const noRooms = CoopRooms.make({
  host: Effect.never,
  join: () => Effect.never,
});

let scope: Scope.Closeable;
/** How many inputs are made and not disposed. */
let inputs: number;
/** How many times the presentation Effect ran. */
let presentations: number;

const client = (
  frames: ManualFrames.ManualFrames,
  view: CoopPresented<TestGame.State, unknown>["view"]
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
    const coop = client(ManualFrames.make(), () => {
      throw noWebGl;
    });
    const error = await Effect.runPromise(Effect.flip(coop.attach(element)));
    expect([error, inputs]).toStrictEqual([
      new AttachError({ message: "no WebGL", cause: noWebGl }),
      0,
    ]);
    // A tagged error's `message` and `cause` aren't enumerable, so the comparison above holds
    // the error's class and neither of them.
    expect(error).toMatchObject({ _tag: "AttachError", message: "no WebGL" });
    expect(error.cause).toBe(noWebGl);
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
          { rooms: noRooms, frames: ManualFrames.make() }
        ),
        scope
      )
    );
    const error = await Effect.runPromise(Effect.flip(coop.attach(element)));
    expect([error, views]).toStrictEqual([
      new AttachError({ message: "no pointer", cause: noPointer }),
      0,
    ]);
    // As above: the message and the cause, on the error itself.
    expect(error).toMatchObject({
      _tag: "AttachError",
      message: "no pointer",
    });
    expect(error.cause).toBe(noPointer);
  });

  it("draws no run on each frame until detached, then cancels its frame and releases the input", async () => {
    const frames = ManualFrames.make();
    const drawn: [TestGame.State | null, number][] = [];
    const coop = client(frames, (_container, { local }) =>
      fakeView({
        render: (state, seconds) => drawn.push([state, seconds + local.slot]),
      })
    );
    const attach = Effect.runFork(coop.attach(element));
    await Effect.runPromise(Effect.yieldNow);
    const attached = inputs;
    ManualFrames.runFrameAt(frames, 500);
    ManualFrames.runFrameAt(frames, 1000);
    await Effect.runPromise(Fiber.interrupt(attach));
    expect([
      attached,
      drawn,
      ManualFrames.waiting(frames),
      inputs,
    ]).toStrictEqual([
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
    const coop = client(ManualFrames.make(), () => {
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
    const views: GameView<TestGame.State>[] = [];
    const coop = client(ManualFrames.make(), () => {
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
    const frames = ManualFrames.make();
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
    ManualFrames.runFrameAt(frames, 16);
    ManualFrames.runFrameAt(frames, 33);
    ManualFrames.runFrameAt(frames, 50);
    const exit = await Effect.runPromise(Fiber.await(attach));
    expect([
      failures(exit),
      renders,
      ManualFrames.waiting(frames),
      inputs,
    ]).toStrictEqual([
      [new GameCrashed({ message: "lost context", cause: bug })],
      2,
      false,
      0,
    ]);
    // As above: the message and the cause, on the error itself.
    const error = Option.getOrUndefined(Exit.findErrorOption(exit));
    expect(error).toMatchObject({
      _tag: "GameCrashed",
      message: "lost context",
    });
    expect(error?.cause).toBe(bug);
  });

  it("dies when attached twice at once", async () => {
    const coop = client(ManualFrames.make(), () => fakeView());
    const first = Effect.runFork(coop.attach(element));
    await Effect.runPromise(Effect.yieldNow);
    const second = await Effect.runPromise(Effect.exit(coop.attach(element)));
    await Effect.runPromise(Fiber.interrupt(first));
    // The defect names the Coop and says what to do. The second attach made nothing.
    expect([
      Result.map(
        Exit.findDefect(second),
        (defect) => (defect as Error).message
      ),
      inputs,
    ]).toStrictEqual([
      Result.succeed(
        'Coop "TestCoop" is already attached to an element. Its Co-op client draws into one element at a time: interrupt the first attach, which detaches without leaving, before attaching again.'
      ),
      0,
    ]);
  });
});
