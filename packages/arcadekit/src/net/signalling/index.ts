// arcadekit/net/signalling: the signalling protocol, the JSON messages a lockstep run's peers and
// the signalling worker exchange over one WebSocket each while the peers set up their WebRTC
// connections (#25). It is the interface between the worker (`arcadekit/net/worker`)
// and the browser's signalling client (`arcadekit/net/browser`), so it has no DOM and needs
// nothing but `effect`. Each message is an Effect Schema with bounded fields, and its type is the
// Schema's. Plain on purpose: Schemas, their constants, and the data work that reads
// them. Each module is a namespace.
//
// A host opens `wss://<worker>/host` and is told its join code in `welcome`. Each guest opens
// `wss://<worker>/join/<code>`. In the host star, the host signals every guest and each guest
// signals only the host: the worker relays `signal` messages between them and tells the host who
// joined and left. Once every data channel is open, the host sends `start`, which closes the room
// to new guests (there is no late join), and the peers close their sockets.

export * as ClientMessage from "./client-message";
export * as JoinCode from "./join-code";
export * as PeerId from "./peer-id";
export * as Room from "./room";
export * as ServerMessage from "./server-message";
export * as Signal from "./signal";
