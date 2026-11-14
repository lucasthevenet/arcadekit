import { SignallingWorker } from "arcadekit/net/worker";

/**
 * The survivors demo's Worker (#25, ADR-0012): it serves the site's files and is co-op's
 * signalling worker, which is the kit's (`arcadekit/net/worker`). `alchemy.run.ts` declares the
 * Worker, routes only the signalling paths to it ahead of the assets, and binds `ROOMS`; Alchemy
 * supplies `ASSETS`.
 */

/** One join code's room, of up to 4 players (the kit's default room size). */
export class SignallingRoom extends SignallingWorker.room() {}

export default SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });
