// Render every src/*.html to pdf/*.pdf with the preinstalled Chromium.
// Usage: node lead-magnets/render.mjs [name ...]
import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const want = process.argv.slice(2);
const files = readdirSync(join(here, "src")).filter(f => f.endsWith(".html") && (!want.length || want.includes(basename(f, ".html"))));
const browser = await chromium.launch();
for (const f of files) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(here, "src", f)).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const out = join(here, "pdf", f.replace(/\.html$/, ".pdf"));
  await page.pdf({ path: out, format: "A4", printBackground: true, preferCSSPageSize: true, tagged: true, outline: true });
  console.log("wrote", out);
  await page.close();
}
await browser.close();
