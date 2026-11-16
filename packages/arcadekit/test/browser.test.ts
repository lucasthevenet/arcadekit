import { Cause, Data, Effect, Exit, Fiber, Layer, Scope } from "effect";
import type { Scope as ScopeType } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as Browser from "../src/Browser";
import {
  App,
  Assets,
  Commands,
  Component,
  Driver,
  Field,
  Input,
  Plugin,
  Query,
  System,
  Time,
} from "../src/index";

const Ship = Component.define("br/Ship", { x: Field.f32, shots: Field.i32 });
const Ships = Query.all(Ship);

const run = <A, E>(effect: Effect.Effect<A, E, ScopeType.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

/** Lets what is waiting on a promise or a timer run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** What a sample says, in a form that compares. */
const told = (devices: Input.Sample) => ({
  down: Array.from(devices.down).toSorted(),
  pressed: devices.pressed.toSorted(),
  released: devices.released.toSorted(),
  axes: Object.fromEntries(devices.axes),
  moved: devices.moved.toSorted(),
});

// A game steered with the keyboard, through the picture in the world.
const Steer = System.make("Steer", function* () {
  const keys = yield* Input.Keyboard;
  const { delta } = yield* Time;
  (yield* Ships).each((ship) => {
    if (keys.down("ArrowLeft")) {
      ship.x -= 10 * delta;
    }
    if (keys.down("ArrowRight")) {
      ship.x += 10 * delta;
    }
    if (keys.pressed("Space")) {
      ship.shots += 1;
    }
  });
});
const Flying = Plugin.make("Flying", {
  plugins: [Input.plugin],
  components: [Ship],
  systems: [Steer],
  setup: Effect.map(Commands, (commands) => {
    commands.spawn(Ship.of({ x: 0, shots: 0 }));
  }),
});
const ship = (app: App.Any): { x: number; shots: number } => {
  let found = { x: Number.NaN, shots: Number.NaN };
  app.world.view(Ships).each((one) => {
    found = { x: one.x, shots: one.shots };
  });
  return found;
};

const files = {
  "/forest.png": new Uint8Array([1, 2, 3]),
  "/cave.png": new Uint8Array([4, 5]),
};

/** An event target that counts who is listening. */
class Listened extends EventTarget {
  readonly listening = new Map<string, number>();
  box: { left: number; top: number } | undefined;

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null
  ): void {
    this.listening.set(type, (this.listening.get(type) ?? 0) + 1);
    super.addEventListener(type, listener);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null
  ): void {
    this.listening.set(type, (this.listening.get(type) ?? 0) - 1);
    super.removeEventListener(type, listener);
  }

  get total(): number {
    let total = 0;
    for (const count of this.listening.values()) {
      total += count;
    }
    return total;
  }

  getBoundingClientRect = (): { left: number; top: number } =>
    this.box ?? { left: 0, top: 0 };

  /** Sends an event with these fields, and says whether its default was prevented. */
  send(type: string, fields: Record<string, unknown> = {}): boolean {
    const event = Object.assign(
      new globalThis.Event(type, { cancelable: true }),
      fields
    );
    this.dispatchEvent(event);
    return event.defaultPrevented;
  }
}

const pad = (
  index: number,
  buttons: boolean[],
  axes: number[],
  connected = true
): Browser.GamepadLike => ({
  index,
  connected,
  buttons: buttons.map((pressed) => ({ pressed })),
  axes,
});

/** Stand-ins for what a page gives a frame loop, and a way to repaint. */
const makePage = () => {
  const requested = new Map<number, (now: number) => void>();
  let ids = 0;
  const visibility = new Set<() => void>();
  const document = {
    visibilityState: "visible",
    addEventListener(_type: string, listener: () => void) {
      visibility.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      visibility.delete(listener);
    },
  };
  const window = new Listened();
  vi.stubGlobal("requestAnimationFrame", (callback: (now: number) => void) => {
    requested.set(++ids, callback);
    return ids;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    requested.delete(id);
  });
  vi.stubGlobal("document", document);
  // In a page the window is the global object.
  vi.stubGlobal("addEventListener", window.addEventListener.bind(window));
  vi.stubGlobal("removeEventListener", window.removeEventListener.bind(window));
  return {
    requested,
    visibility,
    window,
    repaint(now: number): void {
      const due = Array.from(requested.values());
      requested.clear();
      for (const callback of due) {
        callback(now);
      }
    },
  };
};

