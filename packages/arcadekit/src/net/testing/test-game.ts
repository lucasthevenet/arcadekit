/**
 * The test game: a small co-op game for tests, every player adding a number each step, and now
 * and then the run stopping on an offer that each player answers.
 *
 * It is enough to drive every part of the Co-op client: lobby picks, a command the rules take or
 * refuse, players choosing, a pause, a run's end, and a start that reports (\`offerAtStart\`), as a
 * game's does whose \`create\` begins its first stage. An event says whose it is by slot
 * (\`OfferOpened.slot\`, \`RunEnded.totals\`), as a genre's do. Its rules are declared as a genre's
 * are, events, commands with their rejections, then the simulation, and are plain on purpose:
 * a step gives the same bits on every peer. Each declaration's base is named first,
 * with its type, since the kit's type files are made one file at a time (isolatedDeclarations).
 *
 * @since 0.7.0
 */
import { Schema } from "effect";

import * as Game from "../../game/index";

/**
 * The test game's content, as JSON data: the lobby picks, how long a run lasts, how often an offer
 * opens, and whether the run starts on one.
 *
 * **When to use**
 *
 * To make content for a Co-op of the test game: `TestGame.content` with a field changed.
 *
 * **Example** (A run that opens an offer every 60 steps)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const offers: TestGame.Content = { ...TestGame.content, offerEvery: 60 };
 * offers.picks; // => ["red", "green", "blue"]
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export interface Content {
  /** The valid lobby picks. */
  readonly picks: readonly string[];
  /** The run ends after this many steps. */
  readonly length: number;
  /** An offer opens after every this many steps; 0 for none. */
  readonly offerEvery: number;
  /**
   * Whether the run starts on an offer: `create` opens offer 1 for every player and reports it,
   * before any step, as a game that begins on a choice or on its first stage's banner does. Left
   * out, it starts on none, and `create` reports nothing.
   */
  readonly offerAtStart?: boolean;
}

/**
 * The test game's usual content: three picks, a run that outlasts any test, and no offers.
 *
 * **When to use**
 *
 * As a test Coop's `content`, `Effect.succeed(TestGame.content)`, and as the start of any other.
 *
 * **Example** (The usual content)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * TestGame.content.offerEvery; // => 0
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const content: Content = {
  picks: ["red", "green", "blue"],
  length: 1_000_000,
  offerEvery: 0,
};

/**
 * The test game's config: its content, and each player's lobby pick, by slot.
 *
 * **When to use**
 *
 * As what a test Coop's `config` makes from the content and the picks.
 *
 * **Example** (A config for two players)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const config: TestGame.Config = { content: TestGame.content, picks: ["red", "green"] };
 * config.picks.length; // => 2
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export interface Config {
  readonly content: Content;
  /** Each player's lobby pick, by slot. */
  readonly picks: readonly string[];
}

/**
 * One player's input for one step: what its device holds, a number to add to the player's total.
 *
 * **When to use**
 *
 * To write a test Coop's `input`, or a test session's `local`.
 *
 * **Example** (A device that adds 1)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const read = (): TestGame.Input => ({ add: 1 });
 * read().add; // => 1
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export interface Input {
  /** Added to the player's total this step. */
  readonly add: number;
}

/**
 * The test game's state: each player's total, bonus and pick by slot, the open offer, who owes it
 * an answer, who has left and who holds the pause, and whether the run has ended.
 *
 * **When to use**
 *
 * To read a test run's state in a check: a client's `debug().state`, a session's `state`.
 *
 * **Example** (Each player's total)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const loop = Game.makeLoop(TestGame.TestGame);
 * loop.start({ content: TestGame.content, picks: ["red", "green"] }, 1, 0);
 * loop.frame({ read: () => ({ players: [{ add: 2 }, { add: 3 }], leaving: [] }) }, { steps: 1 }, 0);
 * const state: TestGame.State | null = loop.state;
 * state?.totals; // => [2, 3]
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export interface State {
  readonly content: Content;
  /** Each player's lobby pick, by slot. */
  readonly picks: readonly string[];
  steps: number;
  /** Each player's sum of `add`, by slot. */
  readonly totals: number[];
  /** Each player's sum of answered values, by slot. */
  readonly bonus: number[];
  /** The number of the last offer opened; 0 before the first. */
  offer: number;
  /** Whether each player still owes the open offer an answer, by slot. The run waits on them. */
  readonly owes: boolean[];
  /** Whether each player has left the run, by slot. */
  readonly gone: boolean[];
  /** Whether each player holds the run paused (`HoldPause`), by slot. */
  readonly held: boolean[];
  ended: boolean;
}

