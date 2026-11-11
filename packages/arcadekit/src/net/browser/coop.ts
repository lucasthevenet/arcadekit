import { Context, Effect, Layer, Scope } from "effect";

import { Frames } from "../../game/browser";
import type {
  AttachError,
  EngineClass,
  GameCrashed,
  InputSource,
  Used,
  Uses,
  ViewContext,
} from "../../game/browser";
import { playerInputSchema } from "../../game/index";
import type {
  AnyEvent,
  AnySimulation,
  CommandDropped,
  EventOf,
  PlayerInputOf,
  PlayersSimulation,
  RefusalFor,
} from "../../game/index";
import type { Ticker } from "../scoped";
import { DEFAULT_ROOM_SIZE, MAX_ROOM_SIZE } from "../signalling/protocol";
import { coopClient } from "./coop-client";
import type { CoopPresented } from "./coop-client";
import type {
  CoopEvent,
  LobbyChanged,
  RunStarted,
  SeatContext,
  SeatFailed,
  WaitingChanged,
} from "./coop-events";
import { CoopRooms } from "./coop-rooms";
import { workerTicker } from "./ticker";

// A game for several players, each in their own browser: the `Coop` declaration, and the Co-op
// client its class is the key of (ADR-0019, ADR-0021). The client's implementation is in
// coop-client.ts.

/** One handler per event or sample of a run, by its tag, each given the local player. */
export type RunCases<Event> = {
  readonly [
    E in Event as E extends { readonly _tag: infer Tag extends string }
      ? Tag
      : never
  ]: (event: E, context: SeatContext) => unknown;
};

/** What a `Coop`'s `match` takes: a handler for each of the client's own events, and `run`'s for the run's. */
export interface CoopCases<Event> {
  readonly LobbyChanged: (event: LobbyChanged) => unknown;
  readonly RunStarted: (event: RunStarted) => unknown;
  readonly WaitingChanged: (event: WaitingChanged) => unknown;
  readonly SeatFailed: (event: SeatFailed) => unknown;
  /** The run's own events and its sample, each by its tag. */
  readonly run: RunCases<Event>;
}

/** What the handlers of `Handlers` return, together. */
type Returned<Handlers> = Handlers[keyof Handlers] extends (
  ...args: never[]
) => infer Result
  ? Result
  : never;

/** For tests and debugging: a read of the current seat's run. */
export interface CoopDebug<State> {
  readonly stepIndex: number;
  /** The lockstep session's stop error, or null. */
  readonly error: string | null;
  /** The last 32 state hashes, by step. */
  readonly hashes: Readonly<Record<number, number>>;
  /** The local player's slot; -1 with no seat. */
  readonly slot: number;
  /** The run's state, or null with no run. Read it; never change it. */
  readonly state: State | null;
}

/**
 * The Co-op client: one player's side of a co-op game in the browser, as an app drives it. Each
 * `Coop` class is the service key of one: `yield* MyCoop`. It runs the lobby over the signalling
 * worker and WebRTC, then a lockstep session stepped on a worker's timer, and a view drawn on
 * animation frames while attached. A hidden tab keeps stepping at full rate, so it holds no one up, and
 * draws nothing, since the browser runs no animation frames for it (ADR-0012). What a player
 * decides reaches the run as a command, through `send`: it rides the player's next step, so
 * every peer applies it at that step.
 *
 * `attach` and `listen` have `arcadekit/foldkit`'s `AttachableEngine` shapes, so an app mounts
 * the client as it mounts an engine.
 */
