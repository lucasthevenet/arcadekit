// Makes Vite and Vitest resolve the kit packages to their src/ files (ADR-0016), so the
// workspace needs no build. Each kit package's `exports` lists a "source" condition first;
// this puts "source" first in every environment's resolve.conditions: the browser client,
// Vitest's Node tests and the demo's Cloudflare worker.
import { defaultClientConditions, defaultServerConditions } from "vite";
import type { Plugin } from "vite";

export const sourceCondition = (): Plugin => ({
  name: "arcadekit:source-condition",
  // After other plugins, so an environment a plugin adds (the worker) gets it too.
  enforce: "post",
  configEnvironment(name, config) {
    const consumer =
      config.consumer ?? (name === "client" ? "client" : "server");
    const conditions =
      config.resolve?.conditions ??
      (consumer === "client"
        ? defaultClientConditions
        : defaultServerConditions);
    config.resolve ??= {};
    config.resolve.conditions = [
      "source",
      ...conditions.filter((condition) => condition !== "source"),
    ];
  },
});
