# Input

An input controller (`arcadekit/input`) reads a player's keyboard, gamepad, touch drags and swipes on an element as the game's named axes and buttons. A game reads `InputController.axis`, `isDown` and `wasPressed`, and never sees a device. `InputController.moveAxes` is a ready-made pair of movement axes: WASD, the arrow keys, the left stick and a touch drag.

The `input` of a [`Game.Engine`](engine.md): moves from the left stick or the keys, and a dash button where one press reaches one step:

```ts
import { InputController } from "arcadekit/input";

export const raceInput = (surface: HTMLElement) => {
  const controller = InputController.make(surface, {
    axes: InputController.moveAxes,
    buttons: { dash: { keys: ["Space"], gamepadButtons: [0], swipe: "up" } },
  });
  // One object, refilled each step: reading input allocates nothing.
  const input = { moveX: 0, moveY: 0, dash: false };
  return {
    read: () => {
      input.moveX = InputController.axis(controller, "moveX");
      input.moveY = InputController.axis(controller, "moveY");
      input.dash = InputController.wasPressed(controller, "dash");
      return input;
    },
    endStep: () => InputController.consumePresses(controller),
    endFrame: () => InputController.endFrame(controller),
    dispose: () => InputController.dispose(controller),
  };
};
```

The engine calls `input` once per attach and the source's `dispose` when it detaches, so the controller listens for exactly as long as the engine is attached. Key names are `KeyboardEvent.code` values, so they don't move with the keyboard layout, and a name the bindings don't have is a type error.

A game with mouse look can lock the pointer to the same surface (`requestPointerLock`) and read `movementX`/`movementY` itself: while the document has a pointer lock, a controller ignores pointer presses, since a locked pointer can't drag or swipe.
