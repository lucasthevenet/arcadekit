import { Effect, Schema } from "effect";

import * as Game from "../../game/index";
import type { GameView } from "../../runtime/browser";
import type { InputSource } from "../../runtime/index";
import type { CoopGame, CoopPresentation } from "../browser/index";
import type { CoopRules, CoopTypes } from "../coop";

// A small Co-op game for tests: every player adds a number each step, and now and then the run
// stops on an offer that each player answers. It is enough to drive every part of the Co-op
// client: lobby picks, a command the rules take or refuse, players choosing, pause, and a run's
// end. Its rules are declared as a genre's are: events, commands with their rejections, then the
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
  }
> = Game.Event("Score", {
  steps: Schema.Int,
  totals: Schema.Array(Schema.Number),
});

/** The run's sample, every 100 ms: the steps played, and each player's total by slot. */
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

/** What the local player hears of the run. */
export type TestLocalEvent =
  | { readonly type: "score"; readonly steps: number; readonly total: number }
  | { readonly type: "offer"; readonly offer: number }
  | {
      readonly type: "ended";
      readonly total: number;
      readonly names: readonly string[];
    };

/** The test game's types, as the bag a Co-op game names. */
export interface TestCoop extends CoopTypes {
  readonly Config: TestConfig;
  readonly State: TestState;
  readonly Event: TestEvent;
  readonly PlayerInput: TestInput;
  readonly Command: TestCommand;
  readonly Refusals: Game.RefusalsOf<
    readonly [typeof AnswerOffer, typeof HoldPause]
  >;
  readonly LocalEvent: TestLocalEvent;
  readonly Content: TestContent;
}

const TestInputSchema = Schema.Struct({ add: Schema.Number });

const nothing = (): void => undefined;

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
    state.offer += 1;
    for (let slot = 0; slot < state.owes.length; slot++) {
      if (state.gone[slot] !== true) {
        state.owes[slot] = true;
        report(new OfferOpened({ offer: state.offer, slot }));
      }
    }
  }
};

const TestGameBase: Game.SimulationClass<
  "TestGame",
  TestConfig,
  TestState,
  Game.PlayerInputs<TestInput>,
  TestEvent,
  TestCommand,
  Game.RefusalsOf<readonly [typeof AnswerOffer, typeof HoldPause]>
> = Game.Simulation("TestGame", {
  input: Game.PlayerInputs(TestInputSchema),
  events: [OfferOpened, RunEnded],
  commands: [AnswerOffer, HoldPause],
  create: ({ content, picks }: TestConfig): TestState => ({
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
  }),
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
    read: (state) => ({ steps: state.steps, totals: [...state.totals] }),
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

/** The test game's lockstep parts. */
export const testCoopRules: CoopRules<TestCoop> = {
  simulation: TestGame,
  hash: hashTestState,
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  choosing: (state, slot) => state.owes[slot] === true,
  localEvent: (event, slot, names) => {
    switch (event._tag) {
      case "Score": {
        return {
          type: "score",
          steps: event.steps,
          total: event.totals[slot] ?? 0,
        };
      }
      case "OfferOpened": {
        return event.slot === slot
          ? { type: "offer", offer: event.offer }
          : null;
      }
      case "RunEnded": {
        return { type: "ended", total: event.totals[slot] ?? 0, names };
      }
    }
  },
  runEnded: (event) => event._tag === "RunEnded",
};

const ADD_ONE: TestInput = { add: 1 };

/**
 * The test game's presentation: an input that adds 1 each step while attached, and a view that
 * draws nothing. Pass `createInput` or `createView` to watch or replace either.
 */
export const testPresentation = (
  parts: Partial<CoopPresentation<TestState, TestInput>> = {}
): CoopPresentation<TestState, TestInput> => ({
  createInput: (): InputSource<TestInput> => ({
    read: () => ADD_ONE,
    dispose: nothing,
  }),
  createView: (): GameView<TestState> => ({
    render: nothing,
    dispose: nothing,
  }),
  ...parts,
});

export interface TestCoopGameOptions<LoadError = never> {
  /** The content each seat loads. Defaults to `testContent`, at once. */
  readonly content?: Effect.Effect<TestContent, { readonly message: string }>;
  /** What each attach makes. Defaults to `testPresentation()`, at once. */
  readonly presentation?: Effect.Effect<
    CoopPresentation<TestState, TestInput>,
    LoadError
  >;
  readonly maxPlayers?: number;
  readonly lockstep?: CoopRules<TestCoop>["lockstep"];
}

/** The test game as a Co-op game: `testCoopRules`, with content and a presentation from `options`. */
export const testCoopGame = <LoadError = never>(
  options: TestCoopGameOptions<LoadError> = {}
): CoopGame<TestCoop, LoadError> => ({
  ...testCoopRules,
  ...(options.maxPlayers === undefined
    ? {}
    : { maxPlayers: options.maxPlayers }),
  ...(options.lockstep === undefined ? {} : { lockstep: options.lockstep }),
  content: options.content ?? Effect.succeed(testContent),
  presentation:
    options.presentation ??
    Effect.sync((): CoopPresentation<TestState, TestInput> =>
      testPresentation()
    ),
});
