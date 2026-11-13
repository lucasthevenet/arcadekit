/**
 * Input controllers: a player's keys, gamepads, touch drags and swipes on one element, read as a
 * game's named axes and buttons.
 *
 * A controller listens on the window for keys and on its surface for pointers, and polls the
 * gamepads when it is read. Its listeners write what they hear into the controller while the
 * browser dispatches each event, so a press made before a frame is in that frame's reads; its
 * reads are plain calls, since a step reads its input inside the frame or tick that runs it
 * (ADR-0024). A `Game.Engine`'s or a `Coop`'s `input` makes one, and the engine or the Co-op
 * client that acquired that input source disposes it when it detaches.
 *
 * @since 0.7.0
 */
import type { Types } from "effect";
import { Inspectable, Pipeable, Predicate } from "effect";
import { dual } from "effect/Function";

const TypeId = "~arcadekit/input/InputController";

/**
 * Where one axis is read from: keys that push it toward -1 and toward 1, a gamepad stick, and a
 * drag on the surface. The sources add up.
 *
 * **When to use**
 *
 * To bind one of a game's axes, under its name in the `axes` of the bindings.
 *
 * **Details**
 *
 * Key names are `KeyboardEvent.code` values ("KeyW", "ArrowLeft", "Space"), so a binding stays on
 * the same keys in every keyboard layout. `gamepadAxis` is an index into `Gamepad.axes`: 0 is the
 * left stick's x and 1 its y on a standard pad. `pointerDrag` makes the surface a floating
 * joystick: a press anywhere on it starts a drag, read along that axis.
 *
 * **Example** (A throttle on W and S, or the right stick)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const throttle: InputController.AxisBinding = {
 *   negativeKeys: ["KeyS"],
 *   positiveKeys: ["KeyW"],
 *   gamepadAxis: 3,
 * };
 * const controller = InputController.make(document.createElement("canvas"), {
 *   axes: { throttle },
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
 * InputController.axis(controller, "throttle"); // => 1
 * InputController.dispose(controller);
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface AxisBinding {
  /** Keys that push the axis toward -1. */
  readonly negativeKeys?: readonly string[];
  /** Keys that push the axis toward 1. */
  readonly positiveKeys?: readonly string[];
  /** An index into `Gamepad.axes`: 0 is the left stick's x, 1 its y, on a standard pad. */
  readonly gamepadAxis?: number;
  /** A drag on the surface, from where it was pressed, along x or y. */
  readonly pointerDrag?: "x" | "y";
}

/**
 * A way a swipe goes, on screen: up is toward the top.
 *
 * **When to use**
 *
 * To bind a button to a swipe (`ButtonBinding.swipe`), as a grid game on a phone binds each of
 * its directions.
 *
 * **Example** (Reading which way the player swiped)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const directions: readonly InputController.SwipeDirection[] = [
 *   "up",
 *   "down",
 *   "left",
 *   "right",
 * ];
 * const controller = InputController.make(document.createElement("canvas"), {
 *   buttons: {
 *     up: { swipe: "up" },
 *     down: { swipe: "down" },
 *     left: { swipe: "left" },
 *     right: { swipe: "right" },
 *   },
 * });
 * const swiped = directions.filter((direction) =>
 *   InputController.wasPressed(controller, direction)
 * );
 * swiped; // => []
 * InputController.dispose(controller);
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type SwipeDirection = "up" | "down" | "left" | "right";

/**
 * Where one button is read from: keys, gamepad buttons, and a swipe on the surface. Any of them
 * presses it.
 *
 * **When to use**
 *
 * To bind one of a game's buttons, under its name in the `buttons` of the bindings.
 *
 * **Details**
 *
 * Key names are `KeyboardEvent.code` values. `gamepadButtons` are indices into
 * `Gamepad.buttons`: 0 is A (Cross) and 12 to 15 the d-pad's up, down, left and right on a
 * standard pad. A swipe is a short, fast stroke on the surface, at least 30 pixels long and at
 * most 300 milliseconds, in the direction that moved most: it counts as one press
 * (`wasPressed`) and is never held (`isDown`). For a grid game on a phone: one swipe, one move.
 *
 * **Example** (A jump on Space, the A button or a swipe up)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const jump: InputController.ButtonBinding = {
 *   keys: ["Space"],
 *   gamepadButtons: [0],
 *   swipe: "up",
 * };
 * const controller = InputController.make(document.createElement("canvas"), {
 *   buttons: { jump },
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
 * InputController.isDown(controller, "jump"); // => true
 * InputController.dispose(controller);
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface ButtonBinding {
  /** Keys that press the button. */
  readonly keys?: readonly string[];
  /** Indices into `Gamepad.buttons`: 0 is A (Cross) on a standard pad. */
  readonly gamepadButtons?: readonly number[];
  /** A swipe that presses the button once, and never holds it. */
  readonly swipe?: SwipeDirection;
}

