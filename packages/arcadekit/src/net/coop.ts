import type { GameSimulation, PlayerInputs } from "../runtime/index";
import type { InputCodec } from "./codec";

// A Co-op game's lockstep parts, DOM-free: a genre keeps them beside its simulation and tests
// them in Node. The Co-op client (`arcadekit/net/browser`) runs them. Everything here that runs
// between steps is plain code (ADR-0017).

/**
 * The types of one Co-op game, as one bag. A game declares it once and names it everywhere:
 *
 * - `Config`, `State`, `Event`: its `GameSimulation`'s.
 * - `PlayerInput`: one player's input for one step. The simulation's step input is
 *   `PlayerInputs<PlayerInput>`: the kit combines the players' inputs by slot.
 * - `Answer`: what the local player answers the run with (an upgrade pick, say), held on their
 *   input until the game says it's settled.
 * - `LocalEvent`: what the local player's app hears of the run's events.
 * - `Content`: what the run is played with, as JSON data. Every peer loads its own, and the kit
 *   compares their hashes.
 */
export interface CoopTypes {
  readonly Config: unknown;
  readonly State: unknown;
  readonly Event: unknown;
  readonly PlayerInput: unknown;
  readonly Answer: unknown;
  readonly LocalEvent: unknown;
  readonly Content: unknown;
}

/** A Co-op game's lockstep parts: what every peer must agree on, and what only the local player's seat needs. */
export interface CoopRules<G extends CoopTypes> {
  /** The run. Its step input is every player's input by slot, host first, and the slots leaving. */
  readonly simulation: GameSimulation<
    G["Config"],
    G["State"],
    PlayerInputs<G["PlayerInput"]>,
    G["Event"]
  >;
  readonly codec: InputCodec<G["PlayerInput"]>;
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
   * Called once per run. The returned function is called once per scheduled step with the
   * device's input (null while nothing is attached), the held answer (null with none) and the
   * held pause. It refills and returns one object: it must not allocate.
   */
  readonly localInput: () => (
    device: G["PlayerInput"] | null,
    answer: G["Answer"] | null,
    paused: boolean
  ) => G["PlayerInput"];
  /**
   * True once `answer` can no longer apply for `slot`: the kit then stops sending it. Called
   * between steps: it must not allocate or change the state.
   */
  readonly settled: (
    answer: G["Answer"],
    state: G["State"],
    slot: number
  ) => boolean;
  /**
   * True while `slot`'s player owes the run an answer. Called between steps for every slot: it
   * must not allocate or change the state.
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
