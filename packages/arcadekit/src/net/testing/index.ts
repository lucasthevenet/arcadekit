// Test helpers for a Co-op game and its app: fake rooms in place of the signalling worker and
// WebRTC, a ticker the test drives, and a small game to run. Only tests should import this
// entry; the root and ./browser don't export it. Frames come from `manualFrames()` in
// "arcadekit/runtime/testing", provided as `Game.Frames`. It has no Co-op client of its own: a
// test makes one as an app does, from a `Coop`'s `layer`, over `fakeCoopRooms().layer`.

export {
  FAKE_JOIN_CODE,
  type FakeCoopRooms,
  fakeCoopRooms,
} from "./fake-rooms";
export { manualTicker } from "./manual-ticker";
export {
  AnswerOffer,
  HoldPause,
  NothingOwed,
  OfferOpened,
  RunEnded,
  Score,
  type TestCommand,
  type TestConfig,
  type TestContent,
  type TestEvent,
  TestGame,
  type TestInput,
  type TestRefusals,
  type TestState,
  hashTestState,
  testContent,
} from "./test-game";
