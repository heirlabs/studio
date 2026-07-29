import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, safeName } from "../../server/lib/template.js";

describe("renderTemplate", () => {
  it("substitutes variables", () => {
    assert.equal(renderTemplate("hi {{name}}", { name: "x" }), "hi x");
  });

  it("empty string for missing keys", () => {
    assert.equal(renderTemplate("a={{missing}}b", {}), "a=b");
  });

  it("if images block included when images present", () => {
    const tpl = "before {{#if images}}IMGS:{{images}}{{/if}} after";
    assert.equal(
      renderTemplate(tpl, { images: "1. /a.png" }),
      "before IMGS:1. /a.png after",
    );
  });

  it("if images block dropped when empty", () => {
    const tpl = "before {{#if images}}IMGS{{/if}} after";
    assert.equal(renderTemplate(tpl, { images: "" }), "before  after");
    assert.equal(renderTemplate(tpl, { images: null }), "before  after");
  });

  it("null vars become empty", () => {
    assert.equal(renderTemplate("{{a}}", { a: null }), "");
  });

  it("rejects non-string template", () => {
    assert.throws(() => renderTemplate(null, {}), TypeError);
  });
});

describe("safeName", () => {
  it("strips path separators and weird chars", () => {
    assert.equal(safeName("../../etc/passwd"), "____etc_passwd");
    assert.equal(safeName("ok-file (1).png"), "ok-file (1).png");
  });

  it("handles empty", () => {
    assert.equal(safeName(""), "file");
    assert.equal(safeName(null), "file");
  });

  it("truncates long names", () => {
    assert.equal(safeName("a".repeat(200)).length, 120);
  });
});