describe("a page's display", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const Roll = System.make("Roll", function* () {});

  it("is requestAnimationFrame and the document's visibility", async () => {
    const requested = new Map<number, (now: number) => void>();
    let ids = 0;
    const cancelled: number[] = [];
    const listeners = new Set<() => void>();
    const document = {
      visibilityState: "visible",
      addEventListener(type: string, listener: () => void) {
        expect(type).toBe("visibilitychange");
        listeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        expect(type).toBe("visibilitychange");
        listeners.delete(listener);
      },
    };
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: (now: number) => void) => {
        requested.set(++ids, callback);
        return ids;
      }
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelled.push(id);
      requested.delete(id);
    });
    vi.stubGlobal("document", document);
    const repaint = (now: number): void => {
      const due = Array.from(requested.values());
      requested.clear();
      for (const callback of due) {
        callback(now);
      }
    };
    let app: App.Any | undefined;
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          app = yield* App.make({ systems: [Roll] });
          return yield* Driver.frames(app, { hz: 60 });
        })
      ).pipe(Effect.provideService(Driver.Display, Browser.display))
    );
    expect(requested.size).toBe(1);
    expect(listeners.size).toBe(1);
    repaint(0);
    repaint(1000 / 60);
    repaint(2000 / 60);
    expect(app!.time.tick).toBe(2);
    expect(requested.size).toBe(1);
    // The tab is hidden: the request is cancelled.
    document.visibilityState = "hidden";
    for (const listener of listeners) {
      listener();
    }
    expect(requested.size).toBe(0);
    expect(cancelled).toEqual([4]);
    document.visibilityState = "visible";
    for (const listener of listeners) {
      listener();
    }
    expect(requested.size).toBe(1);
    repaint(90_000);
    repaint(90_000 + 1000 / 60);
    expect(app!.time.tick).toBe(3);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(requested.size).toBe(0);
    expect(listeners.size).toBe(0);
  });
});

