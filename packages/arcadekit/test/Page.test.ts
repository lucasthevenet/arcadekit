import { afterEach, describe, expect, it, vi } from "@effect/vitest";
// @vitest-environment happy-dom
import { Effect, Layer } from "effect";
import { act } from "react";

import { Game, Screen } from "../examples/page/game.ts";
import { Hud, Menu } from "../examples/page/protocol.ts";
import type { Requests } from "../examples/page/protocol.ts";
import { mount as mountDom } from "../examples/page/uiDom.ts";
import { mount as mountReact } from "../examples/page/uiReact.ts";
import { App, Assets, Input, Sound, View } from "../src/index.ts";

// The example page's game, with its menu and its heads-up display built
// twice on the view bridge: once with the page's own DOM and once with a
// UI library. Here both are mounted in a document and played.

// `import.meta.glob`, which gives a test the text of files, is declared in
// Entries.test.ts.
declare global {
  // React asks for this before it lets a test wrap its work in `act`.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Lets what is waiting on a promise or a timer run. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0))
);

/**
 * Runs `effect` inside React's `act`, which renders what it was asked to
 * once `effect` is done.
 */
const inAct = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    let done = (): void => {};
    const acting = act(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        })
    );
    const exit = yield* Effect.exit(effect);
    done();
    yield* Effect.promise(() => acting);
    return yield* exit;
  });

const files = {
  "/level.json": JSON.stringify({
    name: "Night sky",
    stars: 40,
    slowest: 40,
    fastest: 160,
  }),
  "/star.png": new Uint8Array([1, 2, 3]),
  "/caught.wav": new Uint8Array([4, 5]),
};

/** A canvas that draws nothing: the game's own drawing is not what is tested here. */
const canvas = new Proxy(
  {},
  { get: () => () => {}, set: () => true }
) as CanvasRenderingContext2D;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const Catch = App.define({ plugins: [Game] });

const play = Effect.fnUntraced(function* (
  mount: (root: Element, ui: View.Bridge<Requests>) => () => void
) {
  vi.stubGlobal("createImageBitmap", async () => ({ close() {} }));
  // The level's sound is decoded as a page decodes it.
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      decodeAudioData(data: ArrayBuffer): Promise<unknown> {
        return Promise.resolve({ samples: data.byteLength });
      }
    }
  );
  const root = document.createElement("div");
  document.body.append(root);
  let records = 0;
  const changes = new MutationObserver((list) => {
    records += list.length;
  });
  const handed: View.Bridge<Requests>[] = [];
  // What the UI is handed: the bridge, counting how often it is told.
  let told = 0;
  const ui = View.mount(Catch, (bridge) => {
    handed.push(bridge);
    return mount(root, {
      get: bridge.get,
      send: bridge.send,
      subscribe: (view, listener) => {
        // What the game tells it: not the value a subscriber is handed at once.
        let subscribed = false;
        const stop = bridge.subscribe(view, (value) => {
          if (subscribed) {
            told++;
          }
          listener(value);
        });
        subscribed = true;
        return stop;
      },
    });
  });
  const source = Input.makeManualSource();
  const sound = Sound.makeRecorder();
  // The app puts the UI on the page when it is made.
  const app = yield* inAct(
    App.make(Catch, { seed: 3 }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ui,
          Sound.layer(sound),
          Assets.layer(Assets.makeMemory(files))
        )
      ),
      Effect.provideService(Screen, { canvas }),
      Effect.provide(Input.layer(source))
    )
  );
  const before = {
    buttons: Array.from(root.querySelectorAll("button"))
      .filter((button) => !button.hidden)
      .map((button) => button.textContent),
    hud: root.querySelector(".hud")?.textContent,
  };
  changes.observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return {
    ui: handed[0]!,
    root,
    source,
    sound,
    before,
    told: () => told,
    /** How many times the document under the UI was changed since last asked. */
    changed: Effect.gen(function* () {
      // An observer is told in its own time: a turn later.
      yield* settle;
      const count = records + changes.takeRecords().length;
      records = 0;
      return count;
    }),
    buttons: () =>
      Array.from(root.querySelectorAll("button"))
        .filter((button) => !button.hidden)
        .map((button) => button.textContent),
    hud: () => root.querySelector(".hud")?.textContent,
    click: (label: string) => {
      const button = Array.from(root.querySelectorAll("button")).find(
        (one) => !one.hidden && one.textContent === label
      );
      if (button === undefined) {
        throw new Error(`There is no button "${label}"`);
      }
      return inAct(
        Effect.sync(() => {
          button.click();
        })
      );
    },
    /** What a driver does each frame a tick is due: the devices, a tick, a frame. */
    step: (times = 1) =>
      inAct(
        Effect.gen(function* () {
          for (let i = 0; i < times; i++) {
            yield* app.input();
            yield* app.tick(1 / 60);
            yield* app.frame();
          }
        })
      ),
    close: inAct(app.close),
  };
});

