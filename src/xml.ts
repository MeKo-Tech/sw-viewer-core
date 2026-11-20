// Minimal XML reader for the small XML streams inside SolidWorks files
// (swXmlContents/COMPINSTANCETREE, docProps/*.xml). Web Workers have no DOMParser, so
// the decoder brings its own. Supports elements, attributes, text, CDATA and the
// predefined and numeric entities; skips comments, processing instructions and DOCTYPE.
// Not a validating parser: malformed input yields a best-effort tree or undefined.

export interface XmlElement {
  /** Qualified name as written, e.g. `cp:keywords`. */
  name: string;
  /** Name without namespace prefix, e.g. `keywords`. */
  localName: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Concatenated direct text content (entities decoded). */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export const decodeEntities = (s: string) =>
  s.indexOf("&") < 0
    ? s
    : s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
        if (e[0] === "#") {
          const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e] ?? m;
      });

const localNameOf = (name: string) => name.slice(name.indexOf(":") + 1);

/** Same set as the regex class `\s`. */
const isSpace = (c: number) =>
  (c >= 9 && c <= 13) ||
  c === 32 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;

/** Characters of an attribute name: anything but whitespace, `=`, `/` and `>`. */
const isNameChar = (c: number) => c !== 61 && c !== 47 && c !== 62 && !isSpace(c);

/**
 * Reads `name = "value"` / `name='value'` pairs from `body` starting at `from`, in one
 * linear pass. Matches what the regex `([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')` found with
 * global matching (junk between pairs is skipped), without its quadratic backtracking
 * on long tokens that are not followed by `=`.
 */
export const readAttributes = (body: string, from: number, out: Record<string, string>) => {
  const n = body.length;
  let i = from;
  while (i < n) {
    if (!isNameChar(body.charCodeAt(i))) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < n && isNameChar(body.charCodeAt(i))) i++;
    const nameEnd = i;
    let k = i;
    while (k < n && isSpace(body.charCodeAt(k))) k++;
    if (body.charCodeAt(k) !== 61) continue;
    k++;
    while (k < n && isSpace(body.charCodeAt(k))) k++;
    const q = body[k];
    if (q !== '"' && q !== "'") continue;
    const close = body.indexOf(q, k + 1);
    if (close < 0) continue;
    out[body.slice(nameStart, nameEnd)] = decodeEntities(body.slice(k + 1, close));
    i = close + 1;
  }
};

/** Hard cap on nesting, so crafted input cannot blow the stack in consumers that recurse. */
const MAX_DEPTH = 256;
/** Element cap; a stream with more elements is read up to here (treated as truncated). */
export const MAX_XML_ELEMENTS = 2_000_000;

/**
 * Parses `input` (string or UTF-8/UTF-16 bytes) and returns the root element. Stops
 * after `maxElements` elements (default `MAX_XML_ELEMENTS`) and returns what it read
 * so far, like for a truncated stream.
 */
export const parseXml = (
  input: string | Uint8Array,
  { maxElements = MAX_XML_ELEMENTS }: { maxElements?: number } = {},
): XmlElement | undefined => {
  const src = typeof input === "string" ? input : decodeXmlBytes(input);
  const root: XmlElement = { name: "", localName: "", attributes: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  let elements = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      top.text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
    } else if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      const name = src.slice(lt + 2, end < 0 ? src.length : end).trim();
      // Pop to the matching element; tolerate unclosed children.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? src.length : end + 1;
    } else {
      // Find the tag end outside quoted attribute values.
      let j = lt + 1;
      let quote = "";
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (j >= src.length) break;
      const selfClosing = src[j - 1] === "/";
      const body = src.slice(lt + 1, selfClosing ? j - 1 : j);
      const nameEnd = body.search(/[\s/]|$/);
      const name = body.slice(0, nameEnd);
      if (++elements > maxElements) break;
      const attributes: Record<string, string> = {};
      readAttributes(body, nameEnd, attributes);
      const el: XmlElement = { name, localName: localNameOf(name), attributes, children: [], text: "" };
      top.children.push(el);
      if (!selfClosing && stack.length < MAX_DEPTH) stack.push(el);
      i = j + 1;
    }
  }
  return root.children.find((c) => c.name) ?? undefined;
};

/** Decodes XML bytes, honouring a UTF-16 BOM (some SolidWorks streams use UTF-16LE). */
export const decodeXmlBytes = (b: Uint8Array) => {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0x3c && b[1] === 0x00) return new TextDecoder("utf-16le").decode(b);
  return new TextDecoder("utf-8").decode(b);
};

/** All descendants (depth-first, document order) whose local name is `localName`. */
export const findAll = (el: XmlElement, localName: string): XmlElement[] => {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.localName === localName) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
};

/** Text content of `el` and all its descendants. */
export const textContent = (el: XmlElement): string =>
  el.text + el.children.map(textContent).join("");
