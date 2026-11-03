import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InputController } from "./index";

// No DOM here: Node's EventTarget stands in for the window and the surface, and events are
// plain Events carrying the few fields InputController reads.

const BUTTONS = {
  right: { keys: ["ArrowRight"], gamepadButtons: [15], swipe: "right" },
  up: { keys: ["ArrowUp"], swipe: "up" },
  undo: { keys: ["KeyZ"] },
} as const;

let window: EventTarget;
let surface: HTMLElement;
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

const controller = () => new InputController(surface, { buttons: BUTTONS });

describe(InputController, () => {
  beforeEach(() => {
    window = new EventTarget();
    surface = Object.assign(new EventTarget(), {
      style: {},
      setPointerCapture: () => {},
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
      expect(input.wasPressed("undo")).toBe(true);
      input.consumePresses();
      expect(input.wasPressed("undo")).toBe(false);
      expect(input.isDown("undo")).toBe(true);
    });

    it("doesn't see a held gamepad button as pressed again", () => {
      const input = controller();
      padButtons[15]!.pressed = true;
      expect(input.wasPressed("right")).toBe(true);
      input.consumePresses();
      expect(input.wasPressed("right")).toBe(false);
      input.endFrame();
      expect(input.wasPressed("right")).toBe(false);
      // Released, then pressed again: a new press.
      padButtons[15]!.pressed = false;
      input.endFrame();
      padButtons[15]!.pressed = true;
      expect(input.wasPressed("right")).toBe(true);
    });
  });

  describe("swipe", () => {
    it("counts a quick stroke as one press in its main direction, never as held", () => {
      const input = controller();
      stroke({ x: 100, y: 100, t: 0 }, { x: 150, y: 90, t: 120 });
      expect(input.wasPressed("right")).toBe(true);
      expect(input.wasPressed("up")).toBe(false);
      expect(input.isDown("right")).toBe(false);
      input.consumePresses();
      expect(input.wasPressed("right")).toBe(false);
    });

    it("reads screen up as up", () => {
      const input = controller();
      stroke({ x: 100, y: 100, t: 0 }, { x: 95, y: 40, t: 100 });
      expect(input.wasPressed("up")).toBe(true);
      input.endFrame();
      expect(input.wasPressed("up")).toBe(false);
    });

    it("ignores a stroke that is too short or too slow", () => {
      const input = controller();
      stroke({ x: 100, y: 100, t: 0 }, { x: 120, y: 100, t: 50 });
      stroke({ x: 100, y: 100, t: 1000 }, { x: 200, y: 100, t: 1500 });
      expect(input.wasPressed("right")).toBe(false);
    });
  });
});
