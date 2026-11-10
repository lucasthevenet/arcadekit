// Draws the site's two PNGs from its mark, public/favicon.svg, in headless Chromium:
// - public/apple-touch-icon.png, the icon iOS shows for a bookmark on the home screen;
// - public/og.png, the card a shared link shows.
// They are committed, so building the site needs no browser. Run this after changing the mark:
//
//   pnpm --filter @arcadekit/docs images
//
// It needs Playwright's Chromium: `pnpm exec playwright install chromium`.
import { readFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

const publicDir = path.resolve(import.meta.dirname, "..", "public");
const mark = readFileSync(path.join(publicDir, "favicon.svg"), "utf-8");
const markUrl = `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`;

const BACKGROUND = "#17151f";

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
        <img src="${markUrl}" alt="" />
        <div>
          <h1>arcadekit</h1>
          <p>Primitives for browser games</p>
          <small>arcadekit.dev</small>
        </div>
      </main>`,
      `body {
        background: radial-gradient(circle at 20% 45%, #2b2350, ${BACKGROUND} 60%);
        color: #f4f2ff;
        font-family: system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
      }
      main { display: flex; align-items: center; gap: 72px; height: 100%; padding: 0 96px; box-sizing: border-box; }
      img { width: 288px; height: 288px; border-radius: 54px; box-shadow: 0 0 0 4px #3a3160; }
      h1 { margin: 0; font-size: 112px; line-height: 1; letter-spacing: -3px; }
      p { margin: 24px 0 0; font-size: 46px; color: #cfc9e6; }
      small { display: block; margin-top: 40px; font-size: 32px; color: #ffd23f; }`
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
