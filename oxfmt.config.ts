import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Vendored: kept as upstream wrote it, so that an update is a plain copy.
  ignorePatterns: [...ultracite.ignorePatterns, "tooling/oxlint/anti-slop/**"],
});
