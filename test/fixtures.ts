// Optional sample files that are not committed (company parts). Point SW_VIEWER_FIXTURES
// at a folder with the CAD-Viewer-Projekt test data (testdaten/solidworks); tests that
// need them skip otherwise.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const fixturesDir = process.env.SW_VIEWER_FIXTURES;

export const haveFixture = (name: string) => !!fixturesDir && existsSync(join(fixturesDir, name));

export const readFixture = (name: string) => {
  if (!fixturesDir) throw new Error("SW_VIEWER_FIXTURES not set");
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
};

export const skipUnless = (...names: string[]) =>
  names.every(haveFixture) ? false : `fixtures missing (set SW_VIEWER_FIXTURES): ${names.join(", ")}`;
