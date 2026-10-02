import assert from "node:assert/strict";
import test from "node:test";
import { createDashScopeVisionProvider } from "../../scripts/providers/dashscope.mjs";

const item = {
  name: "Blue shirt",
  part: "upperbody",
  color: "#336699",
  secondaryColor: null,
  tags: ["cotton", "buttons"],
  boundingBox: { x: 110, y: 80, width: 520, height: 700 },
};

test("DashScope vision provider uses compatible chat completions and validates JSON", async () => {
  let request;
  const provider = createDashScopeVisionProvider({
    env: {
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_COMPATIBLE_BASE_URL: "https://example.test/compatible-mode/v1/",
      DASHSCOPE_VISION_MODEL: "qwen-test",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ items: [item] })}\n\`\`\`` } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-request-id": "request-1" },
      });
    },
  });

  const items = await provider.analyze({ image: Buffer.from("image"), mime: "image/png" });
  const requestBody = JSON.parse(request.options.body);

  assert.deepEqual(items, [item]);
  assert.equal(request.url, "https://example.test/compatible-mode/v1/chat/completions");
  assert.equal(requestBody.model, "qwen-test");
  assert.equal(requestBody.enable_thinking, false);
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.match(requestBody.messages[0].content[0].text, /top-level "items" array/);
  assert.equal(requestBody.messages[0].content[1].type, "image_url");
  assert.match(requestBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test("DashScope vision provider rejects an invalid wardrobe category", async () => {
  const provider = createDashScopeVisionProvider({
    env: { DASHSCOPE_API_KEY: "test-key" },
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({ items: [{ ...item, part: "hat" }] }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  await assert.rejects(
    provider.analyze({ image: Buffer.from("image"), mime: "image/png" }),
    /DashScope vision response was invalid: items\[0\]\.part is invalid/,
  );
});
