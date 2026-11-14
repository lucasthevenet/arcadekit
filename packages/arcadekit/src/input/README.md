# arcadekit/input

An input controller reads a player's keyboard, gamepad, touch drags and swipes on an element as a game's named axes and buttons. A game reads `InputController.axis`, `isDown` and `wasPressed`, and never sees a device. `InputController.moveAxes` is a ready-made pair of movement axes: WASD, the arrow keys, the left stick and a touch drag.

An entry of the [`arcadekit`](../../README.md) package. Needs the DOM.

## Install

```bash
pnpm add arcadekit effect
```

`effect` (~4.1) is the package's one required peer dependency. This entry imports it only for its module's shape (`pipe`, the guard, `dual`): reading input runs no Effect, since a step reads its input inside the frame or tick that runs it.

## Its module

`InputController` is a namespace, written as a module of Effect is: a controller is an `InputController.InputController`, made with `InputController.make` from the element and the game's **bindings** (`InputController.Bindings`), and read by functions that take the controller first.

| Namespace | What it holds | Guide |
| --- | --- | --- |
| `InputController` | A controller, its bindings, `moveAxes`, and the reads `axis`, `isDown` and `wasPressed` | [Input](https://github.com/lucasthevenet/arcadekit/blob/main/docs/guides/input.md) |

## Example

A function of a controller and a name also takes the name alone, and gives the function a `pipe` applies:

```ts
import { InputController } from "arcadekit/input";

const controller = InputController.make(document.createElement("canvas"), {
  axes: InputController.moveAxes,
});
const moveX = controller.pipe(InputController.axis("moveX"));
```