const ScoreBase: Game.EventClass<
  "Score",
  {
    readonly steps: Schema.Int;
    readonly totals: Schema.$Array<Schema.Number>;
    readonly owes: Schema.$Array<Schema.Boolean>;
  }
> = Game.Event("Score", {
  steps: Schema.Int,
  totals: Schema.Array(Schema.Number),
  owes: Schema.Array(Schema.Boolean),
});

/**
 * The run's sample, every 100 ms: the steps played, each player's total by slot, and whether each
 * still owes the open offer an answer. Who a run waits on to decide is the game's to say, and it
 * says it here.
 *
 * **When to use**
 *
 * To read a test run's progress from what a seat reports, under `run` in a Coop's `match`.
 *
 * **Example** (A sample)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const score = new TestGame.Score({ steps: 6, totals: [6, 6], owes: [false, true] });
 * score.owes.includes(true); // => true
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export class Score extends ScoreBase {}

const OfferOpenedBase: Game.EventClass<
  "OfferOpened",
  { readonly offer: Schema.Int; readonly slot: Schema.Int }
> = Game.Event("OfferOpened", { offer: Schema.Int, slot: Schema.Int });

/**
 * Offer `offer` opened for `slot`'s player, who owes it an answer: the run waits until every
 * player still in it has answered.
 *
 * **When to use**
 *
 * To answer an offer in a test, with `AnswerOffer`, when its player's seat hears it.
 *
 * **Example** (An offer for the second player)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const opened = new TestGame.OfferOpened({ offer: 1, slot: 1 });
 * opened.slot; // => 1
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export class OfferOpened extends OfferOpenedBase {}

const RunEndedBase: Game.EventClass<
  "RunEnded",
  { readonly totals: Schema.$Array<Schema.Number> }
> = Game.Event("RunEnded", { totals: Schema.Array(Schema.Number) });

/**
 * The run ended. `totals` is each player's total plus bonus, by slot.
 *
 * **When to use**
 *
 * As a test Coop's `ends`, so the others leaving after it is no failure.
 *
 * **Example** (A run's end)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * new TestGame.RunEnded({ totals: [10, 12] }).totals[1]; // => 12
 * TestGame.RunEnded.tag; // => "RunEnded"
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export class RunEnded extends RunEndedBase {}

/**
 * Everything a run of the test game reports: its two events and its sample.
 *
 * **When to use**
 *
 * To type what a test hears of a run, as a session's or a seat's listener does.
 *
 * **Example** (Telling the events apart)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const ended = (event: TestGame.Event) => event._tag === "RunEnded";
 * ended(new TestGame.RunEnded({ totals: [] })); // => true
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export type Event = Score | OfferOpened | RunEnded;

const NothingOwedBase: Game.RejectionClass<
  "NothingOwed",
  { readonly offer: Schema.Int }
> = Game.Rejection("NothingOwed", { offer: Schema.Int });

/**
 * The sender owes offer `offer` no answer: another offer is the open one, none is, or the sender
 * has answered it already. `AnswerOffer` is refused with it.
 *
 * **When to use**
 *
 * To check, in a test, a command the rules refuse: the sender's `send` fails with it.
 *
 * **Example** (A refusal)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const refused = new TestGame.NothingOwed({ offer: 2 });
 * refused._tag; // => "NothingOwed"
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export class NothingOwed extends NothingOwedBase {}

const AnswerOfferBase: Game.CommandClass<
  "AnswerOffer",
  { readonly offer: Schema.Int; readonly value: Schema.Number },
  readonly [typeof NothingOwed]
> = Game.Command(
  "AnswerOffer",
  { offer: Schema.Int, value: Schema.Number },
  { rejects: [NothingOwed] }
);

/**
 * The sender answers offer `offer`: `value` is added to its bonus, and it owes nothing more. The
 * rules refuse it with `NothingOwed` when the sender owes that offer nothing.
 *
 * **When to use**
 *
 * In a test of a command the rules take or refuse, sent with a seat's `send`.
 *
 * **Example** (An answer)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const answer = new TestGame.AnswerOffer({ offer: 1, value: 5 });
 * TestGame.AnswerOffer.rejects[0] === TestGame.NothingOwed; // => true
 * answer.value; // => 5
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export class AnswerOffer extends AnswerOfferBase {}

const HoldPauseBase: Game.CommandClass<
  "HoldPause",
  { readonly held: Schema.Boolean }
> = Game.Command("HoldPause", { held: Schema.Boolean });

/**
 * The sender holds the run paused for everyone (`held: true`), or lets it go. Leaving lets go.
 *
 * **When to use**
 *
 * In a test of a pause a player holds, as a game's co-op pause is.
 *
 * **Example** (Holding the pause)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * new TestGame.HoldPause({ held: true }).held; // => true
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export class HoldPause extends HoldPauseBase {}

/**
 * Every command a run of the test game takes.
 *
 * **When to use**
 *
 * To type what a test sends to a run.
 *
 * **Example** (Naming a command)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const pause: TestGame.Command = new TestGame.HoldPause({ held: true });
 * pause._tag; // => "HoldPause"
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export type Command = AnswerOffer | HoldPause;

/**
 * The rejections each of the test game's commands can be refused with, by the command's tag.
 *
 * **When to use**
 *
 * To type a test session or client of the test game, whose `send` fails with them.
 *
 * **Example** (The refusal of an answer)
 *
 * ```ts
 * import { TestGame } from "arcadekit/net/testing";
 *
 * type Refused = TestGame.Refusals["AnswerOffer"];
 * const refused: Refused = new TestGame.NothingOwed({ offer: 1 });
 * refused.offer; // => 1
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export type Refusals = Game.RefusalsOf<
  readonly [typeof AnswerOffer, typeof HoldPause]
>;

const TestInputSchema = Schema.Struct({ add: Schema.Number });

/** Opens the next offer for every player still in the run, and reports it to each. */
const openOffer = (
  state: State,
  report: (event: OfferOpened) => void
): void => {
  state.offer += 1;
  for (let slot = 0; slot < state.owes.length; slot++) {
    if (state.gone[slot] !== true) {
      state.owes[slot] = true;
      report(new OfferOpened({ offer: state.offer, slot }));
    }
  }
};

