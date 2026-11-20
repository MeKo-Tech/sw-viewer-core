// Builds the npm package and, with --publish, tags the current commit and attaches the
// tarball to a GitHub Release. Apps depend on that release asset by URL:
//
//   node tools/release.ts            # dry run: writes dist/meko-tech-sw-viewer-core-<v>.tgz
//   node tools/release.ts --publish  # also tags v<version> and creates the GitHub Release
//
// Bump "version" in package.json and commit that first. Publishing needs a clean tree on
// main that matches origin/main, and the `gh` CLI.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publish = process.argv.includes("--publish");

const run = (cmd: string, args: string[], cwd = root) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${pkg.version}`;

if (publish) {
  if (run("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") throw new Error("publish from main");
  if (run("git", ["status", "--porcelain"]) !== "") throw new Error("working tree is not clean");
  run("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
  if (run("git", ["rev-parse", "HEAD"]) !== run("git", ["rev-parse", "origin/main"])) {
    throw new Error("HEAD does not match origin/main");
  }
  if (run("git", ["tag", "--list", tag]) !== "") throw new Error(`tag ${tag} exists; bump the version`);
}

const lib = join(root, "dist", "lib");
rmSync(lib, { recursive: true, force: true });
run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"]);

// The repo's package.json points the exports at the .ts sources; the package points them
// at the built files and drops everything that only matters for development.
const stage = join(root, "dist", "package");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// Plain read/write instead of cpSync: it keeps file modes, which some mounts refuse.
const copy = (from: string, to: string) => {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, readFileSync(from));
};
for (const f of readdirSync(lib, { recursive: true }) as string[]) {
  if (statSync(join(lib, f)).isFile()) copy(join(lib, f), join(stage, "lib", f));
}
copy(join(root, "src/react/sw-viewer.css"), join(stage, "lib/react/sw-viewer.css"));
copy(join(root, "README.md"), join(stage, "README.md"));
copy(join(root, "LICENSE"), join(stage, "LICENSE"));
const entry = (name: string) => ({ types: `./lib/${name}.d.ts`, default: `./lib/${name}.js` });
const { devDependencies, scripts, private: _private, ...rest } = pkg;
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      ...rest,
      repository: { type: "git", url: "git+https://github.com/MeKo-Tech/sw-viewer-core.git" },
      types: "./lib/index.d.ts",
      exports: {
        ".": entry("index"),
        "./worker": entry("worker"),
        "./three": entry("three/index"),
        "./react": entry("react/index"),
        "./sw-viewer.css": "./lib/react/sw-viewer.css",
      },
      sideEffects: ["./lib/worker.js", "*.css"],
    },
    null,
    2,
  )}\n`,
);

const file = run("npm", ["pack", "--silent", "--pack-destination", join(root, "dist")], stage).split("\n").pop()!;
const tgz = join(root, "dist", file);
console.log(`packed ${tgz}`);

if (publish) {
  const commit = run("git", ["rev-parse", "--short=12", "HEAD"]);
  run("git", ["tag", "-a", tag, "-m", `sw-viewer-core ${tag}`]);
  run("git", ["push", "origin", tag]);
  run("gh", ["release", "create", tag, tgz, "--title", tag, "--notes", `Built from ${commit}. Install with:\n\n` +
    `    "@meko-tech/sw-viewer-core": "https://github.com/MeKo-Tech/sw-viewer-core/releases/download/${tag}/${file}"`]);
  console.log(`released ${tag}`);
}
