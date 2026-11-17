/**
 * Input: the keyboard, the pointer and the gamepads, as the game sees them.
 *
 * The devices are outside the game. What they say reaches it as actions,
 * through the same log as everything else that comes from outside, so a
 * replay needs no devices at all: the actions are in its log.
 *
 * There are two ways in, and a game uses either or both.
 *
 * The picture: `Input.plugin` keeps what is held down, and where the
 * pointer and the sticks are, in the world. A system reads it:
 *
 *   const Steer = System.make("Steer", function*() {
 *     const keys = yield* Input.Keyboard
 *     if (keys.down("ArrowLeft")) ...       // held
 *     if (keys.pressed("Space")) ...        // went down in this tick
 *     const pointer = yield* Input.Pointer  // pointer.x, pointer.y, pointer.down()
 *   })
 *
 * Bindings: the devices are turned into the game's own actions, and the
 * game knows nothing of keys:
 *
 *   const Controls = Input.bind("game/Controls",
 *     Input.onPress(["Space", Input.padButton(0, 0)], Jump),
 *     Input.onPress(Input.pointerButton(), Fire, (devices) => ({
 *       x: devices.axes.get(Input.pointerX) ?? 0
 *     }))
 *   )
 *
 * Both run in the input stage, `System.inStage("input")`: just before a
 * tick, with the world frozen, told what the devices say as `Input.Devices`.
 * A system of that stage that needs more than a binding (to find what the
 * pointer is over, say) reads `Input.Devices` and the world and issues the
 * action itself, with `Actions.enqueue`.
 *
 * Where the devices come from is `Input.Source`. A page's keyboard,
 * pointer and gamepads are in the package's other entry, which only a page
 * imports:
 *
 *   import * as Browser from "arcadekit/Browser"
 *   Browser.runMain(App.run(...), { target: canvas })
 *
 * Nothing provides one to a replay or a server, and none is read there.
 */
import { Context, Effect, Effectable, Schema } from "effect";

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

/** The axis of the pointer's place across, in CSS pixels from the left of its target. */
export const pointerX = "PointerX";
/** The axis of the pointer's place down, in CSS pixels from the top of its target. */
export const pointerY = "PointerY";

/** The code of a button of the pointer: 0 the main one, 1 the middle, 2 the secondary. */
export const pointerButton = (button = 0): string => `Pointer${button}`;

/** The code of a button of a gamepad, both numbered as the browser numbers them. */
export const padButton = (pad: number, button: number): string =>
  `Pad${pad}Button${button}`;

/** The code of an axis of a gamepad: a stick's two are 0 and 1, the next stick's 2 and 3. */
export const padAxis = (pad: number, axis: number): string =>
  `Pad${pad}Axis${axis}`;

// --- the devices -------------------------------------------------------------

/** What the devices say at one moment, and what they did since the moment before. */
export interface Sample {
  /** The buttons that are down. */
  readonly down: ReadonlySet<string>;
  /** The buttons that went down since the sample before, down still or not. */
  readonly pressed: readonly string[];
  /** The buttons that went up since the sample before. */
  readonly released: readonly string[];
  /** The value of every axis that has one. An axis that is not here is at 0. */
  readonly axes: ReadonlyMap<string, number>;
  /** The axes whose value is not what it was at the sample before. */
  readonly moved: readonly string[];
}

