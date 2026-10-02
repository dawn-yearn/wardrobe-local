import assert from "node:assert/strict";
import test from "node:test";
import { createImageProvider, createVisionProvider } from "../../scripts/providers/index.mjs";

test("provider registry independently selects vision and image providers", () => {
  const env = {
    WARDROBE_VISION_PROVIDER: "dashscope",
    WARDROBE_IMAGE_PROVIDER: "dashscope",
  };

  assert.equal(createVisionProvider({ env }).id, "dashscope");
  assert.equal(createImageProvider({ env }).id, "dashscope");
});

test("local provider registry rejects Meoo even with project credentials", () => {
  const env = {
    MEOO_PROJECT_API_KEY: "project-service-key",
    WARDROBE_VISION_PROVIDER: "meoo",
    WARDROBE_IMAGE_PROVIDER: "meoo",
  };

  assert.throws(() => createVisionProvider({ env }), /Unsupported wardrobe vision provider: meoo/);
  assert.throws(() => createImageProvider({ env }), /Unsupported wardrobe image provider: meoo/);
});

test("local provider registry defaults to DashScope despite a residual Meoo key", () => {
  const env = { MEOO_PROJECT_API_KEY: "project-service-key" };

  assert.equal(createVisionProvider({ env }).id, "dashscope");
  assert.equal(createImageProvider({ env }).id, "dashscope");
});

test("provider registry rejects unknown providers", () => {
  assert.throws(
    () => createVisionProvider({ env: { WARDROBE_VISION_PROVIDER: "unknown" } }),
    /Unsupported wardrobe vision provider: unknown/,
  );
});
