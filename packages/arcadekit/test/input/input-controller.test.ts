import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import { InputController } from "../../src/input/index";

// No DOM here: Node's EventTarget stands in for the window and the surface, and events are
// plain Events carrying the few fields a controller reads.

const BUTTONS = {
  right: { keys: ["ArrowRight"], gamepadButtons: [15], swipe: "right" },
  up: { keys: ["ArrowUp"], swipe: "up" },
  undo: { keys: ["KeyZ"] },
} as const;

let window: EventTarget;
let surface: HTMLElement;
let ownerDocument: { pointerLockElement: unknown };
/** Pointer ids the surface was asked to capture. */
let captures: number[];
let padButtons: { pressed: boolean }[];

const fire = (
  target: EventTarget,
  type: string,
  fields: Record<string, unknown>
) => {
  const event = new Event(type);
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(event, name, { value });
  }
  target.dispatchEvent(event);
};

const key = (type: "keydown" | "keyup", code: string) =>
  fire(window, type, { code, repeat: false });

const stroke = (
  from: { x: number; y: number; t: number },
  to: { x: number; y: number; t: number }
) => {
  fire(surface, "pointerdown", {
    pointerId: 1,
    clientX: from.x,
    clientY: from.y,
    timeStamp: from.t,
  });
  fire(surface, "pointermove", { pointerId: 1, clientX: to.x, clientY: to.y });
  fire(surface, "pointerup", {
    pointerId: 1,
    clientX: to.x,
    clientY: to.y,
    timeStamp: to.t,
  });
};

const controller = () => InputController.make(surface, { buttons: BUTTONS });