/**
 * A game's bindings: each of its axes and buttons by name, with where it is read from.
 *
 * **When to use**
 *
 * To make a controller with `make`, which takes the names from them: an axis or a button they
 * don't name is a type error on every read.
 *
 * **Details**
 *
 * A game with no axes (a turn-based puzzle) or no buttons (a twin-stick mover) leaves that half
 * out.
 *
 * **Example** (A puzzle that has only buttons)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const bindings: InputController.Bindings<never, "undo"> = {
 *   buttons: { undo: { keys: ["KeyZ", "Backspace"] } },
 * };
 * const controller = InputController.make(
 *   document.createElement("canvas"),
 *   bindings
 * );
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backspace" }));
 * InputController.wasPressed(controller, "undo"); // => true
 * InputController.dispose(controller);
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Bindings<Axis extends string, Button extends string> {
  readonly axes?: Readonly<Record<Axis, AxisBinding>>;
  readonly buttons?: Readonly<Record<Button, ButtonBinding>>;
}

/**
 * Ready-made movement axes, `moveX` and `moveY`: A and D or the arrow keys, W and S or the arrow
 * keys, the left stick, and a drag on the surface.
 *
 * **When to use**
 *
 * As the `axes` of a game whose player walks in two directions, from any device.
 *
 * **Details**
 *
 * Both axes follow screen space: `moveX` is negative to the left and `moveY` negative upward (W,
 * ArrowUp, the stick up, a drag up). A game on the ground plane reads `moveY` as z, with its
 * camera on the +z side, as survivors does.
 *
 * **Example** (Walking up and to the left)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   axes: InputController.moveAxes,
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowLeft" }));
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
 * InputController.axis(controller, "moveX"); // => -1
 * InputController.axis(controller, "moveY"); // => -1
 * InputController.dispose(controller);
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export const moveAxes: {
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

/** Stick values smaller than this count as zero. */
const DEADZONE = 0.2;
/** Pixels of drag for a full-strength pointer axis. */
const DRAG_RANGE = 60;
/** Shortest stroke, in pixels, that counts as a swipe. */
const SWIPE_DISTANCE = 30;
/** Longest stroke, in milliseconds, that counts as a swipe. */
const SWIPE_MS = 300;

/**
 * A player's devices on one surface, read as a game's named axes and buttons: what it has heard
 * of the keys and pointers since it was made, and the gamepads, which it polls when it is read.
 *
 * **When to use**
 *
 * Inside a game's input source, which reads it on each step and forgets its presses after each
 * one. Make it with `make`.
 *
 * **Details**
 *
 * `Axis` and `Button` are the names its bindings give, so reading any other name is a type
 * error. It prints the names, the keys held and whether a drag is on.
 *
 * **Example** (Reading a controller, whole or piped)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   axes: InputController.moveAxes,
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
 * InputController.axis(controller, "moveX"); // => 1
 * controller.pipe(InputController.axis("moveX")); // => 1
 * Object.keys(controller.bindings.axes ?? {}); // => ["moveX", "moveY"]
 * InputController.dispose(controller);
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface InputController<
  Axis extends string = never,
  Button extends string = never,
>
  extends Pipeable.Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: typeof TypeId;
  /** What each axis and button is read from, as `make` was given them. */
  readonly bindings: Bindings<Axis, Button>;
}

