// Test helpers for a Co-op game and its app: fake rooms in place of the signalling worker and
// WebRTC, a ticker the test drives, and a small game to run. Only tests should import this
// entry; the root and ./browser don't export it. Frames come from `manualFrames()` in
// "arcadekit/runtime/testing".

export {
  FAKE_JOIN_CODE,
  type FakeCoopRooms,
  fakeCoopRooms,
} from "./fake-rooms";
export { manualTicker } from "./manual-ticker";
export {
  type TestAnswer,
  type TestConfig,
  type TestContent,
  type TestCoop,
  type TestCoopGameOptions,
  type TestEvent,
  type TestInput,
  type TestLocalEvent,
  type TestState,
  hashTestState,
  testContent,
  testCoopGame,
  testCoopRules,
  testPresentation,
  testSimulation,
} from "./test-game";
