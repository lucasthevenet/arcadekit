/**
 * Input from the keyboard, the pointer and gamepads, as the game sees it.
 *
 * The devices are outside the game. Their input reaches it as actions, through
 * the same log as everything else from outside, so a replay needs no devices at
 * all: the actions are in its log.
 *
 * A game reads input in either or both of two ways.
 *
 * **State.** `Input.plugin` keeps the held buttons, and the pointer and stick
 * positions, in the world. A system reads them:
 *
 *   const Steer = System.make("Steer", function*() {
 *     const keys = yield* Input.Keyboard
 *     if (keys.down("ArrowLeft")) ...       // held
 *     if (keys.pressed("Space")) ...        // went down in this tick
 *     const pointer = yield* Input.Pointer  // pointer.x, pointer.y, pointer.down()
 *   })
 *
 * **Bindings.** Device input is mapped to the game's own actions, and the game
 * knows nothing about keys:
 *
 *   const Controls = Input.bind("game/Controls",
 *     Input.onPress(["Space", Input.padButton(0, 0)], Jump),
 *     Input.onPress(Input.pointerButton(), Fire, (devices) => ({
 *       x: devices.axes.get(Input.pointerX) ?? 0
 *     }))
 *   )
 *
 * Both run in the input stage, `System.inStage("input")`: just before a tick,
 * with the world frozen, receiving the devices' state as `Input.Devices`. An
 * input-stage system that needs more than a binding, for example to find what
 * the pointer is over, reads `Input.Devices` and the world and issues the
 * action itself, with `Actions.enqueue`.
 *
 * `Input.Source` supplies the devices. A page's keyboard, pointer and gamepads
 * come from the package's other entry point, which only a page imports:
 *
 *   import * as Browser from "arcadekit/Browser"
 *   Browser.runMain(App.run(...), { target: canvas })
 *
 * Nothing provides a source to a replay or a server, and no devices are read
 * there.
 */
import { Context, Effect, Effectable, Predicate, Schema } from "effect";

import * as Action from "./Action";
import type { World as EcsWorld } from "./ecs/world";
import * as Field from "./Field";
import * as Plugin from "./Plugin";
import { Time, World } from "./Services";
import type { TimeState } from "./Services";
import * as Singleton from "./Singleton";
import * as System from "./System";

// --- codes -------------------------------------------------------------------
// Everything that can be held down is a button with a code, and everything
// that has a value is an axis with a code. A key's code is the one the
// browser gives it, `KeyboardEvent.code`: "KeyA", "Space", "ArrowLeft".

/**
 * The axis of the pointer's horizontal position, in CSS pixels from the left of
 * its target.
 *
 * @category Actions
 */
export const pointerX = "PointerX";

/**
 * The axis of the pointer's vertical position, in CSS pixels from the top of
 * its target.
 *
 * @category Actions
 */
export const pointerY = "PointerY";

/**
 * Returns the code of a pointer button: 0 for the primary, 1 for the middle, 2
 * for the secondary.
 *
 * @category Actions
 */
export const pointerButton = (button = 0): string => `Pointer${button}`;

/**
 * Returns the code of a gamepad button, both numbered as the browser numbers
 * them.
 *
 * @category Actions
 */
export const padButton = (pad: number, button: number): string =>
  `Pad${pad}Button${button}`;

/**
 * Returns the code of a gamepad axis: the first stick's are 0 and 1, the next
 * stick's 2 and 3.
 *
 * @category Actions
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
 * Where samples come from.
 *
 * @category Services
 */
export interface Source {
  /**
   * Returns the devices' current state, and what changed since the last call.
   * An app calls it once per run of its input stage.
   */
  readonly sample: () => Sample;
}

const NOTHING: Sample = {
  down: new Set(),
  pressed: [],
  released: [],
  axes: new Map(),
  moved: [],
};

/** No devices at all, which differs from devices with nothing pressed. */
const noSource: Source = { sample: () => NOTHING };

/**
 * Where an app's input stage takes its samples from. Nothing has to provide it:
 * the default has no devices, which suits a replay, a server and most tests.
 * Without devices, the state `Input.plugin` keeps is left unchanged: it holds
 * whatever was last reported to it, from a log or another machine. A page
 * provides its own with `Browser.layer()` from `arcadekit/Browser`, and a test
 * that simulates input provides one it controls, `Input.makeManualSource()`.
 *
 * @category Services
 */
