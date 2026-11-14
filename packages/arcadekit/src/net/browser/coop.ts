/**
 * Coops: a game as several players play it, each in their own browser (ADR-0019, ADR-0021).
 *
 * `Coop` is a declaration with a service. A game declares one from its engine, and what only a run
 * that several players share needs besides: one player's input source, the content every peer
 * loads, the lobby picks and the config they make, the state hash the peers compare, the most
 * players, and the events that end a run. The class is the key of the Co-op client an app drives
 * (`CoopClient`), its `layer` provides it over the app's rooms (`CoopRooms`), and its `match`
 * turns what a seat reports into an app's Messages. What a seat runs is in `internal/`.
 *
 * @since 0.7.0
 */
import { Context, Effect, Layer, Scope } from "effect";

import { Frames } from "../../game/browser";
import type {
  EngineClass,
  InputSource,
  Used,
  Uses,
  ViewContext,
} from "../../game/browser";
import { playerInputSchema } from "../../game/index";
import type {
  AnyEvent,
  AnySimulation,
  EventOf,
  PlayerInputOf,
  PlayersSimulation,
} from "../../game/index";
import { Room } from "../signalling/index";
import type * as CoopClient from "./coop-client";
import type * as CoopEvent from "./coop-event";
import { CoopRooms } from "./coop-rooms";
import { CoopTicker } from "./coop-ticker";
import { coopClient } from "./internal/coop-client";
import type { CoopPresented } from "./internal/coop-client";

/**
 * What a `Coop`'s `match` takes under `run`: one handler per event or sample of the run, by its
 * tag, each given the event and the local player of the seat that heard it.
 *
 * **When to use**
 *
 * Rarely by name: `match` checks the cases it is given against it.
 *
 * **Example** (A run's cases)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Coop } from "arcadekit/net/browser";
 * import type { RunCases } from "arcadekit/net/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Int),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 * class SumEngine extends Game.Engine("SumEngine", {
 *   simulation: Sum,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => ({ players: [1], leaving: [] }), dispose: () => {} }),
 * }) {}
 * class SumCoop extends Coop("SumCoop", {
 *   engine: SumEngine,
 *   input: () => ({ read: () => 1, dispose: () => {} }),
 *   content: Effect.succeed({ colours: ["red", "blue"] }),
 *   picks: (content) => content.colours,
 *   config: () => null,
 *   hash: (state) => state.total,
 * }) {}
 *
 * class Filled extends Game.Event("Filled", { total: Schema.Int }) {}
 * const cases: RunCases<Filled> = {
 *   Filled: ({ total }, { local }) => `slot ${local.slot} saw ${total}`,
 * };
 * cases.Filled(new Filled({ total: 100 }), { local: { slot: 1, names: [] } }); // => "slot 1 saw 100"
 * SumCoop.coopName; // => "SumCoop"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type RunCases<Event> = {
  readonly [
    E in Event as E extends { readonly _tag: infer Tag extends string }
      ? Tag
      : never
  ]: (event: E, context: CoopEvent.SeatContext) => unknown;
};

/**
 * What a `Coop`'s `match` takes: a handler for each of the Co-op client's own events, by its tag,
 * and under `run` the run's.
 *
 * **When to use**
 *
 * Rarely by name: `match` checks the cases it is given against it, so a missing case is a type
 * error.
 *
 * **Example** (Every case of a co-op game with no events)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Coop } from "arcadekit/net/browser";
 * import { CoopEvent } from "arcadekit/net/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Int),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 * class SumEngine extends Game.Engine("SumEngine", {
 *   simulation: Sum,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => ({ players: [1], leaving: [] }), dispose: () => {} }),
 * }) {}
 * class SumCoop extends Coop("SumCoop", {
 *   engine: SumEngine,
 *   input: () => ({ read: () => 1, dispose: () => {} }),
 *   content: Effect.succeed({ colours: ["red", "blue"] }),
 *   picks: (content) => content.colours,
 *   config: () => null,
 *   hash: (state) => state.total,
 * }) {}
 *
 * const toText = SumCoop.match({
 *   LobbyChanged: ({ code }) => `lobby ${code}`,
 *   RunStarted: ({ slot }) => `slot ${slot}`,
 *   WaitingChanged: ({ waitingFor }) => `waiting ${waitingFor.length}`,
 *   SeatFailed: ({ reason }) => reason,
 *   run: {},
 * });
 * toText(new CoopEvent.RunStarted({ slot: 1, names: ["Host", "Guest 1"] })); // => "slot 1"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export interface CoopCases<Event> {
  readonly LobbyChanged: (event: CoopEvent.LobbyChanged) => unknown;
  readonly RunStarted: (event: CoopEvent.RunStarted) => unknown;
  readonly WaitingChanged: (event: CoopEvent.WaitingChanged) => unknown;
  readonly SeatFailed: (event: CoopEvent.SeatFailed) => unknown;
  /** The run's own events and its sample, each by its tag. */
  readonly run: RunCases<Event>;
}

