/**
 * Input from the keyboard, the pointer and gamepads, as the game sees it.
 *
 * The devices are outside the game. Their input reaches it as actions, through
 * the same log as every other input from outside. A replay therefore needs no
 * devices, because the actions are in its log.
 *
 * A game reads input in one of two ways, or both.
 *
 * **Device state.** `Input.plugin` keeps the held buttons, and the pointer and
 * stick positions, in the world. A system reads them:
 *
 *   const Steer = System.tick("game/Steer", function*() {
 *     const keys = yield* Input.Keyboard
 *     if (keys.down("ArrowLeft")) ...       // held
 *     if (keys.pressed("Space")) ...        // went down in this tick
 *     const pointer = yield* Input.Pointer  // pointer.x, pointer.y, pointer.down()
 *   })
 *
 * **Bindings.** `Input.bind` maps device input to the game's own actions, so
 * the game's handlers know nothing about keys:
 *
 *   const Controls = Input.bind("game/Controls",
 *     Input.onPress(["Space", Input.padButton(0, 0)], Jump),
 *     Input.onPress(Input.pointerButton(), Fire, (devices) => ({
 *       x: devices.axes.get(Input.pointerX) ?? 0
 *     }))
 *   )
 *
 * Both read the devices in the input stage, `System.input`, which runs just
 * before a tick. The world is read-only in that stage, and its systems receive
 * the devices' state as `Input.Devices`. When a binding isn't enough, an
 * input-stage system reads `Input.Devices` and the world, and issues an action
 * itself with `Actions.enqueue`. Picking the card under the pointer needs both.
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
import type { World as EcsWorld } from "./ecs/world.ts";
import * as Field from "./Field.ts";
import { whole } from "./internal/handed.ts";
import * as Plugin from "./Plugin.ts";
import { Time, World } from "./Services.ts";
import * as Singleton from "./Singleton.ts";
import * as System from "./System.ts";

// --- codes -------------------------------------------------------------------
// Everything that can be held down is a button with a code, and everything
// that has a value is an axis with a code. A key's code is the one the
// browser gives it, `KeyboardEvent.code`: "KeyA", "Space", "ArrowLeft".

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
export const pointerButton = (button = 0): string => `Pointer${button}`;

/**
 * Returns the code of a gamepad button. Gamepads and their buttons are
 * numbered from 0, as the browser numbers them.
 *
 * @category Utilities
 */
export const padButton = (pad: number, button: number): string =>
  `Pad${pad}Button${button}`;

/**
 * Returns the code of a gamepad axis. Axes are numbered as the browser numbers
 * them. On a standard gamepad, 0 and 1 are the left stick, and 2 and 3 the
 * right stick.
 *
 * @category Utilities
 */
export const padAxis = (pad: number, axis: number): string =>
  `Pad${pad}Axis${axis}`;

// --- the devices -------------------------------------------------------------

/**
 * The state of the devices at one moment, and what changed since the previous
 * sample.
 *
 * @category Models
 */
