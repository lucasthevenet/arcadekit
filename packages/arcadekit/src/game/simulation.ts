import type { Duration, Schema } from "effect";

import type { AnyCommand } from "./command";
import type { AnyEvent } from "./event";

/** What `create` is given besides the run's config. */
export interface RunContext<Event> {
  /** The run's seed. The same seed, config, input and commands give the same run. */
  readonly seed: number;
  /** Reports an event the run starts with. */
  readonly report: (event: Event) => void;
}

/** What `step` is given besides the state and the step's input. */
export interface StepContext<Event> {
  /** Seconds this step advances: the simulation's `stepSeconds`. */
  readonly dt: number;
  /** This step's number in its run, from 0. */
  readonly step: number;
  /** Reports an event. The loop delivers it after the frame's steps. */
  readonly report: (event: Event) => void;
}

/** What a command's `apply` handler is given besides the state and the command. */
export interface CommandContext<Event> {
  /** The slot of the player who sent the command: 0 in a single-player run. */
  readonly player: number;
  /** The number of the step the command arrives at. */
  readonly step: number;
  /** Reports an event, as a step does. */
  readonly report: (event: Event) => void;
}

/**
 * A read of the state for the UI, such as a HUD: an event the loop makes from the state, when a
 * run starts and then
 *
 * - every `every`, for a state that changes all the time (a real-time game);
 * - and/or right after any frame in which `version` changed, for a state that changes rarely (a
 *   turn-based game). `version` is a cheap number the game bumps whenever what `read` reports
 *   may have changed, such as a turn counter.
 */
export interface Sample<State, S extends AnyEvent> {
  /** The event a sample is delivered as. */
  readonly event: S;
  /** Measured on the time the loop's caller passes in: real time in the browser. */
  readonly every?: Duration.Input;
  readonly version?: (state: State) => number;
  /** The event's payload, read from the state. Must not change the state. */
  readonly read: (state: State) => Omit<S["Type"], "_tag">;
}

declare const unreturnable: unique symbol;

/**
 * What a `step` returns, and what an `apply` handler returns when it takes its command: nothing.
 * A plain `void` would let a handler return anything (a promise, an Effect, the next state), so
 * the type is `void` or a value nobody can make. A handler that returns anything else is a type
 * error, and `Game.Loop` refuses it too.
 */
// oxlint-disable-next-line typescript/no-invalid-void-type -- Only ever a handler's return type: the union is what stops a handler returning anything else.
export type Nothing = void | { readonly [unreturnable]: never };

/** The rejections each command can be refused with, by the command's tag. */
export type RefusalsOf<Commands extends readonly AnyCommand[]> = {
  readonly [C in Commands[number] as C["tag"]]: InstanceType<
    C["rejects"][number]
  >;
};

/** What the rules may refuse `Command` with, given a simulation's `Refusals`. Never, if nothing. */
export type RefusalFor<Refusals, Command> = unknown extends Refusals
  ? unknown
  : Command extends { readonly _tag: infer Tag }
    ? Tag extends keyof Refusals
      ? Refusals[Tag]
      : never
    : never;

/** Every rejection in a simulation's `Refusals`. Unknown, when they aren't known. */
export type RefusalOf<Refusals> = unknown extends Refusals
  ? unknown
  : Refusals[keyof Refusals];

/**
 * One `apply` handler per command, by the command's tag. A handler takes the command, changing
 * the state and returning nothing, or refuses it by returning one of the rejections the command
 * declares, having changed nothing.
 */
export type CommandHandlers<
  State,
  Commands extends readonly AnyCommand[],
  Event,
> = {
  readonly [C in Commands[number] as C["tag"]]: (
    state: State,
    command: C["Type"],
    context: CommandContext<Event>
  ) => Nothing | InstanceType<C["rejects"][number]>;
};

/** What `Game.Simulation` takes: the rules of a game, with no DOM. */
export interface Definition<
  Config,
  State,
  In extends Schema.Top,
  Events extends readonly AnyEvent[],
  Commands extends readonly AnyCommand[],
  S extends AnyEvent,