/** What the handlers of `Handlers` return, together. */
type Returned<Handlers> = Handlers[keyof Handlers] extends (
  ...args: never[]
) => infer Result
  ? Result
  : never;

/**
 * The key string of the Co-op client of the declaration named `Name`.
 *
 * **When to use**
 *
 * Rarely: it is part of the Coop's type, which a game names by its class.
 *
 * **Example** (A Coop's key)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Coop } from "arcadekit/net/browser";
 * import type { CoopId } from "arcadekit/net/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Int),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 * class SumEngine extends Game.Engine("SumEngine", {
 *   simulation: Sum,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => ({ players: [1], leaving: [] }), dispose: () => {} }),
 * }) {}
 * class SumCoop extends Coop("SumCoop", {
 *   engine: SumEngine,
 *   input: () => ({ read: () => 1, dispose: () => {} }),
 *   content: Effect.succeed({ colours: ["red", "blue"] }),
 *   picks: (content) => content.colours,
 *   config: () => null,
 *   hash: (state) => state.total,
 * }) {}
 *
 * const key: CoopId<"SumCoop"> = SumCoop.key;
 * key; // => "arcadekit/net/Coop/SumCoop"
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CoopId<Name extends string> = `arcadekit/net/Coop/${Name}`;

/**
 * The type-level identity of a Co-op client's service: what `yield* MyCoop` requires. It is the
 * type of the class's own values, so the class names it: `Layer.Layer<MyCoop>`.
 *
 * **When to use**
 *
 * Rarely: name the class instead, as `Layer.Layer<SumCoop>` does.
 *
 * **Example** (The client a Coop's layer provides)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Coop } from "arcadekit/net/browser";
 * import { CoopClient } from "arcadekit/net/browser";
 * import { FakeCoopRooms } from "arcadekit/net/testing";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Int),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 * class SumEngine extends Game.Engine("SumEngine", {
 *   simulation: Sum,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => ({ players: [1], leaving: [] }), dispose: () => {} }),
 * }) {}
 * class SumCoop extends Coop("SumCoop", {
 *   engine: SumEngine,
 *   input: () => ({ read: () => 1, dispose: () => {} }),
 *   content: Effect.succeed({ colours: ["red", "blue"] }),
 *   picks: (content) => content.colours,
 *   config: () => null,
 *   hash: (state) => state.total,
 * }) {}
 *
 * const program = Effect.gen(function* () {
 *   return CoopClient.isCoopClient(yield* SumCoop);
 * });
 * const rooms = FakeCoopRooms.layer(FakeCoopRooms.make());
 * Effect.runSync(program.pipe(Effect.provide(SumCoop.layer), Effect.provide(rooms))); // => true
 * ```
 *
 * @category utility types
 * @since 0.7.0
 */
export type CoopService<
  Name extends string,
  State,
  Event,
  Command,
  E,
  Refusals,
