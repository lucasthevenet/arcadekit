# arcadekit/input

An input controller reads a player's keyboard, gamepad, touch drags and swipes on an element as a game's named axes and buttons. A game reads `InputController.axis`, `isDown` and `wasPressed`, and never sees a device. `InputController.moveAxes` is a ready-made pair of movement axes: WASD, the arrow keys, the left stick and a touch drag.

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM.

## Install

```bash
pnpm add arcadekit effect
```

`effect` (~4.1) is the package's one required peer dependency. This entry imports it only for its module's shape (`pipe`, the guard, `dual`): reading input runs no Effect, since a step reads its input inside the frame or tick that runs it ([ADR-0024](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0024-the-kit-is-written-as-effect-modules.md)).

## Its module

`InputController` is a namespace, written as a module of Effect is: a controller is an `InputController.InputController`, made with `InputController.make` from the element and the game's **bindings** (`InputController.Bindings`), and read by functions that take the controller first.

## Example

The `input` of a [`Game.Engine`](../game/README.md#in-the-browser): moves from the left stick or the keys, and a dash button where one press reaches one step:

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

The engine calls `input` once per attach and the source's `dispose` when it detaches, so the controller listens for exactly as long as the engine is attached. Key names are `KeyboardEvent.code` values, so they don't move with the keyboard layout, and a name the bindings don't have is a type error. See [ADR-0004](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0004-one-press-one-step.md) (one press, one step).

A function of a controller and a name also takes the name alone, and gives the function a `pipe` applies:

```ts
import { InputController } from "arcadekit/input";

const controller = InputController.make(document.createElement("canvas"), {
  axes: InputController.moveAxes,
});
const moveX = controller.pipe(InputController.axis("moveX"));
```

A game with mouse look can lock the pointer to the same surface (`requestPointerLock`) and read `movementX`/`movementY` itself: while the document has a pointer lock, a controller ignores pointer presses, since a locked pointer can't drag or swipe.
