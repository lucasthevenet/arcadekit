// @vitest-environment happy-dom
import { Effect, Exit, Layer, Scope } from "effect";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Game, Screen } from "../examples/page/game";
import { Hud, Menu, Start } from "../examples/page/protocol";
import { mount as mountDom } from "../examples/page/ui-dom";
import { mount as mountReact } from "../examples/page/ui-react";
import { App, Assets, Input, Sound, View } from "../src/index";

// The example page's game, with its menu and its heads-up display built
// twice on the view bridge: once with the page's own DOM and once with a
// UI library. Here both are mounted in a document and played.

// `import.meta.glob`, which gives a test the text of files, is declared in
// entries.test.ts.
declare global {
  // React asks for this before it lets a test wrap its work in `act`.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Lets what is waiting on a promise or a timer run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

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

const play = async (mount: (root: Element, ui: View.Bridge) => () => void) => {
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
  const ui = View.makeBridge();
  // What the UI is handed: the bridge, counting how often it is told.
  let told = 0;
  const handed: View.Bridge = {
    ...ui,
    subscribe: (view, listener) =>
      ui.subscribe(view, (value) => {
        told++;
        listener(value);
      }),
  };
  const root = document.createElement("div");
  document.body.append(root);
  let unmount = (): void => {};
  // The UI is there before the game is.
  await act(async () => {
    unmount = mount(root, handed);
  });
  const before = {
    buttons: Array.from(root.querySelectorAll("button"))
      .filter((button) => !button.hidden)
      .map((button) => button.textContent),
    hud: root.querySelector(".hud")?.textContent,
  };
  let records = 0;
  const changes = new MutationObserver((list) => {
    records += list.length;
  });
  changes.observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const source = Input.makeManualSource();
  const sound = Sound.makeRecorder();
  const scope = Effect.runSync(Scope.make());
  const app = Effect.runSync(
    App.make({ plugins: [Game], seed: 3 }).pipe(
      Effect.provide(Layer.succeed(Screen, { canvas })),
      Effect.provide(View.layer(ui)),
      Effect.provide(Sound.layer(sound)),
      Effect.provide(Assets.layerMemory(files)),
      Effect.provideService(Input.Source, source),
      Scope.provide(scope)
    )
  );
  return {
    ui,
    root,
    source,
    sound,
    before,
    told: () => told,
    /** How many times the document under the UI was changed since last asked. */
    changed: async () => {
      // An observer is told in its own time: a turn later.
      await settle();
      const count = records + changes.takeRecords().length;
      records = 0;
      return count;
    },
    buttons: () =>
      Array.from(root.querySelectorAll("button"))
        .filter((button) => !button.hidden)
        .map((button) => button.textContent),
    hud: () => root.querySelector(".hud")?.textContent,
    click: async (label: string) => {
      const button = Array.from(root.querySelectorAll("button")).find(
        (one) => !one.hidden && one.textContent === label
      );
      if (button === undefined) {
        throw new Error(`There is no button "${label}"`);
      }
      await act(async () => {
        button.click();
      });
    },
    /** What a driver does each frame a tick is due: the devices, a tick, a frame. */
    step: async (times = 1) => {
      await act(async () => {
        for (let i = 0; i < times; i++) {
          app.input();
          app.tick(1 / 60);
          app.frame(0);
        }
      });
    },
    unmount: async () => {
      await act(async () => {
        unmount();
      });
    },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

describe.each([
  ["the page's own DOM", mountDom],
  ["a UI library, React", mountReact],
] as const)("a menu and a heads-up display built with %s", (_, mount) => {
  it("shows the game, and acts on it only by sending actions", async () => {
    const page = await play(mount);
    // Before the game has said anything: every view at its initial value.
    expect(page.before).toEqual({ buttons: ["Start"], hud: "Caught 0" });
    // The game's first frames say what the UI already shows: it is told
    // nothing, and nothing in the document changes.
    await page.step(3);
    expect(page.told()).toBe(0);
    expect(await page.changed()).toBe(0);

    // A button sends an action, and nothing else: the menu is as it was
    // until the game has applied it and published what it then is.
    await page.click("Start");
    expect(page.buttons()).toEqual(["Start"]);
    expect(await page.changed()).toBe(0);
    await page.step();
    expect(page.buttons()).toEqual(["Pause", "Quit"]);
    expect(page.hud()).toBe("Loading");
    // The game is heard as it is seen: from its events, in the frame.
    expect(page.sound.played).toEqual([{ cue: "start", volume: 1, rate: 1 }]);
    // And its music has begun, which is not an event but how things are.
    expect(page.sound.scored).toEqual([
      { channel: "music", track: "theme", volume: 0.4, fade: 0.6 },
    ]);
    expect(await page.changed()).toBeGreaterThan(0);

    // The level's files arrive, and the game fills its sky.
    await settle();
    await page.step();
    expect(page.hud()).toBe("Caught 0");
    await page.changed();

    // Stars fall, sixty ticks a second, and now and then one is caught.
    // The UI is told when one is and at no other time: a frame in which
    // nothing it shows changed changes nothing in the document.
    let quiet = 0;
    for (let i = 0; i < 900 && page.ui.get(Hud).caught < 3; i++) {
      const told = page.told();
      await page.step();
      const changed = await page.changed();
      if (page.told() === told) {
        quiet++;
        expect(changed).toBe(0);
      } else {
        expect(changed).toBeGreaterThan(0);
      }
    }
    const { caught } = page.ui.get(Hud);
    expect(caught).toBeGreaterThanOrEqual(3);
    expect(page.hud()).toBe(`Caught ${caught}`);
    // A sound for each frame in which stars were caught, and no other.
    // It is the level's own sound, a clip its bundle holds.
    const heard = page.sound.played.filter((one) => one.cue === "/caught.wav");
    expect(heard[0]!.clip!.data).toEqual({ samples: 2 });
    expect(heard.length).toBeGreaterThanOrEqual(1);
    expect(heard.length).toBeLessThanOrEqual(caught);
    expect(page.sound.played.length).toBe(1 + heard.length);
    expect(quiet).toBeGreaterThan(50);
    // Told of the menu once, of the level twice, and once per catch.
    expect(page.told()).toBeLessThanOrEqual(3 + caught);

    // Paused from the menu: the game stands still, and so does the UI.
    await page.click("Pause");
    await page.step();
    expect(page.buttons()).toEqual(["Resume", "Quit"]);
    // The music is turned down, not off.
    expect(page.sound.scored.at(-1)).toEqual({
      channel: "music",
      track: "theme",
      volume: 0.1,
      fade: 0.6,
    });
    await page.changed();
    const paused = page.told();
    await page.step(60);
    expect(page.told()).toBe(paused);
    expect(await page.changed()).toBe(0);
    expect(page.hud()).toBe(`Caught ${caught}`);

    // Resumed from the keyboard: the menu follows the game, whoever asked.
    page.source.tap("KeyP");
    await page.step();
    expect(page.buttons()).toEqual(["Pause", "Quit"]);

    // Enter starts a game, and this one is started: nothing begins, and
    // nothing says that anything did.
    page.source.tap("Enter");
    await page.step(2);
    expect(page.sound.played.filter((one) => one.cue === "start").length).toBe(
      1
    );

    await page.click("Quit");
    await page.step();
    expect(page.buttons()).toEqual(["Start"]);
    expect(page.hud()).toBe("Caught 0");
    expect(page.ui.get(Menu)).toEqual({ phase: "title" });
    // Back at the title there is no music.
    expect(page.sound.playing.size).toBe(0);
    expect(page.sound.scored.length).toBe(4);

    // Taken out, it listens no more and leaves nothing behind.
    await page.unmount();
    expect(page.root.childNodes.length).toBe(0);
    const told = page.told();
    page.ui.send(Start, {});
    await page.step(2);
    expect(page.ui.get(Menu)).toEqual({ phase: "playing" });
    expect(page.told()).toBe(told);
    expect(page.root.childNodes.length).toBe(0);
    await page.close();
  });
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
    expect(imported("ui-dom.ts")).toEqual(["../../src/View", "./protocol"]);
    expect(imported("ui-react.ts")).toEqual([
      "../../src/View",
      "./protocol",
      "react",
      "react",
      "react-dom/client",
    ]);
    // Of the bridge they import the type alone: they are handed the bridge.
    for (const file of ["ui-dom.ts", "ui-react.ts"]) {
      expect(sources[`../examples/page/${file}`]).toContain(
        'import type * as View from "../../src/View";'
      );
    }
    // And what they share with the game is keys: no component, no system.
    expect(imported("protocol.ts")).toEqual([
      "../../src/Action",
      "../../src/View",
      "effect",
    ]);
  });
});
