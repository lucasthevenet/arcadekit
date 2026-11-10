import { Content } from "arcadekit/content";

import { GameContent } from "./schema";

/**
 * A survivors game's content: the content Schema, which also checks that every reference names
 * something that exists, and the file each part comes from. The app provides it from its content
 * source (`SurvivorsContent.layer(source)`), and anything loads it with `SurvivorsContent.load`:
 * the first success is kept, and a failed load can be retried. A test reads a game's real files
 * with `SurvivorsContent.read(source)`, which runs the same checks.
 */
export class SurvivorsContent extends Content("SurvivorsContent", {
  schema: GameContent,
  // Paths are relative to the content source.
  files: {
    rules: "rules.json",
    heroes: "heroes.json",
    enemies: "enemies.json",
    weapons: "weapons.json",
    passives: "passives.json",
    waves: "waves.json",
  },
}) {}
