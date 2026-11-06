import type { SignallingRoom } from "@arcadekit/net/browser";
import type { GameView } from "@arcadekit/runtime/browser";
import type { GameContent, World } from "@arcadekit/survivors";
import type { SurvivorsArt } from "@arcadekit/survivors/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoopClient } from "./client";

// Attaching and detaching in Node, with no browser: an EventTarget stands in for the window and
// for the surface, so the input controller's listeners can be counted, and the view is a fake.

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

const fakeView = (dispose: () => void = () => {}): GameView<World> => ({
  render: () => {},
  dispose,
});

let window: ReturnType<typeof countingTarget>;
let surface: ReturnType<typeof countingTarget>;
let element: HTMLElement;

describe("attaching a co-op client", () => {
  beforeEach(() => {
    window = countingTarget();
    surface = countingTarget();
    element = Object.assign(surface.target, {
      style: {},
    }) as unknown as HTMLElement;
    vi.stubGlobal("window", window.target);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves no input listening when the view can't be made", () => {
    const coop = new CoopClient({
      signalling: { url: "ws://unused" },
      createView: () => {
        throw new Error("no WebGL");
      },
    });
    expect(() => coop.attach(element, art)).toThrow("no WebGL");
    expect([window.listening(), surface.listening()]).toStrictEqual([0, 0]);
  });

  it("releases the input and can attach again when the view's dispose throws", () => {
    const views: GameView<World>[] = [];
    const coop = new CoopClient({
      signalling: { url: "ws://unused" },
      createView: () => {
        const view = fakeView(
          views.length === 0
            ? () => {
                throw new Error("lost context");
              }
            : undefined
        );
        views.push(view);
        return view;
      },
    });
    const detach = coop.attach(element, art);
    expect(detach).toThrow("lost context");
    expect([window.listening(), surface.listening()]).toStrictEqual([0, 0]);
    coop.attach(element, art)();
    expect([
      views.length,
      window.listening(),
      surface.listening(),
    ]).toStrictEqual([2, 0, 0]);
  });

  it("leaves nothing attached when the view can't be made again for a new run", () => {
    let disposed = 0;
    let made = 0;
    const cancelled: number[] = [];
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => {
      cancelled.push(frame);
    });
    // A room that never says anything: opening one only rebuilds the view.
    const room = {
      subscribe: () => () => {},
      close: () => {},
    } as unknown as SignallingRoom;
    const coop = new CoopClient({
      signalling: { url: "ws://unused" },
      rooms: { host: () => room, join: () => room },
      createView: () => {
        made += 1;
        if (made === 2) {
          throw new Error("lost context");
        }
        return fakeView(() => {
          disposed += 1;
        });
      },
    });
    const detach = coop.attach(element, art);
    expect(() => coop.host({} as GameContent, "spark")).toThrow("lost context");
    detach();
    expect([
      cancelled,
      disposed,
      window.listening(),
      surface.listening(),
    ]).toStrictEqual([[1], 1, 0, 0]);
    coop.attach(element, art)();
    expect([made, disposed]).toStrictEqual([3, 2]);
  });
});
