---
"arcadekit": patch
---

The reference of `arcadekit/net/Session` and of `session.confirmed` says what the frame stage does in a session that runs ahead: it hears each event once however often a rewind runs its tick, it has already drawn and played what a prediction did, and its change queries visit everything after each rewind. A frame system that must show only final ticks checks `session.confirmed`. Nothing breaks.
