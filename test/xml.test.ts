import assert from "node:assert/strict";
import { it } from "node:test";
import { decodeEntities, findAll, parseXml, readAttributes, textContent } from "../src/xml.ts";

it("parses elements, attributes, entities and CDATA", () => {
  const root = parseXml(
    `<?xml version="1.0"?><!-- c --><a x="1" y='&lt;b&gt;'><b n="&#x41;&amp;"/><p:c>t&#252;<![CDATA[<raw>]]></p:c></a>`
  );
  assert.ok(root);
  assert.equal(root.name, "a");
  assert.deepEqual(root.attributes, { x: "1", y: "<b>" });
  assert.equal(root.children[0].attributes.n, "A&");
  assert.equal(root.children[1].localName, "c");
  assert.equal(textContent(root.children[1]), "tü<raw>");
});

it("finds nested elements by local name in document order", () => {
  const root = parseXml(`<r><m id="1"><ref a="x"/></m><m id="2"><ref a="y"><ref a="z"/></ref></m></r>`)!;
  assert.deepEqual(findAll(root, "ref").map((e) => e.attributes.a), ["x", "y", "z"]);
});

it("decodes UTF-16LE bytes with a BOM and tolerates truncation", () => {
  const bytes = new Uint8Array([0xff, 0xfe, ...Buffer.from(`<a v="ä"><b/>`, "utf16le")]);
  const root = parseXml(bytes)!;
  assert.equal(root.attributes.v, "ä");
  assert.equal(root.children.length, 1);
  assert.equal(parseXml(""), undefined);
});

const ATTR_REGEX = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
const regexAttributes = (body: string, from: number) => {
  const out: Record<string, string> = {};
  ATTR_REGEX.lastIndex = from;
  for (let m = ATTR_REGEX.exec(body); m; m = ATTR_REGEX.exec(body)) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
  return out;
};

it("reads attributes exactly like the former regex, junk included", () => {
  const alphabet = ["a", "b", "x:y", "=", '"', "'", "/", " ", "\t", " ", " ", "&amp;", "&#65;", "1", "-"];
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 8) % n;
  };
  for (let run = 0; run < 20000; run++) {
    let body = "";
    const len = rnd(24);
    for (let i = 0; i < len; i++) body += alphabet[rnd(alphabet.length)];
    const from = rnd(3);
    const got: Record<string, string> = {};
    readAttributes(body, from, got);
    assert.deepEqual(got, regexAttributes(body, from), JSON.stringify(body));
  }
});

it("reads a long attribute-less token in linear time", () => {
  const t0 = performance.now();
  const root = parseXml(`<a ${"x".repeat(200_000)} y="1"/>`);
  assert.ok(performance.now() - t0 < 1000, "took too long");
  assert.deepEqual(root?.attributes, { y: "1" });
  const t1 = performance.now();
  parseXml(`<a ${"x ".repeat(100_000)}${"z=".repeat(50_000)}/>`);
  assert.ok(performance.now() - t1 < 1000, "took too long");
});

it("stops at the element cap and returns what it read", () => {
  const root = parseXml(`<r>${"<e/>".repeat(100)}</r>`, { maxElements: 11 });
  assert.equal(root?.children.length, 10);
  assert.equal(parseXml(`<r>${"<e/>".repeat(100)}</r>`)?.children.length, 100);
});
