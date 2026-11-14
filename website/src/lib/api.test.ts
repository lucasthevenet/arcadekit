import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseDoc, readApi, renderExports } from "./api.ts";
import type { Entry } from "./api.ts";

/** A small package, written as the kit is: an entry of namespaces, and one of declarations. */
const FILES: Readonly<Record<string, string>> = {
  "src/dice/index.ts": `// arcadekit/dice: dice a step rolls.

export * as Die from "./die";
`,
  "src/dice/die.ts": `/**
 * Dice: the faces a step rolls.
 *
 * @since 0.1.0
 */

/**
 * A die.
 *
 * @category models
 * @since 0.1.0
 */
export interface Die {
  /** How many faces it has. */
  readonly faces: number;
}

/**
 * Makes a die.
 *
 * **Example** (A six)
 *
 * \`\`\`ts
 * Die.make(6).faces; // => 6
 * \`\`\`
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (faces: number): Die => ({ faces });

/**
 * Checks for a die.
 *
 * @category guards
 * @since 0.2.0
 */
export const isDie = (value: unknown): value is Die =>
  typeof value === "object" && value !== null && "faces" in value;
`,
  "src/table/index.ts": `/**
 * \`arcadekit/table\`: a table, imported whole as \`Table\`.
 *
 * @since 0.1.0
 */
import { make as makeSeat } from "./seat";

export { type Seat } from "./seat";

/**
 * Declares a seat.
 *
 * @category declarations
 * @since 0.1.0
 */
export const Seat: typeof makeSeat = makeSeat;
`,
  "src/table/seat.ts": `/**
 * A seat at a table.
 *
 * @category models
 * @since 0.1.0
 */
export interface Seat {
  readonly name: string;
}

/**
 * Makes a seat.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (name: string): Seat => ({ name });
`,
  "src/table/browser.ts": `// arcadekit/table/browser: the table, and its cloth.

export { Seat } from "./index";
export { type Seat as SeatType } from "./seat";

/**
 * The cloth on the table.
 *
 * @category models
 * @since 0.1.0
 */
export const cloth: string = "green";
`,
};

describe("the API reference", () => {
  let root = "";
  let api: Entry[] = [];
  const entry = (name: string) => api.find((item) => item.entry === name);

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "arcadekit-api-"));
    for (const [file, text] of Object.entries(FILES)) {
      const at = path.join(root, "kit", file);
      mkdirSync(path.dirname(at), { recursive: true });
      writeFileSync(at, text);
    }
    api = readApi(root, "kit", {
      dice: "./src/dice/index.ts",
      table: "./src/table/index.ts",
      "table/browser": "./src/table/browser.ts",
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("the API", () => {
    it("reads each namespace of an entry as a module, with its exports by name", () => {
      const dice = entry("dice");
      expect(dice?.comment).toBe("arcadekit/dice: dice a step rolls.");
      expect(dice?.exports).toStrictEqual([]);
      const [die] = dice?.modules ?? [];
      expect({
        name: die?.name,
        file: die?.file,
        comment: die?.comment,
        exports: die?.exports.map((item) => item.name),
      }).toStrictEqual({
        name: "Die",
        file: "kit/src/dice/die.ts",
        comment: "Dice: the faces a step rolls.",
        exports: ["Die", "isDie", "make"],
      });
    });

    it("gives each export its signature, as a declaration file has it, and its doc comment", () => {
      const die = entry("dice")?.modules[0];
      const make = die?.exports.find((item) => item.name === "make");
      expect(make?.parts).toStrictEqual([
        {
          signature: "const make: (faces: number) => Die;",
          doc: {
            body: "Makes a die.\n\n**Example** (A six)\n\n```ts\nDie.make(6).faces; // => 6\n```",
            category: "constructors",
            since: "0.1.0",
          },
        },
      ]);
      const model = die?.exports.find((item) => item.name === "Die");
      expect(model?.parts[0]?.signature).toBe(
        "interface Die {\n  /** How many faces it has. */\n  readonly faces: number;\n}"
      );
    });

    it("shows a declaration exported under another name with its own signature", () => {
      const seat = entry("table")?.exports.find((item) => item.name === "Seat");
      // The value, whose signature is the function it names, and the type of the same name.
      expect(seat?.parts.map((part) => part.signature)).toStrictEqual([
        "const Seat: (name: string) => Seat;",
      ]);
      expect(seat?.parts[0]?.doc?.body).toBe("Declares a seat.");
      expect(
        entry("table")
          ?.exports.map((item) => item.name)
          .toSorted()
      ).toStrictEqual(["Seat"]);
    });

    it("leaves out of a sub-entry what it re-exports from the entry above it", () => {
      const browser = entry("table/browser");
      expect(browser?.extends).toBe("table");
      // By name, whatever its case.
      expect(browser?.exports.map((item) => item.name)).toStrictEqual([
        "cloth",
        "SeatType",
      ]);
      expect(entry("table")?.extends).toBeUndefined();
    });
  });

  describe("a doc comment", () => {
    it("is its text without its tags, and the category and version it names", () => {
      expect(
        parseDoc(
          "Rolls.\n\n**When to use**\n\nOnce a step.\n\n@category mutations\n@since 0.3.0"
        )
      ).toStrictEqual({
        body: "Rolls.\n\n**When to use**\n\nOnce a step.",
        category: "mutations",
        since: "0.3.0",
      });
    });
  });

  describe("the exports as markdown", () => {
    it("lists them by category, in the skill's order, each with its signature, text and version", () => {
      const die = entry("dice")?.modules[0];
      expect(renderExports(die?.exports ?? [], 2)).toBe(
        [
          "## Models",
          "### Die",
          "```ts\ninterface Die {\n  /** How many faces it has. */\n  readonly faces: number;\n}\n```",
          "A die.",
          "Since 0.1.0.",
          "## Constructors",
          "### make",
          "```ts\nconst make: (faces: number) => Die;\n```",
          "Makes a die.\n\n**Example** (A six)\n\n```ts\nDie.make(6).faces; // => 6\n```",
          "Since 0.1.0.",
          "## Guards",
          "### isDie",
          "```ts\nconst isDie: (value: unknown) => value is Die;\n```",
          "Checks for a die.",
          "Since 0.2.0.",
        ].join("\n\n")
      );
    });

    it("starts at the depth it is given", () => {
      const die = entry("dice")?.modules[0];
      expect(renderExports(die?.exports ?? [], 3)).toMatch(
        /^### Models\n\n#### Die\n/u
      );
    });
  });
});
