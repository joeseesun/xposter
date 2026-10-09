const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const files = ["manifest.json", "sidepanel.html", "sidepanel.css", "sidepanel.js", "diagnostics.html", "diagnostics.css", "diagnostics.js", "src", "vendor", "assets", "_locales", "fixtures", "LICENSE"];
const out = path.join(root, "dist", `xposter-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
execFileSync("zip", ["-qr", out, ...files], { cwd: root });
const entries = execFileSync("unzip", ["-Z1", out], { encoding: "utf8" });
for (const required of ["src/qiaomu-blog.js", "vendor/turndown.js", "vendor/turndown-plugin-gfm.js", "vendor/turndown.LICENSE", "vendor/turndown-plugin-gfm.LICENSE"]) {
  if (!entries.split("\n").includes(required)) throw new Error(`Missing release file: ${required}`);
}
if (/node_modules|config\.json|\.env|package-lock/.test(entries)) throw new Error("Unexpected private/development file in archive");
console.log(`Packaged ${out}`);
