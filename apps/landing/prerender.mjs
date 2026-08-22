import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { render } from "./dist/server/entry-server.js";

const template = readFileSync("dist/index.html", "utf-8");
const appHtml = render();

if (!template.includes('<div id="root"></div>')) {
  throw new Error("prerender: root placeholder not found in dist/index.html");
}

const html = template.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`);
writeFileSync("dist/index.html", html);
rmSync("dist/server", { recursive: true, force: true });