> = Context.ServiceClass.Shape<
  CoopId<Name>,
  CoopClient.CoopClient<State, Event, Command, E, Refusals>
>;

/**
 * Any class made by `Coop`, as far as its `match` reads it.
 *
 * **When to use**
 *
 * To take any Coop in a function of the app's own, such as one that names its game.
 *
 * **Example** (The game a Coop plays)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Coop } from "arcadekit/net/browser";
 * import type { AnyCoop } from "arcadekit/net/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Int),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 * class SumEngine extends Game.Engine("SumEngine", {
 *   simulation: Sum,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => ({ players: [1], leaving: [] }), dispose: () => {} }),
 * }) {}
 * class SumCoop extends Coop("SumCoop", {
 *   engine: SumEngine,
 *   input: () => ({ read: () => 1, dispose: () => {} }),
 *   content: Effect.succeed({ colours: ["red", "blue"] }),
 *   picks: (content) => content.colours,
 *   config: () => null,
 *   hash: (state) => state.total,
 * }) {}
 *
 * const gameOf = (coop: AnyCoop) => coop.engine.simulation.simulationName;
 * gameOf(SumCoop); // => "Sum"
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface AnyCoop {
  readonly kind: "Coop";
  readonly engine: { readonly simulation: AnySimulation };
}

/**
 * The class `Coop` returns: the key of its Co-op client, and the Layer that provides it.
 *
 * **When to use**
 *
 * Rarely by name: a game extends the class `Coop` returns, and its types come from the engine
 * and the content.
 *
 * **Details**
 *
 * Its types are the engine's and the content's: `U` is what the engine uses, `Content` what
 * `content` loads and `R` what that load needs. Its statics are `kind`, `coopName`, the
 * `engine`, the `definition` every peer must agree on, the `layer` and `match`.
 *
 * **Example** (A Coop's statics)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Coop } from "arcadekit/net/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Int),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 * class SumEngine extends Game.Engine("SumEngine", {
 *   simulation: Sum,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => ({ players: [1], leaving: [] }), dispose: () => {} }),
 * }) {}
 * class SumCoop extends Coop("SumCoop", {
 *   engine: SumEngine,
 *   input: () => ({ read: () => 1, dispose: () => {} }),
 *   content: Effect.succeed({ colours: ["red", "blue"] }),
 *   picks: (content) => content.colours,
 *   config: () => null,
 *   hash: (state) => state.total,
 * }) {}
 *
 * SumCoop.kind; // => "Coop"
 * SumCoop.engine === SumEngine; // => true
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface CoopClass<
  Name extends string,
  EngineName extends string,
  Config,
  State,
  Input,
  Event,
  Command,
  U extends Uses,
  Refusals,
  Content,
  R,
> extends Context.ServiceClass<
  CoopService<Name, State, Event, Command, Effect.Error<U[keyof U]>, Refusals>,
  CoopId<Name>,
  CoopClient.CoopClient<
    State,
    Event,
    Command,
    Effect.Error<U[keyof U]>,
    Refusals
  >
> {
  readonly kind: "Coop";
  readonly coopName: Name;
  /** The game the players share: its simulation, and what each player's view is made from. */
  readonly engine: EngineClass<
    EngineName,
    Config,
    State,
    Input,
    Event,
    Command,
    U,
    Refusals
  >;
  /**
   * What the Coop was declared with: what every peer of a run must agree on, as plain values
   * and functions (`hash`, `picks`, `config`, `maxPlayers`, `lockstep`). A test reads them here,
   * and so does a peer with no browser.
   */
  readonly definition: CoopDefinition<
    EngineName,
    Config,
    State,
    Input,
    Event,
    Command,
    U,
    Refusals,
    Content,
    { readonly message: string },
    R
  >;
  /**
   * Provides the Co-op client. Building it opens no room and loads nothing: a host or a join
   * loads the content, and an attach runs what the engine uses. It needs the app's rooms
   * (`CoopRooms`), and the services of what the engine uses and of the content's load. Its
   * scope (the app) owns the current seat: closing it leaves. A run is ticked by `CoopTicker`
   * and drawn on `Game.Frames`, which a test provides.
   */
  readonly layer: Layer.Layer<
    CoopService<
      Name,
      State,
      Event,
      Command,
      Effect.Error<U[keyof U]>,
      Refusals
    >,
    never,
    CoopRooms | Exclude<Effect.Services<U[keyof U]> | R, Scope.Scope>
  >;
  /**
   * A function that handles everything a seat reports, checked to cover it all: what turns
   * co-op into an app's Messages. The client's own events are handled by their tags, and the
   * run's events and sample under `run`, by theirs, each with the local player beside it.
   *
   * ```ts
   * import * as Game from "arcadekit/game/browser";
   * import { Coop } from "arcadekit/net/browser";
   * import { Effect, Schema } from "effect";
   *
   * class Filled extends Game.Event("Filled", { by: Schema.Int }) {}
   * class Sum extends Game.Simulation("Sum", {
   *   input: Game.PlayerInputs(Schema.Int),
   *   events: [Filled],
   *   create: () => ({ total: 0 }),
   *   step: () => {},
   * }) {}
   * class SumEngine extends Game.Engine("SumEngine", {
   *   simulation: Sum,
   *   view: () => ({ render: () => {}, dispose: () => {} }),
   *   input: () => ({ read: () => ({ players: [], leaving: [] }), dispose: () => {} }),
   * }) {}
   * class SumCoop extends Coop("SumCoop", {
   *   engine: SumEngine,
   *   input: () => ({ read: () => 1, dispose: () => {} }),
   *   content: Effect.succeed({ colours: ["red", "blue"] }),
   *   picks: (content) => content.colours,
   *   config: () => null,
   *   hash: (state) => state.total,
   * }) {}
   *
   * const toText = SumCoop.match({
   *   LobbyChanged: ({ code }) => `lobby ${code}`,
   *   RunStarted: ({ slot, names }) => `you are ${names[slot]}`,
   *   WaitingChanged: ({ waitingFor }) => `waiting for ${waitingFor.join(", ")}`,
   *   SeatFailed: ({ message }) => message,
   *   run: {
   *     Filled: ({ by }, { local }) => (by === local.slot ? "you filled it" : undefined),
   *   },
   * });
   * ```
   *
   * A run's events reach every seat as the rules reported them, so a case says which are the
   * local player's (`hero === local.slot`). `local` is the seat's own: an event that is kept
   * says whose it was, whatever seat the player takes next. The run's cases have a place of
   * their own, so a game may name an event as it likes: no tag is reserved. Pass it to
   * `listen`, or to `arcadekit/foldkit`'s `EngineEntry.make` as `toMessage`.
   *
   * A missing case is a type error. Throws when called, as the app's module loads, for what the
   * types let through: a case for an event that doesn't exist (one left behind by a renamed
   * event, or a run's case beside the client's own), and a case a cast left out.
   */
  readonly match: <
    Self extends AnyCoop,
    const Cases extends CoopCases<EventOf<Self["engine"]["simulation"]>>,
  >(
    this: Self,
    cases: Cases
  ) => (
    event: CoopEvent.CoopEvent<EventOf<Self["engine"]["simulation"]>>
  ) => Returned<Omit<Cases, "run">> | Returned<Cases["run"]>;
}

