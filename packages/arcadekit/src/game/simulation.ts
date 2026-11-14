/**
 * Simulations: the DOM-free half of a game, its rules.
 *
 * `Game.Simulation` is a declaration: a game writes `class Race extends Game.Simulation(...) {}`,
 * and the class carries the rules and their types. Its `create`, `step` and `apply` are plain
 * functions, for correctness: a step gives the same bits on every peer and every
 * replay, finishes in the call that runs it, and reads no clock or random source of its own. The
 * types here are what a handler is given and what a game reads off the class.
 *
 * @since 0.7.0
 */
import type { Duration, Schema } from "effect";

import type { AnyCommand } from "./command";
import type { AnyEvent } from "./event";
import type { Resolved } from "./internal/resolved";

/**
 * What `create` is given besides the run's config: the run's seed, and `report` for the events
 * the run starts with.
 *
 * **When to use**
 *
 * To annotate a `create` written apart from its simulation, which TypeScript can't type from the
 * fields beside it.
 *
 * **Example** (A create written apart)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Seeded extends Game.Event("Seeded", { seed: Schema.Int }) {}
 *
 * const create = (config: null, { seed, report }: Game.RunContext<Seeded>) => {
 *   report(new Seeded({ seed }));
 *   return { seed };
 * };
 * const reported: Seeded[] = [];
 * create(null, { seed: 7, report: (event) => reported.push(event) }).seed; // => 7
 * reported[0]?.seed; // => 7
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface RunContext<Event> {
  /** The run's seed. The same seed, config, input and commands give the same run. */
  readonly seed: number;
  /** Reports an event the run starts with. */
  readonly report: (event: Event) => void;
}

/**
 * What `step` is given besides the state and the step's input: the step's length, its number in
 * the run, and `report`.
 *
 * **When to use**
 *
 * To annotate a `step` written apart from its simulation, as a genre's `world.ts` writes it.
 *
 * **Example** (A step written apart)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Finished extends Game.Event("Finished", { atStep: Schema.Int }) {}
 *
 * const step = (runner: { x: number }, moveX: number, { dt, step, report }: Game.StepContext<Finished>) => {
 *   runner.x += moveX * dt;
 *   if (runner.x >= 1) {
 *     report(new Finished({ atStep: step }));
 *   }
 * };
 * const runner = { x: 0.5 };
 * const reported: Finished[] = [];
 * step(runner, 1, { dt: 0.5, step: 3, report: (event) => reported.push(event) });
 * runner.x; // => 1
 * reported[0]?.atStep; // => 3
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface StepContext<Event> {
  /** Seconds this step advances: the simulation's `stepSeconds`. */
  readonly dt: number;
  /** This step's number in its run, from 0. */
  readonly step: number;
  /** Reports an event. The loop delivers it after the frame's steps. */
  readonly report: (event: Event) => void;
}

/**
 * What a command's `apply` handler is given besides the state and the command: its sender's
 * slot, the number of the step it arrives at, and `report`.
 *
 * **When to use**
 *
 * To annotate an `apply` handler written apart from its simulation.
 *
 * **Example** (A handler written apart)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * const boost = (speeds: number[], command: { readonly by: number }, { player }: Game.CommandContext<never>) => {
 *   speeds[player]! += command.by;
 * };
 * const speeds = [4, 4];
 * boost(speeds, { by: 2 }, { player: 1, step: 0, report: () => {} });
 * speeds; // => [4, 6]
 * ```
 *
 * @category models
 * @since 0.7.0
 */
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
 * run starts and then every `every`, or right after a frame in which `version` changed.
 *
 * **When to use**
 *
 * As a simulation's `sample`: `every` for a state that changes all the time (a real-time game),
 * `version` for one that changes rarely (a turn-based game), or both.
 *
 * **Details**
 *
 * `every` is measured on the time the loop's caller passes in: real time in the browser, and the
 * run's own time in a scenario. `version` is a cheap number the game bumps whenever what `read`
 * reports may have changed, such as a turn counter. `read` must not change the state.
 *
 * **Example** (A HUD read after every turn)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Hud extends Game.Event("Hud", { turns: Schema.Int }) {}
 *
 * const sample: Game.Sample<{ turns: number }, typeof Hud> = {
 *   event: Hud,
 *   version: (game) => game.turns,
 *   read: (game) => ({ turns: game.turns }),
 * };
 * sample.read({ turns: 2 }); // => { turns: 2 }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Sample<State, Sampled extends AnyEvent> {
  /** The event a sample is delivered as. */
  readonly event: Sampled;
  /** Measured on the time the loop's caller passes in: real time in the browser. */
  readonly every?: Duration.Input;
  readonly version?: (state: State) => number;
  /** The event's payload, read from the state. Must not change the state. */
  readonly read: (state: State) => Omit<Sampled["Type"], "_tag">;
}

