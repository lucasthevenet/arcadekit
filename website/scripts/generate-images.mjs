// Draws the site's two PNGs from its mark, public/favicon.svg, in headless Chromium:
// - public/apple-touch-icon.png, the icon iOS shows for a bookmark on the home screen;
// - public/og.png, the card a shared link shows, in the site's look (src/styles/custom.css): the
//   landing page's title in the display face, with its last word in pink.
// They are committed, so building the site needs no browser. Run this after changing the mark or
// the site's look:
//
//   pnpm --filter @arcadekit/website images
//
// It needs Playwright's Chromium: `pnpm exec playwright install chromium`.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { chromium } from "playwright";

const publicDir = path.resolve(import.meta.dirname, "..", "public");
const mark = readFileSync(path.join(publicDir, "favicon.svg"), "utf-8");
const markUrl = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

// The site's palette (src/styles/custom.css).
const BACKGROUND = "#090b0e";
const TEXT = "#f2f0e8";
const MUTED = "#8e99a4";
const LIME = "#c9ff3d";
const PINK = "#ff3f68";
const RAMP = ["#c9ff3d", "#9fe557", "#e6cf48", "#ff9b45", "#ff684f", "#ff3f68"];

// The site's faces, from the packages it serves them from, embedded in the page Chromium draws.
const require = createRequire(import.meta.url);
const font = (family, weight, file) => {
  const data = readFileSync(require.resolve(file)).toString("base64");
  return `@font-face { font-family: "${family}"; font-weight: ${weight}; src: url(data:font/woff2;base64,${data}) format("woff2"); }`;
};
const FONTS = [
  font(
    "Barlow Condensed",
    700,
    "@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2"
  ),
  font(
    "IBM Plex Mono",
    600,
    "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2"
  ),
].join("\n");

const page = (body, css) => `<!doctype html>
<html>
  <head>
    <style>
      html, body { margin: 0; height: 100%; background: ${BACKGROUND}; }
      img { image-rendering: pixelated; }
      ${css}
    </style>
  </head>
  <body>${body}</body>
</html>`;

const IMAGES = [
  {
    file: "apple-touch-icon.png",
    width: 180,
    height: 180,
    // iOS rounds the corners itself, so the mark fills the square.
    html: page(
      `<img src="${markUrl}" alt="" />`,
      "img { display: block; width: 100%; height: 100%; }"
    ),
  },
  {
    file: "og.png",
    width: 1200,
    height: 630,
    html: page(
      `<main>
        <header><img src="${markUrl}" alt="" /><span>ARCADE<b>//</b>KIT</span></header>
        <h1>Primitives for browser <em>games.</em></h1>
        <footer><span>Effect 4 · Foldkit · Three.js</span><span>arcadekit.dev</span></footer>
        <div class="ramp">${RAMP.map((colour) => `<i style="background: ${colour}"></i>`).join("")}</div>
      </main>`,
      `${FONTS}
      body {
        background:
          radial-gradient(900px 520px at 100% 0%, rgb(255 63 104 / 16%), transparent 70%),
          radial-gradient(700px 460px at 0% 100%, rgb(201 255 61 / 7%), transparent 70%),
          ${BACKGROUND};
        color: ${TEXT};
      }
      main { position: relative; display: flex; flex-direction: column; height: 100%; padding: 64px 80px; box-sizing: border-box; }
      header { display: flex; align-items: center; gap: 20px; font: 600 28px "IBM Plex Mono"; letter-spacing: 1px; }
      header img { width: 56px; height: 56px; }
      b { color: ${LIME}; font-weight: 600; }
      h1 { margin: auto 0; font: 700 148px/0.86 "Barlow Condensed"; text-transform: uppercase; }
      em { font-style: normal; color: ${PINK}; }
      footer { display: flex; justify-content: space-between; font: 600 24px "IBM Plex Mono"; letter-spacing: 3px; text-transform: uppercase; color: ${MUTED}; }
      .ramp { position: absolute; inset: 0 0 auto; display: flex; height: 8px; }
      .ramp i { flex: 1; }`
    ),
  },
];

const browser = await chromium.launch();
try {
  await Promise.all(
    IMAGES.map(async (image) => {
      const tab = await browser.newPage({
        viewport: { width: image.width, height: image.height },
      });
      await tab.setContent(image.html, { waitUntil: "load" });
      await tab.screenshot({ path: path.join(publicDir, image.file) });
      console.log(`Wrote public/${image.file}`);
    })
  );
} finally {
  await browser.close();
}
