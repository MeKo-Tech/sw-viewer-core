import assert from "node:assert/strict";
import { it } from "node:test";
import { findAll, parseXml, textContent } from "../src/xml.ts";

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