declare const unreturnable: unique symbol;

/**
 * What a `step` returns, and what an `apply` handler returns when it takes its command: nothing.
 *
 * **When to use**
 *
 * As the return type of a `step` or a handler written apart from its simulation, which then
 * can't return the next state by mistake.
 *
 * **Details**
 *
 * A plain `void` would let a handler return anything (a promise, an Effect, the next state), so
 * the type is `void` or a value nobody can make. A handler that returns anything else is a type
 * error, and a loop refuses at run time what a cast gets past the type.
 *
 * **Example** (A step that changes the state in place)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * const step = (count: { steps: number }): Game.Nothing => {
 *   count.steps += 1;
 * };
 * const count = { steps: 0 };
 * step(count);
 * count.steps; // => 1
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type Nothing =
  // oxlint-disable-next-line typescript/no-invalid-void-type -- Only ever a handler's return type: the union is what stops a handler returning anything else.
  void | { readonly [unreturnable]: never };

/**
 * The rejections each of `Commands` can be refused with, by the command's tag.
 *
 * **When to use**
 *
 * Rarely: a simulation carries it as its `Refusals`, which a host's `send` reads.
 *
 * **Example** (A command's refusals, by its tag)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed") {}
 * class Pick extends Game.Command("Pick", {}, { rejects: [OfferClosed] }) {}
 *
 * const refusal: Game.RefusalsOf<readonly [typeof Pick]>["Pick"] = new OfferClosed();
 * refusal._tag; // => "OfferClosed"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type RefusalsOf<Commands extends readonly AnyCommand[]> = {
  readonly [C in Commands[number] as C["tag"]]: InstanceType<
    C["rejects"][number]
  >;
};

/**
 * What the rules may refuse `Command` with, given a simulation's `Refusals`: never, for a command
 * that can't be refused.
 *
 * **When to use**
 *
 * To type what a host's `send` fails with, as the engine's and a lockstep session's do.
 *
 * **Example** (What a send of each command can fail with)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed") {}
 * class Pick extends Game.Command("Pick", {}, { rejects: [OfferClosed] }) {}
 * type Refusals = Game.RefusalsOf<readonly [typeof Pick]>;
 *
 * const refused: Game.RefusalFor<Refusals, Pick> = new OfferClosed();
 * refused._tag; // => "OfferClosed"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type RefusalFor<Refusals, Command> = unknown extends Refusals
  ? unknown
  : Command extends { readonly _tag: infer Tag }
    ? Tag extends keyof Refusals
      ? Refusals[Tag]
      : never
    : never;

/**
 * Every rejection in a simulation's `Refusals`: unknown, when they aren't known.
 *
 * **When to use**
 *
 * Rarely: `Game.RejectionOf<typeof MySimulation>` reads it off a simulation.
 *
 * **Example** (Every refusal of a set of commands)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * class OfferClosed extends Game.Rejection("OfferClosed") {}
 * class Pick extends Game.Command("Pick", {}, { rejects: [OfferClosed] }) {}
 *
 * const any: Game.RefusalOf<Game.RefusalsOf<readonly [typeof Pick]>> = new OfferClosed();
 * any._tag; // => "OfferClosed"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type RefusalOf<Refusals> = unknown extends Refusals
  ? unknown
  : Refusals[keyof Refusals];

/**
 * The commands of `Command` whose tag may be `Tag`, the key a handler is written under. A tag
 * that is one literal is its key. One that is wider (a `string`, a union, a template) is not, so
 * `Extract` by the key would find no command.
 */
