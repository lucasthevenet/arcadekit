import { Schema } from "effect";

import * as Game from "../../game/index";

// A small Co-op game for tests: every player adds a number each step, and now and then the run
// stops on an offer that each player answers. It is enough to drive every part of the Co-op
// client: lobby picks, a command the rules take or refuse, players choosing, pause, a run's end,
// and a start that reports (`offerAtStart`), as a game's does whose `create` begins its first
// stage. An event says whose it is by slot (`OfferOpened.slot`, `RunEnded.totals`), as a genre's
// do. Its rules are declared as a genre's are: events, commands with their rejections, then the
// simulation. Each declaration's base is named first, with its type, since the kit's type files
// are made one file at a time (isolatedDeclarations).

/** The test game's content, as JSON data. */
export interface TestContent {
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

/** Three picks, a run that outlasts any test, and no offers. */
export const testContent: TestContent = {
  picks: ["red", "green", "blue"],
  length: 1_000_000,
  offerEvery: 0,
};

export interface TestConfig {
  readonly content: TestContent;
  /** Each player's lobby pick, by slot. */
  readonly picks: readonly string[];
}

/** One player's input for one step: what its device holds. */
export interface TestInput {
  /** Added to the player's total this step. */
  readonly add: number;
}

export interface TestState {
  readonly content: TestContent;
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
 * The run's sample, every 100 ms: the steps played, each player's total by slot, and whether
 * each still owes the open offer an answer. Who a run waits on to decide is the game's to say,
 * and it says it here.
 */
export class Score extends ScoreBase {}

const OfferOpenedBase: Game.EventClass<
  "OfferOpened",
  { readonly offer: Schema.Int; readonly slot: Schema.Int }
> = Game.Event("OfferOpened", { offer: Schema.Int, slot: Schema.Int });

/** Offer `offer` opened for `slot`'s player. */
export class OfferOpened extends OfferOpenedBase {}

const RunEndedBase: Game.EventClass<
  "RunEnded",
  { readonly totals: Schema.$Array<Schema.Number> }
> = Game.Event("RunEnded", { totals: Schema.Array(Schema.Number) });

/** The run ended. `totals` is each player's total plus bonus, by slot. */
export class RunEnded extends RunEndedBase {}

/** Everything a run of the test game reports: its two events and its sample. */
export type TestEvent = Score | OfferOpened | RunEnded;

const NothingOwedBase: Game.RejectionClass<
  "NothingOwed",
  { readonly offer: Schema.Int }
> = Game.Rejection("NothingOwed", { offer: Schema.Int });

/**
 * The sender owes offer `offer` no answer: another offer is the open one, none is, or the
 * sender has answered it already.
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

/** The sender answers offer `offer`: `value` is added to its bonus, and it owes nothing more. */
export class AnswerOffer extends AnswerOfferBase {}

const HoldPauseBase: Game.CommandClass<
  "HoldPause",
  { readonly held: Schema.Boolean }
> = Game.Command("HoldPause", { held: Schema.Boolean });

/** The sender holds the run paused for everyone (`held: true`), or lets it go. Leaving lets go. */
export class HoldPause extends HoldPauseBase {}

/** Every command a run of the test game takes. */
export type TestCommand = AnswerOffer | HoldPause;

/** The rejections each of the test game's commands can be refused with, by the command's tag. */
export type TestRefusals = Game.RefusalsOf<
  readonly [typeof AnswerOffer, typeof HoldPause]
>;

const TestInputSchema = Schema.Struct({ add: Schema.Number });

/** Opens the next offer for every player still in the run, and reports it to each. */
const openOffer = (
  state: TestState,
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
  state: TestState,
  players: readonly (TestInput | null)[],
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
  TestConfig,
  TestState,
  Game.PlayerInputs<TestInput>,
  TestEvent,
  TestCommand,
  TestRefusals
> = Game.Simulation("TestGame", {
  input: Game.PlayerInputs(TestInputSchema),
  events: [OfferOpened, RunEnded],
  commands: [AnswerOffer, HoldPause],
  create: ({ content, picks }: TestConfig, { report }): TestState => {
    const state: TestState = {
      content,
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
    if (content.offerAtStart === true) {
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
 */
export class TestGame extends TestGameBase {}

const mix = (hash: number, value: number): number =>
  Math.imul(hash ^ value, 0x01_00_01_93) >>> 0;

/** A digest of everything in the state that a step changes. */
export const hashTestState = (state: TestState): number => {
  let hash = mix(mix(0x81_1c_9d_c5, state.steps), state.offer);
  for (let slot = 0; slot < state.totals.length; slot++) {
    hash = mix(hash, state.totals[slot]!);
    hash = mix(hash, state.bonus[slot]!);
    hash = mix(hash, state.owes[slot] === true ? 1 : 0);
    hash = mix(hash, state.gone[slot] === true ? 1 : 0);
    hash = mix(hash, state.held[slot] === true ? 1 : 0);
  }
  return mix(hash, state.ended ? 1 : 0);
};
