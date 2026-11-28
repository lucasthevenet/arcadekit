/**
 * Input from the keyboard, the pointer and gamepads, as the game sees it.
 *
 * A game names what its player does, a **control**, and binds it to the
 * devices. Its rules read the control, and know nothing of keys:
 *
 *   const Jump = Input.button("game/Jump", ["Space", Input.padButton(0, 0)])
 *   const Move = Input.stick("game/Move", {
 *     left: ["KeyA", "ArrowLeft"],
 *     right: ["KeyD", "ArrowRight"],
 *     up: ["KeyW", "ArrowUp"],
 *     down: ["KeyS", "ArrowDown"],
 *     pad: Input.padStick(0, "left"),
 *   })
 *   const Controls = Input.controls("game/Controls", [Jump, Move])
 *
 *   const Run = System.tick("game/Run", function*() {
 *     const move = yield* Input.Read(Move)          // { x, y }: y up, of length 1 at most
 *     if ((yield* Input.Read(Jump)).pressed) ...    // went down in this tick
 *   })
 *
 * The devices are outside the game. The input stage, `System.input`, reads
 * them just before a tick, works out what each control says with its
 * bindings, and reports what changed as one action, `Input.Report`, through
 * the same log as every other input from outside. A replay therefore needs
 * no devices and no bindings, since what the controls said is in its log.
 *
 * The bindings are settings, outside the world, the save and the hash. A
 * frame or input system changes them with `Input.rebind`. Below the
 * controls, `Input.Keyboard`, `Input.Pointer` and `Input.Gamepads` read the
 * devices by their codes, and an input-stage system that needs the devices
 * and the world, such as one that picks the card under the pointer, reads
 * one sample of them, `Input.Devices`, and issues an action itself.
 *
 * `Input.Source` supplies the devices. A page's keyboard, pointer and gamepads
 * come from the package's other entry point, which only a page imports:
 *
 *   import { Browser } from "arcadekit/browser"
 *   Browser.runMain(Driver.run(...), { target: canvas })
 *
 * Nothing provides a source to a replay or a server, and no devices are read
 * there.
 */