export interface Sample {
  /** The buttons held down. */
  readonly down: ReadonlySet<string>;
  /** The buttons that went down since the previous sample, whether or not they are still down. */
  readonly pressed: readonly string[];
  /** The buttons that went up since the previous sample. */
  readonly released: readonly string[];
  /** The value of every non-zero axis. An axis missing here is at 0. */
  readonly axes: ReadonlyMap<string, number>;
  /** The axes whose value changed since the previous sample. */
  readonly moved: readonly string[];
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
export interface Source {
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
const noSource: Source = {
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
 * `Input.layer(Input.makeManualSource())`.
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
export const Source: Context.Reference<Source> = Context.Reference<Source>(
  "arcadekit/Input.Source",
  { defaultValue: () => noSource }
);

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
 * Use in an input-stage system that issues actions from what the devices did.
 * It isn't part of the game, so a system of the tick or the frame stage cannot
 * require it. Such a system reads the game's device state instead, with
 * `Input.Keyboard`, `Input.Pointer` or `Input.Gamepad`.
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
  readonly press: (code: string) => void;
  /** Releases a button. Does nothing if it is already up. */
  readonly release: (code: string) => void;
  /** Presses and releases a button. The next sample has it pressed and released, and not down. */
  readonly tap: (code: string) => void;
  /** Sets an axis's value. */
  readonly move: (code: string, value: number) => void;
  /** Releases every held button, or with `only`, every held button that `only` accepts. */
  readonly releaseAll: (only?: (code: string) => boolean) => void;
}

/**
 * Makes devices controlled by hand. `press`, `release`, `tap` and `move` take
 * the codes a real device produces, and the next sample reports them.
 *
 *   const source = Input.makeManualSource()
 *   const app = yield* App.make(App.define({ plugins: [Game] })).pipe(
 *     Effect.provide(Input.layer(source))
 *   )
 *   source.press("Space")
 *   yield* app.input()
 *   yield* app.tick(1 / 60)
 *
 * @category Testing
 */
export const makeManualSource = (): ManualSource => {
  const down = new Set<string>();
  // Sets: a button that goes down twice between two samples went down.
  let pressed = new Set<string>();
  let released = new Set<string>();
  const axes = new Map<string, number>();
  let moved = new Set<string>();
  const press = (code: string): void => {
    if (!down.has(code)) {
      down.add(code);
      pressed.add(code);
    }
  };
  const release = (code: string): void => {
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

// --- the picture in the world ---------------------------------------------------

/**
 * What the world stores for one button: whether it is down, the tick it last
 * went down in, and the tick it last went up in.
 */
type Marks = readonly [down: number, pressedAt: number, releasedAt: number];
type Buttons = Readonly<Record<string, Marks>>;
type Axes = Readonly<Record<string, number>>;

const NEVER = -1;

// One singleton for all of it. It is written only when something changes,
// so a game nobody touches hashes as it did, and always with a new object:
// a refused action puts the old one back.
const Held = Singleton.define(
  "arcadekit/Input",
  {
    /**
     * Every button held down, and the ones that went up in the last tick that
     * received a report.
     */
    buttons: Field.json<Buttons>(),
    /** Every axis not at 0. */
    axes: Field.json<Axes>(),
  },
  { buttons: {}, axes: {} }
);

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
type ReportPayload = typeof ReportSchema.Type;

/**
 * What the devices did since the game's last report, as an action.
 * `Input.plugin` issues it from the input stage and handles it, and so keeps
 * the device state in the world.
 *
 * **Details**
 *
 * A test, a tool or another machine can send it too. Where there are devices,
 * the state it sets lasts until the input stage next reads them, and that read
 * reports whatever differs from the devices. Where there are none, the state
 * lasts until the next report.
 *
 * The lists apply in the order they are declared: `up`, then `down`, then
 * `tapped`. A held button in both `up` and `down` was released and pressed
 * again, and is held. A held button in both `up` and `tapped` went up, then was
 * pressed and released again.
 *
 * @category Actions
 */
export const Report = Action.define("arcadekit/Input.Report", ReportSchema);

const sorted = <V>(record: Readonly<Record<string, V>>): Record<string, V> => {
  const out: Record<string, V> = {};
  for (const code of Object.keys(record).toSorted()) {
    out[code] = record[code]!;
  }
  return out;
};

/** Returns the buttons after a report, or undefined if they are unchanged. */
const nextButtons = (
  before: Buttons,
  payload: ReportPayload,
  tick: number
): Buttons | undefined => {
  const after: Record<string, Marks> = {};
  let changed = false;
  for (const code of Object.keys(before)) {
    const marks = before[code]!;
    // A button that is up is remembered for the tick it went up in.
    if (marks[0] === 1 || marks[2] >= tick) {
      after[code] = marks;
    } else {
      changed = true;
    }
  }
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

/** Returns the axes after a report, or undefined if they are unchanged. */
const nextAxes = (before: Axes, moves: Axes | undefined): Axes | undefined => {
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

const report = Action.handler(Report, function* (payload) {
  const held = yield* Held.writes;
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

/** Returns what must be reported for the input state to match the devices. */
const difference = (
  buttons: Buttons,
  axes: Axes,
  devices: Sample
): ReportPayload | undefined => {
  const down: string[] = [];
  const up: string[] = [];
  const tapped: string[] = [];
  for (const code of devices.down) {
    if (buttons[code]?.[0] !== 1) {
      down.push(code);
    } else if (devices.released.includes(code)) {
      // Held, let go and pressed again since the last sample: it went up,
      // and it went down.
      up.push(code);
      down.push(code);
    }
  }
  for (const code of Object.keys(buttons)) {
    if (buttons[code]![0] === 1 && !devices.down.has(code)) {
      up.push(code);
    }
  }
  for (const code of devices.pressed) {
    // Down and up again since the last sample: the game never sees it down.
    // If it was held before that, it went up first, which is said above.
    if (!devices.down.has(code) && !tapped.includes(code)) {
      tapped.push(code);
    }
  }
  let moves: Record<string, number> | undefined;
  for (const [code, value] of devices.axes) {
    if ((axes[code] ?? 0) !== value) {
      (moves ??= {})[code] = value;
    }
  }
  for (const code of Object.keys(axes)) {
    // An axis the devices no longer have is back at 0.
    if (!devices.axes.has(code)) {
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

// What each world's `Read` has reported since the last tick. The reports
// are queued and not applied yet, so the picture in the world is behind by
// exactly these.
const reported = new WeakMap<
  EcsWorld,
  { tick: number; payloads: ReportPayload[] }
>();

/**
 * Reads the devices into the game: compares their state with the input state
 * the game will have at its next tick, and reports any difference as an action.
 */
const Read = System.input("arcadekit/Input.Read", function* () {
  // Where there are no devices there is nothing to bring the picture up
  // to date with: it stays as it was last reported, by a log or by
  // another machine. No devices is not devices with every button up.
  if ((yield* Source) === noSource) {
    return;
  }
  const devices = yield* Devices;
  const world = whole(yield* World);
  const { tick } = yield* Time;
  const held = world.singleton(Held);
  let { axes, buttons } = held;
  // Read twice with no tick between, the picture is what the world holds
  // and what was reported the first time.
  let waiting = reported.get(world);
  if (waiting === undefined || waiting.tick !== tick) {
    waiting = { tick, payloads: [] };
    reported.set(world, waiting);
  }
  for (const earlier of waiting.payloads) {
    buttons = nextButtons(buttons, earlier, tick + 1) ?? buttons;
    axes = nextAxes(axes, earlier.axes) ?? axes;
  }
  const payload = difference(buttons, axes, devices);
  if (payload !== undefined) {
    waiting.payloads.push(payload);
    (yield* Action.Actions).enqueue(Report, payload);
  }
});

/**
 * Buttons, as a system reads them.
 *
 * @category Models
 */
export interface KeyboardView {
  /** Returns whether a key is held down, given its `KeyboardEvent.code`. */
  readonly down: (code: string) => boolean;
  /** Returns whether a key went down in this tick, whether or not it is still held. */
  readonly pressed: (code: string) => boolean;
  /** Returns whether a key went up in this tick. */
  readonly released: (code: string) => boolean;
}

/**
 * The pointer, as a system reads it.
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
  /** Returns whether a button went down in this tick. The button defaults to 0, the primary button. */
  readonly pressed: (button?: number) => boolean;
  /** Returns whether a button went up in this tick. The button defaults to 0, the primary button. */
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
  /** Returns whether a button went down in this tick. */
  readonly pressed: (button: number) => boolean;
  /** Returns whether a button went up in this tick. */
  readonly released: (button: number) => boolean;
}

/**
 * The keyboard's state in the current tick, which `Input.plugin` provides.
 *
 *   const keys = yield* Input.Keyboard
 *   keys.down("ArrowLeft")    // held
 *   keys.pressed("Space")     // went down in this tick
 *   keys.released("Space")    // went up in this tick
 *
 * **Details**
 *
 * `pressed` and `released` are true only in the first tick that sees the
 * change. A system that runs every tick sees each change once. The handlers of
 * the actions applied at the start of that tick see it too: an action bound to
 * a key sees the press that issued it.
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
 * The pointer's state in the current tick, which `Input.plugin` provides.
 *
 * @category Views
 */
export class Pointer extends Context.Service<Pointer, PointerView>()(
  "arcadekit/Input.Pointer"
) {}

/**
 * Every gamepad's state in the current tick, by index, which `Input.plugin`
 * provides. A system reads one with `Input.Gamepad`.
 *
 * @category Views
 */
export class Gamepads extends Context.Service<
  Gamepads,
  (index: number) => GamepadView
>()("arcadekit/Input.Gamepads") {}

const padViews: Effect.Effect<GamepadView, never, Gamepads>[] = [];

/**
 * Returns a gamepad's state in the current tick, or the first gamepad's when
 * given no index. It requires `Input.Gamepads`, which `Input.plugin` provides.
 *
 * @category Views
 */
export const Gamepad = (
  index = 0
): Effect.Effect<GamepadView, never, Gamepads> =>
  (padViews[index] ??= Effect.map(Gamepads, (pads) => pads(index)));

const views = Layer.effectContext(
  Effect.gen(function* () {
    const world = whole(yield* World);
    const time = yield* Time;
    const held = world.singleton(Held);
    const down = (code: string): boolean => held.buttons[code]?.[0] === 1;
    // The tick whoever asks belongs to. An action's handler runs before its
    // tick is counted, in a transaction of the world, which is how it is
    // known here: it is told what that tick's systems will be told.
    const now = (): number => time.tick + (world._recording ? 1 : 0);
    const pressed = (code: string): boolean =>
      held.buttons[code]?.[1] === now();
    const released = (code: string): boolean =>
      held.buttons[code]?.[2] === now();
    const pads: GamepadView[] = [];
    return Context.make(Keyboard, { down, pressed, released }).pipe(
      Context.add(Pointer, {
        get x() {
          return held.axes[pointerX] ?? 0;
        },
        get y() {
          return held.axes[pointerY] ?? 0;
        },
        down: (button = 0) => down(pointerButton(button)),
        pressed: (button = 0) => pressed(pointerButton(button)),
        released: (button = 0) => released(pointerButton(button)),
      }),
      Context.add(
        Gamepads,
        (index) =>
          (pads[index] ??= {
            axis: (axis) => held.axes[padAxis(index, axis)] ?? 0,
            down: (button) => down(padButton(index, button)),
            pressed: (button) => pressed(padButton(index, button)),
            released: (button) => released(padButton(index, button)),
          })
      )
    );
  })
);

/**
 * Keeps the devices' state in the world: which buttons are down, which went
 * down or up in this tick, and where the axes are. It provides
 * `Input.Keyboard`, `Input.Pointer` and `Input.Gamepads`, from which systems
 * and action handlers read it.
 *
 * **When to use**
 *
 * Use when systems read held buttons and positions directly. To map the
 * devices to the game's own actions, use `Input.bind`, which doesn't require
 * this plugin.
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
 *   machine or several, bind each player's devices with `Input.bind` to
 *   actions that carry the player.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Input", {
  handlers: [report],
  systems: [Read],
  layer: views,
});

// --- bindings: from the devices to the game's own actions -------------------------

type Enqueue = <N extends string, P>(
  action: Action.ActionDef<N, P>,
  payload: P
) => void;

/**
 * What a binding sends: a payload, or a function that builds one from the
 * devices' state.
 *
 * @category Type-level
 */
export type PayloadOf<P> = P | ((devices: Sample) => P);

/** Omitted for an action that takes no payload. */
type PayloadArgument<P> = undefined extends P
  ? [payload?: PayloadOf<P>]
  : [payload: PayloadOf<P>];

/**
 * One entry of `Input.bind`: when this happens on the devices, issue that
 * action.
 *
 * @category Models
 */
export interface Binding {
  /**
   * Issues its action with `enqueue` if the devices did what it waits for, as
   * `Input.bind` calls it in each input stage.
   */
  readonly fire: (devices: Sample, enqueue: Enqueue) => void;
}

const binding =
  (among: (devices: Sample) => readonly string[]) =>
  <N extends string, P>(
    codes: string | readonly string[],
    action: Action.ActionDef<N, P>,
    ...payload: PayloadArgument<P>
  ): Binding => {
    const watched = typeof codes === "string" ? [codes] : codes;
    const given = payload[0] as PayloadOf<P>;
    return {
      fire(devices, enqueue) {
        const happened = among(devices);
        if (
          happened.length > 0 &&
          watched.some((code) => happened.includes(code))
        ) {
          enqueue(
            action,
            typeof given === "function"
              ? (given as (devices: Sample) => P)(devices)
              : given
          );
        }
      },
    };
  };

/**
 * Makes a binding that issues an action when a button goes down. A button is a
 * key by its code, `Input.pointerButton(n)` or `Input.padButton(pad, n)`. Given
 * several codes, the action is issued once when any of them goes down.
 *
 * The payload is a value, or a function of the devices' state for an action
 * that needs the pointer's position. The compiler checks it against the action.
 *
 * @category Constructors
 */
export const onPress = binding((devices) => devices.pressed);

/**
 * Makes a binding that issues an action when a button goes up, as
 * `Input.onPress` does when one goes down.
 *
 * @category Constructors
 */
export const onRelease = binding((devices) => devices.released);

/**
 * Makes a binding that issues an action when an axis moves: `Input.pointerX`,
 * `Input.pointerY` or `Input.padAxis(pad, n)`. Given several axes, the action
 * is issued once when any of them moves.
 *
 * @category Constructors
 */
export const onMove = binding((devices) => devices.moved);

/**
 * Makes an input-stage system from bindings. Each time the input stage runs,
 * the system issues the actions of the bindings that fired, in the order given.
 *
 *   const Controls = Input.bind("game/Controls",
 *     Input.onPress("Space", Jump),
 *     Input.onRelease("Space", Land)
 *   )
 *
 * **When to use**
 *
 * Use to map the devices to the game's own actions, so the game's handlers
 * know nothing about keys and you can remap keys without changing the game.
 * To read held buttons and positions in a system, use `Input.plugin` instead.
 *
 * **Details**
 *
 * Like any action from outside, the actions are logged and applied at the
 * start of the next tick. A replay therefore has them, and reads no device. It
 * doesn't require `Input.plugin`.
 *
 * **Gotchas**
 *
 * - The bindings are fixed when the system is made. To let players choose
 *   their keys, write an input-stage system that looks the bindings up.
 *
 * @category Systems
 */
export const bind = (
  name: string,
  ...bindings: readonly Binding[]
): System.System<never, Devices | Action.Actions> =>
  System.input(name, function* () {
    const devices = yield* Devices;
    if (
      devices.pressed.length === 0 &&
      devices.released.length === 0 &&
      devices.moved.length === 0
    ) {
      return;
    }
    const { enqueue } = yield* Action.Actions;
    for (const one of bindings) {
      one.fire(devices, enqueue);
    }
  });
