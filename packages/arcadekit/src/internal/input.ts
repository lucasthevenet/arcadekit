import { Context } from "effect";

import type {
  AnyControl,
  Axis,
  AxisBindings,
  AxisCode,
  Button,
  ButtonBindings,
  ButtonCode,
  ButtonState,
  Declared,
  GamepadView,
  KeyboardView,
  PointerView,
  Sample,
  Stick,
  StickBindings,
  StickState,
} from "../Input.ts";
import * as System from "../System.ts";

/**
 * What the world stores for one button, a device's or a control's: whether
 * it is down, the tick it last went down in, and the tick it last went up in.
 *
 * @internal
 */
export type Marks = readonly [
  down: number,
  pressedAt: number,
  releasedAt: number,
];

/** @internal Every button that has been down, by its code or its control's name. */
export type Buttons = Readonly<Record<string, Marks>>;

/** @internal Every axis not at 0, by its code or its control's key. */
export type Axes = Readonly<Record<string, number>>;

/** @internal The tick of a button that never went down, or never up. */
export const NEVER = -1;

/**
 * What the devices did, or what the controls did with them, over any codes:
 * `Input.Sample` without the axes that moved.
 *
 * @internal
 */
export interface Changes {
  readonly down: ReadonlySet<string>;
  readonly pressed: readonly string[];
  readonly released: readonly string[];
  readonly axes: ReadonlyMap<string, number>;
}

/**
 * What `Input.Report` carries: the buttons that went up, those that went
 * down and are down, those that went down and up again, and the axes that
 * moved.
 *
 * @internal
 */
export interface Reported {
  readonly up?: readonly string[];
  readonly down?: readonly string[];
  readonly tapped?: readonly string[];
  readonly axes?: Readonly<Record<string, number>>;
}

/**
 * The ticks the frame stage has not drawn yet: those after `since`, up to
 * the game's tick. The loop moves it on after each frame, and a rewind moves
 * it back to the moment it rewinds to.
 *
 * @internal
 */
export class Undrawn {
  /** The tick the last frame was drawn after, or the one a rewind went back to. */
  since: number;
  /**
   * The last tick a frame was drawn after, which a rewind with `again` runs
   * again: what the frame stage was shown of it, it is not shown twice.
   */
  drawn: number;
  /** How many frames were drawn, which a frame's reader tells its frames apart by. */
  frames = 0;

  constructor(tick: number) {
    this.since = tick;
    this.drawn = tick;
  }

  /** After a frame drawn after `tick`. */
  framed(tick: number): void {
    this.since = tick;
    this.drawn = tick;
    this.frames++;
  }

  /**
   * After a save of `tick` was loaded in place of the game: what it holds
   * of before that tick is no frame's to show.
   */
  restarted(tick: number): void {
    this.since = tick;
    this.drawn = tick;
  }

  /**
   * After a rewind to a moment of `tick`. What is run from there is new to
   * the frame stage, unless `again`: then the ticks it runs again were drawn,
   * and only what they do differently is new.
   */
  rewound(tick: number, again: boolean): void {
    this.since = Math.min(this.since, tick);
    if (!again) {
      this.drawn = this.since;
    }
  }
}

/**
 * Each control's state as one stage reads it, and the devices beside them:
 * what `Input.plugin` gives a stage.
 *
 * @internal
 */
export interface Faces {
  readonly keyboard: KeyboardView;
  readonly pointer: PointerView;
  readonly gamepad: (index: number) => GamepadView;
  readonly button: (control: Button) => ButtonState;
  readonly axis: (control: Axis) => number;
  readonly stick: (control: Stick) => StickState;
}

/**
 * What `Input.plugin` keeps for an app: the controls declared for it, and
 * what each stage between ticks reads of the devices and the controls.
 *
 * @internal
 */
export class Board extends Context.Service<
  Board,
  {
    /** The controls `Input.controls` declared for the app, in order. */
    readonly controls: readonly AnyControl[];
    readonly sampling: Sampling;
    /**
     * What the input stage has reported since the tick `tick`: queued and
     * not applied yet, so the world is behind by these.
     */
    readonly waiting: { tick: number; payloads: Reported[] };
    /** Declares controls, and returns the tick's view of each. */
    readonly declare: <C extends AnyControl>(
      controls: readonly C[]
    ) => Context.Context<Declared<C["name"]>>;
    /** What the frame stage is given: what changed since the last frame. */
    readonly frame: (undrawn: Readonly<Undrawn>) => Context.Context<unknown>;
    /** What the input stage is given: what this sample says, with the app's bindings. */
    readonly input: (devices: Sample) => Context.Context<unknown>;
  }