> {
  /** Step length in seconds. Defaults to 1/60. */
  readonly stepSeconds?: number;
  /**
   * One step's worth of input, as a Schema: what a device holds for the step, what a replay
   * records and what crosses the network in lockstep.
   */
  readonly input: In;
  /** The events a step may report. */
  readonly events?: Events;
  /** The commands a player may send. Each needs a handler in `apply`. */
  readonly commands?: Commands;
  /** Makes a run's state. Each run has its own: a view tells runs apart by identity. */
  readonly create: (
    config: Config,
    run: RunContext<Events[number]["Type"]>
  ) => State;
  /**
   * Advances the state by one step, in place, and returns nothing: a step that returns a value
   * is a type error and the loop refuses it, so it can't be `async` or return an Effect. Must be deterministic: the same
   * state and input give the same result in every JavaScript engine, so it reads no clock and
   * no random source of its own. It may allocate what it reports (an event is rare), and keeps
   * what it holds per entity in typed arrays, so a step over many entities allocates nothing
   * for them. A turn-based game may ignore `dt`.
   */
  readonly step: (
    state: State,
    input: In["Type"],
    context: StepContext<Events[number]["Type"]>
  ) => Nothing;
  /**
   * Applies each command, by its tag. The loop calls it at the start of the next step, before
   * `step`, in the order the commands were sent. As deterministic as `step`. A handler takes the
   * command, changing the state in place and returning nothing, or refuses it by returning one
   * of the rejections the command declares (`rejects`), having changed nothing: it decides
   * before it changes anything. The sender hears which.
   */
  readonly apply?: CommandHandlers<State, Commands, Events[number]["Type"]>;
  readonly sample?: Sample<State, S>;
}

/** A simulation that declares commands must handle each of them. */
type RequireApply<State, Commands extends readonly AnyCommand[], Event> = [
  Commands[number],
] extends [never]
  ? unknown
  : { readonly apply: CommandHandlers<State, Commands, Event> };

/**
 * A simulation's definition as the loop runs it: defaults filled, and the declarations' classes
 * replaced by what the loop needs of them.
 */
export interface Resolved<Config, State, Input, Event, Command> {
  readonly stepSeconds: number;
  readonly input: Schema.Top;
  readonly events: readonly AnyEvent[];
  readonly commands: readonly AnyCommand[];
  readonly create: (config: Config, run: RunContext<Event>) => State;
  // What a handler returned is the loop's to judge, whatever its type said.
  readonly step: (
    state: State,
    input: Input,
    context: StepContext<Event>
  ) => unknown;
  readonly apply: Readonly<
    Record<
      string,
      (
        state: State,
        command: Command,
        context: CommandContext<Event>
      ) => unknown
    >
  >;
  readonly sample:
    | {
        readonly make: (payload: unknown) => Event;
        readonly tag: string;
        readonly every: Duration.Input | undefined;
        readonly version: ((state: State) => number) | undefined;
        readonly read: (state: State) => unknown;
      }
    | undefined;
}

/** The types of one simulation, as one bag: `Game.StateOf<typeof MySimulation>` reads it. */
export interface SimulationTypes<
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
> {
  readonly Config: Config;
  readonly State: State;
  readonly Input: Input;
  readonly Event: Event;
  readonly Command: Command;
  /** The rejections each command can be refused with, by the command's tag. */
  readonly Refusals: Refusals;
}

/** One handler per event, by its tag: what `match` takes. */
export type EventCases<Event> = {
  readonly [
    E in Event as E extends { readonly _tag: infer Tag extends string }
      ? Tag
      : never
  ]: (event: E) => unknown;
};

/** The class `Game.Simulation` returns. It is a declaration: it runs nothing by itself. */
export interface SimulationClass<
  Name extends string,
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
> {
  new (_: never): { readonly "~arcadekit/game/Simulation": Name };
  readonly kind: "Simulation";
  readonly simulationName: Name;
  /** The definition as the loop runs it. Read it through `resolve`. */
  readonly definition: Resolved<never, unknown, never, unknown, never>;
  /** Types only: never read at run time. */
  readonly "~types": SimulationTypes<
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >;
  /**
   * A function that handles each of the simulation's events by its tag, checked to cover them
   * all: what turns a run's events into an app's Messages.
   *
   * ```ts
   * const toMessage = PushPuzzle.match({
   *   Hud: (hud) => Message.GotHud({ hud }),
   *   LevelSolved: ({ moves }) => Message.GotLevelSolved({ moves }),
   * });
   * ```
   */
  readonly match: <
    Self extends AnySimulation,
    const Cases extends EventCases<EventOf<Self>>,
  >(
    this: Self,
    cases: Cases
  ) => (
    event: EventOf<Self>
  ) => Cases[keyof Cases] extends (...args: never[]) => infer R ? R : never;
}

/** Any class made by `Game.Simulation`. */
export type AnySimulation = SimulationClass<
  string,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>;

