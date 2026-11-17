import { markdownToHtml } from "satteri";
import { describe, expect, it } from "vitest";

import { namePieces, tableNames } from "./tables.ts";

describe("a name in a table's cell", () => {
  it("may break after each slash", () => {
    expect(namePieces("arcadekit/net/worker")).toStrictEqual([
      "arcadekit/",
      "net/",
      "worker",
    ]);
    expect(namePieces("EngineEntry.make")).toStrictEqual(["EngineEntry.make"]);
  });

  it("is rendered with its breaks, and escaped", () => {
    const { html } = markdownToHtml(
      "A `src/core` path.\n\n| Entry `a/b` | Uses |\n| --- | --- |\n| [`arcadekit/net/worker`](worker.md) | `Pool<T>/x` |\n",
      { hastPlugins: [tableNames] }
    );
    expect(html).toContain("<code>arcadekit/<wbr>net/<wbr>worker</code>");
    expect(html).toContain("<code>Pool&lt;T&gt;/<wbr>x</code>");
    // Not in a paragraph, and not in a table's heading.
    expect(html).toContain("<code>src/core</code>");
    expect(html).toContain("<code>a/b</code>");
  });
});
