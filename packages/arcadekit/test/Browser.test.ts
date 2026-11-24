import {
  Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Schema,
  Scope,
} from "effect";
import type { Scope as ScopeType } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as Browser from "../src/browser/Browser";
import {
  App,
  Assets,
  Commands,
  Component,
  Driver,
  Event,
  Field,
  Input,
  Plugin,
  Query,
  Sound,
  System,
  Time,
} from "../src/index";
import { Message, Session, Transport } from "../src/net/index";

const Ship = Component.define("br/Ship", { x: Field.f32, shots: Field.i32 });
const Ships = Query.all(Ship).pipe(Query.writes(Ship));
const Flown = Query.all(Ship);

const run = <A, E>(effect: Effect.Effect<A, E, ScopeType.Scope>): A =>
  Effect.runSync(Effect.scoped(effect));

/** What the page's devices say when they are read after they were let go. */
const DEVICES_LET_GO =
  /The page's devices were read after they were let go: the app that listened to them was closed, or the scope Input\.listen ran in had ended/u;

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
const Steer = System.tick("Steer", function* () {
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
  systems: [Steer],
  setup: Effect.map(Commands.spawns(Ship), (commands) => {
    commands.spawn(Ship.of({ x: 0, shots: 0 }));
  }),
});
const ship = (app: App.Any): { x: number; shots: number } => {
  let found = { x: Number.NaN, shots: Number.NaN };
  Effect.runSync(app.read(Flown)).each((one) => {
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
    /** The tab goes out of sight, and whoever watches is told. */
    hide(): void {
      document.visibilityState = "hidden";
      for (const listener of Array.from(visibility)) {
        listener();
      }
    },
    show(): void {
      document.visibilityState = "visible";
      for (const listener of Array.from(visibility)) {
        listener();
      }
    },
  };
};

describe("a page's display", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const Roll = System.tick("Roll", function* () {});

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
      Effect.gen(function* () {
        app = yield* App.make(App.define({ systems: [Roll] }));
        return yield* Driver.frames(app, { hz: 60 });
      }).pipe(Effect.provideService(Driver.Display, Browser.display))
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
        const listener = yield* Input.listen;
        expect(page.total).toBe(6);
        expect(canvas.listening.get("pointerdown")).toBe(1);
        expect(canvas.total).toBe(1);

        page.send("keydown", { code: "KeyA", repeat: false });
        // A key held down repeats. It went down once.
        page.send("keydown", { code: "KeyA", repeat: true });
        page.send("keydown", { code: "ShiftLeft", repeat: false });
        page.send("keyup", { code: "ShiftLeft" });
        expect(told(listener.sample())).toEqual({
          down: ["KeyA"],
          pressed: ["KeyA", "ShiftLeft"],
          released: ["ShiftLeft"],
          axes: {},
          moved: [],
        });
        // A repeat of a key that was down before the page listened is no press.
        page.send("keydown", { code: "KeyR", repeat: true });
        expect(told(listener.sample()).pressed).toEqual([]);

        // The pointer's place is measured from the target's corner.
        page.send("pointermove", { clientX: 130, clientY: 90 });
        expect(told(listener.sample())).toEqual({
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
        expect(told(listener.sample())).toEqual({
          down: ["KeyA", "Pointer2"],
          pressed: ["Pointer0", "Pointer2"],
          released: ["Pointer0"],
          axes: { PointerX: 500, PointerY: -30 },
          moved: ["PointerX", "PointerY"],
        });
        // A pointer the browser took away lets go of its buttons, not of keys.
        page.send("pointercancel");
        expect(told(listener.sample())).toEqual({
          down: ["KeyA"],
          pressed: [],
          released: ["Pointer2"],
          axes: { PointerX: 500, PointerY: -30 },
          moved: [],
        });
        // The page loses focus: everything held is let go.
        canvas.send("pointerdown", { button: 0, clientX: 100, clientY: 50 });
        page.send("blur");
        expect(told(listener.sample())).toEqual({
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
            // The devices alone: a page's sound listens for a touch too.
            sounds: false,
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
        const listener = yield* Input.listen;
        const at = { clientX: 10, clientY: 10 };
        // The main button goes down: the one press a page reports as one.
        canvas.send("pointerdown", { ...at, button: 0, buttons: 1 });
        // The secondary goes down while it is held. A page says so with a
        // move, not a press: `buttons` is what is down by then.
        page.send("pointermove", { ...at, button: 2, buttons: 3 });
        expect(told(listener.sample())).toMatchObject({
          down: ["Pointer0", "Pointer2"],
          pressed: ["Pointer0", "Pointer2"],
          released: [],
        });
        // The main button goes up, the secondary still held: a move again.
        page.send("pointermove", { ...at, button: 0, buttons: 2 });
        expect(told(listener.sample())).toMatchObject({
          down: ["Pointer2"],
          pressed: [],
          released: ["Pointer0"],
        });
        // The last button goes up: the one release a page reports as one.
        page.send("pointerup", { ...at, button: 2, buttons: 0 });
        expect(told(listener.sample())).toMatchObject({
          down: [],
          pressed: [],
          released: ["Pointer2"],
        });
        // The release of the last button lets go of every one: of one
        // whose own move the page never sent, too.
        canvas.send("pointerdown", { ...at, button: 0, buttons: 1 });
        page.send("pointerup", { ...at, button: 2, buttons: 0 });
        expect(told(listener.sample())).toMatchObject({
          down: [],
          released: ["Pointer0"],
        });
        // The middle button is the third bit of `buttons`, not the second.
        canvas.send("pointerdown", { ...at, button: 0, buttons: 1 });
        page.send("pointermove", { ...at, button: 1, buttons: 5 });
        expect(told(listener.sample()).down).toEqual(["Pointer0", "Pointer1"]);
        // Let go of outside the window, the page hears of no release: the
        // next move, with nothing down, is how it is known.
        page.send("pointermove", { ...at, button: -1, buttons: 0 });
        expect(told(listener.sample())).toMatchObject({
          down: [],
          released: ["Pointer0", "Pointer1"],
        });
        // A button that went down somewhere else on the page is not one
        // the target hears of, however the pointer moves afterwards.
        page.send("pointermove", { ...at, button: -1, buttons: 1 });
        page.send("pointermove", { ...at, button: 2, buttons: 3 });
        expect(told(listener.sample()).down).toEqual([]);
        // An event that says nothing of what is down, as one made by hand
        // may, is still the press and the release of its own button.
        canvas.send("pointerdown", { ...at, button: 2, buttons: 0 });
        expect(told(listener.sample()).down).toEqual(["Pointer2"]);
        page.send("pointerup", { ...at, button: 2 });
        expect(told(listener.sample()).released).toEqual(["Pointer2"]);
      }).pipe(
        Effect.provide(
          Browser.layer({
            window: page,
            target: canvas,
            gamepads: () => [],
            sounds: false,
          })
        )
      )
    );
  });

  it("measures the pointer from the corner of the page when given no target, and hears its presses there", () => {
    const page = new Listened();
    run(
      Effect.gen(function* () {
        const listener = yield* Input.listen;
        expect(page.listening.get("pointerdown")).toBe(1);
        page.send("pointerdown", { button: 0, clientX: 12, clientY: 34 });
        expect(told(listener.sample())).toEqual({
          down: ["Pointer0"],
          pressed: ["Pointer0"],
          released: [],
          axes: { PointerX: 12, PointerY: 34 },
          moved: ["PointerX", "PointerY"],
        });
      }).pipe(
        Effect.provide(
          Browser.layer({ window: page, gamepads: () => [], sounds: false })
        )
      )
    );
    // A target that is no element is measured from where it is given.
    const bare = new EventTarget();
    run(
      Effect.gen(function* () {
        const listener = yield* Input.listen;
        bare.dispatchEvent(
          Object.assign(new globalThis.Event("pointerdown"), {
            button: 0,
            clientX: 5,
            clientY: 6,
          })
        );
        expect(told(listener.sample()).axes).toEqual({
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
        yield* Input.listen;
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
        yield* Input.listen;
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
        const listener = yield* Input.listen;
        expect(polls).toBe(0);
        pads = [
          null,
          pad(1, [true, false], [0.504, -0.05, -1, 0.099, 0.15]),
          pad(2, [true], [1], false),
        ];
        expect(told(listener.sample())).toEqual({
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
        expect(told(listener.sample())).toEqual({
          down: ["Pad1Button0"],
          pressed: [],
          released: [],
          axes: { Pad1Axis0: 0.5, Pad1Axis2: -1, Pad1Axis4: 0.15 },
          moved: [],
        });
        pads = [null, pad(1, [false, true], [0, 0, -1, 0, 0])];
        expect(told(listener.sample())).toEqual({
          down: ["Pad1Button1"],
          pressed: ["Pad1Button1"],
          released: ["Pad1Button0"],
          axes: { Pad1Axis0: 0, Pad1Axis2: -1, Pad1Axis4: 0 },
          moved: ["Pad1Axis0", "Pad1Axis4"],
        });
        // The page losing focus does not let go of a gamepad's buttons.
        page.send("keydown", { code: "KeyA", repeat: false });
        page.send("blur");
        expect(told(listener.sample())).toEqual({
          down: ["Pad1Button1"],
          pressed: ["KeyA"],
          released: ["KeyA"],
          axes: { Pad1Axis0: 0, Pad1Axis2: -1, Pad1Axis4: 0 },
          moved: [],
        });
        // Unplugged: it lets go of everything.
        pads = [];
        expect(told(listener.sample())).toEqual({
          down: [],
          pressed: [],
          released: ["Pad1Button1"],
          axes: { Pad1Axis0: 0, Pad1Axis2: 0, Pad1Axis4: 0 },
          moved: ["Pad1Axis2"],
        });
        expect(told(listener.sample()).released).toEqual([]);
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
        expect(told((yield* Input.listen).sample()).axes).toEqual({
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

  it("lasts as long as the app, whatever its layer is provided to, and refuses to be read once the app is closed", () => {
    const page = new Listened();
    // Provided to the one line that makes the app, in a scope that ends
    // with it, and heard after it.
    const app = Effect.runSync(
      Effect.scoped(
        App.make(App.define({ plugins: [Flying] })).pipe(
          Effect.provide(
            Browser.layer({ window: page, gamepads: () => [], sounds: false })
          )
        )
      )
    );
    expect(page.total).toBe(7);
    page.send("keydown", { code: "Space", repeat: false });
    page.send("keyup", { code: "Space" });
    app.input();
    app.tick(0.1);
    expect(ship(app).shots).toBe(1);
    // Closed, nobody is listening, and a read says so.
    Effect.runSync(app.close);
    expect(page.total).toBe(0);
    expect(() => app.input()).toThrow(DEVICES_LET_GO);
  });

  it("listens to nothing when its layer is built, and says so when read after the scope it was listened to in has closed", () => {
    const page = new Listened();
    const layer = Browser.layer({
      window: page,
      gamepads: () => [],
      sounds: false,
    });
    const listener = run(
      Effect.gen(function* () {
        // A layer listens to nothing: listening to the devices does.
        yield* Layer.build(layer);
        expect(page.total).toBe(0);
        const listener = yield* Input.listen.pipe(Effect.provide(layer));
        expect(page.total).toBe(7);
        return listener;
      })
    );
    expect(page.total).toBe(0);
    expect(() => listener.sample()).toThrow(DEVICES_LET_GO);
  });

  it("is heard by each app for itself, as two apps of one page are", () => {
    const page = new Listened();
    const [one, two] = Effect.runSync(
      Effect.gen(function* () {
        const one = yield* App.make(App.define({ plugins: [Flying] }));
        const two = yield* App.make(App.define({ plugins: [Flying] }));
        expect(page.total).toBe(14);
        page.send("keydown", { code: "Space", repeat: false });
        page.send("keyup", { code: "Space" });
        one.input();
        one.tick(0.1);
        two.input();
        two.tick(0.1);
        expect(ship(one).shots).toBe(1);
        expect(ship(two).shots).toBe(1);
        return [one, two] as const;
      }).pipe(
        Effect.provide(
          Browser.layer({ window: page, gamepads: () => [], sounds: false })
        )
      )
    );
    // One goes, and the other still hears the page.
    Effect.runSync(one.close);
    expect(page.total).toBe(7);
    page.send("keydown", { code: "Space", repeat: false });
    two.input();
    two.tick(0.1);
    expect(ship(two).shots).toBe(2);
    expect(() => one.input()).toThrow(DEVICES_LET_GO);
    Effect.runSync(two.close);
    expect(page.total).toBe(0);
  });

  it("drives a game through an app, end to end", () => {
    const page = new Listened();
    run(
      Effect.gen(function* () {
        const app = yield* App.make(App.define({ plugins: [Flying] }));
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
    const scope = Scope.makeUnsafe();
    const loaded = await Effect.runPromise(
      Assets.load(Art).pipe(
        Scope.provide(scope),
        Effect.provide(Assets.layerMemory(files))
      )
    );
    expect(loaded.one.width).toBe(1);
    expect(loaded.two.width).toBe(4);
    expect(given.toSorted((a, b) => a - b)).toEqual([2, 3]);
    expect(closed).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(closed.toSorted((a, b) => a - b)).toEqual([2, 3]);

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
      Driver.run(App.define({ plugins: [Flying] }), {
        hz: 60,
        ready: (app) =>
          Effect.sync(() => {
            made = app;
          }),
      }).pipe(Effect.provide(Browser.layer({ gamepads: () => [] })))
    );
    // The frame loop asks the page for its frames, and watches its tab.
    expect(page.requested.size).toBe(1);
    expect(page.visibility.size).toBe(1);
    // The keyboard and the pointer are listened to on the window. A game
    // with no sound opens none, and waits for no touch.
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

  it("reads an asset's path against the document's base, as fetch does, and keeps a loader of the game's own", async () => {
    makePage();
    // The page is at /play/, and its <base href> says its files are at /v2/.
    vi.stubGlobal("location", new URL("https://game.test/play/"));
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
      baseURI: "https://game.test/v2/",
    });
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: URL) => {
      asked.push(url.href);
      return Promise.resolve(new Response("fetched"));
    });
    const notes = Effect.scoped(
      Assets.load(
        Assets.bundle("br/Notes", {
          level: Assets.text("levels/one.txt"),
          rooted: Assets.text("/rooted.txt"),
          far: Assets.text("https://cdn.test/far.txt"),
        })
      )
    );
    const loaded = await Effect.runPromise(
      notes.pipe(
        Effect.provide(Browser.layer({ gamepads: () => [], sounds: false }))
      )
    );
    expect(loaded).toEqual({
      level: "fetched",
      rooted: "fetched",
      far: "fetched",
    });
    expect(asked.toSorted()).toEqual([
      "https://cdn.test/far.txt",
      "https://game.test/rooted.txt",
      "https://game.test/v2/levels/one.txt",
    ]);
    // Files of a test's own, around the page's layer, are what is read.
    asked.length = 0;
    const own = await Effect.runPromise(
      notes.pipe(
        Effect.provide(
          Layer.provide(
            Browser.layer({ gamepads: () => [], sounds: false }),
            Assets.layerMemory({
              "levels/one.txt": "mine",
              "/rooted.txt": "mine",
              "https://cdn.test/far.txt": "mine",
            })
          )
        )
      )
    );
    expect(own).toEqual({ level: "mine", rooted: "mine", far: "mine" });
    expect(asked).toEqual([]);
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
      Driver.run(App.define({ plugins: [Sound] }), {
        hz: 60,
        ready: (app) =>
          Effect.sync(() => {
            made = app;
          }),
      }),
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

  it("tells the other peers over a BroadcastChannel that this one left, before the page goes for good", async () => {
    const page = makePage();
    const posted: unknown[] = [];
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: unknown = null;
        postMessage(data: unknown): void {
          posted.push(data);
        }
        close(): void {}
      }
    );
    Browser.runMain(
      Driver.run(
        Effect.flatMap(
          Session.make(App.define({ plugins: [Flying] }), {
            seed: 1,
            me: "ada",
            others: ["grace"],
            delta: 1 / 60,
          }),
          Transport.connect
        )
      ).pipe(Effect.provide(Transport.layerBroadcastChannel("room", "ada"))),
      { gamepads: () => [], teardown: (_, onExit) => onExit(0) }
    );
    await settle();
    page.repaint(0);
    expect(posted[0]).toBe(Message.encodeNotice({ joined: "ada" }));
    expect(posted).not.toContain(Message.encodeNotice({ left: "ada" }));
    page.window.send("pagehide", { persisted: false });
    // At once: the page may run nothing after it.
    expect(posted.at(-1)).toBe(Message.encodeNotice({ left: "ada" }));
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

describe("a page's sound", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** What a source that plays over and over was asked, as the stand-in notes it. */
  interface Looped {
    readonly buffer: unknown;
    readonly into: unknown;
    /** What its volume was told, in order: set to, ramp to, or cancel, and when. */
    readonly levels: (readonly [string, ...number[]])[];
    /** When it was told to stop, if it was. */
    stopped: number | undefined;
    /** There, and true, while it is to play to its end and no further. */
    once?: true;
  }
  /** A stand-in for the page's audio, which notes what it is asked. */
  const makeAudio = () => {
    const destination = { name: "speakers" };
    interface Gain {
      readonly gain: {
        value: number;
        setValueAtTime(value: number, time: number): void;
        linearRampToValueAtTime(value: number, time: number): void;
        cancelScheduledValues(time: number): void;
      };
      readonly levels: (readonly [string, ...number[]])[];
      into: unknown;
      connect(to: unknown): unknown;
    }
    const audio = {
      destination,
      state: "running",
      /** The audio's own clock, which the test turns. */
      currentTime: 0,
      started: [] as {
        readonly buffer: unknown;
        readonly rate: number;
        readonly volume: number;
        readonly into: unknown;
      }[],
      /** Every source that was started as a channel's track. */
      loops: [] as Looped[],
      resumed: 0,
      suspended: 0,
      closed: 0,
      /** What was streamed into it, each with the volume it plays at. */
      streams: [] as { readonly media: unknown; readonly gain: Gain }[],
      createMediaElementSource(media: unknown) {
        return {
          connect(to: unknown) {
            audio.streams.push({ media, gain: to as Gain });
            return to;
          },
        };
      },
      createBufferSource() {
        let gain: Gain | undefined;
        let looped: Looped | undefined;
        let loop = false;
        const source = {
          buffer: undefined as unknown,
          get loop(): boolean {
            return loop;
          },
          set loop(value: boolean) {
            loop = value;
            if (looped !== undefined) {
              if (value) {
                delete looped.once;
              } else {
                looped.once = true;
              }
            }
          },
          playbackRate: { value: 1 },
          connect(to: unknown) {
            gain = to as Gain;
            return to;
          },
          start() {
            // A track's volume is led there; a cue's is set.
            if (source.loop || (gain?.levels.length ?? 0) > 0) {
              looped = {
                buffer: source.buffer,
                into: gain?.into,
                levels: gain?.levels ?? [],
                stopped: undefined,
                ...(source.loop ? {} : { once: true as const }),
              };
              audio.loops.push(looped);
              return;
            }
            audio.started.push({
              buffer: source.buffer,
              rate: source.playbackRate.value,
              volume: gain?.gain.value ?? Number.NaN,
              into: gain?.into,
            });
          },
          stop(when?: number) {
            if (looped !== undefined) {
              looped.stopped = when ?? audio.currentTime;
            }
          },
        };
        return source;
      },
      createGain() {
        const levels: (readonly [string, ...number[]])[] = [];
        const gain: Gain = {
          gain: {
            value: 1,
            setValueAtTime(value, time) {
              gain.gain.value = value;
              levels.push(["set", value, time]);
            },
            // The stand-in is there at once: what is read back is where it
            // was last told to go.
            linearRampToValueAtTime(value, time) {
              gain.gain.value = value;
              levels.push(["ramp", value, time]);
            },
            cancelScheduledValues(time) {
              levels.push(["cancel", time]);
            },
          },
          levels,
          into: undefined,
          connect(to: unknown) {
            gain.into = to;
            return to;
          },
        };
        return gain;
      },
      suspend() {
        audio.suspended++;
        audio.state = "suspended";
        return Promise.resolve();
      },
      resume() {
        audio.resumed++;
        audio.state = "running";
        return Promise.resolve();
      },
      close() {
        audio.closed++;
        return Promise.resolve();
      },
    };
    return audio;
  };
  const sounds = {
    "/coin.wav": new Uint8Array(3),
    "/thud.wav": new Uint8Array(5),
    "/noise.wav": new Uint8Array(1),
  };
  /** Makes a sound of a file: one of a single byte is none. */
  const decodeInto =
    (decoded: number[]) =>
    (data: ArrayBuffer): Promise<unknown> => {
      decoded.push(data.byteLength);
      return data.byteLength === 1
        ? Promise.reject(new Error("Unable to decode audio data"))
        : Promise.resolve({ samples: data.byteLength });
    };
  /** A stand-in for what plays a streamed track, which notes what it is asked. */
  const makeMedia = (url: string, broken: boolean) => {
    const media = {
      url,
      loop: false,
      playing: false,
      plays: 0,
      pauses: 0,
      play(): Promise<void> {
        media.plays++;
        if (broken) {
          return Promise.reject(
            new Error("The element has no supported sources.")
          );
        }
        media.playing = true;
        return Promise.resolve();
      },
      pause(): void {
        media.pauses++;
        media.playing = false;
      },
    };
    return media;
  };
  const build = async (
    files: Readonly<Record<string, string | Sound.Clip>>,
    options: {
      readonly volume?: number;
      readonly loader?: Assets.LoaderShape;
      readonly decode?: (data: ArrayBuffer) => Promise<unknown>;
      /** Whether what is streamed cannot be played. */
      readonly brokenMedia?: boolean;
      /** Whether the audio is one that takes no stream. */
      readonly noStreams?: boolean;
    } = {}
  ) => {
    const page = new Listened();
    const audio = makeAudio();
    if (options.noStreams === true) {
      delete (audio as { createMediaElementSource?: unknown })
        .createMediaElementSource;
    }
    const streamed: ReturnType<typeof makeMedia>[] = [];
    const display = Driver.makeManualDisplay();
    let made = 0;
    /** The length of each file that was given to be decoded. */
    const decoded: number[] = [];
    const decode = options.decode ?? decodeInto(decoded);
    const logged: string[] = [];
    const scope = Scope.makeUnsafe();
    // Opened in a scope of the test's, as an app opens it: the layer is
    // provided to the opening alone.
    const output = await Effect.runPromise(
      Sound.open.pipe(
        Scope.provide(scope),
        Effect.provide(
          Browser.layerSound(files, {
            window: page,
            audio: () => {
              made++;
              return audio;
            },
            decode,
            media: (url) => {
              const media = makeMedia(url, options.brokenMedia === true);
              streamed.push(media);
              return media;
            },
            ...(options.volume === undefined ? {} : { volume: options.volume }),
          })
        ),
        Effect.provideService(Driver.Display, display),
        Effect.provide(
          Layer.mergeAll(
            options.loader === undefined
              ? Assets.layerMemory(sounds)
              : Layer.succeed(Assets.Loader, options.loader),
            Logger.layer([
              Logger.make((entry) => {
                logged.push(String(entry.message));
              }),
            ])
          )
        )
      )
    );
    await settle();
    return {
      page,
      audio,
      display,
      decoded,
      logged,
      streamed,
      made: () => made,
      output,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  };

  /** What the page's sound says when it is played after it was let go. */
  const LET_GO =
    /The page's sound was played after it was let go: the app that opened it was closed, or the scope Sound\.open ran in had ended/u;

  /** What is said, once, of a cue that came before the page was touched. */
  const UNTOUCHED = (cue: string): string =>
    `The cue "${cue}" was asked for before the page was touched, and is not played: a browser lets a page make no sound until its user has pressed a key or a button, and a cue that came late would be worse than none. A track asked for then starts at the first touch. This is said once.`;

  it("makes the page's audio at the first touch, and plays a cue's file through it", async () => {
    const { audio, decoded, logged, made, output, page } = await build({
      coin: "/coin.wav",
      thud: "/thud.wav",
    });
    // The files are decoded as they arrive, which needs no touch.
    expect(decoded.toSorted((a, b) => a - b)).toEqual([3, 5]);
    // A page may not make a sound before its user has touched it: nothing
    // is made, and what is asked for is not played, then or later.
    expect(made()).toBe(0);
    expect(Object.fromEntries(page.listening)).toEqual({
      pointerdown: 1,
      keydown: 1,
    });
    output.play("coin", 1, 1);
    expect(audio.started).toEqual([]);
    page.send("keydown", { code: "Enter" });
    expect(made()).toBe(1);
    expect(audio.started).toEqual([]);
    // At once: what the touch itself set off is heard.
    output.play("coin", 0.5, 2);
    output.play("thud", 1, 1);
    expect(audio.started).toEqual([
      { buffer: { samples: 3 }, rate: 2, volume: 0.5, into: audio.destination },
      { buffer: { samples: 5 }, rate: 1, volume: 1, into: audio.destination },
    ]);
    // Another touch makes no second audio, and wakes one that was put to sleep.
    page.send("pointerdown");
    expect(made()).toBe(1);
    expect(audio.resumed).toBe(0);
    audio.state = "suspended";
    page.send("pointerdown");
    expect(audio.resumed).toBe(1);
    expect(decoded.length).toBe(2);
    // The cue that came before the touch was said, and nothing else.
    expect(logged).toEqual([UNTOUCHED("coin")]);
  });

  it("says once that a cue came before the first touch, by the first one's name, and not where no touch would help", async () => {
    const { audio, close, logged, output, page } = await build({
      coin: "/coin.wav",
    });
    const clip = Sound.clip("/level/chirp.wav", { samples: 2 });
    // A clip is named as it is; a track is not a cue, and waits.
    output.music("score", "coin", 1, 0, false);
    expect(logged).toEqual([]);
    output.play(clip, 1, 1);
    output.play("coin", 1, 1);
    output.play("nothing", 1, 1);
    expect(logged).toEqual([
      UNTOUCHED("/level/chirp.wav"),
      // What has no file is said for itself, as ever.
      'The sound "nothing" was played and has no file. The page\'s sounds are: coin.',
    ]);
    // Touched, a cue is played, and nothing more is said of it: nor when
    // the audio sleeps, which is the page being away.
    page.send("pointerdown");
    output.play("coin", 1, 1);
    audio.state = "suspended";
    output.play("coin", 1, 1);
    expect(audio.started.length).toBe(1);
    expect(logged.length).toBe(2);
    // Let go, the page's audio refuses to play, and has nothing to note.
    await close();
    expect(() => output.play("coin", 1, 1)).toThrow(LET_GO);
    expect(logged.length).toBe(2);

    // Let go before it was ever touched, it refuses all the same.
    const gone = await build({ coin: "/coin.wav" });
    await gone.close();
    expect(() => gone.output.play("coin", 1, 1)).toThrow(LET_GO);
    expect(gone.logged).toEqual([]);
  });

  it("plays nothing on a page with no Web Audio, touched or not, and has nothing to say of it", async () => {
    // As it is here: nothing is given to make an audio with, and there
    // is no AudioContext to make one of.
    expect(typeof AudioContext).toBe("undefined");
    const page = new Listened();
    const logged: string[] = [];
    const scope = Scope.makeUnsafe();
    const output = await Effect.runPromise(
      Sound.open.pipe(
        Scope.provide(scope),
        Effect.provide(
          Browser.layerSound(
            { coin: "/coin.wav" },
            { window: page, decode: decodeInto([]) }
          )
        ),
        Effect.provideService(Driver.Display, Driver.makeManualDisplay()),
        Effect.provide(
          Layer.mergeAll(
            Assets.layerMemory(sounds),
            Logger.layer([
              Logger.make((entry) => {
                logged.push(String(entry.message));
              }),
            ])
          )
        )
      )
    );
    await settle();
    output.play("coin", 1, 1);
    output.music("score", "coin", 1, 0, false);
    page.send("pointerdown");
    output.play("coin", 1, 1);
    // No touch would have helped, so nothing is said of one.
    expect(logged).toEqual([]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("plays every cue at the volume it was given for all of them", async () => {
    const { audio, output, page } = await build(
      { coin: "/coin.wav" },
      { volume: 0.5 }
    );
    page.send("pointerdown");
    await settle();
    output.play("coin", 0.5, 1);
    output.play("coin", 1, 1);
    expect(audio.started.map((one) => one.volume)).toEqual([0.25, 0.5]);
  });

  it("says once of a cue that has no file, could not be fetched or is no sound, and plays nothing for it", async () => {
    const { audio, logged, output, page } = await build({
      coin: "/coin.wav",
      noise: "/noise.wav",
      lost: "/lost.wav",
    });
    // Said when the request fails, or the file turns out to be no sound.
    expect(logged.toSorted()).toEqual([
      'The sound "lost" (/lost.wav) will not be played: There is no such file.',
      'The sound "noise" (/noise.wav) will not be played: Unable to decode audio data',
    ]);
    page.send("pointerdown");
    expect(logged.length).toBe(2);
    for (let i = 0; i < 3; i++) {
      output.play("noise", 1, 1);
      output.play("lost", 1, 1);
      output.play("laser", 1, 1);
      // A name every object has is no cue either.
      output.play("toString", 1, 1);
    }
    expect(audio.started).toEqual([]);
    expect(logged.slice(2)).toEqual([
      'The sound "laser" was played and has no file. The page\'s sounds are: coin, noise, lost.',
      'The sound "toString" was played and has no file. The page\'s sounds are: coin, noise, lost.',
    ]);
    output.play("coin", 1, 1);
    expect(audio.started.length).toBe(1);
  });

  it("plays a cue once its file has arrived, and gives up a file still on its way when it is let go", async () => {
    const waiting = new Map<string, (bytes: Uint8Array) => void>();
    const givenUp: string[] = [];
    const loader: Assets.LoaderShape = {
      bytes: (url) =>
        Effect.callback<Uint8Array, Assets.AssetFailed>((resume) => {
          waiting.set(url, (bytes) => resume(Effect.succeed(bytes)));
          return Effect.sync(() => {
            givenUp.push(url);
          });
        }),
    };
    const { audio, close, decoded, output, page } = await build(
      { coin: "/coin.wav", thud: "/thud.wav" },
      { loader }
    );
    // Both asked for at once, and neither is here.
    expect(Array.from(waiting.keys()).toSorted()).toEqual([
      "/coin.wav",
      "/thud.wav",
    ]);
    page.send("pointerdown");
    expect(decoded).toEqual([]);
    output.play("coin", 1, 1);
    expect(audio.started).toEqual([]);
    waiting.get("/coin.wav")!(new Uint8Array(7));
    await settle();
    expect(decoded).toEqual([7]);
    output.play("coin", 1, 1);
    // The one that was asked for too early is not played late.
    expect(audio.started.length).toBe(1);
    expect(givenUp).toEqual([]);
    await close();
    expect(givenUp).toEqual(["/thud.wav"]);
  });

  it("closes the audio and stops listening when its scope closes, and refuses to play after", async () => {
    const { audio, close, made, output, page } = await build({
      coin: "/coin.wav",
    });
    page.send("pointerdown");
    await settle();
    output.play("coin", 1, 1);
    expect(audio.closed).toBe(0);
    await close();
    expect(audio.closed).toBe(1);
    expect(page.total).toBe(0);
    expect(() => output.play("coin", 1, 1)).toThrow(LET_GO);
    expect(() => output.music("score", "coin", 1, 0)).toThrow(LET_GO);
    expect(audio.started.length).toBe(1);
    page.send("pointerdown");
    expect(made()).toBe(1);

    // A file that is still being decoded when the audio is let go starts
    // nothing when it is done, not even the track that waited for it.
    let done = (_sound: unknown): void => {};
    const late = await build(
      { coin: "/coin.wav" },
      {
        decode: () =>
          new Promise((resolve) => {
            done = resolve;
          }),
      }
    );
    late.page.send("pointerdown");
    late.output.music("score", "coin", 1, 0);
    await late.close();
    done({ samples: 3 });
    await settle();
    expect(late.audio.started).toEqual([]);
    expect(late.audio.loops).toEqual([]);

    // One that was never touched made no audio, and has none to close.
    const untouched = await build({ coin: "/coin.wav" });
    await untouched.close();
    expect(untouched.made()).toBe(0);
    expect(untouched.audio.closed).toBe(0);
    expect(untouched.page.total).toBe(0);
  });

  it("starts a track when it can, plays it over and over, and fades from one to the next", async () => {
    const { audio, made, output, page } = await build(
      { theme: "/coin.wav", drip: "/thud.wav" },
      { volume: 0.5 }
    );
    // Asked for before the first touch: music is not a cue, which would be
    // late. It is what should be playing, and starts when it can.
    output.music("score", "theme", 0.8, 2);
    expect(made()).toBe(0);
    expect(audio.loops).toEqual([]);
    audio.currentTime = 10;
    page.send("keydown", { code: "Enter" });
    // From silence to its volume, of the page's own, over the two seconds.
    expect(audio.loops).toEqual([
      {
        buffer: { samples: 3 },
        into: audio.destination,
        levels: [
          ["set", 0, 10],
          ["ramp", 0.4, 12],
        ],
        stopped: undefined,
      },
    ]);
    // It is no cue: nothing was started to play once.
    expect(audio.started).toEqual([]);

    // The same track, softer: the one source, turned down from where it is.
    audio.currentTime = 20;
    output.music("score", "theme", 0.2, 1);
    expect(audio.loops.length).toBe(1);
    expect(audio.loops[0]!.levels.slice(2)).toEqual([
      ["cancel", 20],
      ["set", 0.4, 20],
      ["ramp", 0.1, 21],
    ]);
    expect(audio.loops[0]!.stopped).toBeUndefined();

    // Another track: the first fades out and stops when it has, while the
    // second fades in.
    audio.currentTime = 30;
    output.music("score", "drip", 1, 4);
    expect(audio.loops.length).toBe(2);
    expect(audio.loops[0]!.levels.slice(5)).toEqual([
      ["cancel", 30],
      ["set", 0.1, 30],
      ["ramp", 0, 34],
    ]);
    expect(audio.loops[0]!.stopped).toBe(34);
    expect(audio.loops[1]).toEqual({
      buffer: { samples: 5 },
      into: audio.destination,
      levels: [
        ["set", 0, 30],
        ["ramp", 0.5, 34],
      ],
      stopped: undefined,
    });

    // Silence: it fades out, stops, and nothing takes its place.
    audio.currentTime = 40;
    output.music("score", undefined, 0, 0.5);
    expect(audio.loops.length).toBe(2);
    expect(audio.loops[1]!.levels.slice(2)).toEqual([
      ["cancel", 40],
      ["set", 0.5, 40],
      ["ramp", 0, 40.5],
    ]);
    expect(audio.loops[1]!.stopped).toBe(40.5);
    // Silence again changes nothing, and the first is left as it was.
    output.music("score", undefined, 0, 0.5);
    expect(audio.loops[1]!.levels.length).toBe(5);
    expect(audio.loops[0]!.levels.length).toBe(8);
    // At once is a fade of no time.
    audio.currentTime = 50;
    output.music("score", "theme", 1, 0);
    expect(audio.loops[2]!.levels).toEqual([
      ["set", 0, 50],
      ["ramp", 0.5, 50],
    ]);
  });

  it("plays a track to its end and no further when it is asked to, and over and over when it is asked that after all", async () => {
    const { audio, output, page } = await build({
      fanfare: "/coin.wav",
      theme: "/thud.wav",
    });
    page.send("pointerdown");
    output.music("score", "fanfare", 1, 0.5, true);
    expect(audio.loops).toEqual([
      {
        buffer: { samples: 3 },
        into: audio.destination,
        levels: [
          ["set", 0, 0],
          ["ramp", 1, 0.5],
        ],
        stopped: undefined,
        once: true,
      },
    ]);
    // It is a track all the same, and not a cue: it is on its channel, and
    // another track fades it out if it has not ended.
    expect(audio.started).toEqual([]);
    audio.currentTime = 1;
    output.music("score", "theme", 1, 2);
    expect(audio.loops[0]!.stopped).toBe(3);
    expect(audio.loops[1]!.once).toBeUndefined();
    // The track that is playing, asked to stop at its end after all, and
    // then to go on again: the one source, told so.
    output.music("score", "theme", 1, 2, true);
    expect(audio.loops.length).toBe(2);
    expect(audio.loops[1]!.once).toBe(true);
    output.music("score", "theme", 1, 2, false);
    expect(audio.loops[1]!.once).toBeUndefined();
    expect(audio.loops.length).toBe(2);
  });

  it("streams a track that is given as a stream: fetched as it plays, and faded and stopped as any track", async () => {
    const { audio, decoded, logged, made, output, page, streamed } =
      await build(
        { theme: Browser.stream("/theme.ogg"), coin: "/coin.wav" },
        { volume: 0.5 }
      );
    // Only the file that is to be decoded was fetched, and nothing was
    // said of the other.
    expect(decoded).toEqual([3]);
    expect(logged).toEqual([]);
    // Asked for before the first touch, it waits for it, as any track.
    output.music("score", "theme", 0.8, 2);
    expect(made()).toBe(0);
    expect(streamed).toEqual([]);
    audio.currentTime = 10;
    page.send("keydown", { code: "Enter" });
    expect(streamed.length).toBe(1);
    expect(streamed[0]).toMatchObject({
      url: "/theme.ogg",
      loop: true,
      playing: true,
      plays: 1,
    });
    // It plays into the page's audio, on a volume of its own, led from
    // silence as a decoded track's is; and it is no decoded track.
    expect(audio.streams.length).toBe(1);
    expect(audio.streams[0]!.media).toBe(streamed[0]);
    expect(audio.streams[0]!.gain.into).toBe(audio.destination);
    expect(audio.streams[0]!.gain.levels).toEqual([
      ["set", 0, 10],
      ["ramp", 0.4, 12],
    ]);
    expect(audio.loops).toEqual([]);
    expect(audio.started).toEqual([]);

    // Softer, and to its end and no further: the one stream, told so.
    audio.currentTime = 20;
    output.music("score", "theme", 0.2, 1, true);
    expect(streamed.length).toBe(1);
    expect(streamed[0]!.loop).toBe(false);
    expect(audio.streams[0]!.gain.levels.slice(2)).toEqual([
      ["cancel", 20],
      ["set", 0.4, 20],
      ["ramp", 0.1, 21],
    ]);
    output.music("score", "theme", 0.2, 1);
    expect(streamed[0]!.loop).toBe(true);

    // Another track, at once: the stream is silenced and stopped, and
    // the other starts.
    output.music("score", "coin", 1, 0);
    expect(audio.streams[0]!.gain.levels.at(-1)).toEqual(["ramp", 0, 20]);
    expect(streamed[0]).toMatchObject({ playing: false, pauses: 1 });
    expect(audio.loops.length).toBe(1);

    // Back to it, and away over a moment: it is a new stream, and is
    // stopped when the moment has gone, and not before.
    output.music("score", "theme", 1, 0);
    expect(streamed.length).toBe(2);
    expect(audio.loops[0]!.stopped).toBe(20);
    output.music("score", undefined, 0, 0.02);
    expect(streamed[1]!.playing).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(streamed[1]).toMatchObject({ playing: false, pauses: 1 });
    expect(streamed[0]!.pauses).toBe(1);
  });

  it("takes a stream as it is, on any channel, and plays none as a cue", async () => {
    const { audio, display, logged, output, page, streamed } = await build({
      theme: Browser.stream("/theme.ogg"),
    });
    const wind = Browser.stream("/wind.ogg");
    // A clip like any other, named for where it is.
    expect(wind).toBeInstanceOf(Sound.Clip);
    expect(wind.name).toBe("/wind.ogg");
    page.send("pointerdown");
    output.music("air", wind, 0.3, 0);
    output.music("score", "theme", 1, 0);
    expect(streamed.map((media) => media.url)).toEqual([
      "/wind.ogg",
      "/theme.ogg",
    ]);
    // One channel stops; the other plays on.
    output.music("air", undefined, 0, 0);
    expect(streamed.map((media) => media.playing)).toEqual([false, true]);
    // What was stopped is done with: the page hidden and seen again
    // starts only what was playing.
    display.hide();
    display.show();
    expect(streamed.map((media) => [media.playing, media.plays])).toEqual([
      [false, 1],
      [true, 2],
    ]);
    // A cue is to be heard at once, and a stream is not there yet.
    output.play(wind, 1, 1);
    output.play("theme", 1, 1);
    output.play(wind, 1, 1);
    expect(audio.started).toEqual([]);
    expect(streamed.length).toBe(2);
    expect(logged).toEqual([
      'The sound "/wind.ogg" is streamed, which is for a channel\'s track: as a cue it is not played. A cue is a file given by its URL, or Browser.sound.',
      'The sound "/theme.ogg" is streamed, which is for a channel\'s track: as a cue it is not played. A cue is a file given by its URL, or Browser.sound.',
    ]);
    // Asked to play once from the start, it is started so.
    output.music("jingle", Browser.stream("/jingle.ogg"), 1, 0, true);
    expect(streamed.at(-1)).toMatchObject({
      url: "/jingle.ogg",
      loop: false,
      playing: true,
    });
  });

  it("stops what is streamed while the page is hidden and when its scope closes, and starts it when the page is seen again", async () => {
    const { audio, close, display, output, page, streamed } = await build({
      theme: Browser.stream("/theme.ogg"),
      other: Browser.stream("/other.ogg"),
    });
    page.send("pointerdown");
    output.music("score", "theme", 1, 0);
    output.music("air", "other", 1, 0);
    // One of the two is on its way out when the page is hidden.
    output.music("air", undefined, 0, 30);
    display.hide();
    // It keeps a time of its own, which the audio's sleep does not stop.
    expect(audio.suspended).toBe(1);
    expect(streamed.map((media) => media.playing)).toEqual([false, false]);
    display.show();
    expect(streamed.map((media) => [media.playing, media.plays])).toEqual([
      [true, 2],
      [true, 2],
    ]);
    // One more on its way out, for a moment that has not gone when the
    // scope closes.
    output.music("score", undefined, 0, 0.01);
    const before = streamed.map((media) => media.pauses);
    await close();
    expect(streamed.map((media) => media.playing)).toEqual([false, false]);
    expect(streamed.map((media) => media.pauses)).toEqual(
      before.map((pauses) => pauses + 1)
    );
    // Nothing is left waiting to stop one, and nothing is started after.
    expect(() => output.music("score", "other", 1, 0)).toThrow(LET_GO);
    display.show();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(streamed.length).toBe(2);
    expect(streamed.map((media) => media.plays)).toEqual([2, 2]);
    expect(streamed.map((media) => media.pauses)).toEqual(
      before.map((pauses) => pauses + 1)
    );
  });

  it("says once of a stream that cannot be played, and of an audio that takes none", async () => {
    const broken = await build(
      { theme: Browser.stream("/gone.ogg") },
      { brokenMedia: true }
    );
    broken.page.send("pointerdown");
    broken.output.music("score", "theme", 1, 0);
    broken.output.music("score", undefined, 0, 0);
    broken.output.music("score", "theme", 1, 0);
    await settle();
    expect(broken.logged).toEqual([
      'The sound "/gone.ogg" will not be played: The element has no supported sources.',
    ]);
    const deaf = await build(
      { theme: Browser.stream("/theme.ogg"), coin: "/coin.wav" },
      { noStreams: true }
    );
    deaf.page.send("pointerdown");
    deaf.output.music("score", "theme", 1, 0);
    deaf.output.music("score", "theme", 0.5, 0);
    expect(deaf.streamed).toEqual([]);
    expect(deaf.logged).toEqual([
      'The sound "/theme.ogg" is streamed, and the page\'s audio cannot take a stream: it will not be played.',
    ]);
    // What it can play, it plays.
    deaf.output.music("score", "coin", 1, 0);
    expect(deaf.audio.loops.length).toBe(1);
  });

  it("sleeps while the page is hidden, music and all, and wakes when it is seen again", async () => {
    const { audio, close, display, output, page } = await build({
      theme: "/coin.wav",
    });
    // Before it was ever touched there is no audio to put to sleep, and
    // the page is not watched.
    expect(display.watching).toBe(0);
    display.hide();
    display.show();
    expect([audio.suspended, audio.resumed]).toEqual([0, 0]);
    page.send("pointerdown");
    page.send("pointerdown");
    expect(display.watching).toBe(1);
    output.music("score", "theme", 1, 1);
    display.hide();
    expect([audio.suspended, audio.resumed]).toEqual([1, 0]);
    // Music that is asked for meanwhile is what it wakes to: nothing is
    // forgotten.
    output.music("score", undefined, 0, 0);
    // A cue is: started now it would wait, and every cue that waited
    // would be heard at once when the audio wakes.
    output.play("theme", 1, 1);
    output.play("theme", 1, 1);
    expect(audio.started).toEqual([]);
    // Seen again, the audio takes its time to wake, as a laptop's does
    // when its lid is opened, while the game goes on at once.
    const waking = audio.resume.bind(audio);
    audio.resume = () => {
      audio.resumed++;
      return Promise.resolve();
    };
    display.show();
    expect([audio.suspended, audio.resumed]).toEqual([1, 1]);
    expect(audio.state).toBe("suspended");
    output.play("theme", 1, 1);
    expect(audio.started).toEqual([]);
    // Awake, a cue is played, and none of the ones that came too early.
    audio.resume = waking;
    audio.state = "running";
    output.play("theme", 0.5, 1);
    expect(audio.started.length).toBe(1);
    expect(audio.started[0]!.volume).toBe(0.5);
    expect(audio.loops[0]!.stopped).toBe(0);
    // The browser can put it to sleep for reasons of its own, and by
    // other names: a touch wakes it from any of them.
    audio.state = "interrupted";
    output.play("theme", 1, 1);
    expect(audio.started.length).toBe(1);
    page.send("keydown", { code: "Enter" });
    expect(audio.resumed).toBe(2);
    expect(audio.state).toBe("running");
    // An audio that does not say how it is, as one of your own may not,
    // is taken to be running.
    delete (audio as { state?: string }).state;
    output.play("theme", 1, 1);
    expect(audio.started.length).toBe(2);
    page.send("keydown", { code: "Enter" });
    expect(audio.resumed).toBe(2);
    audio.state = "running";
    await close();
    expect(display.watching).toBe(0);
    display.hide();
    expect(audio.suspended).toBe(1);
  });

  it("plays each channel by itself, beside the cues", async () => {
    const { audio, output, page } = await build({
      theme: "/coin.wav",
      wind: "/thud.wav",
    });
    page.send("pointerdown");
    output.music("score", "theme", 1, 1);
    output.music("air", "wind", 0.3, 1);
    output.play("theme", 1, 1);
    expect(audio.loops.map((loop) => loop.buffer)).toEqual([
      { samples: 3 },
      { samples: 5 },
    ]);
    // A cue of the same file is a sound of its own, played once.
    expect(audio.started.length).toBe(1);
    // One channel goes quiet; the other is not touched.
    audio.currentTime = 5;
    output.music("air", undefined, 0, 2);
    expect(audio.loops[1]!.stopped).toBe(7);
    expect(audio.loops[0]!.stopped).toBeUndefined();
    expect(audio.loops[0]!.levels.length).toBe(2);
    // The same track on two channels is played twice.
    output.music("air", "theme", 1, 0);
    expect(audio.loops.length).toBe(3);
    expect(audio.loops[2]!.buffer).toEqual({ samples: 3 });
  });

  it("starts a track whose file was not there yet when it is, and says once of one that has no file", async () => {
    const waiting = new Map<string, (bytes: Uint8Array) => void>();
    const loader: Assets.LoaderShape = {
      bytes: (url) =>
        Effect.callback<Uint8Array, Assets.AssetFailed>((resume) => {
          waiting.set(url, (bytes) => resume(Effect.succeed(bytes)));
        }),
    };
    const { audio, logged, output, page } = await build(
      { theme: "/coin.wav", drip: "/thud.wav" },
      { loader }
    );
    page.send("pointerdown");
    output.music("score", "theme", 1, 1);
    // What it changed its mind to before either file came is what plays.
    output.music("score", "drip", 0.5, 1);
    output.music("air", "hiss", 1, 1);
    output.music("air", "hiss", 0.5, 1);
    expect(audio.loops).toEqual([]);
    audio.currentTime = 3;
    waiting.get("/coin.wav")!(new Uint8Array(7));
    await settle();
    expect(audio.loops).toEqual([]);
    waiting.get("/thud.wav")!(new Uint8Array(9));
    await settle();
    expect(audio.loops).toEqual([
      {
        buffer: { samples: 9 },
        into: audio.destination,
        levels: [
          ["set", 0, 3],
          ["ramp", 0.5, 4],
        ],
        stopped: undefined,
      },
    ]);
    expect(logged).toEqual([
      'The sound "hiss" was played and has no file. The page\'s sounds are: theme, drip.',
    ]);
  });

  it("plays a clip as it plays a file of its own, with nothing said of a name it does not have", async () => {
    const { audio, logged, output, page } = await build({});
    page.send("pointerdown");
    const chirp = Sound.clip("/chirp.wav", { samples: 11 });
    const wind = Sound.clip("/wind.ogg", { samples: 99 });
    output.play(chirp, 0.5, 2);
    output.music("air", wind, 0.25, 1);
    expect(audio.started).toEqual([
      {
        buffer: { samples: 11 },
        rate: 2,
        volume: 0.5,
        into: audio.destination,
      },
    ]);
    expect(audio.loops.map((loop) => loop.buffer)).toEqual([{ samples: 99 }]);
    // Another clip of the same file is another track: the one fades to it.
    const again = Sound.clip("/wind.ogg", { samples: 98 });
    output.music("air", again, 0.25, 1);
    expect(audio.loops.map((loop) => loop.buffer)).toEqual([
      { samples: 99 },
      { samples: 98 },
    ]);
    expect(audio.loops[0]!.stopped).toBe(1);
    // The clip it is playing, at another volume, is the one source still.
    output.music("air", again, 0.5, 1);
    expect(audio.loops.length).toBe(2);
    expect(audio.loops[1]!.levels.at(-1)).toEqual(["ramp", 0.5, 1]);
    expect(logged).toEqual([]);
  });

  it("refuses to play music after its scope closes, and plays none in a page that has no audio", async () => {
    const { audio, close, output, page } = await build({ theme: "/coin.wav" });
    page.send("pointerdown");
    output.music("score", "theme", 1, 1);
    expect(audio.loops.length).toBe(1);
    await close();
    expect(audio.closed).toBe(1);
    expect(() => output.music("score", "theme", 0.5, 1)).toThrow(LET_GO);
    expect(() => output.music("other", "theme", 1, 1)).toThrow(LET_GO);
    // Nor a clip, which the page never held and so did not let go of.
    expect(() =>
      output.music("air", Sound.clip("wind", { samples: 1 }), 1, 1)
    ).toThrow(LET_GO);
    expect(() =>
      output.play(Sound.clip("chirp", { samples: 1 }), 1, 1)
    ).toThrow(LET_GO);
    expect(audio.loops.length).toBe(1);
    expect(audio.loops[0]!.levels.length).toBe(2);
    expect(audio.started).toEqual([]);

    // No Web Audio at all, as under Node: a touch makes nothing, and
    // nothing throws.
    const bare = new Listened();
    const scope = Scope.makeUnsafe();
    const quiet = await Effect.runPromise(
      Sound.open.pipe(
        Scope.provide(scope),
        Effect.provide(Browser.layerSound(undefined, { window: bare }))
      )
    );
    expect(bare.total).toBe(2);
    bare.send("pointerdown");
    bare.send("keydown", { code: "Enter" });
    quiet.play(Sound.clip("x", {}), 1, 1);
    quiet.music("score", Sound.clip("y", {}), 1, 1);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(bare.total).toBe(0);
  });

  it("has an asset for a level's sound, which is decoded as it arrives and played as a clip", async () => {
    const decoded: number[] = [];
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData(data: ArrayBuffer): Promise<unknown> {
          decoded.push(data.byteLength);
          return data.byteLength === 1
            ? Promise.reject(new Error("Unable to decode audio data"))
            : Promise.resolve({ samples: data.byteLength });
        }
      }
    );
    const Forest = Assets.bundle("br/Forest", {
      chirp: Browser.sound("/coin.wav"),
      wind: Browser.sound("/thud.wav"),
    });
    const { chirp, wind } = await Effect.runPromise(
      Effect.scoped(Assets.load(Forest)).pipe(
        Effect.provide(Assets.layerMemory(sounds))
      )
    );
    expect(chirp).toBeInstanceOf(Sound.Clip);
    // Named for where it came from, which is what a log calls it.
    expect([chirp.name, chirp.data]).toEqual(["/coin.wav", { samples: 3 }]);
    expect([wind.name, wind.data]).toEqual(["/thud.wav", { samples: 5 }]);
    expect(decoded.toSorted((a, b) => a - b)).toEqual([3, 5]);
    // The page plays it as it is.
    const { audio, output, page } = await build({});
    page.send("pointerdown");
    output.play(chirp, 1, 1);
    expect(audio.started[0]!.buffer).toEqual({ samples: 3 });

    // A file that is no sound fails its bundle, as any asset does.
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Assets.load(
            Assets.bundle("br/Broken", { noise: Browser.sound("/noise.wav") })
          )
        )
      ).pipe(Effect.provide(Assets.layerMemory(sounds)))
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Cause.squash((exit as Exit.Failure<never, unknown>).cause);
    expect(error).toBeInstanceOf(Assets.AssetFailed);
    expect((error as Assets.AssetFailed).url).toBe("/noise.wav");
    expect((error as Assets.AssetFailed).message).toBe(
      "It could not be made a sound: Unable to decode audio data"
    );
  });

  it("is part of Browser.layer unless the page is told it has none, and a game's events are heard through it", async () => {
    const Scored = Event.define("br/Scored", Schema.Struct({}));
    const Score = System.tick("br/Score", function* () {
      if ((yield* Time).tick === 2) {
        (yield* Scored.emits).emit({});
      }
    });
    const Cues = Sound.cues(
      "br/Cues",
      Sound.on(Scored, { cue: "coin", volume: 0.8 })
    );
    const Game = Plugin.make("br/Noisy", {
      plugins: [Sound.plugin],
      systems: [Score, Cues],
    });
    const page = makePage();
    const audio = makeAudio();
    const audible: boolean[] = [];
    const Ask = System.frame("br/Ask", function* () {
      audible.push((yield* Sound.Player).audible);
    });
    const start = (options: Browser.Options) =>
      Effect.runFork(
        Driver.run(App.define({ plugins: [Game], systems: [Ask] }), {
          hz: 60,
        }).pipe(
          Effect.provide(
            Browser.layer({ gamepads: () => [], ...options }).pipe(
              Layer.provideMerge(Assets.layerMemory(sounds))
            )
          )
        )
      );
    const fiber = start({
      sounds: { coin: "/coin.wav" },
      audio: () => audio,
      decode: decodeInto([]),
    });
    await settle();
    // The devices' seven listeners, and the two that wait for a touch.
    expect(page.window.total).toBe(9);
    page.window.send("keydown", { code: "Space", repeat: false });
    await settle();
    page.repaint(0);
    page.repaint(1000 / 60);
    expect(audio.started).toEqual([]);
    page.repaint(2000 / 60);
    expect(audio.started).toEqual([
      { buffer: { samples: 3 }, rate: 1, volume: 0.8, into: audio.destination },
    ]);
    expect(audible.at(-1)).toBe(true);
    // It is the page's own document that puts it to sleep, the one the
    // frame loop rests by.
    expect(page.visibility.size).toBe(2);
    page.hide();
    expect(audio.suspended).toBe(1);
    page.show();
    expect(audio.resumed).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(page.visibility.size).toBe(0);
    expect(page.window.total).toBe(0);
    expect(audio.closed).toBe(1);

    // Given no files of its own the page has sound all the same: a
    // level's sounds are clips of its bundle, and need no name here.
    audible.length = 0;
    const plain = start({ audio: () => audio });
    await settle();
    expect(page.window.total).toBe(9);
    page.repaint(0);
    expect(audible).toEqual([true]);
    await Effect.runPromise(Fiber.interrupt(plain));
    expect(page.window.total).toBe(0);

    // Told it has none, the page's sound goes nowhere, and no touch is
    // waited for.
    audible.length = 0;
    const silent = start({ sounds: false });
    await settle();
    expect(page.window.total).toBe(7);
    page.repaint(0);
    expect(audible).toEqual([false]);
    await Effect.runPromise(Fiber.interrupt(silent));
  });

  /** A game that plays a coin in each frame. */
  const Clinking = App.define({
    plugins: [Sound.plugin],
    systems: [
      System.frame("br/Clink", function* () {
        (yield* Sound.Player).play("coin");
      }),
    ],
  });

  it("is heard, and the devices read, by an app carried out of the scope it was made in, until the app is closed", async () => {
    const Plink = System.frame("br/Plink", function* () {
      if ((yield* Input.Keyboard).down("Space")) {
        (yield* Sound.Player).play("coin");
      }
    });
    const Game = App.define({
      plugins: [Input.plugin, Sound.plugin],
      systems: [Plink],
    });
    const page = makePage();
    const audio = makeAudio();
    // Made in a scope that has closed by the time the app is used.
    const app = Effect.runSync(
      Effect.scoped(
        App.make(Game).pipe(
          Effect.provide(
            Browser.layer({
              gamepads: () => [],
              sounds: { coin: "/coin.wav" },
              audio: () => audio,
              decode: decodeInto([]),
            }).pipe(Layer.provideMerge(Assets.layerMemory(sounds)))
          )
        )
      )
    );
    await settle();
    page.window.send("keydown", { code: "Space", repeat: false });
    app.input();
    app.tick(1 / 60);
    app.frame();
    expect(audio.started).toEqual([
      { buffer: { samples: 3 }, rate: 1, volume: 1, into: audio.destination },
    ]);
    // Closed, it lets go of the page, and what is used after says so.
    Effect.runSync(app.close);
    expect(page.window.total).toBe(0);
    expect(audio.closed).toBe(1);
    expect(() => app.input()).toThrow(DEVICES_LET_GO);
    expect(() => app.frame(1)).toThrow(LET_GO);
    expect(audio.started.length).toBe(1);
  });

  it("lasts as long as the app, wherever it is provided, and refuses to play once the app is closed", async () => {
    const page = new Listened();
    const audio = makeAudio();
    // Provided to the making of the app alone, in a scope of its own: both
    // end here.
    const app = await Effect.runPromise(
      Effect.scoped(
        App.make(Clinking).pipe(
          Effect.provide(
            Browser.layerSound(
              { coin: "/coin.wav" },
              { window: page, audio: () => audio, decode: decodeInto([]) }
            )
          ),
          Effect.provideService(Driver.Display, Driver.makeManualDisplay()),
          Effect.provide(Assets.layerMemory(sounds))
        )
      )
    );
    await settle();
    page.send("pointerdown");
    app.frame();
    expect(audio.started).toEqual([
      { buffer: { samples: 3 }, rate: 1, volume: 1, into: audio.destination },
    ]);
    expect(audio.closed).toBe(0);
    await Effect.runPromise(app.close);
    expect(audio.closed).toBe(1);
    expect(page.total).toBe(0);
    // A frame that plays a cue after that says so, where it would be heard
    // by nobody.
    expect(() => app.frame(1)).toThrow(LET_GO);
    expect(audio.started.length).toBe(1);
    // Closing it again does nothing.
    await Effect.runPromise(app.close);
    expect(audio.closed).toBe(1);
  });

  it("is one audio for every app made under it, each file fetched once, and closed with the last of them", async () => {
    const page = new Listened();
    const audio = makeAudio();
    let made = 0;
    const decoded: number[] = [];
    // Built once, as a program provides it, and its own scope closed at once.
    const provided = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          Browser.layerSound(
            { coin: "/coin.wav" },
            {
              window: page,
              audio: () => {
                made++;
                return audio;
              },
              decode: decodeInto(decoded),
            }
          )
        )
      ).pipe(
        Effect.provideService(Driver.Display, Driver.makeManualDisplay()),
        Effect.provide(Assets.layerMemory(sounds))
      )
    );
    const start = async () => {
      const app = await Effect.runPromise(
        App.make(Clinking).pipe(Effect.provideContext(provided))
      );
      return { app, close: () => Effect.runPromise(app.close) };
    };
    const one = await start();
    const two = await start();
    await settle();
    expect(decoded).toEqual([3]);
    expect(Object.fromEntries(page.listening)).toEqual({
      pointerdown: 1,
      keydown: 1,
    });
    page.send("pointerdown");
    expect(made).toBe(1);
    one.app.frame();
    two.app.frame();
    expect(audio.started.length).toBe(2);
    // The first app goes; the other still plays through the same audio, and
    // the one that went refuses to.
    await one.close();
    expect(audio.closed).toBe(0);
    two.app.frame(1);
    expect(audio.started.length).toBe(3);
    expect(() => one.app.frame(1)).toThrow(LET_GO);
    expect(audio.started.length).toBe(3);
    await two.close();
    expect(audio.closed).toBe(1);
    expect(made).toBe(1);
    expect(page.total).toBe(0);

    // An app made after that opens the page's audio again, and its files.
    const three = await start();
    await settle();
    expect(decoded).toEqual([3, 3]);
    page.send("pointerdown");
    expect(made).toBe(2);
    three.app.frame();
    expect(audio.started.length).toBe(4);
    await three.close();
    expect(audio.closed).toBe(2);
    expect(page.total).toBe(0);
  });
});