describe("a page's devices", () => {
  it("hears the keyboard and the pointer, and lets go of both when the page loses focus", () => {
    const page = new Listened();
    const canvas = new Listened();
    canvas.box = { left: 100, top: 50 };
    run(
      Effect.gen(function* () {
        const source = yield* Input.Source;
        expect(page.total).toBe(6);
        expect(canvas.listening.get("pointerdown")).toBe(1);
        expect(canvas.total).toBe(1);

        page.send("keydown", { code: "KeyA", repeat: false });
        // A key held down repeats. It went down once.
        page.send("keydown", { code: "KeyA", repeat: true });
        page.send("keydown", { code: "ShiftLeft", repeat: false });
        page.send("keyup", { code: "ShiftLeft" });
        expect(told(source.sample())).toEqual({
          down: ["KeyA"],
          pressed: ["KeyA", "ShiftLeft"],
          released: ["ShiftLeft"],
          axes: {},
          moved: [],
        });
        // A repeat of a key that was down before the page listened is no press.
        page.send("keydown", { code: "KeyR", repeat: true });
        expect(told(source.sample()).pressed).toEqual([]);

        // The pointer's place is measured from the target's corner.
        page.send("pointermove", { clientX: 130, clientY: 90 });
        expect(told(source.sample())).toEqual({
          down: ["KeyA"],
          pressed: [],
          released: [],
          axes: { PointerX: 30, PointerY: 40 },
          moved: ["PointerX", "PointerY"],
        });
        // Pressed on the target, let go anywhere on the page.
        canvas.send("pointerdown", { button: 0, clientX: 140, clientY: 90 });
        canvas.send("pointerdown", { button: 2, clientX: 140, clientY: 90 });
        page.send("pointerdown", { button: 1, clientX: 0, clientY: 0 });
        page.send("pointerup", { button: 0, clientX: 600, clientY: 20 });
        expect(told(source.sample())).toEqual({
          down: ["KeyA", "Pointer2"],
          pressed: ["Pointer0", "Pointer2"],
          released: ["Pointer0"],
          axes: { PointerX: 500, PointerY: -30 },
          moved: ["PointerX", "PointerY"],
        });
        // A pointer the browser took away lets go of its buttons, not of keys.
        page.send("pointercancel");
        expect(told(source.sample())).toEqual({
          down: ["KeyA"],
          pressed: [],
          released: ["Pointer2"],
          axes: { PointerX: 500, PointerY: -30 },
          moved: [],
        });
        // The page loses focus: everything held is let go.
        canvas.send("pointerdown", { button: 0, clientX: 100, clientY: 50 });
        page.send("blur");
        expect(told(source.sample())).toEqual({
          down: [],
          pressed: ["Pointer0"],
          released: ["KeyA", "Pointer0"],
          axes: { PointerX: 0, PointerY: 0 },
          moved: ["PointerX", "PointerY"],
        });
      }).pipe(
        Effect.provide(
          Browser.layer({
            window: page,
            target: canvas,
            gamepads: () => [],
          })
        )
      )
    );
    // Its scope has closed: nobody is listening.
    expect(page.total).toBe(0);
    expect(canvas.total).toBe(0);
  });

  it("follows every button of a mouse held in a chord, which the page tells of as moves", () => {
    const page = new Listened();
    const canvas = new Listened();
    run(
      Effect.gen(function* () {
        const source = yield* Input.Source;
        const at = { clientX: 10, clientY: 10 };
        // The main button goes down: the one press a page reports as one.
        canvas.send("pointerdown", { ...at, button: 0, buttons: 1 });
        // The secondary goes down while it is held. A page says so with a
        // move, not a press: `buttons` is what is down by then.
        page.send("pointermove", { ...at, button: 2, buttons: 3 });
        expect(told(source.sample())).toMatchObject({
          down: ["Pointer0", "Pointer2"],
          pressed: ["Pointer0", "Pointer2"],
          released: [],
        });
        // The main button goes up, the secondary still held: a move again.
        page.send("pointermove", { ...at, button: 0, buttons: 2 });
        expect(told(source.sample())).toMatchObject({
          down: ["Pointer2"],
          pressed: [],
          released: ["Pointer0"],
        });
        // The last button goes up: the one release a page reports as one.
        page.send("pointerup", { ...at, button: 2, buttons: 0 });
        expect(told(source.sample())).toMatchObject({
          down: [],
          pressed: [],
          released: ["Pointer2"],
        });
        // The release of the last button lets go of every one: of one
        // whose own move the page never sent, too.
        canvas.send("pointerdown", { ...at, button: 0, buttons: 1 });
        page.send("pointerup", { ...at, button: 2, buttons: 0 });
        expect(told(source.sample())).toMatchObject({
          down: [],
          released: ["Pointer0"],
        });
        // The middle button is the third bit of `buttons`, not the second.
        canvas.send("pointerdown", { ...at, button: 0, buttons: 1 });
        page.send("pointermove", { ...at, button: 1, buttons: 5 });
        expect(told(source.sample()).down).toEqual(["Pointer0", "Pointer1"]);
        // Let go of outside the window, the page hears of no release: the
        // next move, with nothing down, is how it is known.
        page.send("pointermove", { ...at, button: -1, buttons: 0 });
        expect(told(source.sample())).toMatchObject({
          down: [],
          released: ["Pointer0", "Pointer1"],
        });
        // A button that went down somewhere else on the page is not one
        // the target hears of, however the pointer moves afterwards.
        page.send("pointermove", { ...at, button: -1, buttons: 1 });
        page.send("pointermove", { ...at, button: 2, buttons: 3 });
        expect(told(source.sample()).down).toEqual([]);
        // An event that says nothing of what is down, as one made by hand
        // may, is still the press and the release of its own button.
        canvas.send("pointerdown", { ...at, button: 2, buttons: 0 });
        expect(told(source.sample()).down).toEqual(["Pointer2"]);
        page.send("pointerup", { ...at, button: 2 });
        expect(told(source.sample()).released).toEqual(["Pointer2"]);
      }).pipe(
        Effect.provide(
          Browser.layer({ window: page, target: canvas, gamepads: () => [] })
        )
      )
    );
  });

  it("measures the pointer from the corner of the page when given no target, and hears its presses there", () => {
    const page = new Listened();
    run(
      Effect.gen(function* () {
        const source = yield* Input.Source;
        expect(page.listening.get("pointerdown")).toBe(1);
        page.send("pointerdown", { button: 0, clientX: 12, clientY: 34 });
        expect(told(source.sample())).toEqual({
          down: ["Pointer0"],
          pressed: ["Pointer0"],
          released: [],
          axes: { PointerX: 12, PointerY: 34 },
          moved: ["PointerX", "PointerY"],
        });
      }).pipe(
        Effect.provide(Browser.layer({ window: page, gamepads: () => [] }))
      )
    );
    // A target that is no element is measured from where it is given.
    const bare = new EventTarget();
    run(
      Effect.gen(function* () {
        const source = yield* Input.Source;
        bare.dispatchEvent(
          Object.assign(new globalThis.Event("pointerdown"), {
            button: 0,
            clientX: 5,
            clientY: 6,
          })
        );
        expect(told(source.sample()).axes).toEqual({
          PointerX: 5,
          PointerY: 6,
        });
      }).pipe(
        Effect.provide(
          Browser.layer({ window: page, target: bare, gamepads: () => [] })
        )
      )
    );
  });

  it("prevents what the keys it was told of usually do in the page, and no others", () => {
    const page = new Listened();
    run(
      Effect.gen(function* () {
        yield* Input.Source;
        expect(page.send("keydown", { code: "Space", repeat: false })).toBe(
          true
        );
        expect(page.send("keydown", { code: "Space", repeat: true })).toBe(
          true
        );
        expect(page.send("keyup", { code: "Space" })).toBe(true);
        expect(page.send("keydown", { code: "KeyR", repeat: false })).toBe(
          false
        );
        expect(page.send("keyup", { code: "KeyR" })).toBe(false);
      }).pipe(
        Effect.provide(
          Browser.layer({
            window: page,
            preventDefault: ["Space"],
            gamepads: () => [],
          })
        )
      )
    );
    run(
      Effect.gen(function* () {
        yield* Input.Source;
        expect(page.send("keydown", { code: "Space", repeat: false })).toBe(
          false
        );
      }).pipe(
        Effect.provide(Browser.layer({ window: page, gamepads: () => [] }))
      )
    );
  });

  it("reads the gamepads when it is sampled", () => {
    const page = new Listened();
    let pads: (Browser.GamepadLike | null)[] = [];
    let polls = 0;
    run(
      Effect.gen(function* () {
        const source = yield* Input.Source;
        expect(polls).toBe(0);
        pads = [
          null,
          pad(1, [true, false], [0.504, -0.05, -1, 0.099, 0.15]),
          pad(2, [true], [1], false),
        ];
        expect(told(source.sample())).toEqual({
          down: ["Pad1Button0"],
          pressed: ["Pad1Button0"],
          released: [],
          // Rounded to two decimals, and nothing within the dead zone,
          // which is a tenth unless told otherwise.
          axes: { Pad1Axis0: 0.5, Pad1Axis2: -1, Pad1Axis4: 0.15 },
          moved: ["Pad1Axis0", "Pad1Axis2", "Pad1Axis4"],
        });
        expect(polls).toBe(1);
        // Held still, and a stick that trembles: nothing happened.
        pads = [null, pad(1, [true, false], [0.5049, 0.02, -1, 0, 0.15])];
        expect(told(source.sample())).toEqual({
          down: ["Pad1Button0"],
          pressed: [],
          released: [],
          axes: { Pad1Axis0: 0.5, Pad1Axis2: -1, Pad1Axis4: 0.15 },
          moved: [],
        });
        pads = [null, pad(1, [false, true], [0, 0, -1, 0, 0])];
        expect(told(source.sample())).toEqual({
          down: ["Pad1Button1"],
          pressed: ["Pad1Button1"],
          released: ["Pad1Button0"],
          axes: { Pad1Axis0: 0, Pad1Axis2: -1, Pad1Axis4: 0 },
          moved: ["Pad1Axis0", "Pad1Axis4"],
        });
        // The page losing focus does not let go of a gamepad's buttons.
        page.send("keydown", { code: "KeyA", repeat: false });
        page.send("blur");
        expect(told(source.sample())).toEqual({
          down: ["Pad1Button1"],
          pressed: ["KeyA"],
          released: ["KeyA"],
          axes: { Pad1Axis0: 0, Pad1Axis2: -1, Pad1Axis4: 0 },
          moved: [],
        });
        // Unplugged: it lets go of everything.
        pads = [];
        expect(told(source.sample())).toEqual({
          down: [],
          pressed: [],
          released: ["Pad1Button1"],
          axes: { Pad1Axis0: 0, Pad1Axis2: 0, Pad1Axis4: 0 },
          moved: ["Pad1Axis2"],
        });
        expect(told(source.sample()).released).toEqual([]);
      }).pipe(
        Effect.provide(
          Browser.layer({
            window: page,
            gamepads: () => {
              polls++;
              return pads;
            },
          })
        )
      )
    );
    // A dead zone of its own.
    pads = [pad(0, [], [0.3, 0.2])];
    run(
      Effect.gen(function* () {
        expect(told((yield* Input.Source).sample()).axes).toEqual({
          Pad0Axis0: 0.3,
        });
      }).pipe(
        Effect.provide(
          Browser.layer({
            window: page,
            deadzone: 0.25,
            gamepads: () => pads,
          })
        )
      )
    );
  });

  it("says so when it is read after it was let go, as when it was provided to App.make alone", () => {
    const page = new Listened();
    run(
      Effect.gen(function* () {
        const Listen = System.make("Listen", function* () {
          yield* Input.Devices;
        }).pipe(System.inStage("input"));
        // The layer is let go as soon as the app is made.
        const app = yield* App.make({ systems: [Listen] }).pipe(
          Effect.provide(Browser.layer({ window: page, gamepads: () => [] }))
        );
        expect(page.total).toBe(0);
        expect(() => app.input()).toThrow(
          /were read after Browser\.layer was let go/
        );
        expect(() => app.input()).toThrow(/Provide it to the whole program/);
      })
    );
  });

  it("drives a game through an app, end to end", () => {
    const page = new Listened();
    run(
      Effect.gen(function* () {
        const app = yield* App.make({ plugins: [Flying] });
        const step = Driver.fixedStep(app, { hz: 10 });
        page.send("keydown", { code: "ArrowRight", repeat: false });
        step(0.1);
        step(0.1);
        page.send("keyup", { code: "ArrowRight" });
        page.send("keydown", { code: "Space", repeat: false });
        page.send("keyup", { code: "Space" });
        step(0.1);
        expect(ship(app).x).toBeCloseTo(2, 5);
        expect(ship(app).shots).toBe(1);
      }).pipe(
        Effect.provide(Browser.layer({ window: page, gamepads: () => [] }))
      )
    );
  });
});