/** What starting a run of `S` needs. */
export type ConfigOf<S extends AnySimulation> = S["~types"]["Config"];
/** `S`'s state: what its views read. */
export type StateOf<S extends AnySimulation> = S["~types"]["State"];
/** One step's input of `S`. */
export type InputOf<S extends AnySimulation> = S["~types"]["Input"];
/** Every event and sample a run of `S` reports. */
export type EventOf<S extends AnySimulation> = S["~types"]["Event"];
/** Every command a run of `S` takes. */
export type CommandOf<S extends AnySimulation> = S["~types"]["Command"];
/** Every rejection a command of `S` can be refused with. */
export type RejectionOf<S extends AnySimulation> = RefusalOf<
  S["~types"]["Refusals"]
>;

/** `simulation`'s definition, typed for the loop that runs it. */
export const resolve = <Config, State, Input, Event, Command, Refusals>(
  simulation: SimulationClass<
    string,
    Config,
    State,
    Input,
    Event,
    Command,
    Refusals
  >
): Resolved<Config, State, Input, Event, Command> =>
  simulation.definition as unknown as Resolved<
    Config,
    State,
    Input,
    Event,
    Command
  >;

/**
 * The DOM-free half of a game: its rules. It says what a run's state is made from, how one step
 * advances it, which events it reports and which commands it takes. It runs in a browser, a Web
 * Worker, on a server or in a test: `Game.Loop` steps it, `Game.Engine` runs it in the browser,
 * and a scenario checks it.
 *
 * ```ts
 * export class PushPuzzle extends Game.Simulation("PushPuzzle", {
 *   input: PushPuzzleInput,
 *   events: [LevelSolved],
 *   create: createPuzzle,
 *   step,
 *   sample: { event: Hud, version: (puzzle) => puzzle.turns, read: hudSample },
 * }) {}
 * ```
 *
 * `create` and `step` are plain functions, and so is each `apply` handler: a step runs no Effect
 * and reads no clock or random source of its own (ADR-0017). A simulation that declares a
 * command without its handler is refused when its module loads. An `apply` handler may refuse
 * its command by returning one of the rejections the command declares (`Game.Rejection`).
 */
export const make = <
  const Name extends string,
  Config,
  State,
  In extends Schema.Top,
  const Events extends readonly AnyEvent[] = readonly [],
  const Commands extends readonly AnyCommand[] = readonly [],
  S extends AnyEvent = never,
>(
  name: Name,
  definition: Definition<Config, State, In, Events, Commands, S> &
    RequireApply<State, Commands, Events[number]["Type"]>
): SimulationClass<
  Name,
  Config,
  State,
  In["Type"],
  Events[number]["Type"] | S["Type"],
  Commands[number]["Type"],
  RefusalsOf<Commands>
> => {
  const commands = definition.commands ?? [];
  const apply = (definition.apply ?? {}) as Readonly<
    Record<string, (state: State, command: never, context: never) => unknown>
  >;
  const tags = new Set<string>();
  for (const command of commands) {
    // The loop finds a command's handler and its rejections by its tag.
    if (tags.has(command.tag)) {
      throw new Error(
        `Simulation "${name}" lists two commands with the tag "${command.tag}". A command is told from another by its tag: give each its own.`
      );
    }
    tags.add(command.tag);
    if (apply[command.tag] === undefined) {
      throw new Error(
        `Simulation "${name}" declares the command "${command.tag}" but has no apply.${command.tag} to handle it`
      );
    }
  }
  const { sample } = definition;
  const resolved = {
    stepSeconds: definition.stepSeconds ?? 1 / 60,
    input: definition.input,
    events: definition.events ?? [],
    commands,
    create: definition.create,
    step: definition.step,
    apply,
    sample:
      sample === undefined
        ? undefined
        : {
            make: (payload: unknown) =>
              new (sample.event as unknown as new (payload: unknown) => object)(
                payload
              ),
            tag: sample.event.tag,
            every: sample.every,
            version: sample.version,
            read: sample.read,
          },
  };
  // oxlint-disable-next-line typescript/no-extraneous-class -- A declaration is a class, so a game extends it and gets a name for it.
  return class {
    static readonly kind = "Simulation" as const;
    static readonly simulationName: Name = name;
    static readonly definition = resolved;
    static readonly match =
      (cases: Readonly<Record<string, (event: unknown) => unknown>>) =>
      (event: { readonly _tag: string }) => {
        const handle = cases[event._tag];
        if (handle === undefined) {
          throw new Error(
            `Simulation "${name}" has no case for the event "${event._tag}"`
          );
        }
        return handle(event);
      };
  } as unknown as SimulationClass<
    Name,
    Config,
    State,
    In["Type"],
    Events[number]["Type"] | S["Type"],
    Commands[number]["Type"],
    RefusalsOf<Commands>
  >;
};