>()("arcadekit/Input.Board") {}

/**
 * The bindings the game set while it runs, by control name, for each app:
 * settings, outside the world, the save and the hash.
 *
 * @internal
 */
export const Rebound = System.local(() => new Map<string, unknown>());

/**
 * Returns a control's bindings in an app: what the game set while it runs,
 * or what the control was declared with.
 *
 * @internal
 */
export const bindingsIn = <B>(
  control: { readonly name: string; readonly bindings: B },
  rebound: ReadonlyMap<string, unknown>
): B =>
  // Written only by `Input.rebind`, which is given this control's bindings.
  (rebound.get(control.name) as B | undefined) ?? control.bindings;

type ButtonsByWay = readonly (readonly ButtonCode[] | undefined)[];

type Unheard = "held since bound" | "let go this sample";

const buttonsByWay = (
  control: AnyControl,
  rebound: ReadonlyMap<string, unknown>
): ButtonsByWay => {
  switch (control.kind) {
    case "button":
      return [bindingsIn(control, rebound)];
    case "axis": {
      const { negative, positive } = bindingsIn(control, rebound);
      return [negative, positive];
    }
    case "stick": {
      const { left, right, up, down } = bindingsIn(control, rebound);
      return [left, right, up, down];
    }
    default: {
      const never: never = control;
      throw new Error(`Not a control: ${String(never)}`);
    }
  }
};

/**
 * How the input stage reads the controls: with the bindings the game had set
 * when the sample began, and without the keys bound while they were held.
 *
 * @internal
 */
export class Sampling {
  readonly bindings = new Map<string, unknown>();
  private readonly unheard = new Map<string, Map<ButtonCode, Unheard>>();

  begin(
    controls: readonly AnyControl[],
    rebound: ReadonlyMap<string, unknown>,
    devices: Sample
  ): void {
    for (const waiting of this.unheard.values()) {
      for (const [code, state] of waiting) {
        if (state === "let go this sample") {
          waiting.delete(code);
        } else if (!devices.down.has(code)) {
          waiting.set(code, "let go this sample");
        }
      }
    }
    for (const control of controls) {
      const bound = rebound.get(control.name);
      if (bound === this.bindings.get(control.name)) {
        continue;
      }
      const before = buttonsByWay(control, this.bindings);
      this.bindings.set(control.name, bound);
      const after = buttonsByWay(control, this.bindings);
      const waiting: Map<ButtonCode, Unheard> =
        this.unheard.get(control.name) ?? new Map();
      for (const [way, codes] of after.entries()) {
        for (const code of codes ?? []) {
          if (devices.down.has(code) && before[way]?.includes(code) !== true) {
            waiting.set(code, "held since bound");
          }
        }
      }
      this.unheard.set(control.name, waiting);
    }
  }

  heard(control: AnyControl, devices: Sample): Sample {
    const waiting = this.unheard.get(control.name);
    if (waiting === undefined || waiting.size === 0) {
      return devices;
    }
    const hears = (code: ButtonCode): boolean => !waiting.has(code);
    return {
      ...devices,
      down: new Set(Array.from(devices.down).filter(hears)),
      pressed: devices.pressed.filter(hears),
      released: devices.released.filter(hears),
    };
  }
}

/** @internal The keys a stick keeps its two halves in. */
export const halves = (name: string): readonly [x: string, y: string] => [
  `${name}.x`,
  `${name}.y`,
];

/** @internal The keys of the world a control writes. */
export const keysOf = (control: AnyControl): readonly string[] =>
  control.kind === "stick" ? halves(control.name) : [control.name];

const sorted = <V>(record: Readonly<Record<string, V>>): Record<string, V> => {
  const out: Record<string, V> = {};
  for (const code of Object.keys(record).toSorted()) {
    out[code] = record[code]!;
  }
  return out;
};

/**
 * Returns the buttons after a report, or undefined if they are unchanged.
 *
 * @internal
 */
