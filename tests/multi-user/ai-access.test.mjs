import assert from "node:assert/strict";
import test from "node:test";
import { hasAiAccess, requireAiAccess } from "../../scripts/ai-access.mjs";
import { normalizeManualMetadata } from "../../scripts/import-job-api.mjs";

test("AI access reuses invite_activated without changing the profile schema", () => {
  assert.equal(hasAiAccess({ invite_activated: true }), true);
  assert.equal(hasAiAccess({ invite_activated: false }), false);
  assert.throws(() => requireAiAccess({ invite_activated: false }), (error) => error.status === 403 && error.code === "AI_ACCESS_REQUIRED");
  assert.equal(requireAiAccess({ invite_activated: true }).invite_activated, true);
});

test("manual wardrobe metadata keeps every field optional", () => {
  assert.deepEqual(normalizeManualMetadata({}), {
    name: "",
    part: null,
    color: null,
    secondaryColor: null,
    tags: [],
  });
  assert.deepEqual(normalizeManualMetadata({ name: " 衬衫 ", part: "lowerbody", color: "#ABCDEF", tags: "棉质, 休闲" }), {
    name: "衬衫",
    part: "lowerbody",
    color: "#abcdef",
    secondaryColor: null,
    tags: ["棉质", "休闲"],
  });
  assert.deepEqual(normalizeManualMetadata({ name: "挂件", category: "accessories_up", primaryColor: "#ABCDEF" }), {
    name: "挂件",
    part: "accessories_up",
    color: "#abcdef",
    secondaryColor: null,
    tags: [],
  });
});
