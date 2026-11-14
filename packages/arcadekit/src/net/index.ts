// arcadekit/net: lockstep multiplayer, DOM-free. Every peer steps the same `Game.Simulation` on the
// inputs the host confirms for each step (ADR-0012). A `LockstepSession` is a host of the
// simulation, as `Game.Loop` is, ticked by its caller and talking through a `Transport`; a
// `ScopedLockstepSession` is one an Effect program's scope owns, run on the Clock or a `Ticker`;
// a `MemoryNetwork` is the in-memory transport for tests. Plain where a tick runs (ADR-0024): it
// decides each step's input and runs the steps, in the call that ticks it. The WebRTC transport,
// the signalling client and the `Coop` declaration are in ./browser. Each module is a namespace.

export * as LockstepSession from "./lockstep-session";
export * as MemoryNetwork from "./memory-network";
export * as ScopedLockstepSession from "./scoped-lockstep-session";
export * as Ticker from "./ticker";
export * as Transport from "./transport";