/** Where samples come from. */
export interface SourceShape {
  /**
   * What the devices say now, and what they did since this was last
   * called. An app calls it once per run of its input stage.
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

/** No devices at all, which is another thing than devices with nothing pressed. */
const noSource: SourceShape = { sample: () => NOTHING };

/**
 * Where an app's input stage takes its samples from. Nothing has to provide
 * it: the default has no devices, which is what a replay, a server and
 * most tests want. With no devices the picture `Input.plugin` keeps is
 * left as it is: what it says is whatever was last reported to it, from
 * a log or from another machine. A page provides its own, with `Browser.layer()` from
 * `arcadekit/Browser`, and a test that plays provides a source it works by
 * hand, `Input.makeManualSource()`.
 */
export const Source: Context.Reference<SourceShape> =
  Context.Reference<SourceShape>("arcadekit/Input.Source", {
    defaultValue: () => noSource,
  });

/**
 * What the devices say, for a system of the input stage: one sample, taken
 * when the stage began, the same for every system of that run.
 *
 * It is no part of the game, so nothing else can read it: in the tick and
 * in the frame stage its fields throw. A system there reads the picture
 * the game has, `Input.Keyboard`, `Input.Pointer` or `Input.Gamepad`.
 */
export class Devices extends Context.Service<Devices, Sample>()(
  "arcadekit/Input.Devices"
) {}

/** A source worked by hand, for a test, a tool or controls drawn on the screen. */
export interface ManualSource extends SourceShape {
  /** A button goes down. Nothing happens if it is down already. */
  readonly press: (code: string) => void;
  /** A button goes up. Nothing happens if it is up already. */
  readonly release: (code: string) => void;
  /** A button goes down and up again at once. */
  readonly tap: (code: string) => void;
  /** An axis takes a value. */
  readonly move: (code: string, value: number) => void;
  /** Every button that is down and that `only` takes, all of them without it, goes up. */
  readonly releaseAll: (only?: (code: string) => boolean) => void;
}

/**
 * A source that says what it is told: `press`, `release`, `tap` and `move`,
 * with the codes a device would give.
 *
 *   const source = Input.makeManualSource()
 *   const app = yield* App.make({ plugins: [Game] }).pipe(
 *     Effect.provideService(Input.Source, source)
 *   )
 *   source.press("Space")
 *   app.input()
 *   app.tick(1 / 60)
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
 * What the world holds of one button: whether it is down, the tick it last
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
    /** Every button that is down, and the ones that went up in the last tick that heard of any. */
    buttons: Field.json<Buttons>(),
    /** Every axis that is not at 0. */
    axes: Field.json<Axes>(),
  },
  { buttons: {}, axes: {} }
);

const ReportSchema = Schema.Struct({
  /** Buttons that went up. */
  up: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Buttons that went down, and are down. */
  down: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Buttons that went down and up again in between: pressed, and not held. */
  tapped: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The axes that moved, and where to. */
  axes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
});
type ReportPayload = typeof ReportSchema.Type;

/**
 * What the devices did since the game last heard: the action that keeps
 * the picture in the world. `Input.plugin` issues it from the input stage
 * and handles it. A test, a tool or another machine can send it too.
 * Where there are devices, what it says lasts until the input stage next
 * reads them; where there are none, it stays.
 *
 * The lists are applied in the order they are written here: what went up,
 * then what went down, then what was tapped. So a held button that is in
 * `up` and in `down` was let go and pressed again, and is held; and one
 * that is in `up` and in `tapped` went up, and was then pressed and let go
 * again.
 */
export const Report = Action.define("arcadekit/Input.Report", ReportSchema);

const sorted = <V>(record: Readonly<Record<string, V>>): Record<string, V> => {
  const out: Record<string, V> = {};
  for (const code of Object.keys(record).toSorted()) {
    out[code] = record[code]!;
  }
  return out;
};

/** The buttons after a report, or undefined if they are as they were. */
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

/** The axes after a report, or undefined if they are as they were. */
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

/** What has to be reported for the picture to be what the devices say. */
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
 * Reads the devices into the game: compares what they say with the picture
 * the game will have at its next tick, and reports the difference, if there
 * is one, as an action.
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
 * Keeps a picture of the devices in the world: which buttons are down,
 * which went down or up in this tick, and where the axes are. Systems read
 * it with `Input.Keyboard`, `Input.Pointer` and `Input.Gamepad`.
 *
 * - The devices are read once per tick, in the input stage, and what
 *   changed is one action, `Input.Report`, in the log. So every system of a
 *   tick sees the same picture, and a replay sees the same as the game.
 * - The picture is a singleton of the world: saved with a game, counted in
 *   its hash once something was pressed, and untouched while nothing
 *   changes.
 * - It is one picture, of one player's devices. A game of several players
 *   on several machines binds its devices to actions that say whose they
 *   are, with `Input.bind`.
 */
