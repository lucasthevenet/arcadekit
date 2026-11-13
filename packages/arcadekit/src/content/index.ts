// arcadekit/content: what a game is played with and drawn from, each declared and loaded once per
// app (ADR-0020). `Content` and `Asset` are builders a game writes bare, with their types; where
// a content's files come from is the namespace `ContentSource`. Effect, but for what a game hands
// a declaration: its `validate` and its `release` are plain functions, called inside a load.

export {
  Asset,
  type AssetClass,
  type AssetId,
  type AssetService,
  type Loaded,
} from "./asset";
export {
  Content,
  type ContentClass,
  type ContentDefinition,
  type ContentId,
  type ContentService,
} from "./content";
export * as ContentSource from "./content-source";
