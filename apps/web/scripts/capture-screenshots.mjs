import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";
import { preview } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "public", "screenshots");
await fs.mkdir(outputDir, { recursive: true });

const server = await preview({
  root,
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});

let browser;
try {
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });

  const pages = [
    ["settings", "01-fixed-url.png"],
    ["chat", "02-mobile-chat.png"],
    ["workspaces", "03-workspaces-threads.png"],
    ["attachments", "04-attachments-queue.png"],
    ["git", "05-git-push.png"],
  ];

  for (const [mode, filename] of pages) {
    await page.goto(`http://127.0.0.1:4173/?demo=${mode}`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`${mode} has ${overflow}px horizontal overflow`);
    await page.screenshot({ path: path.join(outputDir, filename), fullPage: false });
    console.log(`Captured ${filename}`);
  }
} finally {
  await browser?.close();
  await server.close();
}
