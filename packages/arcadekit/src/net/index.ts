/**
 * The `arcadekit/net` entry point: a game played on several machines.
 *
 *   import { Session, Transport } from "arcadekit/net"
 *
 *   const session = yield* Session.make(Duel, { seed, me, others, delta: 1 / 60 })
 *   yield* Driver.frames(yield* Transport.connect(session))
 *
 * Each module is also an entry of its own, such as `arcadekit/net/Session`,
 * for a program that wants only that module. A relay server imports
 * `arcadekit/net/Relay`, and loads no session.
 *
 * - `Session`: one peer of a game, with the app it makes and steps.
 * - `Transport`: what carries a session's messages to the other peers.
 * - `Relay`: the rules of a server that passes messages on between peers.
 * - `Message`: what peers send each other, and its form in bytes.
 * - `Drift`: peers that are no longer playing the same game.
 * - `Peer`: a session without its app, which a driver steps.
 */
export * as Drift from "./Drift";
export * as Message from "./Message";
export * as Peer from "./Peer";
export * as Relay from "./Relay";
export * as Session from "./Session";
export * as Transport from "./Transport";
