// Document properties from the Office-style XML entries of a SolidWorks 2015+ file:
// docProps/custom.xml (user custom properties), docProps/ISolidWorksInformation.xml
// (SolidWorks-maintained values such as SW-Author or the sheet scale) and
// docProps/core.xml (title, creator, dates). Same sources as parseProps in MeKo's
// CAD-Viewer-Projekt (src/sw.js), read with our own XML reader (no DOMParser in workers).

import type { SwContainer } from "./container.ts";
import { findAll, parseXml, textContent } from "./xml.ts";

/** Earlier sources win when two define the same name. */
export const PROPERTY_SOURCES = [
  "docProps/custom.xml",
  "docProps/ISolidWorksInformation.xml",
  "docProps/core.xml",
] as const;

/**
 * Sets an own, enumerable property, also for names like `__proto__` (a plain
 * assignment would change the prototype or be ignored).
 */
const setOwn = (out: Record<string, string>, name: string, value: string) =>
  Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });

/** `<property name="…"><vt:lpstr>value</vt:lpstr><FPVals>…</FPVals></property>` → name → value.
 *  The value is the first typed child; FPVals (the unevaluated expression) is skipped.
 *  Unnamed entries and internal `_PID_*` blobs are left out. */
export const readPropertyList = (xml: Uint8Array | string, out: Record<string, string> = {}) => {
  const root = parseXml(xml);
  if (!root) return out;
  for (const p of findAll(root, "property")) {
    const name = p.attributes.name?.trim();
    if (!name || name.startsWith("_PID_") || Object.hasOwn(out, name)) continue;
    const valueEl = p.children.find((c) => c.localName !== "FPVals");
    const value = (valueEl ? textContent(valueEl) : p.text).trim();
    if (value) setOwn(out, name, value);
  }
  return out;
};

/** core.xml: every child element of the root, by local name (`title`, `creator`, `created`). */
export const readCoreProperties = (xml: Uint8Array | string, out: Record<string, string> = {}) => {
  const root = parseXml(xml);
  if (!root) return out;
  for (const el of root.children) {
    const value = textContent(el).trim();
    if (value && !Object.hasOwn(out, el.localName)) setOwn(out, el.localName, value);
  }
  return out;
};

/** All document properties, or undefined when the file has none (e.g. OLE2 parts). */
export const readProperties = async (c: SwContainer): Promise<Record<string, string> | undefined> => {
  const out: Record<string, string> = {};
  for (const source of PROPERTY_SOURCES) {
    const entry = c.entries.find((e) => e.name === source);
    if (!entry?.size) continue;
    const bytes = await entry.read().catch(() => undefined);
    if (!bytes) continue;
    if (source.endsWith("core.xml")) readCoreProperties(bytes, out);
    else readPropertyList(bytes, out);
  }
  return Object.keys(out).length ? out : undefined;
};
