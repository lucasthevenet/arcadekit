/** Key names are `KeyboardEvent.code` values, e.g. "KeyW", "ArrowLeft", "Space". */
export interface AxisBinding {
  readonly negativeKeys?: readonly string[];
  readonly positiveKeys?: readonly string[];
  /** Index into `Gamepad.axes` (0 = left stick X, 1 = left stick Y on standard pads). */
  readonly gamepadAxis?: number;
  /** Floating touch/mouse joystick: press anywhere on the surface and drag. */
  readonly pointerDrag?: "x" | "y";
}

export type SwipeDirection = "up" | "down" | "left" | "right";

export interface ButtonBinding {
  readonly keys?: readonly string[];
  /** Indices into `Gamepad.buttons` (0 = A / Cross on standard pads). */
  readonly gamepadButtons?: readonly number[];
  /**
   * A short, fast touch or mouse stroke on the surface in this direction counts as one press
   * (`wasPressed`), never as held. For grid games on a phone: one swipe, one move.
   */
  readonly swipe?: SwipeDirection;
}

/** A game with no axes (a turn-based puzzle) or no buttons (a twin-stick mover) leaves that half out. */
export interface InputBindings<Axis extends string, Button extends string> {
  readonly axes?: Readonly<Record<Axis, AxisBinding>>;
  readonly buttons?: Readonly<Record<Button, ButtonBinding>>;
}

/** Stick values smaller than this count as zero. */
const DEADZONE = 0.2;
/** Pixels of drag for a full-strength pointer axis. */
const DRAG_RANGE = 60;
/** Shortest stroke, in pixels, that counts as a swipe. */
const SWIPE_DISTANCE = 30;
/** Longest stroke, in milliseconds, that counts as a swipe. */
const SWIPE_MS = 300;

/**
 * Ready-made movement axes: WASD, arrow keys, left stick, and touch drag. Both axes follow
 * screen space: `moveX` is negative to the left and `moveY` is negative upward (W, ArrowUp,
 * stick up, drag up). A game on the ground plane reads `moveY` as z, with its camera on the
 * +z side (survivors does).
 */
export const MOVE_AXES: {
  readonly moveX: AxisBinding;
  readonly moveY: AxisBinding;
} = {
  moveX: {
    negativeKeys: ["KeyA", "ArrowLeft"],
    positiveKeys: ["KeyD", "ArrowRight"],
    gamepadAxis: 0,
    pointerDrag: "x",
  },
  moveY: {
    negativeKeys: ["KeyW", "ArrowUp"],
    positiveKeys: ["KeyS", "ArrowDown"],
    gamepadAxis: 1,
    pointerDrag: "y",
  },
};

/**
 * Turns keyboard, gamepad and pointer events on `surface` into named axes and buttons.
 * A game reads `axis()` / `isDown()` / `wasPressed()` and never sees raw devices.
 */
export class InputController<
  Axis extends string = never,
  Button extends string = never,
