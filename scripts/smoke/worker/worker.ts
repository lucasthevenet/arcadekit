// A Worker over arcadekit/net/worker, checked with Cloudflare's Workers types and no DOM
// (tsconfig.worker.json). That project skips the check of library type files, so the two
// expected errors below are what show that the entry's types arrived whole: with a type that
// had fallen back to `any`, neither line would be an error, and the unused directive would fail.
import { SignallingWorker } from "arcadekit/net/worker";

export class SignallingRoom extends SignallingWorker.room({ roomSize: 8 }) {}

const worker = SignallingWorker.make({ rooms: "ROOMS", assets: "ASSETS" });

interface Env {
  readonly ROOMS: DurableObjectNamespace<SignallingRoom>;
  readonly ASSETS: Fetcher;
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    worker.fetch(request, env),
} satisfies ExportedHandler<Env>;

export const withoutBindings = (request: Request): Promise<Response> =>
  // @ts-expect-error -- the env must hold both bindings.
  worker.fetch(request, { ROOMS: undefined });

// @ts-expect-error -- the room size is a number.
SignallingWorker.room({ roomSize: "8" });