type CommandTagged<Command extends AnyCommand, Tag> = Command extends AnyCommand
  ? Tag extends Command["tag"]
    ? Command
    : never
  : never;

/**
 * One `apply` handler per command, by the command's tag. A handler takes the command, changing
 * the state and returning nothing, or refuses it by returning one of the rejections the command
 * declares, having changed nothing.
 *
 * **When to use**
 *
 * To type a simulation's `apply` written apart from it, as a genre that keeps its handlers in a
 * file of their own does.
 *
 * **Details**
 *
 * Its keys are the commands' tags, read from the list and not renamed with `as`: while a
 * definition's types are still being inferred, TypeScript types a handler's parameters from a
 * mapped type only if its keys are not renamed, and a handler written directly under `create`
 * then takes the state `create` returns. Each key finds its command with `CommandTagged`, so a
 * command whose tag is not one literal still has a handler typed with it. A tag typed as a union
 * asks for a handler under each of its members, and `Game.Simulation` refuses the one under a
 * member that is no listed command's tag: give a command a tag of one literal.
 *
 * **Example** (Handlers written apart)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Boost extends Game.Command("Boost", { by: Schema.Number }) {}
 *
 * const apply: Game.CommandHandlers<{ speed: number }, readonly [typeof Boost], never> = {
 *   Boost: (race, boost) => {
 *     race.speed += boost.by;
 *   },
 * };
 * const race = { speed: 4 };
 * apply.Boost(race, new Boost({ by: 2 }), { player: 0, step: 0, report: () => {} });
 * race.speed; // => 6
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CommandHandlers<
  State,
  Commands extends readonly AnyCommand[],
  Event,
> = {
  readonly [Tag in Commands[number]["tag"]]: (
    state: State,
    command: CommandTagged<Commands[number], Tag>["Type"],
    context: CommandContext<Event>
  ) =>
    | Nothing
    | InstanceType<CommandTagged<Commands[number], Tag>["rejects"][number]>;
};

/**
 * What `Game.Simulation` takes: the rules of a game, with no DOM.
 *
 * **When to use**
 *
 * Rarely: a game writes its definition in place, in the builder's call, where TypeScript types
 * each handler from the fields beside it.
 *
 * **Details**
 *
 * `create` comes before `step`, `apply` and `sample` when it is written in place: TypeScript
 * types the state from what it returns. Each field is documented where it is declared.
 *
 * **Example** (A definition's fields)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const Input = Schema.Struct({ moveX: Schema.Number });
 * const rules: Game.Definition<null, { x: number }, typeof Input, readonly [], readonly [], never> = {
 *   input: Input,
 *   create: () => ({ x: 0 }),
 *   step: (runner, input, { dt }) => {
 *     runner.x += input.moveX * dt;
 *   },
 * };
 * rules.create(null, { seed: 0, report: () => {} }); // => { x: 0 }
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface Definition<
  Config,
  State,
  In extends Schema.Top,
  Events extends readonly AnyEvent[],
  Commands extends readonly AnyCommand[],
  Sampled extends AnyEvent,
> {
  /** Step length in seconds. Defaults to 1/60. */
  readonly stepSeconds?: number;
  /**
   * One step's worth of input, as a Schema: what a device holds for the step and what a replay
   * records. A simulation several players can play declares it with `Game.PlayerInputs`, from
   * the Schema of one player's input, which is what crosses the network in lockstep.
   */
  readonly input: In;
  /** The events a step may report. */
  readonly events?: Events;
  /** The commands a player may send. Each needs a handler in `apply`. */
  readonly commands?: Commands;
  /**
   * Makes a run's state. Each run has its own: a view tells runs apart by identity. Written in
   * place, it comes before `step`, `apply` and `sample`: TypeScript types the state from what it
   * returns, and a handler written above it can leave the state `unknown`.
   */
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
  readonly sample?: Sample<State, Sampled>;
}