/**
 * What `Coop` takes: the game's engine, and what only a run that several players share needs.
 * Every type comes from the engine's simulation and from `content`.
 *
 * **When to use**
 *
 * Rarely by name: a game writes it in place, as `Coop`'s second argument, and reads it back from
 * the class's `definition` in a test.
 *
 * **Details**
 *
 * - `engine` is the game: its simulation, what its view is made from and the view. Its
 *   simulation's `input` is a `Game.PlayerInputs`.
 * - `input` makes one player's input source, where the engine's reads the whole step's. It is made
 *   on each attach, after the view, with what the engine uses.
 * - `content` loads what a run is played with, once per seat: JSON data, whose hash every peer
 *   compares. `picks` lists the valid lobby picks, and `config` makes the run's config from the
 *   content and the players' picks, by slot.
 * - `hash` digests the whole state, compared every `lockstep.hashEvery` steps (60).
 * - `maxPlayers` is the most players a run takes: a room's 4 unless it says.
 * - `ends` lists the events that end a run, after which the others leaving is no failure.
 * - `lockstep.inputDelay` is the steps ahead input is scheduled (4).
 *
 * **Example** (What every peer agrees on, read in Node)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Coop } from "arcadekit/net/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Int),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 * class SumEngine extends Game.Engine("SumEngine", {
 *   simulation: Sum,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => ({ players: [1], leaving: [] }), dispose: () => {} }),
 * }) {}
 * class SumCoop extends Coop("SumCoop", {
 *   engine: SumEngine,
 *   input: () => ({ read: () => 1, dispose: () => {} }),
 *   content: Effect.succeed({ colours: ["red", "blue"] }),
 *   picks: (content) => content.colours,
 *   config: () => null,
 *   hash: (state) => state.total,
 * }) {}
 *
 * SumCoop.definition.picks({ colours: ["red", "blue"] }); // => ["red", "blue"]
 * SumCoop.definition.hash({ total: 12 }); // => 12
 * ```
 *
 * @category models
 * @since 0.7.0
 */
