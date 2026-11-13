// arcadekit/save/browser: the storage a save and a setting are kept in, in a browser. Kept out of
// the root entry, so the save logic is checked and tested with no DOM types (ADR-0002). The
// module is a namespace.

export * as BrowserSaveStorage from "./browser-save-storage";
