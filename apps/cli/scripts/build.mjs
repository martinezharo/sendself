/**
 * Bundle the CLI into one self-contained file, so installing it on a server is
 * copying (or linking) `dist/sendself.mjs` onto the PATH — no workspace, no
 * node_modules, nothing to build there.
 */

import { chmod, readFile } from "node:fs/promises";
import { build } from "esbuild";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const outfile = new URL("../dist/sendself.mjs", import.meta.url).pathname;

await build({
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    // `qrcode` is CommonJS and still calls `require` for its own modules.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __SENDSELF_CLI_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "warning",
});
await chmod(outfile, 0o755);
console.log(`Built ${outfile}`);