export interface CoopDefinition<
  EngineName extends string,
  Config,
  State,
  Input,
  Event,
  Command,
  U extends Uses,
  Refusals,
  Content,
  ContentError extends { readonly message: string },
  R,
> {
  /**
   * The game: its simulation, what its view is made from (`uses`) and the view. The Co-op
   * client steps the same simulation in lockstep and makes the same view, for the local player
   * at the slot the lobby gave. The simulation's `input` is a `Game.PlayerInputs`: any other is
   * a type error here that names it.
   */
  readonly engine: EngineClass<
    EngineName,
    Config,
    State,
    Input,
    Event,
    Command,
    U,
    Refusals
  > & {
    readonly simulation: PlayersSimulation<
      Config,
      State,
      Input,
      Event,
      Command,
      Refusals
    >;
  };
  /**
   * Makes the input source that reads the local player's own input from the viewport element:
   * one player's, where the engine's `input` reads the whole step's. They are one source: the
   * engine's is `Game.soloInput` of this one, which puts it at slot 0. Called once per attach,
   * after the view, with what the engine uses. What it reads rides each step this player
   * schedules; with nothing attached, null does.
   */
  readonly input: (
    surface: HTMLElement,
    uses: Used<NoInfer<U>>
  ) => InputSource<PlayerInputOf<NoInfer<Input>>>;
  /**
   * Loads what a run is played with: a `Content` declaration's `load`. Run once per seat (each
   * host or join), in the seat's fiber, so leaving cancels it. It must be JSON data: the client
   * hashes it, and every peer's must match. `picks` and `config` take their `content` from it.
   * Building it here with a data-first call can leave their `content` unknown
   * (`Effect.map(load, fn)`, `Effect.as(load, value)`). Pipe it (`load.pipe(Effect.map(fn))`),
   * or name it first.
   */
  readonly content: Effect.Effect<Content, ContentError, R>;
  /**
   * The valid lobby picks, in order, at least one: a game with nothing to choose lists one id.
   * On the host, the first replaces an empty or unknown one at the start.
   */
  readonly picks: (content: NoInfer<Content>) => readonly string[];
  /** The run's config from the content and each player's lobby pick, by slot. */
  readonly config: (
    content: NoInfer<Content>,
    picks: readonly string[]
  ) => NoInfer<Config>;
  /**
   * The most players a run of this game takes: the lobby refuses a start above it, on the host
   * and on a guest. A signalling room's default size (4) if left out; state a smaller number, or
   * the app's own room size. The same on every peer, since it is part of the game.
   */
  readonly maxPlayers?: number;
  /** A digest of the whole state, the same on every peer for the same run. */
  readonly hash: (state: NoInfer<State>) => number;
  /**
   * The events that end a run, of those the simulation reports. After one, a lost host or peer
   * is no failure: the others leaving a run that is over stops it quietly, with its end still
   * on screen.
   */
  readonly ends?: readonly (AnyEvent & { readonly Type: NoInfer<Event> })[];
  /**
   * Steps ahead local input is scheduled, and steps between state hash comparisons. Defaults 4
   * (67 ms at 60 Hz, ADR-0012) and 60. The same on every peer, since it is part of the game.
   */
  readonly lockstep?: {
    readonly inputDelay?: number;
    readonly hashEvery?: number;
  };
}