describe("a picture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is an ImageBitmap, closed when the scope it was loaded in closes", async () => {
    const closed: number[] = [];
    const given: number[] = [];
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      given.push(bytes.length);
      return { width: bytes[0], close: () => closed.push(bytes.length) };
    });
    const Art = Assets.bundle("br/Art", {
      one: Browser.image("/forest.png"),
      two: Browser.image("/cave.png"),
    });
    const scope = Effect.runSync(Scope.make());
    const loaded = await Effect.runPromise(
      Assets.load(Art).pipe(
        Scope.provide(scope),
        Effect.provide(Assets.layerMemory(files))
      )
    );
    expect(loaded.one.width).toBe(1);
    expect(loaded.two.width).toBe(4);
    expect(given.toSorted()).toEqual([2, 3]);
    expect(closed).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(closed.toSorted()).toEqual([2, 3]);

    // Where there is no such thing, or the bytes are no picture, it fails.
    vi.stubGlobal("createImageBitmap", () =>
      Promise.reject(new Error("The source image could not be decoded."))
    );
    const exit = await Effect.runPromise(
      Effect.exit(Effect.scoped(Assets.load(Art))).pipe(
        Effect.provide(Assets.layerMemory(files))
      )
    );
    const error = Cause.squash(
      (exit as Exit.Failure<never, unknown>).cause
    ) as Assets.AssetFailed;
    expect(error).toBeInstanceOf(Assets.AssetFailed);
    expect(error.message).toBe(
      "It could not be made a picture: The source image could not be decoded."
    );
  });
});