export const plugin = Plugin.make("arcadekit/Input", {
  components: [Held],
  handlers: [report],
  systems: [Read],
});

/** Buttons, as a system reads them. */
export interface KeyboardView {
  /** Whether a key is held down. Its code is `KeyboardEvent.code`. */
  readonly down: (code: string) => boolean;
  /** Whether it went down in this tick, held still or not. */
  readonly pressed: (code: string) => boolean;
  /** Whether it went up in this tick. */
  readonly released: (code: string) => boolean;
}

/** The pointer, as a system reads it. */
export interface PointerView {
  /** CSS pixels from the left of the target the page was listening on. */
  readonly x: number;
  /** CSS pixels from its top. */
  readonly y: number;
  /** Whether a button is held down: 0, the main one, when none is given. */
  readonly down: (button?: number) => boolean;
  readonly pressed: (button?: number) => boolean;
  readonly released: (button?: number) => boolean;
}

/** One gamepad, as a system reads it. */
export interface GamepadView {
  /** Where an axis is, from -1 to 1, and 0 when there is no such gamepad. */
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

/** One view of the picture. It is an Effect, so `yield*` gives the view. */
class View<A> extends Effectable.Class<A, never, World | Time> {
  private effect: Effect.Effect<A, never, World | Time> | undefined;

  constructor(private readonly pick: (all: Views) => A) {
    super();
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
 * The keyboard, as the game has it this tick. Needs `Input.plugin`.
 *
 *   const keys = yield* Input.Keyboard
 *   keys.down("ArrowLeft")    // held
 *   keys.pressed("Space")     // went down in this tick
 *   keys.released("Space")    // went up in this tick
 *
 * `pressed` and `released` are true for the one tick that first sees the
 * change, so a system that runs every tick sees each exactly once. A key
 * that went down and up between two ticks was pressed and released in the
 * same tick, and is not down.
 */
export const Keyboard: View<KeyboardView> = new View((all) => all.keyboard);

/** The pointer, as the game has it this tick. Needs `Input.plugin`. */
export const Pointer: View<PointerView> = new View((all) => all.pointer);

const padViews: View<GamepadView>[] = [];

/** A gamepad, the first when none is said, as the game has it this tick. Needs `Input.plugin`. */
export const Gamepad = (index = 0): View<GamepadView> =>
  (padViews[index] ??= new View((all) => all.pad(index)));

// --- bindings: from the devices to the game's own actions -------------------------

type Enqueue = <N extends string, P>(
  action: Action.ActionDef<N, P, unknown>,
  payload: P
) => void;

/** What a binding sends: a payload, or how to make one of what the devices say. */
export type PayloadOf<P> = P | ((devices: Sample) => P);

/** Left out for an action that takes no payload. */
type PayloadArgument<P> = undefined extends P
  ? [payload?: PayloadOf<P>]
  : [payload: PayloadOf<P>];

/** One line of `Input.bind`: when this happens to the devices, issue that action. */
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
 * Issues an action when a button goes down: a key, by its code, or
 * `Input.pointerButton(n)` or `Input.padButton(pad, n)`. Given several
 * codes, any of them does, and the action is issued once.
 *
 * The payload is a value, or a function of what the devices say, for an
 * action that needs to know where the pointer is.
 */
export const onPress = binding((devices) => devices.pressed);

/** Issues an action when a button goes up. */
export const onRelease = binding((devices) => devices.released);

/**
 * Issues an action when an axis moves: `Input.pointerX`, `Input.pointerY`
 * or `Input.padAxis(pad, n)`. Given several, once when any of them does.
 */
export const onMove = binding((devices) => devices.moved);

/**
 * Makes a system of the input stage out of bindings: each tick it issues
 * the actions of the bindings whose moment has come, in the order they
 * were given. The actions are logged and applied at the start of the tick,
 * as any action from outside is, so a replay has them and reads no device.
 *
 *   const Controls = Input.bind("game/Controls",
 *     Input.onPress("Space", Jump),
 *     Input.onRelease("Space", Land)
 *   )
 *
 * The game's handlers know nothing of keys, so the keys can change without
 * the game changing. It does not need `Input.plugin`.
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
