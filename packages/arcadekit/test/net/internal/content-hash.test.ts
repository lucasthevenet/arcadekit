import { describe, expect, it } from "vitest";

import { contentHash } from "../../../src/net/internal/content-hash";

describe(contentHash, () => {
  it("is 8 hex digits, the same for the same content and different for different content", () => {
    const content = { heroes: [{ id: "spark" }], rules: { runLength: 60 } };
    const changed = { ...content, rules: { runLength: 61 } };
    const hash = contentHash(content);
    expect([
      /^[0-9a-f]{8}$/u.test(hash),
      contentHash(structuredClone(content)) === hash,
      contentHash(changed) === hash,
    ]).toStrictEqual([true, true, false]);
  });

  it("counts the order of the content's keys", () => {
    expect(contentHash({ a: 1, b: 2 })).not.toBe(contentHash({ b: 2, a: 1 }));
  });
});
