import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSwFile } from "../src/parse.ts";
import { readCoreProperties, readPropertyList } from "../src/properties.ts";
import { readFixture, skipUnless } from "./fixtures.ts";

describe("document properties", () => {
  it("reads named custom properties and skips unnamed, empty and internal ones", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Properties xmlns:vt="x"><propertySection name="UserDefinedProperties">
        <property name="" pid="1"><vt:i2>65001</vt:i2></property>
        <property name="Material" pid="3"><vt:lpstr>Stahl &lt;S235&gt;</vt:lpstr><FPVals><vt:lpstr>&lt;$0$x$&gt;</vt:lpstr></FPVals></property>
        <property name="Comment" pid="4"><vt:lpstr></vt:lpstr></property>
        <property name="_PID_HLINKS" pid="5"><vt:blob>AAAA</vt:blob></property>
      </propertySection></Properties>`;
    assert.deepEqual(readPropertyList(xml), { Material: "Stahl <S235>" });
  });

  it("keeps the first source's value on a name clash", () => {
    const out = readPropertyList(`<P><property name="A"><vt:lpstr>first</vt:lpstr></property></P>`);
    readPropertyList(`<P><property name="A"><vt:lpstr>second</vt:lpstr></property></P>`, out);
    assert.equal(out.A, "first");
  });

  it("reads core.xml elements by local name", () => {
    const xml = `<cp:coreProperties xmlns:cp="a" xmlns:dc="b"><dc:title>Bracket</dc:title><dc:subject/><dcterms:created>2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`;
    assert.deepEqual(readCoreProperties(xml), { title: "Bracket", created: "2026-01-01T00:00:00Z" });
  });
});

describe("document properties of the sample files", { skip: skipUnless("Baugr3.sldasm", "wuerfel.sldprt") }, () => {
  it("fills properties for assemblies", async () => {
    const r = await parseSwFile(readFixture("Baugr3.sldasm"));
    assert.equal(r.properties?.Weight, "7288.05");
    assert.equal(r.properties?.title, "Baugruppe MeKo");
    assert.equal(r.properties?.creator, "Wagner C.");
  });

  it("fills properties for parts", async () => {
    const r = await parseSwFile(readFixture("wuerfel.sldprt"));
    assert.equal(r.properties?.Weight, "1000.00");
    assert.equal(r.properties?.["SW-Dateiname"], "Würfel 100x100x100");
    assert.equal(r.properties?.title, "Teil MeKo");
  });
});

describe("property names shadowing Object.prototype", () => {
  it("keeps constructor, toString and __proto__ as plain values", () => {
    const xml = `<Properties>${["constructor", "toString", "__proto__", "hasOwnProperty"]
      .map((n, i) => `<property name="${n}"><vt:lpwstr>v${i}</vt:lpwstr></property>`)
      .join("")}</Properties>`;
    const out = readPropertyList(xml);
    assert.deepEqual(Object.keys(out), ["constructor", "toString", "__proto__", "hasOwnProperty"]);
    assert.equal(out.constructor, "v0");
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(JSON.parse(JSON.stringify(out)).__proto__, "v2");
    const core = readCoreProperties(`<cp:coreProperties><dc:constructor>c</dc:constructor><dc:title>t</dc:title></cp:coreProperties>`);
    assert.deepEqual(Object.entries(core), [["constructor", "c"], ["title", "t"]]);
  });
});
