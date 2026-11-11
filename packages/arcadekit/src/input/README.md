# arcadekit/input

`InputController` turns keyboard, gamepad, touch-drag and swipe events on an element into named axes and buttons. A game reads `axis()`, `isDown()` and `wasPressed()` and never sees raw devices. `MOVE_AXES` is a ready-made WASD, arrows, left stick and touch-drag pair.

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM.

## Install

```bash
pnpm add arcadekit effect
```

`effect` (~4.1) is the package's one required peer dependency, but this entry doesn't import it: a game can use `arcadekit/input` without running any Effect.

## Example

The `input` of a [`Game.Engine`](../game/README.md#in-the-browser): moves from the left stick or keys, and a dash button where one press reaches one step:

```ts
import { InputController, MOVE_AXES } from "arcadekit/input";

export const createInput = (surface: HTMLElement) => {
  const controller = new InputController(surface, {
    axes: MOVE_AXES,
    buttons: { dash: { keys: ["Space"], gamepadButtons: [0], swipe: "up" } },
  });
  // One object, refilled each step: reading input allocates nothing.
  const input = { moveX: 0, moveY: 0, dash: false };
  return {
    read: () => {
      input.moveX = controller.axis("moveX");
      input.moveY = controller.axis("moveY");
      input.dash = controller.wasPressed("dash");
      return input;
    },
    endStep: () => controller.consumePresses(),
    endFrame: () => controller.endFrame(),
    dispose: () => controller.dispose(),
  };
};
```

Key names are `KeyboardEvent.code` values, so they don't move with the keyboard layout. See [ADR-0004](https://github.com/lucasthevenet/arcadekit/blob/main/docs/adr/0004-one-press-one-step.md) (one press, one step).

A game with mouse look can lock the pointer to the same surface (`requestPointerLock`) and read `movementX`/`movementY` itself: while the document has a pointer lock, `InputController` ignores pointer presses, since a locked pointer can't drag or swipe.
