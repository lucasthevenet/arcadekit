import type { PlayerInputs, PlayersSimulation } from "../game/index";

// A Co-op game's lockstep parts, DOM-free: a genre keeps them beside its simulation and tests
// them in Node. The Co-op client (`arcadekit/net/browser`) runs them. What it calls between
// steps, `choosing`, is plain code (ADR-0017).

/**
 * The types of one Co-op game, as one bag. A game declares it once and names it everywhere:
 *
 * - `Config`, `State`, `Event`: its simulation's.
 * - `PlayerInput`: one player's input for one step. The simulation's step input is
 *   `Game.PlayerInputs` of it: the kit combines the players' inputs by slot.
 * - `Command`: the commands its simulation takes, which a player sends through the client's
 *   `send`: `Game.CommandOf<typeof MySimulation>`.
 * - `Refusals`: the rejections each of those commands can be refused with, by the command's
 *   tag: `Game.RefusalsOf` of the simulation's `commands`. `send` fails with them.
 * - `LocalEvent`: what the local player's app hears of the run's events.
 * - `Content`: what the run is played with, as JSON data. Every peer loads its own, and the kit
 *   compares their hashes.
 */
export interface CoopTypes {
  readonly Config: unknown;
  readonly State: unknown;
  readonly Event: unknown;
  readonly PlayerInput: unknown;
  readonly Command: unknown;
  readonly Refusals: unknown;
  readonly LocalEvent: unknown;
  readonly Content: unknown;
}

/** A Co-op game's lockstep parts: what every peer must agree on, and what only the local player's seat needs. */
export interface CoopRules<G extends CoopTypes> {
  /**
   * The run's rules: a `Game.Simulation` class whose step input was declared with
   * `Game.PlayerInputs`, every player's input by slot, host first, and the slots leaving. Each
   * player's own input crosses the network as that declaration's one-player Schema encodes it,
   * and what a player decides (a pick, a pause) is one of its commands, sent through the
   * client's `send`.
   *
   * These types don't refuse a struct written by hand with `players` and `leaving`: they name
   * the step input's type, which such a struct has too. `makeCoopClient`'s throw is the only
   * refusal here.
   */
  readonly simulation: PlayersSimulation<
    G["Config"],
    G["State"],
    PlayerInputs<G["PlayerInput"]>,
    G["Event"],
    G["Command"],
    G["Refusals"]
  >;
  /** A digest of the whole state, the same on every peer for the same run. */
  readonly hash: (state: G["State"]) => number;
  /**
   * The valid lobby picks, in order, at least one: a game with nothing to choose lists one id.
   * On the host, the first replaces an empty or unknown one at the start.
   */
  readonly picks: (content: G["Content"]) => readonly string[];
  /** The run's config from the content and each player's lobby pick, by slot. */
  readonly config: (
    content: G["Content"],
    picks: readonly string[]
  ) => G["Config"];
  /**
   * The most players a run of this game takes: the lobby refuses a start above it, on the host
   * and on a guest. A signalling room's default size (4) if left out; state a smaller number, or
   * the app's own room size. The same on every peer, since it is part of the game.
   */
  readonly maxPlayers?: number;
  /**
   * Steps ahead local input is scheduled, and steps between state hash comparisons. Defaults 4
   * (67 ms at 60 Hz, ADR-0012) and 60. The same on every peer, since it is part of the game.
   */
  readonly lockstep?: {
    readonly inputDelay?: number;
    readonly hashEvery?: number;
  };
  /**
   * True while the run waits on `slot`'s player to decide something, such as an upgrade to pick:
   * the others are shown who. Called between steps for every slot: it must not allocate or
   * change the state.
   */
  readonly choosing: (state: G["State"], slot: number) => boolean;
  /** What the local player hears of `event`, or null. `names` is every player's name, by slot. */
  readonly localEvent: (
    event: G["Event"],
    slot: number,
    names: readonly string[]
  ) => G["LocalEvent"] | null;
  /** Tested on the raw event: after it, a lost host or peer is not a failure. */
  readonly runEnded: (event: G["Event"]) => boolean;
}