/** One step of play: every player's `add`, then the end, or the next offer. */
const advance = (
  state: State,
  players: readonly (Input | null)[],
  report: (event: OfferOpened | RunEnded) => void
): void => {
  state.steps += 1;
  for (let slot = 0; slot < players.length; slot++) {
    if (state.gone[slot] !== true) {
      state.totals[slot]! += players[slot]?.add ?? 0;
    }
  }
  const { length, offerEvery } = state.content;
  if (state.steps >= length) {
    state.ended = true;
    report(
      new RunEnded({
        totals: state.totals.map((total, slot) => total + state.bonus[slot]!),
      })
    );
  } else if (offerEvery > 0 && state.steps % offerEvery === 0) {
    openOffer(state, report);
  }
};

const TestGameBase: Game.SimulationClass<
  "TestGame",
  Config,
  State,
  Game.PlayerInputs<Input>,
  Event,
  Command,
  Refusals
> = Game.Simulation("TestGame", {
  input: Game.PlayerInputs(TestInputSchema),
  events: [OfferOpened, RunEnded],
  commands: [AnswerOffer, HoldPause],
  create: ({ content: played, picks }: Config, { report }): State => {
    const state: State = {
      content: played,
      picks,
      steps: 0,
      totals: picks.map(() => 0),
      bonus: picks.map(() => 0),
      offer: 0,
      owes: picks.map(() => false),
      gone: picks.map(() => false),
      held: picks.map(() => false),
      ended: false,
    };
    if (played.offerAtStart === true) {
      openOffer(state, report);
    }
    return state;
  },
  step: (state, input, { report }) => {
    if (state.ended) {
      return;
    }
    for (const slot of input.leaving) {
      state.gone[slot] = true;
      state.owes[slot] = false;
      state.held[slot] = false;
    }
    // The run waits while a player owes the open offer an answer, or holds the pause.
    if (!state.owes.includes(true) && !state.held.includes(true)) {
      advance(state, input.players, report);
    }
  },
  apply: {
    // Decide first, then change: a refused answer leaves the state as it was.
    AnswerOffer: (state, { offer, value }, { player }) => {
      if (state.offer !== offer || state.owes[player] !== true) {
        return new NothingOwed({ offer });
      }
      state.bonus[player]! += value;
      state.owes[player] = false;
    },
    HoldPause: (state, { held }, { player }) => {
      if (state.gone[player] === false) {
        state.held[player] = held;
      }
    },
  },
  sample: {
    event: Score,
    every: "100 millis",
    read: (state) => ({
      steps: state.steps,
      totals: [...state.totals],
      owes: [...state.owes],
    }),
  },
});

