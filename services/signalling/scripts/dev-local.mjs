// Runs the signalling worker's routes locally (src/local.ts), for co-op with no Cloudflare:
//   pnpm --filter @gamekit/signalling dev:local
// SIGNALLING_PORT (default 8787) and SIGNALLING_HOST (default 127.0.0.1; 0.0.0.0 for the LAN)
// choose where it listens. Node runs the TypeScript sources by stripping their types; this hook
// lets their extensionless relative imports ("./room") find the .ts files.
import { registerHooks } from "node:module";

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (/^\.\.?\//u.test(specifier) && !/\.[cm]?[jt]s$/u.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Not a TypeScript module: resolve it as written.
      }
    }
    return nextResolve(specifier, context);
  },
});

const { startLocalSignalling } = await import("../src/local.ts");

const signalling = await startLocalSignalling({
  port: Number(process.env.SIGNALLING_PORT ?? 8787),
  host: process.env.SIGNALLING_HOST ?? "127.0.0.1",
});
console.log(`Local signalling at ${signalling.url}`);

const stop = async () => {
  await signalling.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
