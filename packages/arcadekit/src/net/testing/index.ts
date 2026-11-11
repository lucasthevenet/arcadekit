// Test helpers for a Co-op game and its app: fake rooms in place of the signalling worker and
// WebRTC, a ticker the test drives, and a small game to run. Only tests should import this
// entry; the root and ./browser don't export it. Frames come from `manualFrames()` in
// "arcadekit/runtime/testing", provided as `Game.Frames`.

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
  type TestCoopClient,
  type TestCoopOptions,
  type TestCoopParts,
  type TestEvent,
  TestGame,
  type TestInput,
  type TestRefusals,
  type TestState,
  hashTestState,
  testContent,
  testCoopClient,
  testCoopParts,
  testPresentation,
} from "./test-game";