describe("an input controller", () => {
  beforeEach(() => {
    window = new EventTarget();
    ownerDocument = { pointerLockElement: null };
    captures = [];
    surface = Object.assign(new EventTarget(), {
      style: {},
      ownerDocument,
      // As in a browser: capturing throws while the document has a pointer lock.
      setPointerCapture: (pointerId: number) => {
        captures.push(pointerId);
        if ((ownerDocument.pointerLockElement ?? null) !== null) {
          throw new DOMException("Pointer is locked", "InvalidStateError");
        }
      },
    }) as unknown as HTMLElement;
    padButtons = Array.from({ length: 16 }, () => ({ pressed: false }));
    vi.stubGlobal("window", window);
    vi.stubGlobal("navigator", {
      getGamepads: () => [{ axes: [], buttons: padButtons }],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("consumePresses", () => {
    it("forgets a key press but keeps the key held", () => {
      const input = controller();
      key("keydown", "KeyZ");
      expect(InputController.wasPressed(input, "undo")).toBe(true);
      InputController.consumePresses(input);
      expect(InputController.wasPressed(input, "undo")).toBe(false);
      expect(InputController.isDown(input, "undo")).toBe(true);
    });

    it("doesn't see a held gamepad button as pressed again", () => {
      const input = controller();
      padButtons[15]!.pressed = true;
      expect(InputController.wasPressed(input, "right")).toBe(true);
      InputController.consumePresses(input);
      expect(InputController.wasPressed(input, "right")).toBe(false);
      InputController.endFrame(input);
      expect(InputController.wasPressed(input, "right")).toBe(false);
      // Released, then pressed again: a new press.
      padButtons[15]!.pressed = false;
      InputController.endFrame(input);
      padButtons[15]!.pressed = true;
      expect(InputController.wasPressed(input, "right")).toBe(true);
    });
  });

  describe("swipe", () => {
    it("counts a quick stroke as one press in its main direction, never as held", () => {
      const input = controller();
      stroke({ x: 100, y: 100, t: 0 }, { x: 150, y: 90, t: 120 });
      expect(InputController.wasPressed(input, "right")).toBe(true);
      expect(InputController.wasPressed(input, "up")).toBe(false);
      expect(InputController.isDown(input, "right")).toBe(false);
      InputController.consumePresses(input);
      expect(InputController.wasPressed(input, "right")).toBe(false);
    });

    it("reads screen up as up", () => {
      const input = controller();
      stroke({ x: 100, y: 100, t: 0 }, { x: 95, y: 40, t: 100 });
      expect(InputController.wasPressed(input, "up")).toBe(true);
      InputController.endFrame(input);
      expect(InputController.wasPressed(input, "up")).toBe(false);
    });

    it("ignores a stroke that is too short or too slow", () => {
      const input = controller();
      stroke({ x: 100, y: 100, t: 0 }, { x: 120, y: 100, t: 50 });
      stroke({ x: 100, y: 100, t: 1000 }, { x: 200, y: 100, t: 1500 });
      expect(InputController.wasPressed(input, "right")).toBe(false);
    });
  });
  describe("pointer lock", () => {
    it("ignores presses while the pointer is locked, so mouse look neither captures nor drags", () => {
      const input = InputController.make(surface, {
        axes: { moveX: { pointerDrag: "x" } },
      });
      ownerDocument.pointerLockElement = surface;
      fire(surface, "pointerdown", {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
      });
      fire(surface, "pointermove", {
        pointerId: 1,
        clientX: 160,
        clientY: 100,
      });
      expect(captures).toStrictEqual([]);
      expect(InputController.axis(input, "moveX")).toBe(0);
    });

    it("drags again once the lock is released", () => {
      const input = InputController.make(surface, {
        axes: { moveX: { pointerDrag: "x" } },
      });
      ownerDocument.pointerLockElement = surface;
      fire(surface, "pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        timeStamp: 0,
      });
      ownerDocument.pointerLockElement = null;
      fire(surface, "pointerdown", {
        pointerId: 2,
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
      });
      fire(surface, "pointermove", {
        pointerId: 2,
        clientX: 130,
        clientY: 100,
      });
      expect(InputController.axis(input, "moveX")).toBe(0.5);
    });

    it("drags where the browser has no pointer lock (iPhone Safari leaves it undefined)", () => {
      const input = InputController.make(surface, {
        axes: { moveX: { pointerDrag: "x" } },
      });
      ownerDocument.pointerLockElement = undefined;
      fire(surface, "pointerdown", {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
      });
      fire(surface, "pointermove", {
        pointerId: 1,
        clientX: 130,
        clientY: 100,
      });
      expect(InputController.axis(input, "moveX")).toBe(0.5);
    });
  });

  describe("as a value", () => {
    it("is told from a look-alike, and prints its names and what it holds", () => {
      const input = controller();
      key("keydown", "KeyZ");
      expect({
        controller: InputController.isInputController(input),
        lookAlike: InputController.isInputController({
          bindings: { buttons: BUTTONS },
        }),
        printed: input.toJSON(),
      }).toStrictEqual({
        controller: true,
        lookAlike: false,
        printed: {
          _id: "InputController",
          axes: [],
          buttons: ["right", "up", "undo"],
          held: ["KeyZ"],
          dragging: false,
        },
      });
    });

    it("reads the same whole or piped", () => {
      const input = InputController.make(surface, {
        axes: InputController.moveAxes,
        buttons: BUTTONS,
      });
      key("keydown", "KeyD");
      key("keydown", "KeyZ");
      expect({
        axis: [
          InputController.axis(input, "moveX"),
          input.pipe(InputController.axis("moveX")),
        ],
        isDown: [
          InputController.isDown(input, "undo"),
          input.pipe(InputController.isDown("undo")),
        ],
        wasPressed: [
          InputController.wasPressed(input, "undo"),
          input.pipe(InputController.wasPressed("undo")),
        ],
      }).toStrictEqual({
        axis: [1, 1],
        isDown: [true, true],
        wasPressed: [true, true],
      });
    });

    it("takes its names from its bindings, and refuses any other", () => {
      const moving = InputController.make(surface, {
        axes: InputController.moveAxes,
      });
      const input = controller();
      expectTypeOf(moving).toEqualTypeOf<
        InputController.InputController<"moveX" | "moveY">
      >();
      expectTypeOf(input).toEqualTypeOf<
        InputController.InputController<never, "right" | "up" | "undo">
      >();
      // @ts-expect-error -- the bindings name no axis "moveZ"
      InputController.axis(moving, "moveZ");
      // @ts-expect-error -- nor any button
      InputController.isDown(moving, "undo");
      // @ts-expect-error -- the bindings name no button "jump"
      InputController.wasPressed(input, "jump");
      // @ts-expect-error -- piped, too
      input.pipe(InputController.isDown("jump"));
    });
  });

  describe("dispose", () => {
    it("removes every listener make added, and hears nothing after", () => {
      const added = [
        vi.spyOn(window, "addEventListener"),
        vi.spyOn(surface, "addEventListener"),
      ];
      const removed = [
        vi.spyOn(window, "removeEventListener"),
        vi.spyOn(surface, "removeEventListener"),
      ];
      const input = controller();
      key("keydown", "KeyZ");
      InputController.dispose(input);
      key("keydown", "ArrowUp");
      expect({
        added: added.map((spy) => spy.mock.calls.map(([type]) => type)),
        // The very listeners added, each with its type.
        removed: removed.map((spy) => spy.mock.calls),
        held: [
          InputController.isDown(input, "undo"),
          InputController.isDown(input, "up"),
        ],
      }).toStrictEqual({
        added: [
          ["keydown", "keyup", "blur"],
          ["pointerdown", "pointermove", "pointerup", "pointercancel"],
        ],
        removed: added.map((spy) => spy.mock.calls),
        held: [false, false],
      });
    });
  });
});
