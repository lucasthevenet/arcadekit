import { Effect } from "effect";
import type { Scope } from "effect";

import { Frames } from "../../../game/browser";
import type {
  FrameSource,
  View as GameView,
  InputSource,
} from "../../../game/browser";
import type * as Game from "../../../game/index";
import { TestGame } from "../../testing/index";
import type * as Ticker from "../../ticker";
import type * as CoopClient from "../coop-client";
import type * as CoopRooms from "../coop-rooms";
import { CoopTicker } from "../coop-ticker";
import { coopClient } from "./coop-client";
import type { CoopParts, CoopPresented } from "./coop-client";

// The Co-op client of the test game (`arcadekit/net/testing`'s `TestGame`) from plain parts, with no
// declaration and no Layer: the kit's own client tests build many variants of one game, each
// with one part replaced (a hash that differs, content that fails to load, a view that throws).
// Test support, not exported from any entry: a game has one way to make a Co-op client, its
// `Coop`'s `layer`, and tests it over `FakeCoopRooms.layer(hub)`.

const nothing = (): void => undefined;

const ADD_ONE: TestGame.Input = { add: 1 };

/**
 * What the test game's attach makes: a view that draws nothing, and an input that adds 1 each
 * step while attached. Pass `view` or `input` to watch or replace either.
 */
export const testPresentation = (
  parts: Partial<CoopPresented<TestGame.State, TestGame.Input>> = {}
): CoopPresented<TestGame.State, TestGame.Input> => ({
  view: (): GameView<TestGame.State> => ({
    render: nothing,
    dispose: nothing,
  }),
  input: (): InputSource<TestGame.Input> => ({
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
    TestGame.Config,
    TestGame.State,
    Game.PlayerInputs<TestGame.Input>,
    TestGame.Event,
    TestGame.Command,
    TestGame.Refusals,
    TestGame.Content,
    LoadError
  >,
  "rooms" | "ticker" | "frames"
>;

export interface TestCoopOptions<LoadError = never> {
  /** The content each seat loads. Defaults to `TestGame.content`, at once. */
  readonly content?: Effect.Effect<
    TestGame.Content,
    { readonly message: string }
  >;
  /** What each attach makes. Defaults to `testPresentation()`, at once. */
  readonly presentation?: Effect.Effect<
    CoopPresented<TestGame.State, TestGame.Input>,
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
  simulation: TestGame.TestGame,
  hash: TestGame.hash,
  picks: (content) => content.picks,
  config: (content, picks) => ({ content, picks }),
  ends: new Set([TestGame.RunEnded.tag]),
  ...(options.maxPlayers === undefined
    ? {}
    : { maxPlayers: options.maxPlayers }),
  ...(options.lockstep === undefined ? {} : { lockstep: options.lockstep }),
  content: options.content ?? Effect.succeed(TestGame.content),
  presentation:
    options.presentation ??
    Effect.sync((): CoopPresented<TestGame.State, TestGame.Input> =>
      testPresentation()
    ),
});

/** The Co-op client of the test game, as an app drives it. */
export type TestCoopClient<LoadError = never> = CoopClient.CoopClient<
  TestGame.State,
  TestGame.Event,
  TestGame.Command,
  LoadError,
  TestGame.Refusals
>;

/**
 * The Co-op client of the test game, from its plain parts: over `rooms` (a `FakeCoopRooms`' `rooms`),
 * ticked by `ticker` (a `ManualTicker`'s `ticker`) and drawn on `frames` (`ManualFrames.make()`). Without
 * one of the last two, it reads the reference a declared `Coop` reads: `CoopTicker`, a worker's
 * timer, and `Game.Frames`, animation frames. Its scope owns the current seat.
 */
export const testCoopClient = <LoadError = never>(
  parts: TestCoopParts<LoadError>,
  options: {
    readonly rooms: CoopRooms.CoopRooms;
    readonly ticker?: Ticker.Ticker;
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