export const nextButtons = (
  before: Buttons,
  payload: Reported,
  tick: number
): Buttons | undefined => {
  const after: Record<string, Marks> = { ...before };
  let changed = false;
  for (const code of payload.up ?? []) {
    const marks = after[code];
    if (marks !== undefined && marks[0] === 1) {
      after[code] = [0, marks[1], tick];
      changed = true;
    }
  }
  for (const code of payload.down ?? []) {
    const marks = after[code];
    if (marks === undefined || marks[0] === 0) {
      after[code] = [1, tick, marks?.[2] ?? NEVER];
      changed = true;
    }
  }
  for (const code of payload.tapped ?? []) {
    const marks = after[code];
    if (marks === undefined || marks[0] === 0) {
      after[code] = [0, tick, tick];
      changed = true;
    }
  }
  // In order of code: two games that hold the same buttons hold the same data.
  return changed ? sorted(after) : undefined;
};

/**
 * Returns the axes after a report, or undefined if they are unchanged.
 *
 * @internal
 */
export const nextAxes = (
  before: Axes,
  moves: Axes | undefined
): Axes | undefined => {
  if (moves === undefined) {
    return undefined;
  }
  const after: Record<string, number> = { ...before };
  let changed = false;
  for (const code of Object.keys(moves)) {
    const value = moves[code]!;
    if ((before[code] ?? 0) === value) {
      continue;
    }
    changed = true;
    // An axis at 0 is one nobody has moved: it is not kept.
    if (value === 0) {
      delete after[code];
    } else {
      after[code] = value;
    }
  }
  return changed ? sorted(after) : undefined;
};

/**
 * Returns what must be reported for the world to match what the devices and
 * the controls say, or undefined if it matches already.
 *
 * @internal
 */
export const difference = (
  buttons: Buttons,
  axes: Axes,
  devices: Changes,
  controls: Changes | undefined
): Reported | undefined => {
  const down: string[] = [];
  const up: string[] = [];
  const tapped: string[] = [];
  let moves: Record<string, number> | undefined;
  for (const changes of controls === undefined
    ? [devices]
    : [devices, controls]) {
    for (const code of changes.down) {
      if (buttons[code]?.[0] !== 1) {
        down.push(code);
      } else if (changes.released.includes(code)) {
        // Held, let go and pressed again since the last sample: it went up,
        // and it went down.
        up.push(code);
        down.push(code);
      }
    }
    for (const code of changes.pressed) {
      // Down and up again since the last sample: the game never sees it
      // down. If it was held before that, it went up first, said below.
      if (!changes.down.has(code) && !tapped.includes(code)) {
        tapped.push(code);
      }
    }
    for (const [code, value] of changes.axes) {
      if ((axes[code] ?? 0) !== value) {
        (moves ??= {})[code] = value;
      }
    }
  }
  for (const code of Object.keys(buttons)) {
    if (
      buttons[code]![0] === 1 &&
      !devices.down.has(code) &&
      controls?.down.has(code) !== true
    ) {
      up.push(code);
    }
  }
  for (const code of Object.keys(axes)) {
    // An axis that is no longer said to be anywhere is back at 0.
    if (!devices.axes.has(code) && controls?.axes.has(code) !== true) {
      (moves ??= {})[code] = 0;
    }
  }
  if (
    down.length === 0 &&
    up.length === 0 &&
    tapped.length === 0 &&
    moves === undefined
  ) {
    return undefined;
  }
  return {
    ...(up.length > 0 ? { up } : {}),
    ...(down.length > 0 ? { down } : {}),
    ...(tapped.length > 0 ? { tapped } : {}),
    ...(moves === undefined ? {} : { axes: moves }),
  };
};

const clamp = (value: number): number => Math.max(-1, Math.min(1, value));

/**
 * Returns a button's state from one sample: held while any of its codes is
 * down, and pressed or released when one of them went down or up, unless
 * another was held all along.
 *
 * @internal
 */
export const buttonIn = (
  devices: Sample,
  codes: ButtonBindings
): ButtonState => {
  let held = false;
  let all = false;
  let pressed = false;
  let released = false;
  for (const code of codes) {
    const down = devices.down.has(code);
    const wentDown = devices.pressed.includes(code);
    const wentUp = devices.released.includes(code);
    held ||= down;
    all ||= down && !wentDown && !wentUp;
    pressed ||= wentDown;
    released ||= wentUp;
  }
  return all
    ? { held, pressed: false, released: false }
    : { held, pressed, released };
};

