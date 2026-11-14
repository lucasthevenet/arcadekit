import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findBrokenLinks } from "./dead-links.ts";

const sites: string[] = [];

/** A built site in a folder of its own: each file's path and its text. */
const builtSite = (files: Readonly<Record<string, string>>) => {
  const dist = mkdtempSync(path.join(tmpdir(), "arcadekit-site-"));
  sites.push(dist);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    writeFileSync(path.join(dist, file), text);
  }
  return dist;
};

const page = (body: string) =>
  `<!doctype html><html><body>${body}</body></html>`;

describe("the built site's links", () => {
  afterEach(() => {
    for (const dist of sites.splice(0)) {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("are whole when each goes to a page, a file or an anchor that exists", () => {
    const dist = builtSite({
      "index.html": page(
        '<a href="/core">core</a> <a href="/net/worker#abuse">abuse</a> <a href="#install">install</a> <h2 id="install">Install</h2> <a href="/favicon.svg">mark</a>'
      ),
      "core/index.html": page(
        '<a href="/">home</a> <a href="/net/worker/">worker</a>'
      ),
      "net/worker/index.html": page('<h2 id="abuse">Abuse</h2>'),
      "favicon.svg": "<svg/>",
    });
    expect(findBrokenLinks(dist)).toStrictEqual([]);
  });

  it("are broken when a page or an anchor is missing, named by the page they are on", () => {
    const dist = builtSite({
      "index.html": page(
        '<a href="/nope">nope</a> <a href="/core#gone">gone</a>'
      ),
      "core/index.html": page('<a href="#here">here</a>'),
    });
    expect(findBrokenLinks(dist)).toStrictEqual([
      { page: "/", href: "/nope", reason: "no page has this address" },
      {
        page: "/",
        href: "/core#gone",
        reason: '/core has no heading or anchor "gone"',
      },
      {
        page: "/core",
        href: "#here",
        reason: '/core has no heading or anchor "here"',
      },
    ]);
  });

  it("read an address and an anchor as the browser does", () => {
    const dist = builtSite({
      "index.html": page(
        '<a href="/core?plain=1#caf%C3%A9">café</a> <a href="/core#a&amp;b">a&amp;b</a>'
      ),
      "core/index.html": page(
        '<h2 id="café">Café</h2> <h2 id="a&amp;b">a&amp;b</h2>'
      ),
    });
    expect(findBrokenLinks(dist)).toStrictEqual([]);
  });

  it("leave links to other sites alone", () => {
    const dist = builtSite({
      "index.html": page(
        '<a href="https://github.com/x/y#nothing">gh</a> <a href="//example.com/x">x</a> <a href="mailto:a@b.c">mail</a>'
      ),
    });
    expect(findBrokenLinks(dist)).toStrictEqual([]);
  });
});