/** A drag in progress: the pointer, where and when it went down, and where it is now. */
interface Drag {
  readonly id: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  x: number;
  y: number;
}

/** What the module's functions keep, which no caller reads. */
type Internal<Axis extends string, Button extends string> = Types.Mutable<
  InputController<Axis, Button>
> & {
  /** Keys down now. */
  heldKeys: Set<string>;
  /** Keys that went down since presses were last forgotten. */
  pressedKeys: Set<string>;
  /** Buttons whose gamepad buttons were down when last polled, or whose press was consumed. */
  padWasDown: Set<Button>;
  /** Buttons whose gamepad press a read has seen and nothing has forgotten yet. */
  padPressed: Set<Button>;
  drag: Drag | null;
  /** Swipes finished since presses were last forgotten. */
  swipes: Set<SwipeDirection>;
  /** What removes each listener `make` added. */
  cleanups: (() => void)[];
};

const Proto = {
  [TypeId]: TypeId,
  ...Pipeable.Prototype,
  ...Inspectable.BaseProto,
  toJSON(this: Internal<string, string>) {
    return {
      _id: "InputController",
      axes: Object.keys(this.bindings.axes ?? {}),
      buttons: Object.keys(this.bindings.buttons ?? {}),
      held: [...this.heldKeys],
      dragging: this.drag !== null,
    };
  },
};

/**
 * Checks whether a value is an input controller.
 *
 * **When to use**
 *
 * Narrow an unknown value before reading it. A narrowed controller's names are unknown, so it
 * is read through its `bindings`.
 *
 * **Example** (Recognising a controller)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   axes: InputController.moveAxes,
 * });
 * InputController.isInputController(controller); // => true
 * InputController.isInputController({ bindings: {} }); // => false
 * InputController.dispose(controller);
 * ```
 *
 * @category guards
 * @since 0.7.0
 */
export const isInputController = (value: unknown): value is InputController =>
  Predicate.hasProperty(value, TypeId);

/** Adds a listener to `target`, and what removes it to `cleanups`. */
const listen = <K extends keyof WindowEventMap & keyof HTMLElementEventMap>(
  cleanups: (() => void)[],
  target: Window | HTMLElement,
  type: K,
  handler: (event: WindowEventMap[K] & HTMLElementEventMap[K]) => void
): void => {
  const listener = handler as EventListener;
  target.addEventListener(type, listener);
  cleanups.push(() => target.removeEventListener(type, listener));
};

/** The swipe a stroke that ended at `x`, `y` and `time` made, if it was long and quick enough. */
const swipeOf = (
  drag: Drag,
  x: number,
  y: number,
  time: number
): SwipeDirection | null => {
  if (time - drag.startTime > SWIPE_MS) {
    return null;
  }
  const dx = x - drag.startX;
  const dy = y - drag.startY;
  if (Math.hypot(dx, dy) < SWIPE_DISTANCE) {
    return null;
  }
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? "right" : "left";
  }
  return dy > 0 ? "down" : "up";
};

