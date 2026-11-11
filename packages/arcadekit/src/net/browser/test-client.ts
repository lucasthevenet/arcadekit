import { Effect } from "effect";
import type { Scope } from "effect";

import { Frames } from "../../game/browser";
import type {
  FrameSource,
  View as GameView,
  InputSource,
} from "../../game/browser";
import type * as Game from "../../game/index";
import type { Ticker } from "../scoped";
import {
  RunEnded,
  TestGame,
  hashTestState,
  testContent,
} from "../testing/index";
import type {
  TestCommand,
  TestConfig,
  TestContent,
  TestEvent,
  TestInput,
  TestRefusals,
  TestState,
} from "../testing/index";
import { CoopTicker } from "./coop";
import type { CoopClient } from "./coop";
import { coopClient } from "./coop-client";
import type { CoopParts, CoopPresented } from "./coop-client";
import type { Rooms } from "./coop-rooms";

// The Co-op client of the test game (`arcadekit/net/testing`) from plain parts, with no
// declaration and no Layer: the kit's own client tests build many variants of one game, each
// with one part replaced (a hash that differs, content that fails to load, a view that throws).
// Test support, not exported from any entry: a game has one way to make a Co-op client, its
// `Coop`'s `layer`, and tests it over `fakeCoopRooms().layer`.

const nothing = (): void => undefined;

const ADD_ONE: TestInput = { add: 1 };

/**
 * What the test game's attach makes: a view that draws nothing, and an input that adds 1 each
 * step while attached. Pass `view` or `input` to watch or replace either.
 */
export const testPresentation = (
  parts: Partial<CoopPresented<TestState, TestInput>> = {}
): CoopPresented<TestState, TestInput> => ({
  view: (): GameView<TestState> => ({
    render: nothing,
    dispose: nothing,
  }),
  input: (): InputSource<TestInput> => ({
    read: () => ADD_ONE,
    dispose: nothing,
  }),
  ...parts,
});

/**
 * The test game as the Co-op client takes one: plain parts, so a test can replace any of them.
 * Spread it to change one (`{ ...testCoopParts(), hash }`).
 */
export type TestCoopParts<LoadError = never> = Omit<
  CoopParts<
    TestConfig,
    TestState,
    Game.PlayerInputs<TestInput>,
    TestEvent,
    TestCommand,
    TestRefusals,
    TestContent,
    LoadError
  >,
  "rooms" | "ticker" | "frames"
>;

export interface TestCoopOptions<LoadError = never> {
  /** The content each seat loads. Defaults to `testContent`, at once. */
  readonly content?: Effect.Effect<TestContent, { readonly message: string }>;
  /** What each attach makes. Defaults to `testPresentation()`, at once. */
  readonly presentation?: Effect.Effect<
    CoopPresented<TestState, TestInput>,
    LoadError
  >;
  readonly maxPlayers?: number;
  readonly lockstep?: TestCoopParts["lockstep"];
}

/** The test game's parts, with content and a presentation from `options`. */
export const testCoopParts = <LoadError = never>(
  options: TestCoopOptions<LoadError> = {}
): TestCoopParts<LoadError> => ({
  name: "TestCoop",
  simulation: TestGame,
  hash: hashTestState,
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  ends: new Set([RunEnded.tag]),
  ...(options.maxPlayers === undefined
    ? {}
    : { maxPlayers: options.maxPlayers }),
  ...(options.lockstep === undefined ? {} : { lockstep: options.lockstep }),
  content: options.content ?? Effect.succeed(testContent),
  presentation:
    options.presentation ??
    Effect.sync((): CoopPresented<TestState, TestInput> => testPresentation()),
});

/** The Co-op client of the test game, as an app drives it. */
export type TestCoopClient<LoadError = never> = CoopClient<
  TestState,
  TestEvent,
  TestCommand,
  LoadError,
  TestRefusals
>;

/**
 * The Co-op client of the test game, from its plain parts: over `rooms` (`fakeCoopRooms().rooms`),
 * ticked by `ticker` (`manualTicker().ticker`) and drawn on `frames` (`manualFrames()`). Without
 * one of the last two, it reads the reference a declared `Coop` reads: `CoopTicker`, a worker's
 * timer, and `Game.Frames`, animation frames. Its scope owns the current seat.
 */
export const testCoopClient = <LoadError = never>(
  parts: TestCoopParts<LoadError>,
  options: {
    readonly rooms: Rooms;
    readonly ticker?: Ticker;
    readonly frames?: FrameSource;
  }
): Effect.Effect<TestCoopClient<LoadError>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { ticker } = options;
    return yield* coopClient({
      ...parts,
      rooms: options.rooms,
      ticker: ticker === undefined ? yield* CoopTicker : Effect.succeed(ticker),
      frames: options.frames ?? (yield* Frames),
    });
  });