/** The Co-op client's own events, by tag: the cases `match` takes beside `run`. */
const SEAT_EVENTS: readonly string[] = [
  "LobbyChanged",
  "RunStarted",
  "WaitingChanged",
  "SeatFailed",
] satisfies readonly Exclude<keyof CoopCases<never>, "run">[];

/** What `match` is handed, as far as it reads it: the types have checked the rest. */
type GivenCases = Readonly<Record<string, (event: unknown) => unknown>> & {
  readonly run?: Readonly<
    Record<string, (event: unknown, context: CoopEvent.SeatContext) => unknown>
  >;
};

/**
 * Declares a Coop: a game as several players play it, each in their own browser, the game's
 * engine played in lockstep from a lobby. The class is the key of the Co-op client an app drives,
 * and its `layer` provides it.
 *
 * **When to use**
 *
 * Once per game that several players play together, from the engine the game already declares
 * for one player, in the game's `./browser` entry.
 *
 * **Details**
 *
 * The engine's simulation, what its view is made from and the view serve both hosts, and the
 * view is told the local player, whose slot it reads when it draws. What a co-op run needs
 * besides is declared here: one player's input source, the content every peer loads, the lobby
 * picks and the config they make, the state hash the peers compare, and the events that end a
 * run. An app turns what a seat reports into its Messages with the class's `match`. Every seat
 * hears its run from the start, the host's as a guest's: what the simulation's `create` reports
 * (a first stage's banner, say) follows the seat's `RunStarted`, then the first sample.
 *
 * **Example** (A game for two to four players)
 *
 * ```ts
 * import * as Game from "arcadekit/game/browser";
 * import { Coop } from "arcadekit/net/browser";
 * import { Effect, Schema } from "effect";
 *
 * class Sum extends Game.Simulation("Sum", {
 *   input: Game.PlayerInputs(Schema.Int),
 *   create: () => ({ total: 0 }),
 *   step: (state, input) => {
 *     for (const add of input.players) {
 *       state.total += add ?? 0;
 *     }
 *   },
 * }) {}
 * class SumEngine extends Game.Engine("SumEngine", {
 *   simulation: Sum,
 *   view: () => ({ render: () => {}, dispose: () => {} }),
 *   input: () => ({ read: () => ({ players: [1], leaving: [] }), dispose: () => {} }),
 * }) {}
 * class SumCoop extends Coop("SumCoop", {
 *   engine: SumEngine,
 *   input: () => ({ read: () => 1, dispose: () => {} }),
 *   content: Effect.succeed({ colours: ["red", "blue"] }),
 *   picks: (content) => content.colours,
 *   config: () => null,
 *   hash: (state) => state.total,
 * }) {}
 *
 * SumCoop.key; // => "arcadekit/net/Coop/SumCoop"
 * SumCoop.definition.config({ colours: [] }, ["red", "blue"]); // => null
 * ```
 *
 * Throws when declared, for what the types let through: an engine whose simulation's `input`
 * was not declared with `Game.PlayerInputs`, an `ends` entry the simulation doesn't report, and
 * a `maxPlayers` no room can have.
 *
 * @category declarations
 * @since 0.7.0
 */
