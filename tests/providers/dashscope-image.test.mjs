import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createDashScopeImageProvider } from "../../scripts/providers/dashscope.mjs";

async function png(color) {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: color,
    },
  }).png().toBuffer();
}

function providerWithDownload(generated, requests) {
  return createDashScopeImageProvider({
    env: {
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_API_BASE_URL: "https://example.test/api/v1/",
      DASHSCOPE_IMAGE_MODEL: "qwen-image-test",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "GET") {
        return new Response(generated, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return new Response(JSON.stringify({
        output: {
          choices: [{
            message: {
              content: [{ image: "https://temporary.example.test/generated.png" }],
            },
          }],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-request-id": "request-2" },
      });
    },
  });
}

test("DashScope image provider sends one garment image and immediately downloads PNG bytes", async () => {
  const input = await png("#ff0000");
  const generated = await png("#00ff00");
  const requests = [];
  const provider = providerWithDownload(generated, requests);

  const result = await provider.edit({
    purpose: "garment",
    prompt: "clean product image",
    images: [{ data: input, mime: "image/png", name: "garment.png" }],
    size: { width: 1024, height: 1024 },
  });
  const requestBody = JSON.parse(requests[0].options.body);

  assert.equal(requests[0].url, "https://example.test/api/v1/services/aigc/multimodal-generation/generation");
  assert.equal(requestBody.model, "qwen-image-test");
  assert.equal(requestBody.parameters.size, "1024*1024");
  assert.equal(requestBody.input.messages[0].content.filter((part) => part.image).length, 1);
  assert.equal(requests[1].url, "https://temporary.example.test/generated.png");
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(result.subarray(1, 4), Buffer.from("PNG"));
  assert.doesNotMatch(result.toString("utf8"), /temporary\.example/);
});

test("DashScope image provider sends model reference before garment for modeled output", async () => {
  const model = await png("#222222");
  const garment = await png("#eeeeee");
  const generated = await png("#777777");
  const requests = [];
  const provider = providerWithDownload(generated, requests);

  await provider.edit({
    purpose: "modeled",
    prompt: "person wearing garment",
    images: [
      { data: model, mime: "image/png", name: "model.png" },
      { data: garment, mime: "image/png", name: "garment.png" },
    ],
    size: { width: 1536, height: 1024 },
  });
  const content = JSON.parse(requests[0].options.body).input.messages[0].content;

  assert.equal(content.filter((part) => part.image).length, 2);
  assert.match(content[0].image, /^data:image\/png;base64,/);
  assert.match(content[1].image, /^data:image\/png;base64,/);
  assert.deepEqual(content.at(-1), { text: "person wearing garment" });
});

test("DashScope image provider sends exactly identity, top, and bottom for outfit output", async () => {
  const identity = await png("#222222");
  const top = await png("#cc3333");
  const bottom = await png("#3333cc");
  const generated = await png("#777777");
  const requests = [];
  const provider = createDashScopeImageProvider({
    env: {
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_API_BASE_URL: "https://example.test/api/v1/",
      DASHSCOPE_IMAGE_MODEL: "general-image-test",
      DASHSCOPE_OUTFIT_MODEL: "outfit-image-test",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "GET") {
        return new Response(generated, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return new Response(JSON.stringify({
        output: {
          choices: [{
            message: {
              content: [{ image: "https://temporary.example.test/outfit.png" }],
            },
          }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await provider.edit({
    purpose: "outfit",
    prompt: "wear the exact top and bottom",
    images: [
      { data: identity, mime: "image/png", name: "identity.png" },
      { data: top, mime: "image/png", name: "top.png" },
      { data: bottom, mime: "image/png", name: "bottom.png" },
    ],
    size: { width: 1536, height: 1536 },
  });
  const requestBody = JSON.parse(requests[0].options.body);
  const content = requestBody.input.messages[0].content;

  assert.equal(requestBody.model, "outfit-image-test");
  assert.equal(requestBody.parameters.size, "1536*1536");
  assert.equal(requestBody.parameters.prompt_extend, false);
  assert.equal(content.filter((part) => part.image).length, 3);
  assert.deepEqual(content.at(-1), { text: "wear the exact top and bottom" });
});

test("DashScope outfit image provider rejects anything other than three inputs", async () => {
  const provider = createDashScopeImageProvider({
    env: { DASHSCOPE_API_KEY: "test-key" },
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  await assert.rejects(
    provider.edit({
      purpose: "outfit",
      prompt: "test",
      images: [{ data: Buffer.from("one"), mime: "image/png" }],
      size: { width: 1536, height: 1536 },
    }),
    /requires exactly 3 input images/,
  );
});
