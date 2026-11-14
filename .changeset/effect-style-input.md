---
"arcadekit": minor
---

`arcadekit/input` is written as Effect's modules are: its one module is the namespace `InputController`, with a data type named after it, its `make`, an `isInputController` guard, `pipe`, a printed form, and functions that take the controller first and, given the name alone, return the function a `pipe` applies. **Breaking**: every export of `arcadekit/input` is renamed or reshaped.

A controller reads its devices as it did: the same keys, sticks, drags and swipes, the same deadzone, the same one press per step. Its reads stay plain, since a step reads its input inside the frame or tick that runs it, and it runs no Effect. It now imports `effect`, for its shape only (`Pipeable`, `Inspectable`, `Predicate`, `dual`). A name the bindings don't give is a type error on every read, as it was.

```ts
import { InputController } from "arcadekit/input";

export const raceInput = (surface: HTMLElement) => {
  // Before: new InputController(surface, { axes: MOVE_AXES, buttons: { ... } })
  const controller = InputController.make(surface, {
    axes: InputController.moveAxes,
    buttons: { dash: { keys: ["Space"] } },
  });
  const input = { moveX: 0, dash: false };
  return {
    read: () => {
      // Before: controller.axis("moveX"), controller.wasPressed("dash")
      input.moveX = InputController.axis(controller, "moveX");
      input.dash = InputController.wasPressed(controller, "dash");
      return input;
    },
    // Before: controller.consumePresses(), controller.endFrame(), controller.dispose()
    endStep: () => InputController.consumePresses(controller),
    endFrame: () => InputController.endFrame(controller),
    dispose: () => InputController.dispose(controller),
  };
};
```

**Breaking**

Every export of `arcadekit/input` before, and what a game writes now:

| Before | Now |
| --- | --- |
| `new InputController(surface, bindings)` | `InputController.make(surface, bindings)` |
| `InputController<Axis, Button>`, the class as a type | `InputController.InputController<Axis, Button>`, an interface with a readonly `bindings` |
| `controller.axis(name)` | `InputController.axis(controller, name)`, or `controller.pipe(InputController.axis(name))` |
| `controller.isDown(name)`, `controller.wasPressed(name)` | `InputController.isDown(controller, name)`, `InputController.wasPressed(controller, name)` |
| `controller.consumePresses()`, `controller.endFrame()`, `controller.dispose()` | `InputController.consumePresses(controller)`, `InputController.endFrame(controller)`, `InputController.dispose(controller)` |
| `InputBindings<Axis, Button>` | `InputController.Bindings<Axis, Button>` |
| `AxisBinding`, `ButtonBinding`, `SwipeDirection` | `InputController.AxisBinding`, `InputController.ButtonBinding`, `InputController.SwipeDirection` |
| `MOVE_AXES` | `InputController.moveAxes` |

And what follows from the shape: a controller is not an instance of a class, so `instanceof InputController` is `InputController.isInputController(value)`, and it has no methods but `pipe` and the printing ones (`toJSON`, `toString`).