const anyDown = (
  devices: Sample,
  codes: readonly ButtonCode[] | undefined
): number => (codes?.some((code) => devices.down.has(code)) === true ? 1 : 0);

/**
 * Returns an axis's value from one sample: 1 while a positive code is held,
 * -1 while a negative one is, plus the gamepad's axis, from -1 to 1.
 *
 * @internal
 */
export const axisIn = (devices: Sample, bindings: AxisBindings): number =>
  clamp(
    anyDown(devices, bindings.positive) -
      anyDown(devices, bindings.negative) +
      (bindings.pad === undefined ? 0 : (devices.axes.get(bindings.pad) ?? 0))
  );

/** A stick's dead zone when it is not given one. */
const DEADZONE = 0.2;

/**
 * Returns a stick's value from one sample: the direction of the keys held,
 * plus the gamepad's stick past its dead zone, with y up and of length 1 at
 * most.
 *
 * @internal
 */
export const stickIn = (
  devices: Sample,
  bindings: StickBindings
): StickState => {
  let x = anyDown(devices, bindings.right) - anyDown(devices, bindings.left);
  let y = anyDown(devices, bindings.up) - anyDown(devices, bindings.down);
  const { pad } = bindings;
  if (pad !== undefined) {
    const px = devices.axes.get(pad.x) ?? 0;
    // A gamepad's y is down, as the page's is.
    const py = 0 - (devices.axes.get(pad.y) ?? 0);
    const deadzone = bindings.deadzone ?? DEADZONE;
    const length = Math.sqrt(px * px + py * py);
    if (length > deadzone) {
      // From the edge of the dead zone, so the stick starts at 0.
      const scale = Math.min(1, (length - deadzone) / (1 - deadzone)) / length;
      x += px * scale;
      y += py * scale;
    }
  }
  const length = Math.sqrt(x * x + y * y);
  return length > 1 ? { x: x / length, y: y / length } : { x, y };
};

/**
 * Returns what the controls say of one sample, as the input stage reads them,
 * by name, in the shape of a sample.
 *
 * @internal
 */
export const controlsIn = (
  controls: readonly AnyControl[],
  sampling: Sampling,
  sample: Sample
): Changes => {
  const down = new Set<string>();
  const pressed: string[] = [];
  const released: string[] = [];
  const axes = new Map<string, number>();
  const bound = sampling.bindings;
  for (const control of controls) {
    const devices = sampling.heard(control, sample);
    switch (control.kind) {
      case "button": {
        const state = buttonIn(devices, bindingsIn(control, bound));
        if (state.held) {
          down.add(control.name);
        }
        if (state.pressed) {
          pressed.push(control.name);
        }
        if (state.released) {
          released.push(control.name);
        }
        break;
      }
      case "axis": {
        const value = axisIn(devices, bindingsIn(control, bound));
        if (value !== 0) {
          axes.set(control.name, value);
        }
        break;
      }
      case "stick": {
        const { x, y } = stickIn(devices, bindingsIn(control, bound));
        const [kx, ky] = halves(control.name);
        if (x !== 0) {
          axes.set(kx, x);
        }
        if (y !== 0) {
          axes.set(ky, y);
        }
        break;
      }
      default: {
        const never: never = control;
        throw new Error(`Not a control: ${String(never)}`);
      }
    }
  }
  return { down, pressed, released, axes };
};

/** @internal The code of a pointer button, as `Input.pointerButton` makes it. */
export const pointerCode = (button: number): `Pointer${number}` =>
  `Pointer${button}`;

/** @internal The code of a gamepad button, as `Input.padButton` makes it. */
export const padButtonCode = (
  pad: number,
  button: number
): `Pad${number}Button${number}` => `Pad${pad}Button${button}`;

/** @internal The code of a gamepad axis, as `Input.padAxis` makes it. */
export const padAxisCode = (
  pad: number,
  axis: number
): `Pad${number}Axis${number}` => `Pad${pad}Axis${axis}`;

/** What a stage reads a button or an axis of the devices with. */
interface Reading {
  readonly down: (code: ButtonCode) => boolean;
  readonly pressed: (code: ButtonCode) => boolean;
  readonly released: (code: ButtonCode) => boolean;
  readonly axis: (code: AxisCode) => number;
}