declare const noCommand: unique symbol;

/**
 * What `apply` holds when no command is declared: nothing. A handler written there is a property
 * this type doesn't have, so it is a type error on its own line.
 *
 * **When to use**
 *
 * Never by hand: the builder's own type names it, so the entry exports it, and a package that
 * emits its types can then name the builder's.
 *
 * **Example** (No handlers)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * const apply: Game.NoHandlers = {};
 * Object.keys(apply); // => []
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface NoHandlers {
  readonly [noCommand]?: never;
}

/**
 * A simulation that declares commands must have an `apply`: `Definition` then asks it for a
 * handler of each. One that declares none takes no handler. It names no type the handlers
 * infer, so it settles none of them early.
 */
type RequireApply<Commands extends readonly AnyCommand[]> = [
  Commands[number],
] extends [never]
  ? { readonly apply?: NoHandlers }
  : { readonly apply: object };

/**
 * The types of one simulation, as one bag: the class's types-only `"~types"` field, which
 * `Game.StateOf<typeof MySimulation>` and the others read.
 *
 * **When to use**
 *
 * Rarely: read one type with `Game.ConfigOf`, `StateOf`, `InputOf`, `EventOf`, `CommandOf` or
 * `RejectionOf`.
 *
 * **Example** (The bag a simulation carries)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: (config: { readonly from: number }) => ({ steps: config.from }),
 *   step: (count) => {
 *     count.steps += 1;
 *   },
 * }) {}
 *
 * type Types = (typeof Count)["~types"];
 * const config: Types["Config"] = { from: 3 };
 * config.from; // => 3
 * ```
 *
 * @category models
 * @since 0.7.0
 */
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

/**
 * One handler per event, by its tag: what a simulation's `match` takes.
 *
 * **When to use**
 *
 * To type the cases of `match` written apart from it.
 *
 * **Example** (Cases written apart)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 *
 * class Started extends Game.Event("Started") {}
 * class Ended extends Game.Event("Ended") {}
 *
 * const cases: Game.EventCases<Started | Ended> = {
 *   Started: () => "go",
 *   Ended: () => "done",
 * };
 * cases.Ended(new Ended()); // => "done"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type EventCases<Event> = {
  readonly [
    E in Event as E extends { readonly _tag: infer Tag extends string }
      ? Tag
      : never
  ]: (event: E) => unknown;
};

/**
 * The class `Game.Simulation` returns. It is a declaration: it runs nothing by itself.
 *
 * **When to use**
 *
 * To type a value that is some simulation's class, as a host that takes one does. A game names
 * its own class.
 *
 * **Example** (What the class holds)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: (count) => {
 *     count.steps += 1;
 *   },
 * }) {}
 *
 * Count.kind; // => "Simulation"
 * Count.simulationName; // => "Count"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
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
  /** The definition as its hosts run it: what a loop and a scenario read of the class. */
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
   * all: what turns a run's events into an app's Messages (`Race.match({ Finished: ..., Hud: ...
   * })`). A missing case is a type error. Throws when called, as the app's module loads, for what
   * the types let through: a case for an event that doesn't exist (one left behind by a renamed
   * event), and a case a cast left out.
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