/**
 * Makes a controller that reads `bindings` from the keys, the pointers on `surface` and the
 * gamepads, and starts listening.
 *
 * **When to use**
 *
 * In a `Game.Engine`'s or a `Coop`'s `input`, once per attach, with the surface it is given.
 * Dispose it in the input source's `dispose`.
 *
 * **Details**
 *
 * It listens on the window for `keydown`, `keyup` and `blur`, so the keys reach it wherever the
 * focus is and none stays held once the page loses it, and on `surface` for presses, drags and
 * swipes, whose touches it keeps from scrolling the page (`touch-action: none`). A key's
 * auto-repeat is no new press. It reads the gamepads when it is read, so a pad plugged in later
 * is read too. While the document has a pointer lock, as for a game's mouse look, it ignores
 * pointer presses: a locked pointer can't drag or swipe.
 *
 * **Example** (Making the controller of a dash button)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const surface = document.createElement("canvas");
 * const controller = InputController.make(surface, {
 *   axes: InputController.moveAxes,
 *   buttons: { dash: { keys: ["Space"], gamepadButtons: [0] } },
 * });
 * surface.style.touchAction; // => "none"
 * InputController.isDown(controller, "dash"); // => false
 * InputController.dispose(controller);
 * ```
 *
 * @category constructors
 * @since 0.7.0
 */
export const make = <
  Axis extends string = never,
  Button extends string = never,
>(
  surface: HTMLElement,
  bindings: Bindings<Axis, Button>
): InputController<Axis, Button> => {
  const self = Object.create(Proto) as Internal<Axis, Button>;
  self.bindings = bindings;
  self.heldKeys = new Set();
  self.pressedKeys = new Set();
  self.padWasDown = new Set();
  self.padPressed = new Set();
  self.drag = null;
  self.swipes = new Set();
  self.cleanups = [];
  const { cleanups } = self;
  listen(cleanups, window, "keydown", (e) => {
    if (!e.repeat) {
      self.pressedKeys.add(e.code);
    }
    self.heldKeys.add(e.code);
  });
  listen(cleanups, window, "keyup", (e) => self.heldKeys.delete(e.code));
  listen(cleanups, window, "blur", () => self.heldKeys.clear());
  listen(cleanups, surface, "pointerdown", (e) => {
    // A locked pointer (a game's mouse look) stays put on screen, so it can't drag or swipe,
    // and setPointerCapture throws InvalidStateError while the document has a pointer lock.
    // A browser without pointer lock (iPhone Safari) leaves `pointerLockElement` undefined.
    if (
      self.drag ||
      (surface.ownerDocument.pointerLockElement ?? null) !== null
    ) {
      return;
    }
    surface.setPointerCapture(e.pointerId);
    self.drag = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTime: e.timeStamp,
      x: e.clientX,
      y: e.clientY,
    };
  });
  listen(cleanups, surface, "pointermove", (e) => {
    if (self.drag?.id === e.pointerId) {
      self.drag.x = e.clientX;
      self.drag.y = e.clientY;
    }
  });
  listen(cleanups, surface, "pointerup", (e) => {
    if (self.drag?.id === e.pointerId) {
      const swipe = swipeOf(self.drag, e.clientX, e.clientY, e.timeStamp);
      if (swipe !== null) {
        self.swipes.add(swipe);
      }
      self.drag = null;
    }
  });
  listen(cleanups, surface, "pointercancel", (e) => {
    if (self.drag?.id === e.pointerId) {
      self.drag = null;
    }
  });
  surface.style.touchAction = "none";
  return self;
};

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

