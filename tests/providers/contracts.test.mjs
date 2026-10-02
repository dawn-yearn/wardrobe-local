import assert from "node:assert/strict";
import test from "node:test";
import { parseWardrobeItems } from "../../scripts/providers/contracts.mjs";

const valid = {
  items: [{
    name: "Blue shirt",
    part: "upperbody",
    color: "#123456",
    secondaryColor: null,
    tags: ["cotton"],
    boundingBox: { x: 10, y: 20, width: 300, height: 400 },
  }],
};

test("parseWardrobeItems accepts fenced JSON and validates the item contract", () => {
  assert.deepEqual(parseWardrobeItems(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``), valid.items);
});

test("parseWardrobeItems rejects invalid categories", () => {
  const invalid = structuredClone(valid);
  invalid.items[0].part = "hat";
  assert.throws(() => parseWardrobeItems(JSON.stringify(invalid)), /part is invalid/);
});

test("parseWardrobeItems rejects malformed JSON", () => {
  assert.throws(() => parseWardrobeItems("{not json}"), /invalid JSON/);
});