describe.each([
  ["the page's own DOM", mountDom],
  ["a UI library, React", mountReact],
] as const)("a menu and a heads-up display built with %s", (_, mount) => {
  it.live("shows the game, and acts on it only by sending actions", () =>
    Effect.gen(function* () {
      const page = yield* play(mount);
      // Before the game has said anything: every view at its initial value.
      expect(page.before).toEqual({ buttons: ["Start"], hud: "Caught 0" });
      // The game's first frames say what the UI already shows: it is told
      // nothing, and nothing in the document changes.
      yield* page.step(3);
      expect(page.told()).toBe(0);
      expect(yield* page.changed).toBe(0);

      // A button sends an action, and nothing else: the menu is as it was
      // until the game has applied it and published what it then is.
      yield* page.click("Start");
      expect(page.buttons()).toEqual(["Start"]);
      expect(yield* page.changed).toBe(0);
      yield* page.step();
      expect(page.buttons()).toEqual(["Pause", "Quit"]);
      expect(page.hud()).toBe("Loading");
      // The game is heard as it is seen: from its events, in the frame.
      expect(page.sound.played).toEqual([{ cue: "start", volume: 1, rate: 1 }]);
      // And its music has begun, which is not an event but how things are.
      expect(page.sound.scored).toEqual([
        { channel: "music", track: "theme", volume: 0.4, fade: 0.6 },
      ]);
      expect(yield* page.changed).toBeGreaterThan(0);

      // The level's files arrive, and the game fills its sky.
      yield* settle;
      yield* page.step();
      expect(page.hud()).toBe("Caught 0");
      yield* page.changed;

      // Stars fall, sixty ticks a second, and now and then one is caught.
      // The UI is told when one is and at no other time: a frame in which
      // nothing it shows changed changes nothing in the document.
      const frames: { told: boolean; changed: boolean }[] = [];
      for (let i = 0; i < 900 && page.ui.get(Hud).caught < 3; i++) {
        const told = page.told();
        yield* page.step();
        const changed = yield* page.changed;
        frames.push({ told: page.told() !== told, changed: changed > 0 });
      }
      expect(frames.filter((frame) => frame.told !== frame.changed)).toEqual(
        []
      );
      const quiet = frames.filter((frame) => !frame.told).length;
      const { caught } = page.ui.get(Hud);
      expect(caught).toBeGreaterThanOrEqual(3);
      expect(page.hud()).toBe(`Caught ${caught}`);
      // A sound for each frame in which stars were caught, and no other.
      // It is the level's own sound, a clip its bundle holds.
      const heard = page.sound.played.filter(
        (one) => one.cue === "/caught.wav"
      );
      expect(heard[0]!.clip!.data).toEqual({ samples: 2 });
      expect(heard.length).toBeGreaterThanOrEqual(1);
      expect(heard.length).toBeLessThanOrEqual(caught);
      expect(page.sound.played.length).toBe(1 + heard.length);
      expect(quiet).toBeGreaterThan(50);
      // Told of the menu once, of the level twice, and once per catch.
      expect(page.told()).toBeLessThanOrEqual(3 + caught);

      // Paused from the menu: the game stands still, and so does the UI.
      yield* page.click("Pause");
      yield* page.step();
      expect(page.buttons()).toEqual(["Resume", "Quit"]);
      // The music is turned down, not off.
      expect(page.sound.scored.at(-1)).toEqual({
        channel: "music",
        track: "theme",
        volume: 0.1,
        fade: 0.6,
      });
      yield* page.changed;
      const paused = page.told();
      yield* page.step(60);
      expect(page.told()).toBe(paused);
      expect(yield* page.changed).toBe(0);
      expect(page.hud()).toBe(`Caught ${caught}`);

      // Resumed from the keyboard: the menu follows the game, whoever asked.
      page.source.tap("KeyP");
      yield* page.step();
      expect(page.buttons()).toEqual(["Pause", "Quit"]);

      // Enter starts a game, and this one is started: nothing begins, and
      // nothing says that anything did.
      page.source.tap("Enter");
      yield* page.step(2);
      expect(
        page.sound.played.filter((one) => one.cue === "start").length
      ).toBe(1);

      yield* page.click("Quit");
      yield* page.step();
      expect(page.buttons()).toEqual(["Start"]);
      expect(page.hud()).toBe("Caught 0");
      expect(page.ui.get(Menu)).toEqual({ phase: "title" });
      // Back at the title there is no music.
      expect(page.sound.playing.size).toBe(0);
      expect(page.sound.scored.length).toBe(4);

      // Closing the app takes the UI out, and it leaves nothing behind.
      yield* page.close;
      expect(page.root.childNodes.length).toBe(0);
    })
  );
});

describe("the page's UI", () => {
  const sources = import.meta.glob("../examples/page/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  /** What a file imports from, type-only imports among them. */
  const imported = (file: string): string[] => {
    const found: string[] = [];
    const pattern =
      /^\s*(?:import|export)\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gmu;
    for (const match of sources[`../examples/page/${file}`]!.matchAll(
      pattern
    )) {
      found.push(match[1]!);
    }
    return found.toSorted();
  };

  it("holds no reference to the world: it imports the views and actions it may use, and the type of the bridge", () => {
    expect(imported("uiDom.ts")).toEqual([
      "../../src/View.ts",
      "./protocol.ts",
      "./protocol.ts",
    ]);
    expect(imported("uiReact.ts")).toEqual([
      "../../src/View.ts",
      "./protocol.ts",
      "./protocol.ts",
      "react",
      "react",
      "react-dom/client",
    ]);
    // Of the bridge they import the type alone: they are handed the bridge.
    for (const file of ["uiDom.ts", "uiReact.ts"]) {
      expect(sources[`../examples/page/${file}`]).toContain(
        'import type * as View from "../../src/View.ts";'
      );
    }
    // And what they share with the game is keys: no component, no system.
    expect(imported("protocol.ts")).toEqual([
      "../../src/Action.ts",
      "../../src/View.ts",
    ]);
  });
});