export const Coop = <
  const Name extends string,
  EngineName extends string,
  Config,
  State,
  Input,
  Event,
  Command,
  Refusals,
  Content,
  ContentError extends { readonly message: string },
  U extends Uses = Record<never, never>,
  R = never,
>(
  name: Name,
  definition: CoopDefinition<
    EngineName,
    Config,
    State,
    Input,
    Event,
    Command,
    U,
    Refusals,
    Content,
    ContentError,
    R
  >
): CoopClass<
  Name,
  EngineName,
  Config,
  State,
  Input,
  Event,
  Command,
  U,
  Refusals,
  Content,
  R
> => {
  type E = Effect.Error<U[keyof U]>;
  type Needs = Effect.Services<U[keyof U]> | R;
  type PlayerInput = PlayerInputOf<Input>;
  const { engine } = definition;
  const { simulation } = engine;
  // What the types let through is refused here, as the game's module loads.
  try {
    playerInputSchema<Input>(simulation);
  } catch (error) {
    throw new Error(
      `Coop "${name}" is declared with the engine "${engine.engineName}", whose simulation several players can't play. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const reported = simulation.definition.events.map(({ tag }) => tag);
  const ends = new Set<string>();
  for (const { tag } of definition.ends ?? []) {
    if (tag === simulation.definition.sample?.tag) {
      throw new Error(
        `Coop "${name}" lists "${tag}" in \`ends\`, which is the sample of the simulation "${simulation.simulationName}": a run reports it all the time, so every run would count as over at once. List the event a run ends with, one of the simulation's \`events\`.`
      );
    }
    if (!reported.includes(tag)) {
      throw new Error(
        `Coop "${name}" lists "${tag}" in \`ends\`, which the simulation "${simulation.simulationName}" doesn't report. List the event a run ends with, one of the simulation's \`events\`${reported.length === 0 ? ", which declares none" : ` (${reported.join(", ")})`}.`
      );
    }
    ends.add(tag);
  }
  const maxPlayers = definition.maxPlayers ?? Room.defaultSize;
  if (
    !Number.isInteger(maxPlayers) ||
    maxPlayers < 2 ||
    maxPlayers > Room.maxSize
  ) {
    throw new Error(
      `Coop "${name}" has maxPlayers ${maxPlayers}, a size no room has: a signalling room holds 2 to ${Room.maxSize} players. Write a whole number from 2 to ${Room.maxSize}, or leave it out for ${Room.defaultSize}.`
    );
  }
  /** What a run reports, by tag: its events, then its sample. Each has a case under `run`. */
  const sampled = simulation.definition.sample?.tag;
  const runEvents = sampled === undefined ? reported : [...reported, sampled];
  const noCase = (tag: string): Error =>
    new Error(
      `Coop "${name}" has no case for the event "${tag}". \`match\` takes a case for each of the Co-op client's own events (${SEAT_EVENTS.join(", ")}), and the run's under \`run\`.`
    );
  const noRunCase = (tag: string): Error =>
    new Error(
      `Coop "${name}" has no case under \`run\` for the run's event "${tag}". \`match\` takes one there for everything the simulation "${simulation.simulationName}" reports${runEvents.length === 0 ? "" : ` (${runEvents.join(", ")})`}.`
    );
  /**
   * Refuses the cases `match` can't use, when it is called: a case for an event that doesn't
   * exist would never run and nobody would be told, and a case a cast left out would only be
   * missed when its event came.
   */
  const checkCases = (cases: GivenCases): void => {
    const run = cases.run ?? {};
    for (const tag of Object.keys(cases)) {
      if (tag !== "run" && !SEAT_EVENTS.includes(tag)) {
        throw new Error(
          runEvents.includes(tag)
            ? `Coop "${name}" has a case "${tag}" beside the Co-op client's own, and "${tag}" is one of the run's events. Its case goes under \`run\`.`
            : `Coop "${name}" has a case "${tag}", which is none of the Co-op client's own events (${SEAT_EVENTS.join(", ")}). Remove it, or name it after the event it handles; a case for one of the run's events goes under \`run\`.`
        );
      }
    }
    for (const tag of Object.keys(run)) {
      if (!runEvents.includes(tag)) {
        throw new Error(
          SEAT_EVENTS.includes(tag)
            ? `Coop "${name}" has a case "${tag}" under \`run\`, and "${tag}" is one of the Co-op client's own events. Its case goes beside \`run\`, not under it.`
            : `Coop "${name}" has a case "${tag}" under \`run\`, which the simulation "${simulation.simulationName}" doesn't report${runEvents.length === 0 ? ": it reports nothing" : ` (${runEvents.join(", ")})`}. Remove it, or name it after the event it handles.`
        );
      }
    }
    for (const tag of SEAT_EVENTS) {
      if (cases[tag] === undefined) {
        throw noCase(tag);
      }
    }
    for (const tag of runEvents) {
      if (run[tag] === undefined) {
        throw noRunCase(tag);
      }
    }
  };
  const Key = Context.Service<
    CoopService<Name, State, Event, Command, E, Refusals>,
    CoopClient.CoopClient<State, Event, Command, E, Refusals>
  >()(`arcadekit/net/Coop/${name}` as CoopId<Name>);
  const uses = Effect.all(
    engine.definition.uses ?? {}
  ) as unknown as Effect.Effect<Used<U>, E, Needs>;
  const layer = Layer.effect(
    Key,
    Effect.gen(function* () {
      // What the engine uses and what the content's load needs are taken once, here, so a seat
      // and an attach need nothing but their scope. The layer's own scope is left out: what an
      // attach acquires is released when it detaches.
      const context = Context.omit(Scope.Scope)(
        yield* Effect.context<Exclude<Needs, Scope.Scope>>()
      );
      return yield* coopClient({
        name,
        simulation,
        content: definition.content.pipe(
          Effect.provideContext(context)
        ) as Effect.Effect<Content, ContentError>,
        presentation: uses.pipe(
          Effect.map((used) => ({
            view: (container: HTMLElement, seat: ViewContext) =>
              engine.definition.view(container, used, seat),
            input: (surface: HTMLElement) => definition.input(surface, used),
          })),
          Effect.provideContext(context)
        ) as Effect.Effect<CoopPresented<State, PlayerInput>, E, Scope.Scope>,
        hash: definition.hash,
        picks: definition.picks,
        config: definition.config,
        maxPlayers,
        ...(definition.lockstep === undefined
          ? {}
          : { lockstep: definition.lockstep }),
        ends,
        rooms: yield* CoopRooms,
        ticker: yield* CoopTicker,
        frames: yield* Frames,
      });
    })
  );
  return class extends Key {
    static readonly kind = "Coop" as const;
    static readonly coopName: Name = name;
    static readonly engine = engine;
    static readonly definition = definition;
    static readonly layer = layer;
    static readonly match = (cases: GivenCases) => {
      checkCases(cases);
      return (heard: CoopEvent.CoopEvent<{ readonly _tag: string }>) => {
        // One of the run's events is handled by its own tag, under `run`.
        if (heard._tag === "RunEvent") {
          const handle = cases.run?.[heard.event._tag];
          // Every case was there when `match` was called: only an event the simulation
          // doesn't declare gets here.
          if (handle === undefined) {
            throw noRunCase(heard.event._tag);
          }
          return handle(heard.event, heard);
        }
        const handle = cases[heard._tag];
        if (handle === undefined) {
          throw noCase(heard._tag);
        }
        return handle(heard);
      };
    };
  } as unknown as CoopClass<
    Name,
    EngineName,
    Config,
    State,
    Input,
    Event,
    Command,
    U,
    Refusals,
    Content,
    R
  >;
};
