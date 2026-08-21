// Extracts every <script> block from the project's HTML pages and parses it as
// an ES module, so a syntax error fails loudly instead of at page load.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const publicDir = process.argv[2] ?? "public";
const tmp = join(process.argv[3] ?? tmpdir(), "jlpt-syntax-check");
mkdirSync(tmp, { recursive: true });

let failures = 0;
for (const file of readdirSync(publicDir).filter(f => f.endsWith(".html"))) {
  const html = readFileSync(join(publicDir, file), "utf8");
  // A classic <script> parses as a sloppy-mode script; type="module" parses as
  // strict-mode ESM. Node picks the goal from the extension, so match it.
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map(m => ({ isModule: /type\s*=\s*["']?module/i.test(m[1]), src: m[2] }))
    .filter(b => b.src.trim());

  blocks.forEach(({ isModule, src }, i) => {
    const out = join(tmp, `${file}.${i}.${isModule ? "mjs" : "js"}`);
    writeFileSync(out, src);
    try {
      execFileSync(process.execPath, ["--check", out], { stdio: "pipe" });
    } catch (e) {
      failures++;
      console.log(`FAIL ${file} block#${i}`);
      console.log(String(e.stderr).split("\n").slice(0, 12).join("\n"));
    }
  });
  console.log(`  ok  ${file} (${blocks.length} script block${blocks.length === 1 ? "" : "s"})`);
}

console.log(failures ? `\n${failures} block(s) failed to parse` : "\nAll script blocks parse cleanly.");
process.exit(failures ? 1 : 0);
