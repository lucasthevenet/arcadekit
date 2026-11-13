// arcadekit/save: what a game keeps between sessions, each part declared (ADR-0020). `Save` and
// `Setting` are builders a game writes bare, with their types; what their services give is the
// namespace `Stored`. Effect, but for its data and what a game hands a declaration: a save's
// merge by id, its `mergeRecord` and a setting's `merge` are plain functions, called inside a
// write.

export {
  type Records,
  Save,
  type SaveClass,
  type SaveDefinition,
  type SaveId,
  type SaveService,
} from "./save";
export {
  Setting,
  type SettingClass,
  type SettingDefinition,
  type SettingId,
  type SettingService,
} from "./setting";
export * as Stored from "./stored";