/**
 * An axis's value now, in [-1, 1]: its sources added up, then clamped.
 *
 * **When to use**
 *
 * In an input source's `read`, for each axis the step input holds.
 *
 * **Details**
 *
 * Each key held adds 1 or -1, so two opposite keys cancel out. A gamepad stick adds its value
 * past a deadzone of 0.2, on every pad connected. A drag adds its distance from where it was
 * pressed, at full strength from 60 pixels.
 *
 * **Example** (Opposite keys cancel out)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   axes: InputController.moveAxes,
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
 * InputController.axis(controller, "moveX"); // => -1
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
 * InputController.axis(controller, "moveX"); // => 0
 * InputController.dispose(controller);
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const axis: {
  <Axis extends string>(
    name: Axis
  ): <Button extends string>(self: InputController<Axis, Button>) => number;
  <Axis extends string, Button extends string>(
    self: InputController<Axis, Button>,
    name: NoInfer<Axis>
  ): number;
} = dual(
  2,
  <Axis extends string, Button extends string>(
    self: InputController<Axis, Button>,
    name: Axis
  ): number => {
    const controller = self as Internal<Axis, Button>;
    const binding = controller.bindings.axes?.[name];
    if (!binding) {
      return 0;
    }
    let value = 0;
    for (const key of binding.negativeKeys ?? []) {
      if (controller.heldKeys.has(key)) {
        value -= 1;
      }
    }
    for (const key of binding.positiveKeys ?? []) {
      if (controller.heldKeys.has(key)) {
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
    const { drag } = controller;
    if (binding.pointerDrag && drag) {
      const delta =
        binding.pointerDrag === "x"
          ? drag.x - drag.startX
          : drag.y - drag.startY;
      value += delta / DRAG_RANGE;
    }
    return Math.min(Math.max(value, -1), 1);
  }
);

/**
 * Whether a button is held now, by one of its keys or gamepad buttons.
 *
 * **When to use**
 *
 * In an input source's `read`, for what lasts while the button is held: a charge, a run, a
 * direction that repeats.
 *
 * **Details**
 *
 * A swipe is never held: read it with `wasPressed`. Every key is let go when the page loses the
 * focus, since its `keyup` would go elsewhere.
 *
 * **Example** (Held until it is let go)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   buttons: { charge: { keys: ["KeyX"] } },
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyX" }));
 * InputController.isDown(controller, "charge"); // => true
 * window.dispatchEvent(new Event("blur"));
 * InputController.isDown(controller, "charge"); // => false
 * InputController.dispose(controller);
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const isDown: {
  <Button extends string>(
    name: Button
  ): <Axis extends string>(self: InputController<Axis, Button>) => boolean;
  <Axis extends string, Button extends string>(
    self: InputController<Axis, Button>,
    name: NoInfer<Button>
  ): boolean;
} = dual(
  2,
  <Axis extends string, Button extends string>(
    self: InputController<Axis, Button>,
    name: Button
  ): boolean => {
    const controller = self as Internal<Axis, Button>;
    const binding = controller.bindings.buttons?.[name];
    if (!binding) {
      return false;
    }
    if (binding.keys?.some((key) => controller.heldKeys.has(key))) {
      return true;
    }
    return padButtonDown(binding);
  }
);

/**
 * Whether a button went down since its presses were last forgotten (`consumePresses` or
 * `endFrame`), by a key, a gamepad button or a swipe.
 *
 * **When to use**
 *
 * In an input source's `read`, for what happens once per press: a jump, a move of a turn-based
 * game, an undo.
 *
 * **Details**
 *
 * A key pressed and let go before the read still counts, and its auto-repeat is no new press.
 * A gamepad button counts once from the read that first sees it down, until it is let go and
 * pressed again.
 *
 * **Example** (A tap between two reads)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   buttons: { jump: { keys: ["Space"] } },
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
 * window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
 * InputController.wasPressed(controller, "jump"); // => true
 * InputController.isDown(controller, "jump"); // => false
 * InputController.dispose(controller);
 * ```
 *
 * @category getters
 * @since 0.7.0
 */
export const wasPressed: {
  <Button extends string>(
    name: Button
  ): <Axis extends string>(self: InputController<Axis, Button>) => boolean;
  <Axis extends string, Button extends string>(
    self: InputController<Axis, Button>,
    name: NoInfer<Button>
  ): boolean;
} = dual(
  2,
  <Axis extends string, Button extends string>(
    self: InputController<Axis, Button>,
    name: Button
  ): boolean => {
    const controller = self as Internal<Axis, Button>;
    const binding = controller.bindings.buttons?.[name];
    if (!binding) {
      return false;
    }
    if (binding.keys?.some((key) => controller.pressedKeys.has(key))) {
      return true;
    }
    if (binding.swipe && controller.swipes.has(binding.swipe)) {
      return true;
    }
    const down = padButtonDown(binding);
    if (down && !controller.padWasDown.has(name)) {
      controller.padPressed.add(name);
    }
    return controller.padPressed.has(name);
  }
);