describe("Browser.layer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the page's display and its devices together, for as long as it is provided", async () => {
    const page = makePage();
    let made: App.Any | undefined;
    const fiber = Effect.runFork(
      App.run(
        { plugins: [Flying] },
        {
          hz: 60,
          ready: (app) =>
            Effect.sync(() => {
              made = app;
            }),
        }
      ).pipe(Effect.provide(Browser.layer({ gamepads: () => [] })))
    );
    // The frame loop asks the page for its frames, and watches its tab.
    expect(page.requested.size).toBe(1);
    expect(page.visibility.size).toBe(1);
    // The keyboard and the pointer are listened to on the window.
    expect(page.window.total).toBe(7);
    page.repaint(0);
    page.window.send("keydown", { code: "ArrowRight", repeat: false });
    page.repaint(1000 / 60);
    page.repaint(2000 / 60);
    expect(made!.time.tick).toBe(2);
    expect(ship(made!).x).toBeCloseTo(20 / 60, 5);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(page.requested.size).toBe(0);
    expect(page.visibility.size).toBe(0);
    expect(page.window.total).toBe(0);
  });
});

describe("Browser.runMain", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the game in the page, and interrupts it when the page goes away for good", async () => {
    const page = makePage();
    const log: string[] = [];
    const Sound = Plugin.make("Sound", {
      plugins: [Flying],
      layer: Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => log.push("sound opened")),
          () => Effect.sync(() => log.push("sound closed"))
        )
      ),
    });
    let made: App.Any | undefined;
    let ended: Exit.Exit<unknown, unknown> | undefined;
    Browser.runMain(
      App.run(
        { plugins: [Sound] },
        {
          hz: 60,
          ready: (app) =>
            Effect.sync(() => {
              made = app;
            }),
        }
      ),
      {
        gamepads: () => [],
        preventDefault: ["Space"],
        teardown: (exit, onExit) => {
          ended = exit;
          onExit(0);
        },
      }
    );
    expect(log).toEqual(["sound opened"]);
    expect(page.requested.size).toBe(1);
    // The page's devices, and the page going away.
    expect(page.window.total).toBe(8);
    expect(page.window.listening.get("pagehide")).toBe(1);
    page.repaint(0);
    page.window.send("keydown", { code: "ArrowLeft", repeat: false });
    expect(page.window.send("keydown", { code: "Space", repeat: false })).toBe(
      true
    );
    page.repaint(1000 / 60);
    expect(ship(made!)).toEqual({ x: Math.fround(-10 / 60), shots: 1 });

    // Into the back/forward cache: the page may come back, so it goes on.
    page.window.send("pagehide", { persisted: true });
    await settle();
    expect(ended).toBeUndefined();
    page.repaint(2000 / 60);
    expect(made!.time.tick).toBe(2);

    // Gone for good.
    page.window.send("pagehide", { persisted: false });
    await settle();
    expect(ended !== undefined && Exit.isFailure(ended)).toBe(true);
    expect(
      Cause.hasInterruptsOnly((ended as Exit.Failure<unknown, unknown>).cause)
    ).toBe(true);
    expect(log).toEqual(["sound opened", "sound closed"]);
    expect(page.requested.size).toBe(0);
    expect(page.visibility.size).toBe(0);
    expect(page.window.total).toBe(0);
    page.repaint(5000);
    expect(made!.time.tick).toBe(2);
  });

  it("ends with what the game fails with, and takes only a game that needs nothing more", async () => {
    class NoCanvas extends Data.TaggedError("NoCanvas")<{}> {}
    const page = makePage();
    // What Effect's logger writes, wherever it writes it.
    const said: string[] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        said.push(args.map(String).join(" "));
      });
    }
    let ended: Exit.Exit<unknown, unknown> | undefined;
    Browser.runMain(Effect.fail(new NoCanvas()), {
      gamepads: () => [],
      disableErrorReporting: true,
      teardown: (exit, onExit) => {
        ended = exit;
        onExit(1);
      },
    });
    await settle();
    expect(ended !== undefined && Exit.isFailure(ended)).toBe(true);
    expect(
      Cause.squash((ended as Exit.Failure<unknown, unknown>).cause)
    ).toEqual(new NoCanvas());
    // Nothing of the page is held on to.
    expect(page.window.total).toBe(0);
    // Told not to report it, it said nothing. Otherwise it is reported.
    expect(said).toEqual([]);
    ended = undefined;
    Browser.runMain(Effect.fail(new NoCanvas()), {
      gamepads: () => [],
      teardown: (exit, onExit) => {
        ended = exit;
        onExit(1);
      },
    });
    await settle();
    expect(ended).toBeDefined();
    expect(said.join("\n")).toMatch(/NoCanvas/);
    vi.restoreAllMocks();

    const unprovided = Effect.flatMap(
      Effect.service(Assets.Store),
      () => Effect.never
    );
    // @ts-expect-error the game still needs a service
    void (() => Browser.runMain(unprovided));
  });
});
