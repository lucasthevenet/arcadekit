// arcadekit/net/testing: test helpers for a Co-op game and its app. `FakeCoopRooms` stands in for
// the signalling worker and WebRTC, in memory; `ManualTicker` is a ticker the test drives;
// `PageTimers` gives a test on fake timers the Clock and scheduler of a page; and `TestGame` is a
// small game to run. Only tests import this entry; the root and ./browser don't export it. Frames
// come from `ManualFrames.make()` in "arcadekit/game/testing", provided as `Game.Frames`. It has
// no Co-op client of its own: a test makes one as an app does, from a `Coop`'s `layer`, over
// `FakeCoopRooms.layer(hub)`. Each module is a namespace.

export * as FakeCoopRooms from "./fake-coop-rooms";
export * as ManualTicker from "./manual-ticker";
export * as PageTimers from "./page-timers";
export * as TestGame from "./test-game";