/**
 * Forgets the presses seen so far, so `wasPressed` reports only newer ones. What is held, and
 * the axes, stay as they are.
 *
 * **When to use**
 *
 * In an input source's `endStep`, after every step, so one press reaches exactly one step, even
 * on a slow frame that runs several (ADR-0004).
 *
 * **Details**
 *
 * A gamepad press it forgets counts as already down, so it is not seen again while the button is
 * held.
 *
 * **Example** (One press, one step)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   buttons: { undo: { keys: ["KeyZ"] } },
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ" }));
 * InputController.wasPressed(controller, "undo"); // => true
 * InputController.consumePresses(controller);
 * InputController.wasPressed(controller, "undo"); // => false
 * InputController.isDown(controller, "undo"); // => true
 * InputController.dispose(controller);
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const consumePresses = <Axis extends string, Button extends string>(
  self: InputController<Axis, Button>
): void => {
  const controller = self as Internal<Axis, Button>;
  controller.pressedKeys.clear();
  controller.swipes.clear();
  // A consumed pad press counts as already down, so it isn't detected again while held.
  for (const name of controller.padPressed) {
    controller.padWasDown.add(name);
  }
  controller.padPressed.clear();
};

/**
 * Ends a frame's reading: forgets the presses seen so far, and notes which gamepad buttons are
 * down, so a press next frame is one that starts after this.
 *
 * **When to use**
 *
 * In an input source's `endFrame`, which runs once after each frame that stepped, once the game
 * has read its input.
 *
 * **Details**
 *
 * A game that reads only held buttons and axes still calls it, for its gamepad buttons. One that
 * forgets presses here and not in `endStep` lets a press reach every step of a frame.
 *
 * **Example** (Presses last a frame)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   buttons: { fire: { keys: ["KeyF"] } },
 * });
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF" }));
 * InputController.endFrame(controller);
 * InputController.wasPressed(controller, "fire"); // => false
 * InputController.isDown(controller, "fire"); // => true
 * InputController.dispose(controller);
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const endFrame = <Axis extends string, Button extends string>(
  self: InputController<Axis, Button>
): void => {
  const controller = self as Internal<Axis, Button>;
  controller.pressedKeys.clear();
  controller.swipes.clear();
  controller.padPressed.clear();
  const { buttons } = controller.bindings;
  if (!buttons) {
    return;
  }
  for (const name of Object.keys(buttons) as Button[]) {
    if (padButtonDown(buttons[name])) {
      controller.padWasDown.add(name);
    } else {
      controller.padWasDown.delete(name);
    }
  }
};

/**
 * Stops listening: removes every listener `make` added, and lets go of every key and drag.
 *
 * **When to use**
 *
 * In the input source's `dispose`, which the engine or the Co-op client calls when it detaches.
 *
 * **Details**
 *
 * After it the controller hears no key or pointer, and reads as nothing held by them; a read
 * still polls the gamepads. Disposing it again does nothing.
 *
 * **Example** (Hearing nothing once disposed)
 *
 * ```ts
 * import { InputController } from "arcadekit/input";
 *
 * const controller = InputController.make(document.createElement("canvas"), {
 *   buttons: { jump: { keys: ["Space"] } },
 * });
 * InputController.dispose(controller);
 * window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
 * InputController.isDown(controller, "jump"); // => false
 * ```
 *
 * @category mutations
 * @since 0.7.0
 */
export const dispose = <Axis extends string, Button extends string>(
  self: InputController<Axis, Button>
): void => {
  const controller = self as Internal<Axis, Button>;
  for (const cleanup of controller.cleanups) {
    cleanup();
  }
  controller.cleanups.length = 0;
  controller.heldKeys.clear();
  controller.drag = null;
};
