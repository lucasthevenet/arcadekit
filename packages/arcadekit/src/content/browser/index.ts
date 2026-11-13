// arcadekit/content/browser: the content sources that need `fetch`, a browser's or another
// runtime's. Kept out of the root entry, so a genre's simulation and content Schema are checked
// with no DOM types (ADR-0002). The module is a namespace.

export * as FetchContentSource from "./fetch-content-source";
