// Module hooks that compile .tsx with rolldown's oxc transform (a vite dependency), so
// tests can render the React components with react-dom/server in plain Node.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/experimental";

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
  const path = fileURLToPath(url);
  const out = transformSync(path, await readFile(path, "utf8"), { jsx: { runtime: "automatic" } });
  if (out.errors?.length) throw new Error(`${path}: ${out.errors.map((e) => e.message).join("; ")}`);
  return { format: "module", source: out.code, shortCircuit: true };
}