> {
  private readonly heldKeys = new Set<string>();
  private readonly pressedKeys = new Set<string>();
  private readonly padWasDown = new Set<Button>();
  private readonly padPressed = new Set<Button>();
  private drag: {
    id: number;
    startX: number;
    startY: number;
    startTime: number;
    x: number;
    y: number;
  } | null = null;
  private readonly swipes = new Set<SwipeDirection>();
  private readonly cleanups: (() => void)[] = [];
  private readonly surface: HTMLElement;
  private readonly bindings: InputBindings<Axis, Button>;

  constructor(surface: HTMLElement, bindings: InputBindings<Axis, Button>) {
    this.surface = surface;
    this.bindings = bindings;
    this.listen(window, "keydown", (e) => {
      if (!e.repeat) {
        this.pressedKeys.add(e.code);
      }
      this.heldKeys.add(e.code);
    });
    this.listen(window, "keyup", (e) => this.heldKeys.delete(e.code));
    this.listen(window, "blur", () => this.heldKeys.clear());
    this.listen(surface, "pointerdown", (e) => {
      // A locked pointer (a game's mouse look) stays put on screen, so it can't drag or swipe,
      // and setPointerCapture throws InvalidStateError while the document has a pointer lock.
      // A browser without pointer lock (iPhone Safari) leaves `pointerLockElement` undefined.
      if (
        this.drag ||
        (surface.ownerDocument.pointerLockElement ?? null) !== null
      ) {
        return;
      }
      surface.setPointerCapture(e.pointerId);
      this.drag = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startTime: e.timeStamp,
        x: e.clientX,
        y: e.clientY,
      };
    });
    this.listen(surface, "pointermove", (e) => {
      if (this.drag?.id === e.pointerId) {
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
      }
    });
    this.listen(surface, "pointerup", (e) => {
      if (this.drag?.id === e.pointerId) {
        this.endStroke(e.clientX, e.clientY, e.timeStamp);
        this.drag = null;
      }
    });
    this.listen(surface, "pointercancel", (e) => {
      if (this.drag?.id === e.pointerId) {
        this.drag = null;
      }
    });
    surface.style.touchAction = "none";
  }

  /** Current value in [-1, 1]. Sources add up, then clamp. */
  axis(name: Axis): number {
    const binding = this.bindings.axes?.[name];
    if (!binding) {
      return 0;
    }
    let value = 0;
    for (const key of binding.negativeKeys ?? []) {
      if (this.heldKeys.has(key)) {
        value -= 1;
      }
    }
    for (const key of binding.positiveKeys ?? []) {
      if (this.heldKeys.has(key)) {
        value += 1;
      }
    }
    if (binding.gamepadAxis !== undefined) {
      for (const pad of connectedGamepads()) {
        const v = pad.axes[binding.gamepadAxis] ?? 0;
        if (Math.abs(v) > DEADZONE) {
          value += v;
        }
      }
    }
    if (binding.pointerDrag && this.drag) {
      const delta =
        binding.pointerDrag === "x"
          ? this.drag.x - this.drag.startX
          : this.drag.y - this.drag.startY;
      value += delta / DRAG_RANGE;
    }
    return Math.min(Math.max(value, -1), 1);
  }

  isDown(name: Button): boolean {
    const binding = this.bindings.buttons?.[name];
    if (!binding) {
      return false;
    }
    if (binding.keys?.some((key) => this.heldKeys.has(key))) {
      return true;
    }
    return padButtonDown(binding);
  }

  /** True if the button went down since the last `consumePresses()` or `endFrame()`. */
  wasPressed(name: Button): boolean {
    const binding = this.bindings.buttons?.[name];
    if (!binding) {
      return false;
    }
    if (binding.keys?.some((key) => this.pressedKeys.has(key))) {
      return true;
    }
    if (binding.swipe && this.swipes.has(binding.swipe)) {
      return true;
    }
    const down = padButtonDown(binding);
    if (down && !this.padWasDown.has(name)) {
      this.padPressed.add(name);
    }
    return this.padPressed.has(name);
  }

  /**
   * Forgets the presses seen so far, so the next `wasPressed` only reports newer ones.
   * Call it after every simulation step (`InputSource.endStep`) to make one press reach
   * exactly one step. Held state and axes are untouched.
   */
  consumePresses(): void {
    this.pressedKeys.clear();
    this.swipes.clear();
    // A consumed pad press counts as already down, so it isn't detected again while held.
    for (const name of this.padPressed) {
      this.padWasDown.add(name);
    }
    this.padPressed.clear();
  }

  /** Call once per frame after the game has read input. Resets `wasPressed` and polls gamepads for the next frame. */
  endFrame(): void {
    this.pressedKeys.clear();
    this.swipes.clear();
    this.padPressed.clear();
    const { buttons } = this.bindings;
    if (!buttons) {
      return;
    }
    for (const name of Object.keys(buttons) as Button[]) {
      if (padButtonDown(buttons[name])) {
        this.padWasDown.add(name);
      } else {
        this.padWasDown.delete(name);
      }
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
    this.heldKeys.clear();
    this.drag = null;
  }

  /** Records a swipe if the stroke that just ended was long and quick enough. */
  private endStroke(x: number, y: number, time: number) {
    const { drag } = this;
    if (!drag || time - drag.startTime > SWIPE_MS) {
      return;
    }
    const dx = x - drag.startX;
    const dy = y - drag.startY;
    if (Math.hypot(dx, dy) < SWIPE_DISTANCE) {
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      this.swipes.add(dx > 0 ? "right" : "left");
    } else {
      this.swipes.add(dy > 0 ? "down" : "up");
    }
  }

  private listen<K extends keyof WindowEventMap & keyof HTMLElementEventMap>(
    target: Window | HTMLElement,
    type: K,
    handler: (event: WindowEventMap[K] & HTMLElementEventMap[K]) => void
  ) {
    const listener = handler as EventListener;
    target.addEventListener(type, listener);
    this.cleanups.push(() => target.removeEventListener(type, listener));
  }
}

const connectedGamepads = function* (): Iterable<Gamepad> {
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (pad) {
      yield pad;
    }
  }
};

const padButtonDown = (binding: ButtonBinding): boolean => {
  if (!binding.gamepadButtons) {
    return false;
  }
  for (const pad of connectedGamepads()) {
    for (const index of binding.gamepadButtons) {
      if (pad.buttons[index]?.pressed) {
        return true;
      }
    }
  }
  return false;
};