export const Source: Context.Reference<Source> = Context.Reference<Source>(
  "arcadekit/Input.Source",
  {
    defaultValue: () => noSource,
  }
);

/**
 * The devices' state, for an input-stage system: one sample, taken when the
 * stage began, shared by every system in that run.
 *
 * It isn't part of the game, so nothing else can read it: in the tick and in
 * the frame stage its fields throw. Systems there read the game's input state
 * instead: `Input.Keyboard`, `Input.Pointer` or `Input.Gamepad`.
 *
 * @category Services
 */
export class Devices extends Context.Service<Devices, Sample>()(
  "arcadekit/Input.Devices"
) {}

/**
 * A source controlled by hand, for a test, a tool or on-screen controls.
 *
 * @category Testing
 */
export interface ManualSource extends Source {
  /** Presses a button. Does nothing if it is already down. */
  readonly press: (code: string) => void;
  /** Releases a button. Does nothing if it is already up. */
  readonly release: (code: string) => void;
  /** Presses and releases a button at once. */
  readonly tap: (code: string) => void;
  /** Sets an axis's value. */
  readonly move: (code: string, value: number) => void;
  /** Releases every held button that `only` accepts, or every held button without it. */
  readonly releaseAll: (only?: (code: string) => boolean) => void;
}

/**
 * Makes a source that reports what it is told with `press`, `release`, `tap`
 * and `move`, using the codes a device would produce.
 *
 *   const source = Input.makeManualSource()
 *   const app = yield* App.make({ plugins: [Game] }).pipe(
 *     Effect.provideService(Input.Source, source)
 *   )
 *   source.press("Space")
 *   app.input()
 *   app.tick(1 / 60)
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
      // Copied first: releasing a button takes it out of `down`.
      const held = [...down];

      for (const code of held) {
        if (only === undefined || only(code)) {
          release(code);
        }
      }
    },
    sample() {
      const sample: Sample = {
        down: new Set(down),
        pressed: [...pressed],
        released: [...released],
        axes: new Map(axes),
        moved: [...moved],
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

/** A payload being put together, a property at a time. */
type Draft<T> = { -readonly [K in keyof T]: T[K] };

/**
 * What the devices did since the game's last report: the action that keeps the
 * input state in the world. `Input.plugin` issues it from the input stage and
 * handles it. A test, a tool or another machine can send it too. Where there
 * are devices, it holds until the input stage next reads them; where there are
 * none, it persists.
 *
 * The lists are applied in the order they are declared here: what went up, then
 * what went down, then what was tapped. So a held button in both `up` and
 * `down` was released and pressed again, and is held; and one in both `up` and
 * `tapped` went up, then was pressed and released again.
 *
 * @category Actions
 */
export const Report = Action.define("arcadekit/Input.Report", ReportSchema);