/** The keyboard, the pointer and the gamepads, read with `reading`. */
const devicesOf = (
  reading: Reading
): Pick<Faces, "keyboard" | "pointer" | "gamepad"> => {
  const { axis, down, pressed, released } = reading;
  const pads: GamepadView[] = [];
  return {
    keyboard: { down, pressed, released },
    pointer: {
      get x() {
        return axis("PointerX");
      },
      get y() {
        return axis("PointerY");
      },
      down: (button = 0) => down(pointerCode(button)),
      pressed: (button = 0) => pressed(pointerCode(button)),
      released: (button = 0) => released(pointerCode(button)),
    },
    gamepad: (index) =>
      (pads[index] ??= {
        axis: (n) => axis(padAxisCode(index, n)),
        down: (button) => down(padButtonCode(index, button)),
        pressed: (button) => pressed(padButtonCode(index, button)),
        released: (button) => released(padButtonCode(index, button)),
      }),
  };
};

/**
 * Which of a button's marks: the tick it last went down in, or up in.
 *
 * @internal
 */
export type Went = 1 | 2;

/**
 * Says whether a button went down or up in a tick no frame has drawn, and in
 * no tick to come, since an action dispatched since the last tick is the
 * next tick's: what the frame stage reads. A tick that a rewind with `again`
 * ran again was drawn, so a press of it that the last frame saw is not shown
 * twice, and one it did not see is.
 *
 * @internal
 */
export const drawnIn = (
  held: { readonly buttons: Buttons },
  time: { readonly tick: number },
  undrawn: Readonly<Undrawn>
): ((key: string, which: Went) => boolean) => {
  // The buttons as the last frame that read them saw them, and as this
  // frame sees them: the world's record, which a change replaces whole.
  let frames = undrawn.frames - 1;
  let seen = held.buttons;
  let before = seen;
  return (key, which) => {
    if (frames !== undrawn.frames) {
      frames = undrawn.frames;
      before = seen;
      seen = held.buttons;
    }
    const tick = held.buttons[key]?.[which] ?? NEVER;
    return (
      undrawn.since < tick &&
      tick <= time.tick &&
      !(tick <= undrawn.drawn && (before[key]?.[which] ?? NEVER) === tick)
    );
  };
};

/**
 * The devices and the controls as the world holds them, where `went` says
 * whether a button went down or up in the reader's moment: in this tick for
 * the tick, since the last frame for a frame.
 *
 * @internal
 */
export const facesInWorld = (
  held: { readonly buttons: Buttons; readonly axes: Axes },
  went: (key: string, which: Went) => boolean
): Faces => {
  // A device's code or a control's name: the world keeps both alike.
  const down = (key: string): boolean => held.buttons[key]?.[0] === 1;
  const pressed = (key: string): boolean => went(key, 1);
  const released = (key: string): boolean => went(key, 2);
  const axis = (key: string): number => held.axes[key] ?? 0;
  return {
    ...devicesOf({ down, pressed, released, axis }),
    button: ({ name }) => ({
      held: down(name),
      pressed: pressed(name),
      released: released(name),
    }),
    axis: ({ name }) => axis(name),
    stick: ({ name }) => {
      const [x, y] = halves(name);
      return { x: axis(x), y: axis(y) };
    },
  };
};

/**
 * The devices and the controls as one sample says them, each control read as
 * `sampling` reads it: what the input stage reads.
 *
 * @internal
 */
export const facesInSample = (devices: Sample, sampling: Sampling): Faces => ({
  ...devicesOf({
    down: (code) => devices.down.has(code),
    pressed: (code) => devices.pressed.includes(code),
    released: (code) => devices.released.includes(code),
    axis: (code) => devices.axes.get(code) ?? 0,
  }),
  button: (control) =>
    buttonIn(
      sampling.heard(control, devices),
      bindingsIn(control, sampling.bindings)
    ),
  axis: (control) =>
    axisIn(
      sampling.heard(control, devices),
      bindingsIn(control, sampling.bindings)
    ),
  stick: (control) =>
    stickIn(
      sampling.heard(control, devices),
      bindingsIn(control, sampling.bindings)
    ),
});