/**
 * Any class made by `Game.Simulation`.
 *
 * **When to use**
 *
 * As the bound of a type that reads a simulation's types, so it refuses a look-alike:
 * `Game.StateOf<S extends Game.AnySimulation>`.
 *
 * **Example** (A function of any simulation)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * const nameOf = (simulation: Game.AnySimulation): string => simulation.simulationName;
 *
 * class Count extends Game.Simulation("Count", {
 *   input: Schema.Null,
 *   create: () => ({ steps: 0 }),
 *   step: () => {},
 * }) {}
 * nameOf(Count); // => "Count"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export type AnySimulation = SimulationClass<
  string,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>;

/**
 * What starting a run of `S` needs.
 *
 * **When to use**
 *
 * To type the config an app hands a loop or an engine to start a run.
 *
 * **Example** (Reading the type off a simulation)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Finished extends Game.Event("Finished") {}
 * class Exhausted extends Game.Rejection("Exhausted") {}
 * class Boost extends Game.Command("Boost", {}, { rejects: [Exhausted] }) {}
 * class Race extends Game.Simulation("Race", {
 *   input: Schema.Struct({ moveX: Schema.Number }),
 *   events: [Finished],
 *   commands: [Boost],
 *   create: (config: { readonly goal: number }) => ({ x: 0, goal: config.goal }),
 *   step: () => {},
 *   apply: { Boost: () => undefined },
 * }) {}
 *
 * const config: Game.ConfigOf<typeof Race> = { goal: 2 };
 * config.goal; // => 2
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type ConfigOf<S extends AnySimulation> = S["~types"]["Config"];
/**
 * `S`'s state: what its views read.
 *
 * **When to use**
 *
 * To type a view, a helper or a test that reads the state of a run.
 *
 * **Example** (Reading the type off a simulation)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Finished extends Game.Event("Finished") {}
 * class Exhausted extends Game.Rejection("Exhausted") {}
 * class Boost extends Game.Command("Boost", {}, { rejects: [Exhausted] }) {}
 * class Race extends Game.Simulation("Race", {
 *   input: Schema.Struct({ moveX: Schema.Number }),
 *   events: [Finished],
 *   commands: [Boost],
 *   create: (config: { readonly goal: number }) => ({ x: 0, goal: config.goal }),
 *   step: () => {},
 *   apply: { Boost: () => undefined },
 * }) {}
 *
 * const state: Game.StateOf<typeof Race> = { x: 0, goal: 2 };
 * state.goal; // => 2
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type StateOf<S extends AnySimulation> = S["~types"]["State"];
/**
 * One step's input of `S`.
 *
 * **When to use**
 *
 * To type a script, a replay or a test that feeds a run its input.
 *
 * **Example** (Reading the type off a simulation)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Finished extends Game.Event("Finished") {}
 * class Exhausted extends Game.Rejection("Exhausted") {}
 * class Boost extends Game.Command("Boost", {}, { rejects: [Exhausted] }) {}
 * class Race extends Game.Simulation("Race", {
 *   input: Schema.Struct({ moveX: Schema.Number }),
 *   events: [Finished],
 *   commands: [Boost],
 *   create: (config: { readonly goal: number }) => ({ x: 0, goal: config.goal }),
 *   step: () => {},
 *   apply: { Boost: () => undefined },
 * }) {}
 *
 * const input: Game.InputOf<typeof Race> = { moveX: 1 };
 * input.moveX; // => 1
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type InputOf<S extends AnySimulation> = S["~types"]["Input"];
/**
 * Every event and sample a run of `S` reports.
 *
 * **When to use**
 *
 * To type what a listener hears, such as the function that turns a run's events into an app's Messages.
 *
 * **Example** (Reading the type off a simulation)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Finished extends Game.Event("Finished") {}
 * class Exhausted extends Game.Rejection("Exhausted") {}
 * class Boost extends Game.Command("Boost", {}, { rejects: [Exhausted] }) {}
 * class Race extends Game.Simulation("Race", {
 *   input: Schema.Struct({ moveX: Schema.Number }),
 *   events: [Finished],
 *   commands: [Boost],
 *   create: (config: { readonly goal: number }) => ({ x: 0, goal: config.goal }),
 *   step: () => {},
 *   apply: { Boost: () => undefined },
 * }) {}
 *
 * const heard: Game.EventOf<typeof Race>[] = [new Finished()];
 * heard[0]?._tag; // => "Finished"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type EventOf<S extends AnySimulation> = S["~types"]["Event"];
/**
 * Every command a run of `S` takes.
 *
 * **When to use**
 *
 * To type a function that sends any of a run's commands.
 *
 * **Example** (Reading the type off a simulation)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Finished extends Game.Event("Finished") {}
 * class Exhausted extends Game.Rejection("Exhausted") {}
 * class Boost extends Game.Command("Boost", {}, { rejects: [Exhausted] }) {}
 * class Race extends Game.Simulation("Race", {
 *   input: Schema.Struct({ moveX: Schema.Number }),
 *   events: [Finished],
 *   commands: [Boost],
 *   create: (config: { readonly goal: number }) => ({ x: 0, goal: config.goal }),
 *   step: () => {},
 *   apply: { Boost: () => undefined },
 * }) {}
 *
 * const sent: Game.CommandOf<typeof Race> = new Boost();
 * sent._tag; // => "Boost"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CommandOf<S extends AnySimulation> = S["~types"]["Command"];
/**
 * Every rejection a command of `S` can be refused with.
 *
 * **When to use**
 *
 * To type what an app's handler of a refused command takes.
 *
 * **Example** (Reading the type off a simulation)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Finished extends Game.Event("Finished") {}
 * class Exhausted extends Game.Rejection("Exhausted") {}
 * class Boost extends Game.Command("Boost", {}, { rejects: [Exhausted] }) {}
 * class Race extends Game.Simulation("Race", {
 *   input: Schema.Struct({ moveX: Schema.Number }),
 *   events: [Finished],
 *   commands: [Boost],
 *   create: (config: { readonly goal: number }) => ({ x: 0, goal: config.goal }),
 *   step: () => {},
 *   apply: { Boost: () => undefined },
 * }) {}
 *
 * const refused: Game.RejectionOf<typeof Race> = new Exhausted();
 * refused._tag; // => "Exhausted"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type RejectionOf<S extends AnySimulation> = RefusalOf<
  S["~types"]["Refusals"]
>;

/**
 * Declares a simulation: the DOM-free half of a game, its rules. It says what a run's state is
 * made from, how one step advances it, which events it reports and which commands it takes. It
 * runs in a browser, a Web Worker, on a server or in a test: a loop (`Game.makeLoop`) steps it,
 * `Game.Engine` runs it in the browser, and a scenario checks it.
 *
 * **When to use**
 *
 * Once per game, for its rules. Everything that draws or reads a device is the engine's, in
 * `arcadekit/game/browser`.
 *
 * **Details**
 *
 * `create`, `step` and each `apply` handler are plain functions: a step runs no Effect and reads
 * no clock or random source of its own, so the same seed, input and commands always give the same
 * run. `step` and `apply` change the state in place and return nothing; an
 * `apply` handler may instead refuse its command by returning one of the rejections the command
 * declares (`Game.Rejection`). A `create` written in place comes before the other handlers, since
 * TypeScript types the state from what it returns.
 *
 * The class's `match` makes the function that handles each of the simulation's events by its
 * tag, checked to cover them all: what turns a run's events into an app's Messages. A missing
 * case is a type error, and `match` throws when it is called for a case of an event the
 * simulation doesn't report, such as one left behind by a renamed event.
 *
 * **Example** (Declaring the rules and stepping them)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { Schema } from "effect";
 *
 * class Finished extends Game.Event("Finished", { steps: Schema.Int }) {}
 * class Hud extends Game.Event("Hud", { x: Schema.Number }) {}
 *
 * class Race extends Game.Simulation("Race", {
 *   stepSeconds: 1 / 4,
 *   input: Schema.Struct({ moveX: Schema.Number }),
 *   events: [Finished],
 *   create: (config: { readonly goal: number }) => ({ x: 0, goal: config.goal, done: false }),
 *   step: (runner, input, { dt, step, report }) => {
 *     runner.x += input.moveX * dt;
 *     if (!runner.done && runner.x >= runner.goal) {
 *       runner.done = true;
 *       report(new Finished({ steps: step + 1 }));
 *     }
 *   },
 *   sample: { event: Hud, every: "1 second", read: (runner) => ({ x: runner.x }) },
 * }) {}
 *
 * const toText = Race.match({
 *   Finished: ({ steps }) => `finished in ${steps}`,
 *   Hud: ({ x }) => `at ${x}`,
 * });
 * const heard: string[] = [];
 * const loop = Game.makeLoop(Race);
 * loop.subscribe((event) => heard.push(toText(event)));
 * loop.start({ goal: 1 }, 0, 0);
 * loop.frame({ read: () => ({ moveX: 1 }) }, { steps: 4 }, 1000);
 * heard; // => ["at 0", "finished in 4", "at 1"]
 * ```
 *
 * Throws when declared, for what the types let through: a command with no `apply` handler, an
 * `apply` handler for a command it doesn't declare, and two commands with one tag.
 *
 * @category declarations
 * @since 0.7.0
 */