const sorted = <V>(record: Readonly<Record<string, V>>) => {
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

  const after = { ...before };
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
  const held = (yield* World).singleton(Held);
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

/** The buttons that went down, went up and were tapped since the last sample. */
const buttonChanges = (buttons: Buttons, devices: Sample) => {
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

  return { down, tapped, up };
};

/** The axes that moved since the last sample, or undefined if none did. */
const axisMoves = (
  axes: Axes,
  devices: Sample
): Record<string, number> | undefined => {
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

  return moves;
};

/** Returns what must be reported for the input state to match the devices. */
const difference = (
  buttons: Buttons,
  axes: Axes,
  devices: Sample
): ReportPayload | undefined => {
  const { down, tapped, up } = buttonChanges(buttons, devices);
  const moves = axisMoves(axes, devices);

  // In the order the lists are applied.
  const payload: Draft<ReportPayload> = {};

  if (up.length > 0) {
    payload.up = up;
  }

  if (down.length > 0) {
    payload.down = down;
  }

  if (tapped.length > 0) {
    payload.tapped = tapped;
  }

  if (moves !== undefined) {
    payload.axes = moves;
  }

  return Object.keys(payload).length === 0 ? undefined : payload;
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
const Read = System.make("arcadekit/Input.Read", function* () {
  // Where there are no devices there is nothing to bring the picture up
  // to date with: it stays as it was last reported, by a log or by
  // another machine. No devices is not devices with every button up.
  if ((yield* Source) === noSource) {
    return;
  }

  const devices = yield* Devices;
  const world = yield* World;
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
}).pipe(System.inStage("input"));

/**
 * Keeps the devices' state in the world: which buttons are down, which went
 * down or up in this tick, and where the axes are. Systems read it with
 * `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad`.
 *
 * - The devices are read once per tick, in the input stage, and what changed
 *   becomes one action in the log, `Input.Report`. Every system in a tick
 *   therefore sees the same state, and a replay sees the same as the game.
 * - The state is a singleton of the world: saved with the game, restored when
 *   an action is refused, included in the hash once something was pressed, and
 *   untouched while nothing changes.
 * - The devices are the source of truth. When a game is loaded from a save in
 *   which a key was held, and the key is no longer down, it is released on the
 *   first read.
 * - It holds one state, for one player's devices. A multiplayer game across
 *   machines binds its devices to actions that identify their player, with
 *   `Input.bind`.
 *
 * @category Plugins
 */
export const plugin = Plugin.make("arcadekit/Input", {
  components: [Held],
  handlers: [report],
  systems: [Read],
});

/**
 * Buttons, as a system reads them.
 *
 * @category Models
 */
export interface KeyboardView {
  /** Returns whether a key is held down. Its code is the `KeyboardEvent.code`. */
  readonly down: (code: string) => boolean;
  /** Returns whether it went down in this tick, whether or not it is still held. */
  readonly pressed: (code: string) => boolean;
  /** Returns whether it went up in this tick. */
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
  /** Returns whether a button is held down; defaults to 0, the primary button. */
  readonly down: (button?: number) => boolean;
  readonly pressed: (button?: number) => boolean;
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
  readonly down: (button: number) => boolean;
  readonly pressed: (button: number) => boolean;
  readonly released: (button: number) => boolean;
}

interface Views {
  readonly keyboard: KeyboardView;
  readonly pointer: PointerView;
  readonly pad: (index: number) => GamepadView;
}

// A world's views of its picture, made once.
const views = new WeakMap<EcsWorld, Views>();

const viewsOf = (world: EcsWorld, time: Readonly<TimeState>): Views => {
  const found = views.get(world);

  if (found !== undefined) {
    return found;
  }

  // Whoever asks first may be a system that said what it reads and writes.
  // The picture is not among what it says, as the time is not: no system
  // writes it, so reading it puts no two systems in an order.
  const { guard } = world;
  world.guard = undefined;
  const held = world.singleton(Held);
  world.guard = guard;
  const down = (code: string): boolean => held.buttons[code]?.[0] === 1;
  // The tick whoever asks belongs to. An action's handler runs before its
  // tick is counted, in a transaction of the world, which is how it is
  // known here: it is told what that tick's systems will be told.
  const now = (): number => time.tick + (world._recording ? 1 : 0);
  const pressed = (code: string): boolean => held.buttons[code]?.[1] === now();
  const released = (code: string): boolean => held.buttons[code]?.[2] === now();
  const pads: GamepadView[] = [];

  const made: Views = {
    keyboard: { down, pressed, released },
    pointer: {
      get x() {
        return held.axes[pointerX] ?? 0;
      },
      get y() {
        return held.axes[pointerY] ?? 0;
      },
      down: (button = 0) => down(pointerButton(button)),
      pressed: (button = 0) => pressed(pointerButton(button)),
      released: (button = 0) => released(pointerButton(button)),
    },
    pad: (index) =>
      (pads[index] ??= {
        axis: (axis) => held.axes[padAxis(index, axis)] ?? 0,
        down: (button) => down(padButton(index, button)),
        pressed: (button) => pressed(padButton(index, button)),
        released: (button) => released(padButton(index, button)),
      }),
  };

  views.set(world, made);

  return made;
};

/** One view of the input state. It is an Effect, so `yield*` returns the view. */
class View<A> extends Effectable.Class<A, never, World | Time> {
  private effect: Effect.Effect<A, never, World | Time> | undefined;

  private readonly pick: (all: Views) => A;

  constructor(pick: (all: Views) => A) {
    super();
    this.pick = pick;
  }

  asEffect(): Effect.Effect<A, never, World | Time> {
    return (this.effect ??= Effect.flatMap(Effect.service(World), (world) =>
      Effect.map(Effect.service(Time), (time) =>
        this.pick(viewsOf(world, time))
      )
    ));
  }
}

/**
 * The keyboard's state in the current tick. Requires `Input.plugin`.
 *
 *   const keys = yield* Input.Keyboard
 *   keys.down("ArrowLeft")    // held
 *   keys.pressed("Space")     // went down in this tick
 *   keys.released("Space")    // went up in this tick
 *
 * `pressed` and `released` are true only in the first tick that sees the
 * change, so a system that runs every tick sees each exactly once, as do the
 * handlers of the actions applied in that tick: an action bound to a key sees
 * the press that issued it. A key pressed and released between two ticks is
 * both pressed and released in the same tick, and isn't down. A held key
 * released and pressed again between two ticks is both released and pressed in
 * the same tick, and is down.
 *
 * @category Views
 */
export const Keyboard = new View<KeyboardView>((all) => all.keyboard);

/**
 * The pointer's state in the current tick. Requires `Input.plugin`.
 *
 * @category Views
 */
export const Pointer = new View<PointerView>((all) => all.pointer);

const padViews: View<GamepadView>[] = [];

/**
 * A gamepad's state in the current tick, defaulting to the first. Requires
 * `Input.plugin`.
 *
 * @category Views
 */
export const Gamepad = (index = 0): View<GamepadView> =>
  (padViews[index] ??= new View((all) => all.pad(index)));

// --- bindings: from the devices to the game's own actions -------------------------

type Enqueue = <N extends string, P>(
  action: Action.ActionDef<N, P, unknown>,
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
  /** @internal */
  readonly fire: (devices: Sample, enqueue: Enqueue) => void;
}

const binding =
  (among: (devices: Sample) => readonly string[]) =>
  <N extends string, P>(
    codes: string | readonly string[],
    action: Action.ActionDef<N, P, unknown>,
    ...payload: PayloadArgument<P>
  ): Binding => {
    const watched = Predicate.isString(codes) ? [codes] : codes;
    // SAFETY: by PayloadArgument, the payload is given, or left out where P
    // takes undefined, which left out is.
    const given = payload[0] as PayloadOf<P>;

    return {
      fire(devices, enqueue) {
        const happened = among(devices);

        if (
          happened.length > 0 &&
          watched.some((code) => happened.includes(code))
        ) {
          // SAFETY: a payload is data, which a function is not: one given
          // is what makes the payload from the devices.
          enqueue(
            action,
            Predicate.isFunction(given)
              ? (given as (devices: Sample) => P)(devices)
              : given
          );
        }
      },
    };
  };

/**
 * Issues an action when a button goes down: a key by its code, or
 * `Input.pointerButton(n)` or `Input.padButton(pad, n)`. Given several codes,
 * any of them triggers it, and the action is issued once.
 *
 * The payload is a value, or a function of the devices' state, for an action
 * that needs the pointer's position.
 *
 * @category Constructors
 */
export const onPress = binding((devices) => devices.pressed);

/**
 * Issues an action when a button goes up.
 *
 * @category Constructors
 */
export const onRelease = binding((devices) => devices.released);

/**
 * Issues an action when an axis moves: `Input.pointerX`, `Input.pointerY` or
 * `Input.padAxis(pad, n)`. Given several, it is issued once when any of them
 * moves.
 *
 * @category Constructors
 */
export const onMove = binding((devices) => devices.moved);

/**
 * Makes an input-stage system from bindings: each tick, it issues the actions
 * of the bindings that triggered, in the order given. Like any action from
 * outside, they are logged and applied at the start of the tick, so a replay
 * has them and reads no device.
 *
 *   const Controls = Input.bind("game/Controls",
 *     Input.onPress("Space", Jump),
 *     Input.onRelease("Space", Land)
 *   )
 *
 * The game's handlers know nothing about keys, so you can remap keys without
 * changing the game. It doesn't require `Input.plugin`.
 *
 * @category Systems
 */
export const bind = (
  name: string,
  ...bindings: readonly Binding[]
): System.System<never, Devices | Action.Actions> =>
  System.make(name, function* () {
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
  }).pipe(System.inStage("input"));