/**
 * The test game's rules: plain and deterministic, as a genre's are. Several players play it, so
 * its step input is a `Game.PlayerInputs`. A player answers an offer with `AnswerOffer` and
 * holds the pause with `HoldPause`.
 *
 * **When to use**
 *
 * As the simulation of a Co-op game's test, through a test engine and a test Coop, or of a
 * lockstep session's: it is the game a test of the client or of the protocol runs.
 *
 * **Details**
 *
 * Each step adds every player's `add` to its total, unless a player owes the open offer an
 * answer or holds the pause. A player at a step's `leaving` has left: it owes nothing and holds
 * nothing from then on. The run ends after `content.length` steps.
 *
 * **Example** (Two players' first step)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const loop = Game.makeLoop(TestGame.TestGame);
 * loop.start({ content: TestGame.content, picks: ["red", "green"] }, 1, 0);
 * loop.frame({ read: () => ({ players: [{ add: 1 }, { add: 2 }], leaving: [] }) }, { steps: 1 }, 0);
 * loop.state?.totals; // => [1, 2]
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export class TestGame extends TestGameBase {}

const mix = (hash: number, value: number): number =>
  Math.imul(hash ^ value, 0x01_00_01_93) >>> 0;

/**
 * A digest of everything in the test game's state that a step changes, as a genre's state hash
 * is.
 *
 * **When to use**
 *
 * As a test Coop's `hash`, or a test session's: peers compare it every `hashEvery` steps.
 *
 * **Example** (Two states, two digests)
 *
 * ```ts
 * import * as Game from "arcadekit/game";
 * import { TestGame } from "arcadekit/net/testing";
 *
 * const loop = Game.makeLoop(TestGame.TestGame);
 * loop.start({ content: TestGame.content, picks: ["red"] }, 1, 0);
 * const before = TestGame.hash(loop.state!);
 * loop.frame({ read: () => ({ players: [{ add: 1 }], leaving: [] }) }, { steps: 1 }, 0);
 * TestGame.hash(loop.state!) === before; // => false
 * ```
 *
 * @category testing
 * @since 0.7.0
 */
export const hash = (state: State): number => {
  let digest = mix(mix(0x81_1c_9d_c5, state.steps), state.offer);
  for (let slot = 0; slot < state.totals.length; slot++) {
    digest = mix(digest, state.totals[slot]!);
    digest = mix(digest, state.bonus[slot]!);
    digest = mix(digest, state.owes[slot] === true ? 1 : 0);
    digest = mix(digest, state.gone[slot] === true ? 1 : 0);
    digest = mix(digest, state.held[slot] === true ? 1 : 0);
  }
  return mix(digest, state.ended ? 1 : 0);
};