export const make = <
  const Name extends string,
  Config,
  State,
  In extends Schema.Top,
  const Events extends readonly AnyEvent[] = readonly [],
  const Commands extends readonly AnyCommand[] = readonly [],
  Sampled extends AnyEvent = never,
>(
  name: Name,
  definition: Definition<Config, State, In, Events, Commands, Sampled> &
    RequireApply<Commands>
): SimulationClass<
  Name,
  Config,
  State,
  In["Type"],
  Events[number]["Type"] | Sampled["Type"],
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
  for (const tag of Object.keys(apply)) {
    // `Game.Loop` would never call it, and whoever wrote it would not be told.
    if (!tags.has(tag)) {
      throw new Error(
        `Simulation "${name}" has apply.${tag} but declares no command "${tag}". List the command's class in \`commands\`, or remove the handler.`
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
  /** What a run reports, by tag: its events, then its sample. `match` takes a case for each. */
  const reported = resolved.events.map(({ tag }) => tag);
  if (resolved.sample !== undefined) {
    reported.push(resolved.sample.tag);
  }
  const reports =
    reported.length === 0
      ? ": it reports nothing"
      : ` (${reported.join(", ")})`;
  const noCase = (tag: string): Error =>
    new Error(
      `Simulation "${name}" has no case for the event "${tag}". \`match\` takes a case for everything the simulation reports${reported.length === 0 ? "" : ` (${reported.join(", ")})`}.`
    );
  /**
   * Refuses the cases `match` can't use, when it is called: a case for an event that doesn't
   * exist would never run and nobody would be told, and a case a cast left out would only be
   * missed when its event came.
   */
  const checkCases = (
    cases: Readonly<Record<string, (event: unknown) => unknown>>
  ): void => {
    for (const tag of Object.keys(cases)) {
      if (!reported.includes(tag)) {
        throw new Error(
          `Simulation "${name}" has a case "${tag}", which it doesn't report${reports}. Remove it, or name it after the event it handles.`
        );
      }
    }
    for (const tag of reported) {
      if (cases[tag] === undefined) {
        throw noCase(tag);
      }
    }
  };
  // oxlint-disable-next-line typescript/no-extraneous-class -- A declaration is a class, so a game extends it and gets a name for it.
  return class {
    static readonly kind = "Simulation" as const;
    static readonly simulationName: Name = name;
    static readonly definition = resolved;
    static readonly match = (
      cases: Readonly<Record<string, (event: unknown) => unknown>>
    ) => {
      checkCases(cases);
      return (event: { readonly _tag: string }) => {
        const handle = cases[event._tag];
        // Every case was there when `match` was called: only an event the simulation doesn't
        // declare gets here.
        if (handle === undefined) {
          throw noCase(event._tag);
        }
        return handle(event);
      };
    };
  } as unknown as SimulationClass<
    Name,
    Config,
    State,
    In["Type"],
    Events[number]["Type"] | Sampled["Type"],
    Commands[number]["Type"],
    RefusalsOf<Commands>
  >;
};