import { Context, Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";

import * as Action from "./Action.ts";
import type * as App from "./App.ts";
import * as Field from "./Field.ts";
import { whole } from "./internal/handed.ts";
import {
  Board,
  NEVER,
  Rebound,
  Sampling,
  bindingsIn,
  controlsIn,
  difference,
  drawnIn,
  facesInSample,
  facesInWorld,
  keysOf,
  nextAxes,
  nextButtons,
  padAxisCode,
  padButtonCode,
  pointerCode,
} from "./internal/input.ts";
import type {
  Axes,
  Buttons,
  Changes,
  Faces,
  Undrawn,
} from "./internal/input.ts";
import { lookup, service } from "./internal/lookup.ts";
import type { Given } from "./internal/lookup.ts";
import { partsOf } from "./internal/parts.ts";
import * as Plugin from "./Plugin.ts";
import { Time, World } from "./Services.ts";
import * as Singleton from "./Singleton.ts";
import * as System from "./System.ts";

// --- codes -------------------------------------------------------------------
// Everything that can be held down is a button with a code, and everything
// that has a value is an axis with a code. A key's code is the one the
// browser gives it, `KeyboardEvent.code`: "KeyA", "Space", "ArrowLeft".

// The values of `KeyboardEvent.code` that the UI Events specification lists,
// and the function keys a keyboard can have past F12.
const keyCodes = [
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Equal",
  "IntlBackslash",
  "IntlRo",
  "IntlYen",
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Minus",
  "Period",
  "Quote",
  "Semicolon",
  "Slash",
  "AltLeft",
  "AltRight",
  "Backspace",
  "CapsLock",
  "ContextMenu",
  "ControlLeft",
  "ControlRight",
  "Enter",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
  "Space",
  "Tab",
  "Convert",
  "KanaMode",
  "Lang1",
  "Lang2",
  "Lang3",
  "Lang4",
  "Lang5",
  "NonConvert",
  "Delete",
  "End",
  "Help",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "NumLock",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "NumpadAdd",
  "NumpadBackspace",
  "NumpadClear",
  "NumpadClearEntry",
  "NumpadComma",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadEqual",
  "NumpadHash",
  "NumpadMemoryAdd",
  "NumpadMemoryClear",
  "NumpadMemoryRecall",
  "NumpadMemoryStore",
  "NumpadMemorySubtract",
  "NumpadMultiply",
  "NumpadParenLeft",
  "NumpadParenRight",
  "NumpadStar",
  "NumpadSubtract",
  "Escape",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "Fn",
  "FnLock",
  "PrintScreen",
  "ScrollLock",
  "Pause",
  "BrowserBack",
  "BrowserFavorites",
  "BrowserForward",
  "BrowserHome",
  "BrowserRefresh",
  "BrowserSearch",
  "BrowserStop",
  "Eject",
  "LaunchApp1",
  "LaunchApp2",
  "LaunchMail",
  "MediaPlayPause",
  "MediaSelect",
  "MediaStop",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "Power",
  "Sleep",
  "AudioVolumeDown",
  "AudioVolumeMute",
  "AudioVolumeUp",
  "WakeUp",
  "Hyper",
  "Super",
  "Turbo",
  "Abort",
  "Resume",
  "Suspend",
  "Again",
  "Copy",
  "Cut",
  "Find",
  "Open",
  "Paste",
  "Props",
  "Select",
  "Undo",
  "Hiragana",
  "Katakana",
] as const;

/**
 * A key's code, the browser's `KeyboardEvent.code`: where the key is on the
 * keyboard, whatever its layout prints on it. `"KeyW"` is the key above
 * `"KeyS"` on any layout.
 *
 * @category Models
 */
export type KeyCode = (typeof keyCodes)[number];

/**
 * The code of a pointer button, as `Input.pointerButton(n)` returns it.
 *
 * @category Models
 */
export type PointerButtonCode = `Pointer${number}`;

/**
 * The code of a gamepad's button, as `Input.padButton(pad, n)` returns it.
 *
 * @category Models
 */
export type PadButtonCode = `Pad${number}Button${number}`;

/**
 * The code of anything that is held down: a key, a pointer button or a
 * gamepad's button.
 *
 * @category Models
 */
export type ButtonCode = KeyCode | PointerButtonCode | PadButtonCode;

/**
 * The code of a gamepad's axis, as `Input.padAxis(pad, n)` returns it.
 *
 * @category Models
 */
export type PadAxisCode = `Pad${number}Axis${number}`;

/**
 * The code of anything that has a value: the pointer's position on either
 * axis, or a gamepad's axis.
 *
 * @category Models
 */
export type AxisCode = typeof pointerX | typeof pointerY | PadAxisCode;

const known: ReadonlySet<string> = new Set(keyCodes);

/**
 * Returns whether a string is a key's code, as the browser's
 * `KeyboardEvent.code` gives one.
 *
 * @category Guards
 */
export const isKeyCode = (code: string): code is KeyCode => known.has(code);

/**
 * The code of the pointer's horizontal axis, whose value is the pointer's
 * position in CSS pixels from the left of its target.
 *
 * @category Constants
 */
export const pointerX = "PointerX";
/**
 * The code of the pointer's vertical axis, whose value is the pointer's
 * position in CSS pixels from the top of its target.
 *
 * @category Constants
 */
export const pointerY = "PointerY";

/**
 * Returns the code of a pointer button, or of the primary button when given
 * none. Buttons are numbered as the browser numbers them: 0 is the primary, 1
 * the middle and 2 the secondary.
 *
 * @category Utilities
 */
export const pointerButton = (button = 0): PointerButtonCode =>
  pointerCode(button);

/**
 * Returns the code of a gamepad button. Gamepads and their buttons are
 * numbered from 0, as the browser numbers them. The input guide has the
 * buttons of a standard gamepad.
 *
 * @category Utilities
 */
export const padButton = (pad: number, button: number): PadButtonCode =>
  padButtonCode(pad, button);

/**
 * Returns the code of a gamepad axis. Axes are numbered as the browser numbers
 * them. On a standard gamepad, 0 and 1 are the left stick, and 2 and 3 the
 * right stick, each from -1, left or up, to 1, right or down.
 *
 * @category Utilities
 */
export const padAxis = (pad: number, axis: number): PadAxisCode =>
  padAxisCode(pad, axis);

/**
 * A gamepad's stick: the codes of its two axes.
 *
 * @category Models
 */
export interface PadStick {
  /** The axis from -1, left, to 1, right. */
  readonly x: PadAxisCode;
  /** The axis from -1, up, to 1, down, as the browser gives it. */
  readonly y: PadAxisCode;
}

/**
 * Returns a stick of a standard gamepad: the left, axes 0 and 1, or the
 * right, axes 2 and 3.
 *
 * @category Utilities
 */
export const padStick = (pad: number, side: "left" | "right"): PadStick => {
  const first = side === "left" ? 0 : 2;
  return { x: padAxis(pad, first), y: padAxis(pad, first + 1) };
};

// --- the devices -------------------------------------------------------------

/**
 * The state of the devices at one moment, and what changed since the previous
 * sample.
 *
 * @category Models
 */
export interface Sample {
  /** The buttons held down. */
  readonly down: ReadonlySet<ButtonCode>;
  /** The buttons that went down since the previous sample, whether or not they are still down. */
  readonly pressed: readonly ButtonCode[];
  /** The buttons that went up since the previous sample. */
  readonly released: readonly ButtonCode[];
  /** The value of every non-zero axis. An axis missing here is at 0. */
  readonly axes: ReadonlyMap<AxisCode, number>;
  /** The axes whose value changed since the previous sample. */
  readonly moved: readonly AxisCode[];
}

/**
 * Devices being listened to. Each call to `sample` reads their state.
 *
 * @category Models
 */
export interface Listener {
  /**
   * Returns the devices' current state, and what changed since the last call.
   * An app calls it once per run of its input stage.
   */
  readonly sample: () => Sample;
}

/**
 * The shape of `Input.Source`. A source says how to listen to the devices, and
 * listens to nothing until `listen` runs.
 *
 * @category Services
 */
export interface SourceShape {
  /**
   * Starts listening to the devices in the current scope, and stops when that
   * scope closes.
   */
  readonly listen: Effect.Effect<Listener, never, Scope.Scope>;
}

const NOTHING: Sample = {
  down: new Set(),
  pressed: [],
  released: [],
  axes: new Map(),
  moved: [],
};

/** No devices at all, which differs from devices with nothing pressed. */
const noSource: SourceShape = {
  listen: Effect.succeed({ sample: () => NOTHING }),
};

/**
 * Where an app's input stage takes its samples from. Nothing has to provide
 * it. By default there are no devices, as a replay, a server and most tests
 * need.
 *
 * **Details**
 *
 * A page provides its own source with `Browser.layer()` from
 * `arcadekit/browser`. A test that simulates input provides one it controls,
 * `Input.layer(Input.makeManualSource())`, or makes its game with `Test.make`,
 * which does.
 *
 * Without devices, the input stage leaves the state that `Input.plugin` keeps
 * as it is. That state holds whatever was last reported to it, from a log or
 * from another machine.
 *
 * A source listens to nothing itself. `App.make` runs `listen` in the app's
 * own scope, and the listening stops when the app is closed. Wherever the
 * layer is provided, the devices are heard for as long as the app is open.
 * Each app listens for itself.
 *
 * @category Services
 */
export const Source: Context.Reference<SourceShape> =
  Context.Reference<SourceShape>("arcadekit/Input.Source", {
    defaultValue: () => noSource,
  });

/**
 * Listens to the devices of `Input.Source` in the current scope, and stops
 * when that scope closes. `App.make` listens in the app's own scope instead.
 *
 * **When to use**
 *
 * Use when a program samples the devices itself, outside an app.
 *
 * @category Running
 */
export const listen: Effect.Effect<Listener, never, Scope.Scope> =
  Effect.flatMap(Source, (source) => source.listen);

/**
 * Returns a layer that provides devices made by hand, such as
 * `Input.makeManualSource()`. The listener is used as it is, with nothing to
 * start or stop.
 *
 *   App.make(game).pipe(Effect.provide(Input.layer(source)))
 *
 * @category Layers
 */
export const layer = (listener: Listener): Layer.Layer<never> =>
  Layer.succeed(Source, { listen: Effect.succeed(listener) });

/**
 * The devices' state, for a system of the input stage. It is one sample, taken
 * when the stage began, and every system of that run reads the same one.
 *
 * **When to use**
 *
 * Use in an input-stage system that issues actions from what the devices did
 * and from the world, such as one that picks what is under the pointer. To
 * read what the player does, declare a control with `Input.button`,
 * `Input.axis` or `Input.stick`, which every stage reads. It isn't part of
 * the game, so a system of the tick or the frame stage cannot require it.
 *
 * @category Services
 */
export class Devices extends Context.Service<Devices, Sample>()(
  "arcadekit/Input.Devices"
) {}

/**
 * Devices controlled by hand, for a test, a tool or on-screen controls.
 *
 * @category Testing
 */
export interface ManualSource extends Listener {
  /** Presses a button. Does nothing if it is already down. */
  readonly press: (code: ButtonCode) => void;
  /** Releases a button. Does nothing if it is already up. */
  readonly release: (code: ButtonCode) => void;
  /** Presses and releases a button. The next sample has it pressed and released, and not down. */
  readonly tap: (code: ButtonCode) => void;
  /** Sets an axis's value. */
  readonly move: (code: AxisCode, value: number) => void;
  /** Releases every held button, or with `only`, every held button that `only` accepts. */
  readonly releaseAll: (only?: (code: ButtonCode) => boolean) => void;
}

/**
 * Makes devices controlled by hand. `press`, `release`, `tap` and `move` take
 * the codes a real device produces, and the next sample reports them. A
 * control bound to a code follows it.
 *
 *   const source = Input.makeManualSource()
 *   const app = yield* App.make(App.define({ plugins: [Controls] })).pipe(
 *     Effect.provide(Input.layer(source))
 *   )
 *   source.press("Space")
 *   yield* app.input()
 *   yield* app.tick(1 / 60)
 *
 * @category Testing
 */
export const makeManualSource = (): ManualSource => {
  const down = new Set<ButtonCode>();
  // Sets: a button that goes down twice between two samples went down.
  let pressed = new Set<ButtonCode>();
  let released = new Set<ButtonCode>();
  const axes = new Map<AxisCode, number>();
  let moved = new Set<AxisCode>();
  const press = (code: ButtonCode): void => {
    if (!down.has(code)) {
      down.add(code);
      pressed.add(code);
    }
  };
  const release = (code: ButtonCode): void => {
    if (down.delete(code)) {
      released.add(code);
    }
  };
  return {
    press,
    release,
    tap(code) {
      press(code);
      release(code);
    },
    move(code, value) {
      if ((axes.get(code) ?? 0) !== value) {
        axes.set(code, value);
        moved.add(code);
      }
    },
    releaseAll(only) {
      for (const code of Array.from(down)) {
        if (only === undefined || only(code)) {
          release(code);
        }
      }
    },
    sample() {
      const sample: Sample = {
        down: new Set(down),
        pressed: Array.from(pressed),
        released: Array.from(released),
        axes: new Map(axes),
        moved: Array.from(moved),
      };
      pressed = new Set();
      released = new Set();
      moved = new Set();
      return sample;
    },
  };
};

// --- controls ------------------------------------------------------------------

/**
 * What a game that reads a control requires, and the `Input.controls` that
 * declares it provides. A game that reads a control no `Input.controls` of
 * its declares doesn't compile: the control's name is in what `App.make`
 * requires from outside, as `Declared<"game/Jump">`.
 *
 * @category Type-level
 */
export interface Declared<out N extends string> {
  readonly "~arcadekit/Input.Declared": N;
}

/**
 * A button's state, as `Input.Read` returns it.
 *
 * @category Models
 */
export interface ButtonState {
  /** Whether it is held down. */
  readonly held: boolean;
  /**
   * Whether it went down in this tick, whether or not it is still held. A
   * frame system is told whether it went down since the last frame, and an
   * input system whether it went down since the last sample.
   */
  readonly pressed: boolean;
  /** Whether it went up in this tick, or since the last frame or sample, as `pressed`. */
  readonly released: boolean;
}

/**
 * A stick's direction, as `Input.Read` returns it: x right and y up, from
 * -1 to 1, and of length 1 at most.
 *
 * @category Models
 */
export interface StickState {
  readonly x: number;
  readonly y: number;
}

/**
 * The codes a button is held by. It is held while any of them is down.
 *
 * @category Models
 */
export type ButtonBindings = readonly ButtonCode[];

/**
 * What an axis is bound to: buttons that push it to -1 or to 1, and a
 * gamepad's axis.
 *
 * @category Models
 */
export interface AxisBindings {
  /** The buttons that push it to -1 while one is held. */
  readonly negative?: readonly ButtonCode[];
  /** The buttons that push it to 1 while one is held. */
  readonly positive?: readonly ButtonCode[];
  /** A gamepad's axis, added to what the buttons say. */
  readonly pad?: PadAxisCode;
}

/**
 * What a stick is bound to: a button or more for each direction, and a
 * gamepad's stick.
 *
 * @category Models
 */
export interface StickBindings {
  readonly left?: readonly ButtonCode[];
  readonly right?: readonly ButtonCode[];
  readonly up?: readonly ButtonCode[];
  readonly down?: readonly ButtonCode[];
  /** A gamepad's stick, added to what the buttons say. */
  readonly pad?: PadStick;
  /**
   * How far the gamepad's stick moves from its center, in any direction,
   * before it counts. Past it, the stick counts from 0. Defaults to 0.2.
   */
  readonly deadzone?: number;
}

// The bindings as data, which a settings store keeps and gives back: a code
// that is not one is refused when the store's text is read.
const buttonCode = Schema.Union([
  Schema.Literals(keyCodes),
  Schema.TemplateLiteral(["Pointer", Schema.Number]),
  Schema.TemplateLiteral(["Pad", Schema.Number, "Button", Schema.Number]),
]);
const padAxisSchema = Schema.TemplateLiteral([
  "Pad",
  Schema.Number,
  "Axis",
  Schema.Number,
]);
const buttons = Schema.optionalKey(Schema.Array(buttonCode));
const buttonSchema: Schema.Codec<ButtonBindings> = Schema.Array(buttonCode);
const axisSchema: Schema.Codec<AxisBindings> = Schema.Struct({
  negative: buttons,
  positive: buttons,
  pad: Schema.optionalKey(padAxisSchema),
});
const stickSchema: Schema.Codec<StickBindings> = Schema.Struct({
  left: buttons,
  right: buttons,
  up: buttons,
  down: buttons,
  pad: Schema.optionalKey(
    Schema.Struct({ x: padAxisSchema, y: padAxisSchema })
  ),
  deadzone: Schema.optionalKey(Schema.Finite),
});

// Keeps a control's state in its type, which nothing else of it says.
declare const StateBrand: unique symbol;

/**
 * Something the player does, named by the game and bound to the devices:
 * what `Input.button`, `Input.axis` and `Input.stick` declare.
 * `yield* Input.Read(control)` returns its state in the stage that reads it.
 *
 * @typeParam N its name
 * @typeParam A its state
 * @typeParam B its bindings
 *
 * @category Models
 */
export interface Control<
  out N extends string = string,
  out A = unknown,
  out B = unknown,
> {
  readonly [StateBrand]?: A;
  /** Its name, which no other control of the game has. */
  readonly name: N;
  /** What it is bound to unless the game rebinds it. */
  readonly bindings: B;
  /**
   * The schema of its bindings, whose JSON form a settings store keeps:
   * `Setting.define("game/JumpKeys", Jump.schema, Jump.bindings)`.
   */
  readonly schema: Schema.Codec<B>;
}

/**
 * A button, as `Input.button` declares it.
 *
 * @category Models
 */
export interface Button<out N extends string = string> extends Control<
  N,
  ButtonState,
  ButtonBindings
> {
  readonly kind: "button";
}

/**
 * An axis, as `Input.axis` declares it. Its state is a number from -1 to 1.
 *
 * @category Models
 */
export interface Axis<out N extends string = string> extends Control<
  N,
  number,
  AxisBindings
> {
  readonly kind: "axis";
}

/**
 * A stick, as `Input.stick` declares it.
 *
 * @category Models
 */
export interface Stick<out N extends string = string> extends Control<
  N,
  StickState,
  StickBindings
> {
  readonly kind: "stick";
}

/**
 * Any button, axis or stick.
 *
 * @category Type-level
 */
export type AnyControl = Button | Axis | Stick;

/** What each stage reads a control's state from. */
type Face<A> = () => A;

/** The service each control's state is read from, by its name. */
const keyOf = <N extends string, A>(name: N) =>
  Context.Service<Declared<N>, Face<A>>(`arcadekit/Input.${name}`);

class Declaration<K extends AnyControl["kind"], N extends string, A, B> {
  /** Where each stage keeps what reads the control's state. */
  readonly face: Context.Service<Declared<N>, Face<A>>;

  constructor(
    readonly kind: K,
    readonly name: N,
    readonly bindings: B,
    readonly schema: Schema.Codec<B>
  ) {
    this.face = keyOf<N, A>(name);
  }
}

const stateOf = <A>(given: Given, control: Control<string, A>): A => {
  if (!(control instanceof Declaration)) {
    throw new Error(
      `Input.Read was given "${control.name}", which Input.button, Input.axis or Input.stick did not declare.`
    );
  }
  return service(
    given,
    (control as Declaration<never, string, A, unknown>).face
  )();
};

/**
 * Asks for a control's state in the stage that reads it: in the tick, what
 * the world holds of it, and in the frame and input stages, what the devices
 * say now.
 *
 *   const jump = yield* Input.Read(Jump)   // { held, pressed, released }
 *   const x = yield* Input.Read(Steer)     // from -1 to 1
 *
 * A game that reads a control declares it with `Input.controls`, or doesn't
 * compile.
 *
 * @category Capabilities
 */
export const Read = <N extends string, A>(
  control: Control<N, A>
): Effect.Effect<A, never, Declared<N>> => lookup(stateOf, control);

/**
 * A control's name: its feature, a slash, and what it is, as `"game/Jump"`.
 * No device's code has a slash, so a name is never a code.
 *
 * @category Type-level
 */
export type Name = `${string}/${string}`;

/**
 * Declares a button, held while any of its codes is down.
 *
 *   const Jump = Input.button("game/Jump", ["Space", Input.padButton(0, 0)])
 *
 *   const Leap = System.tick("game/Leap", function* () {
 *     const jump = yield* Input.Read(Jump)   // { held, pressed, released }
 *     if (jump.pressed) ...
 *   })
 *
 * **Details**
 *
 * - Pressing a second of its codes while one is held is no new press, and
 *   letting one go while another is held doesn't release it.
 * - A game that reads it declares it with `Input.controls`, or doesn't
 *   compile.
 *
 * @category Constructors
 */
export const button = <const N extends Name>(
  name: N,
  bindings: ButtonBindings
): Button<N> =>
  new Declaration<"button", N, ButtonState, ButtonBindings>(
    "button",
    name,
    bindings,
    buttonSchema
  );

/**
 * Declares an axis, a number from -1 to 1: 1 while a `positive` button is
 * held, -1 while a `negative` one is, 0 while both are or neither is, plus
 * the gamepad's axis.
 *
 *   const Steer = Input.axis("game/Steer", {
 *     negative: ["ArrowLeft", "KeyA"],
 *     positive: ["ArrowRight", "KeyD"],
 *     pad: Input.padAxis(0, 0),
 *   })
 *
 *   const x = yield* Input.Read(Steer)
 *
 * @category Constructors
 */
export const axis = <const N extends Name>(
  name: N,
  bindings: AxisBindings
): Axis<N> =>
  new Declaration<"axis", N, number, AxisBindings>(
    "axis",
    name,
    bindings,
    axisSchema
  );

/**
 * Declares a stick: a direction, from buttons for each way and from a
 * gamepad's stick, with x right and y up, of length 1 at most.
 *
 *   const Move = Input.stick("game/Move", {
 *     left: ["KeyA", "ArrowLeft"],
 *     right: ["KeyD", "ArrowRight"],
 *     up: ["KeyW", "ArrowUp"],
 *     down: ["KeyS", "ArrowDown"],
 *     pad: Input.padStick(0, "left"),
 *   })
 *
 *   const { x, y } = yield* Input.Read(Move)
 *
 * **Details**
 *
 * - Two keys held together, such as right and up, give a diagonal of length
 *   1, not of length 1.41.
 * - The gamepad's stick counts once it is `deadzone` from its center, 0.2 by
 *   default, in any direction, and counts from 0 there. Its y is turned
 *   around, so up is up whatever the gamepad says.
 *
 * @category Constructors
 */
export const stick = <const N extends Name>(
  name: N,
  bindings: StickBindings
): Stick<N> =>
  new Declaration<"stick", N, StickState, StickBindings>(
    "stick",
    name,
    bindings,
    stickSchema
  );

/**
 * Changes what a control is bound to in this app, from a frame or an input
 * system, such as a menu that asks the player for a key. It takes effect at
 * the next sample of the devices: the input systems after it in this sample
 * read the bindings the sample began with.
 *
 *   const Choose = System.input("game/Choose", function* () {
 *     const [key] = (yield* Input.Devices).pressed
 *     if (key !== undefined) yield* Input.rebind(Jump, [key])
 *   })
 *
 * **Details**
 *
 * - A key that is down at that sample, as the one the player pressed to
 *   choose and still holds, moves the control only from its next press: the
 *   control stays up until the key is let go and pressed again. A key the
 *   control was already bound to the same way counts as it did.
 * - Bindings are settings, not the game: they are outside the world, so a
 *   save, the hash, the log and a rewind leave them as they are, and a
 *   replay needs none. Each app has its own, and they are let go of when it
 *   is closed. `Input.rebind(Jump, Jump.bindings)` puts back the ones it was
 *   declared with.
 * - A system of the tick that rebinds doesn't compile, nor does a game that
 *   rebinds a control it doesn't declare.
 * - Code outside the game's systems, such as a settings menu in the page,
 *   rebinds with `Input.settingsOf`, and keeps the bindings in a setting
 *   of the control's `schema`.
 *
 * @category Running
 */
export const rebind = <N extends string, B>(
  control: Control<N, unknown, B>,
  bindings: NoInfer<B>
): Effect.Effect<void, never, Declared<N> | System.Locals> =>
  Effect.gen(function* () {
    // Declared, as the type says: a control nobody declared has no bindings.
    yield* keyOf(control.name);
    (yield* System.Kept(Rebound)).set(control.name, bindings);
  });

/**
 * Returns what a control is bound to in this app: what `Input.rebind` last
 * set, or what the control was declared with. A frame or input system reads
 * it, for a menu that shows the player's keys.
 *
 * @category Running
 */
export const bindingsOf = <N extends string, B>(
  control: Control<N, unknown, B>
): Effect.Effect<B, never, Declared<N> | System.Locals> =>
  Effect.gen(function* () {
    yield* keyOf(control.name);
    return bindingsIn(control, yield* System.Kept(Rebound));
  });

/**
 * The names of the controls a plugin declares, with those of the plugins it
 * depends on: the controls `Input.settingsOf` takes.
 *
 * @category Type-level
 */
export type DeclaredBy<P> = NamesIn<Plugin.ProvidedOf<P>>;

type NamesIn<D> = D extends Declared<infer N> ? N : never;

/**
 * The bindings of a running app's controls, for code outside its systems,
 * as `Input.settingsOf` returns them: a settings menu, or a store that keeps
 * the player's keys.
 *
 * @typeParam N the names of the controls it takes
 *
 * @category Models
 */
export interface Settings<N extends string> {
  /**
   * Changes what a control is bound to in the app, from its next sample of
   * the devices on, as `Input.rebind` does from a system.
   */
  readonly rebind: <M extends N, B>(
    control: Control<M, unknown, B>,
    bindings: NoInfer<B>
  ) => Effect.Effect<void>;
  /**
   * Returns what a control is bound to in the app now. It is plain data,
   * which `JSON.stringify` keeps and `rebind` takes back.
   */
  readonly bindingsOf: <M extends N, B>(
    control: Control<M, unknown, B>
  ) => Effect.Effect<B>;
}

/**
 * Returns the bindings of a running app's controls, for code outside its
 * systems: a settings menu in the page's UI, or a store that keeps them
 * between two runs. It takes the plugin that declares the controls, or one
 * that depends on it, and the handle it returns takes only the controls that
 * plugin declares.
 *
 *   Driver.run(Game, {
 *     hz: 60,
 *     ready: (app) => {
 *       const settings = Input.settingsOf(app, Controls)
 *       return settings.rebind(Jump, ["KeyK"])
 *     },
 *   })
 *
 * **Details**
 *
 * - They are the same bindings `Input.rebind` and `Input.bindingsOf` change
 *   and read from a system: settings, outside the world, the save and the
 *   hash, each app its own.
 * - `bindingsOf` gives plain data. A store keeps it with `JSON.stringify`,
 *   and gives it back to the next run's app with `rebind`.
 * - It throws for an app that wasn't made with the plugin.
 *
 * @category Running
 */
export const settingsOf = <P extends Plugin.Any>(
  app: App.Any,
  controls: P
): Settings<DeclaredBy<P>> => {
  if (!app.plugins.includes(controls.name)) {
    throw new Error(
      `Input.settingsOf was given an app without the plugin "${controls.name}": its controls are no app's. Give it the app the game made with that plugin, or the plugin the app was made with.`
    );
  }
  const rebound = (): Map<string, unknown> => partsOf(app).locals.get(Rebound);
  return {
    rebind: (control, bindings) =>
      Effect.sync(() => {
        rebound().set(control.name, bindings);
      }),
    bindingsOf: (control) => Effect.sync(() => bindingsIn(control, rebound())),
  };
};

// --- the state in the world ----------------------------------------------------

// One singleton for all of it, the devices' codes and the controls' names
// alike. It is written only when something changes, so a game nobody
// touches hashes as it did, and always with a new object: a refused action
// puts the old one back.
const Held = Singleton.define("arcadekit/Input", {
  /**
   * Every button that has been down, a device's or a control's, and the
   * ticks it last went down and up in: a frame after several ticks reads
   * them.
   */
  buttons: Field.json<Buttons>({}),
  /** Every axis not at 0, a device's or a control's. */
  axes: Field.json<Axes>({}),
});

const ReportSchema = Schema.Struct({
  /** Buttons that went up. */
  up: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Buttons that went down, and are still down. */
  down: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Buttons that went down and up again between samples: pressed, but not held. */
  tapped: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The axes that moved, and their new values. */
  axes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
});

/**
 * What the devices and the controls did since the game's last report, as an
 * action. `Input.plugin` issues it from the input stage and handles it, and
 * so keeps their state in the world.
 *
 * **Details**
 *
 * A button or an axis is named by its code, as `"Space"` or `"PointerX"`, or
 * by its control's name, as `"game/Jump"`. A stick is two axes, its name with
 * `.x` and `.y`. A test, a tool or another machine can send it too. Where
 * there are devices, the state it sets lasts until the input stage next reads
 * them, and that read reports whatever differs from the devices. Where there
 * are none, the state lasts until the next report.
 *
 * The lists apply in the order they are declared: `up`, then `down`, then
 * `tapped`. A held button in both `up` and `down` was released and pressed
 * again, and is held. A held button in both `up` and `tapped` went up, then was
 * pressed and released again.
 *
 * @category Actions
 */
export const Report = Action.define("arcadekit/Input.Report", {
  payload: ReportSchema,
});

const report = Action.handler(Report, function* (payload) {
  const held = yield* Singleton.Write(Held);
  // It is applied at the start of a tick, before the tick is counted: the
  // tick whose systems see it first is the next.
  const tick = (yield* Time).tick + 1;
  const buttons = nextButtons(held.buttons, payload, tick);
  if (buttons !== undefined) {
    held.buttons = buttons;
  }
  const axes = nextAxes(held.axes, payload.axes);
  if (axes !== undefined) {
    held.axes = axes;
  }
});

/**
 * Reads the devices into the game: works out what the controls say of them,
 * compares both with the state the game will have at its next tick, and
 * reports any difference as an action.
 */
const ReadDevices = System.input("arcadekit/Input.Read", function* () {
  // Where there are no devices there is nothing to bring the state up to
  // date with: it stays as it was last reported, by a log or by another
  // machine. No devices is not devices with every button up.
  if ((yield* Source) === noSource) {
    return;
  }
  const devices = yield* Devices;
  const { controls, sampling, waiting } = yield* Board;
  const world = whole(yield* World);
  const { tick } = yield* Time;
  let { axes, buttons } = world.singleton(Held);
  // Read twice with no tick between, the state is what the world holds and
  // what was reported the first time.
  if (waiting.tick !== tick) {
    waiting.tick = tick;
    waiting.payloads = [];
  }
  for (const earlier of waiting.payloads) {
    buttons = nextButtons(buttons, earlier, tick + 1) ?? buttons;
    axes = nextAxes(axes, earlier.axes) ?? axes;
  }
  let said: Changes | undefined;
  if (controls.length > 0) {
    sampling.begin(controls, yield* System.Kept(Rebound), devices);
    said = controlsIn(controls, sampling, devices);
  }
  const payload = difference(buttons, axes, devices, said);
  if (payload !== undefined) {
    waiting.payloads.push(payload);
    (yield* Action.Actions).enqueue(Report, payload);
  }
});

// --- the devices, as a system reads them -----------------------------------------

/**
 * Keys, as a system reads them.
 *
 * @category Models
 */
export interface KeyboardView {
  /** Returns whether a key is held down. */
  readonly down: (code: KeyCode) => boolean;
  /**
   * Returns whether a key went down in this tick, whether or not it is still
   * held: since the last frame for a frame system, and since the last sample
   * for an input system.
   */
  readonly pressed: (code: KeyCode) => boolean;
  /** Returns whether a key went up in this tick, or since the last frame or sample, as `pressed`. */
  readonly released: (code: KeyCode) => boolean;
}

/**
 * The pointer, as a system reads it. Its `x` and `y` are a point, which
 * `Three.toPlane` of `@arcadekit/three` turns into the game's units.
 *
 * @category Models
 */
export interface PointerView {
  /** CSS pixels from the left of the target the page listens on. */
  readonly x: number;
  /** CSS pixels from the top of that target. */
  readonly y: number;
  /** Returns whether a button is held down. The button defaults to 0, the primary button. */
  readonly down: (button?: number) => boolean;
  /** Returns whether a button went down, as `KeyboardView.pressed` says. The button defaults to 0, the primary button. */
  readonly pressed: (button?: number) => boolean;
  /** Returns whether a button went up, as `KeyboardView.released` says. The button defaults to 0, the primary button. */
  readonly released: (button?: number) => boolean;
}

/**
 * One gamepad, as a system reads it.
 *
 * @category Models
 */
export interface GamepadView {
  /** Returns an axis's position, from -1 to 1, or 0 when there is no such gamepad. */
  readonly axis: (axis: number) => number;
  /** Returns whether a button is held down. */
  readonly down: (button: number) => boolean;
  /** Returns whether a button went down, as `KeyboardView.pressed` says. */
  readonly pressed: (button: number) => boolean;
  /** Returns whether a button went up, as `KeyboardView.released` says. */
  readonly released: (button: number) => boolean;
}

/**
 * The keyboard's state in the current tick, which `Input.plugin` provides:
 * the level below the controls, for what reads a key by its code.
 *
 *   const keys = yield* Input.Keyboard
 *   keys.down("ArrowLeft")    // held
 *   keys.pressed("Space")     // went down in this tick
 *   keys.released("Space")    // went up in this tick
 *
 * **When to use**
 *
 * Use where a key is the point, as a debug key. To read what the player
 * does, declare a control with `Input.button`, which the player can rebind.
 *
 * **Details**
 *
 * The keyboard, the pointer, the gamepads and the controls are read the same
 * way, by the stage that reads them:
 *
 * - In the tick, `pressed` and `released` are true only in the first tick
 *   that sees the change. A system that runs every tick sees each change
 *   once. The handlers of the actions applied at the start of that tick see
 *   it too.
 * - A frame system is told what changed in the ticks since the last frame,
 *   so it too sees each change once, in the first frame after its tick,
 *   however many frames a tick has or ticks a frame has. After
 *   `Timeline.rewind`, the ticks run again are new to it, as their events
 *   are. After a rewind with `{ again: true }`, as a rollback session makes,
 *   a press the last frame showed isn't shown again, and one that only the
 *   ticks run again have is shown once.
 * - An input system is told what the devices say in this run's sample, with
 *   the app's bindings: what changed since the last sample.
 *
 * **Gotchas**
 *
 * - A key pressed and released between two ticks is both pressed and released
 *   in the next tick, and isn't down.
 * - A held key released and pressed again between two ticks is both released
 *   and pressed in the next tick, and is down.
 * - A game that reads it and leaves out `Input.plugin` doesn't compile.
 *
 * @category Views
 */
export class Keyboard extends Context.Service<Keyboard, KeyboardView>()(
  "arcadekit/Input.Keyboard"
) {}

/**
 * The pointer's state in the current tick, which `Input.plugin` provides, read
 * as `Input.Keyboard` is.
 *
 *   const at = yield* Three.toPlane(yield* Input.Pointer)
 *
 * @category Views
 */
export class Pointer extends Context.Service<Pointer, PointerView>()(
  "arcadekit/Input.Pointer"
) {}

/**
 * Every gamepad's state in the current tick, by index, which `Input.plugin`
 * provides. A system reads it as it reads `Input.Keyboard`, and one gamepad
 * of it by its index:
 *
 *   const pads = yield* Input.Gamepads
 *   pads(0).axis(0)          // the first gamepad's first axis
 *
 * @category Views
 */
export class Gamepads extends Context.Service<
  Gamepads,
  (index: number) => GamepadView
>()("arcadekit/Input.Gamepads") {}

// --- the plugins ---------------------------------------------------------------

/** How a stage reads one control. */
const faceOf = (faces: Faces, control: AnyControl): Face<unknown> => {
  switch (control.kind) {
    case "button":
      return () => faces.button(control);
    case "axis":
      return () => faces.axis(control);
    case "stick":
      return () => faces.stick(control);
    default: {
      const never: never = control;
      throw new Error(`Not a control: ${String(never)}`);
    }
  }
};

/**
 * What a stage is given of the devices, and of each control declared: the
 * services of `S`, by the keys a game reads them with.
 */
const contextOf = <S>(
  faces: Faces,
  controls: readonly AnyControl[]
): Context.Context<S> => {
  const services = new Map<string, unknown>([
    [Keyboard.key, faces.keyboard],
    [Pointer.key, faces.pointer],
    [Gamepads.key, faces.gamepad],
  ]);
  for (const control of controls) {
    services.set(keyOf(control.name).key, faceOf(faces, control));
  }
  return Context.makeUnsafe<S>(services);
};

const board = Layer.effectContext(
  Effect.gen(function* () {
    const world = whole(yield* World);
    const time = yield* Time;
    const held = world.singleton(Held);
    // The tick whoever asks belongs to. An action's handler runs before its
    // tick is counted, in a transaction of the world, which is how it is
    // known here: it is told what that tick's systems will be told.
    const now = (): number => time.tick + (world._recording ? 1 : 0);
    const ticked = facesInWorld(
      held,
      (key, which) => (held.buttons[key]?.[which] ?? NEVER) === now()
    );
    const controls: AnyControl[] = [];
    const sampling = new Sampling();
    const taken = new Map<string, string>();
    const shape: Context.Service.Shape<typeof Board> = {
      controls,
      sampling,
      waiting: { tick: NEVER, payloads: [] },
      declare: <C extends AnyControl>(declared: readonly C[]) => {
        for (const control of declared) {
          for (const key of keysOf(control)) {
            const other = taken.get(key);
            if (other !== undefined) {
              throw new Error(
                `The control "${control.name}" was declared where "${other}" already was: two controls keep the same state. Give each its own name, and declare each in one Input.controls.`
              );
            }
            taken.set(key, control.name);
          }
          controls.push(control);
        }
        return contextOf<Declared<C["name"]>>(ticked, declared);
      },
      frame: (undrawn: Readonly<Undrawn>) =>
        contextOf(facesInWorld(held, drawnIn(held, time, undrawn)), controls),
      input: (devices) => contextOf(facesInSample(devices, sampling), controls),
    };
    return Context.make(Keyboard, ticked.keyboard).pipe(
      Context.add(Pointer, ticked.pointer),
      Context.add(Gamepads, ticked.gamepad),
      Context.add(Board, shape)
    );
  })
);

/**
 * Keeps the devices' state in the world: which buttons are down, which went
 * down or up in this tick, and where the axes are. It provides
 * `Input.Keyboard`, `Input.Pointer` and `Input.Gamepads`, from which systems
 * and action handlers read the devices by their codes, and keeps the state of
 * the controls that `Input.controls` declares beside them.
 *
 * **When to use**
 *
 * `Input.controls` installs it. Name it in a game's plugins alone where its
 * systems read the devices by their codes and declare no control.
 *
 * **Details**
 *
 * - The devices are read once before each tick, in the input stage. What
 *   changed becomes one action in the log, `Input.Report`, and nothing is
 *   logged while nothing changes. Every system in a tick therefore sees the
 *   same state, and a replay sees the same state as the game.
 * - The state is a singleton of the world. It is saved with the game, restored
 *   when an action is refused, and included in the hash once something was
 *   pressed.
 * - The devices win over a save. When a game is loaded from a save in which a
 *   key was held, and the key is no longer down, the first read releases it.
 *
 * **Gotchas**
 *
 * - It holds one state, for one player's devices. For several players, on one
 *   machine or several, write an input system that reads `Input.Devices` and
 *   issues actions that carry the player.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Input", {
  handlers: [report],
  systems: [ReadDevices],
  layer: board,
});

/**
 * Makes a plugin that declares a game's controls, installs `Input.plugin`
 * before it, and keeps what each control says in the world, so that every
 * stage can read it.
 *
 *   const Controls = Input.controls("game/Controls", [Jump, Move])
 *   App.define({ plugins: [Controls], systems: [Leap, Walk] })
 *
 * **Details**
 *
 * - Each input stage works out what every control says of the devices with
 *   the app's bindings, and reports what changed with the devices' own
 *   state, in one `Input.Report`. The log holds the controls' state, so a
 *   replay plays the same game whatever its bindings, or with no devices.
 * - Several plugins can each declare their own controls. Two controls of one
 *   name are refused when the app is made.
 *
 * @category Constructors
 */
export const controls = <
  const Id extends string,
  const C extends readonly AnyControl[],
>(
  name: Id,
  declared: C
) =>
  Plugin.make(name, {
    plugins: [plugin],
    layer: Layer.effectContext(
      Effect.map(Board, (made) => made.declare<C[number]>(declared))
    ),
  });