export interface CoopClient<State, Event, Command, E, Refusals> {
  /**
   * Hosts a room with lobby pick `pick`, after interrupting the seat before it. Returns at once:
   * the lobby, the run and any failure are reported through `listen`, and none of them before
   * every earlier seat has closed.
   */
  readonly host: (pick: string) => Effect.Effect<void>;
  /** Joins the room with join code `code`, with lobby pick `pick`, as `host` opens one. */
  readonly join: (code: string, pick: string) => Effect.Effect<void>;
  /** Changes the local player's lobby pick. Does nothing once the run has started. */
  readonly choose: (pick: string) => Effect.Effect<void>;
  /**
   * Host: starts the run with everyone linked, if the lobby's `canStart` is true. Does nothing
   * otherwise, or for a guest. The worker confirms, then each guest is told the players and
   * their picks. A guest that links in between can't make the run larger than the game's
   * `maxPlayers`: the last to join fail with `leftOut`.
   */
  readonly start: Effect.Effect<void>;
  /**
   * Sends a command to the run as the local player and waits for the rules' answer, as
   * `Game.Engine`'s `send` does. The command rides the player's next step, and every peer's
   * rules take or refuse it alike at that step. It succeeds when this player's own took it. It
   * fails with the rejection they refused it with, one of those the command declares, and with
   * `CommandDropped` when they gave no answer: there is no run (`noRun`: no seat, or still its
   * lobby), or the run stopped, or this player left, first (`runEnded`).
   *
   * ```ts
   * yield* coop
   *   .send(new ChooseUpgrade({ offer, index }))
   *   .pipe(Effect.catchTag(["OfferClosed", "CommandDropped"], () => Effect.void));
   * ```
   *
   * It completes a few steps after it is sent (the run's `inputDelay`, and the network), never
   * inside a step, and waits for as long as the run waits on a player. Interrupt it to take the
   * command back while it has no step yet, which is about one step's time; after that every
   * peer applies it. A player the host removes after its command's step was confirmed is told
   * `runEnded`, though the others applied the command.
   *
   * When it succeeds, or fails with a rejection, a listener (`listen`) has been called with
   * what the command's step reported, as an engine's has: an Effect that listens and then sends
   * knows, on the line after the send, what that step did. Here nothing is excepted: a run that
   * throws in that step answers `CommandDropped`. The order is that of the two calls, not of
   * the Messages an app makes of them.
   */
  readonly send: <C extends Command>(
    command: C
  ) => Effect.Effect<void, RefusalFor<Refusals, C> | CommandDropped>;
  /**
   * Leaves the lobby or the run, and returns once its room, links, session and ticker have
   * closed, with those of any earlier seat still closing. No event of that seat follows. The
   * others see this player stop sending (ADR-0012's drop-out).
   */
  readonly leave: Effect.Effect<void>;
  /**
   * Draws the run into `element` on every frame, and reads input from it, for as long as it
   * runs. With no run it draws `render(null, t)`. Fails with what one of the engine's `uses`
   * fails with (`E`: an asset that can't be loaded), with `AttachError` if the view or the input
   * source can't be made, and with `GameCrashed` if a frame throws (that frame is the last),
   * each with nothing left attached and after leaving: a seat left running undrawn would hold
   * the others up. Interrupt it to detach, which doesn't leave. One attach at a time: a second
   * dies.
   */
  readonly attach: (
    element: HTMLElement
  ) => Effect.Effect<never, AttachError | GameCrashed | E>;
  /**
   * Calls `onEvent` with everything the current seat reports while the scope is open: the
   * client's own events and the run's, in one order. A seat hears its run from the start, the
   * host's as a guest's: after its `RunStarted`, what the simulation's `create` reports, then
   * the first sample, then what each step reports, each once. The class's `match` makes the
   * handler.
   */
  readonly listen: (
    onEvent: (event: CoopEvent<Event>) => void
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly debug: () => CoopDebug<State>;
}

/** How often a run ticks on the default ticker. Browsers clamp shorter timers to about 4 ms anyway. */
const TICK_MS = 4;

/**
 * What ticks a co-op run, every few milliseconds: made when a run starts, in the run's scope,
 * and stopped with it. A timer in a dedicated worker, which a hidden tab doesn't throttle,
 * unless a test provides its own: `manualTicker().layer` (`arcadekit/net/testing`).
 *
 * ```ts
 * MyCoop.layer.pipe(
 *   Layer.provide(Layer.succeed(CoopTicker, Effect.succeed(ticker)))
 * );
 * ```
 */
export const CoopTicker: Context.Reference<
  Effect.Effect<Ticker, never, Scope.Scope>
> = Context.Reference("arcadekit/net/CoopTicker", {
  defaultValue: () => workerTicker({ everyMs: TICK_MS }),
});

/** The key string of the Co-op client of the declaration named `Name`. */
export type CoopId<Name extends string> = `arcadekit/net/Coop/${Name}`;

/**
 * The type-level identity of a Co-op client's service: what `yield* MyCoop` requires. It is the
 * type of the class's own values, so the class names it: `Layer.Layer<MyCoop>`.
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
  CoopClient<State, Event, Command, E, Refusals>
>;

/** Any class made by `Coop`, as far as its `match` reads it. */
export interface AnyCoop {
  readonly kind: "Coop";
  readonly engine: { readonly simulation: AnySimulation };
}

/**
 * The class `Coop` returns: the key of its Co-op client, and the Layer that provides it. Its
 * types are the engine's and the content's: `U` is what the engine uses, `Content` what
 * `content` loads and `R` what that load needs.
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
  CoopClient<State, Event, Command, Effect.Error<U[keyof U]>, Refusals>
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
   * const toMessage = SurvivorsCoop.match({
   *   LobbyChanged: (lobby) => Message.GotCoopLobby({ lobby }),
   *   RunStarted: ({ slot, names }) => Message.GotCoopStarted({ slot, names }),
   *   WaitingChanged: ({ waitingFor }) => Message.GotCoopWaiting({ waitingFor }),
   *   SeatFailed: ({ message }) => Message.GotCoopFailed({ error: message }),
   *   run: {
   *     Hud: (hud) => Message.GotHud({ hud }),
   *     LeveledUp: ({ hero, offer, choices }, { local }) =>
   *       hero === local.slot
   *         ? Message.GotCoopLevelUp({ offer, choices })
   *         : undefined,
   *     HeroLeft: () => undefined,
   *     RunEnded: ({ summaries }, { local }) => {
   *       const summary = summaries[local.slot];
   *       return summary === undefined
   *         ? undefined
   *         : Message.GotCoopRunEnded({ summary });
   *     },
   *   },
   * });
   * ```
   *
   * A run's events reach every seat as the rules reported them, so a case says which are the
   * local player's (`hero === local.slot`). `local` is the seat's own: an event that is kept
   * says whose it was, whatever seat the player takes next. The run's cases have a place of
   * their own, so a game may name an event as it likes: no tag is reserved. Pass it to
   * `listen`, or to `arcadekit/foldkit`'s `engineEntry` as `toMessage`.
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
    event: CoopEvent<EventOf<Self["engine"]["simulation"]>>
  ) => Returned<Omit<Cases, "run">> | Returned<Cases["run"]>;
}

/**
 * What `Coop` takes: the game's engine, and what only a run that several players share needs.
 * Every type comes from the engine's simulation and from `content`.
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
    Record<string, (event: unknown, context: SeatContext) => unknown>
  >;
};

/**
 * A game as several players play it, each in their own browser: the game's engine, played in
 * lockstep from a lobby. The class is the key of the Co-op client an app drives, and its `layer`
 * provides it.
 *
 * ```ts
 * export class SurvivorsCoop extends Coop("SurvivorsCoop", {
 *   engine: SurvivorsEngine,
 *   input: heroDevice,
 *   content: SurvivorsContent.load,
 *   picks: (content) => content.heroes.map((hero) => hero.id),
 *   config: (content, heroIds) => ({ content, heroIds }),
 *   maxPlayers: MAX_HEROES,
 *   hash: hashWorld,
 *   ends: [RunEnded],
 * }) {}
 *
 * // In the app:
 * const coop = yield* SurvivorsCoop;
 * yield* coop.host(heroId);
 * yield* coop.send(new ChooseUpgrade({ offer, index }));
 * ```
 *
 * The engine's simulation, what its view is made from and the view serve both hosts, and the
 * view is told the local player, whose slot it reads when it draws. What a co-op run needs
 * besides is declared here: one player's input source, the content every peer loads, the lobby
 * picks and the config they make, the state hash the peers compare, and the events that end a
 * run. An app turns what a seat reports into its Messages with the class's `match`. Every seat
 * hears its run from the start, the host's as a guest's: what the simulation's `create` reports
 * (a first stage's banner, say) follows the seat's `RunStarted`, then the first sample.
 *
 * Throws when declared, for what the types let through: an engine whose simulation's `input`
 * was not declared with `Game.PlayerInputs`, an `ends` entry the simulation doesn't report, and
 * a `maxPlayers` no room can have.
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
  const maxPlayers = definition.maxPlayers ?? DEFAULT_ROOM_SIZE;
  if (
    !Number.isInteger(maxPlayers) ||
    maxPlayers < 2 ||
    maxPlayers > MAX_ROOM_SIZE
  ) {
    throw new Error(
      `Coop "${name}" has maxPlayers ${maxPlayers}, a size no room has: a signalling room holds 2 to ${MAX_ROOM_SIZE} players. Write a whole number from 2 to ${MAX_ROOM_SIZE}, or leave it out for ${DEFAULT_ROOM_SIZE}.`
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
    CoopClient<State, Event, Command, E, Refusals>
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
      return (heard: CoopEvent<{ readonly _tag: string }>) => {
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
