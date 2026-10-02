import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIImageProvider, createOpenAIVisionProvider } from "../../scripts/providers/openai.mjs";

const item = {
  name: "Black tee",
  part: "upperbody",
  color: "#111111",
  secondaryColor: null,
  tags: ["cotton"],
  boundingBox: { x: 100, y: 120, width: 500, height: 600 },
};

test("OpenAI vision provider converts a Responses API result to wardrobe items", async () => {
  let request;
  const provider = createOpenAIVisionProvider({
    env: { OPENAI_API_KEY: "test-key", OPENAI_VISION_MODEL: "vision-test" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ output_text: JSON.stringify({ items: [item] }) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const items = await provider.analyze({ image: Buffer.from("image"), mime: "image/png" });
  assert.deepEqual(items, [item]);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(JSON.parse(request.options.body).model, "vision-test");
});

test("OpenAI image provider converts base64 output to a Buffer", async () => {
  const expected = Buffer.from("generated-image");
  let request;
  const provider = createOpenAIImageProvider({
    env: { OPENAI_API_KEY: "test-key", OPENAI_IMAGE_MODEL: "image-test" },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: [{ b64_json: expected.toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await provider.edit({
    purpose: "garment",
    prompt: "test",
    images: [{ data: Buffer.from("input"), mime: "image/png", name: "input.png" }],
    size: { width: 1024, height: 1024 },
  });
  assert.deepEqual(result, expected);
  assert.equal(request.url, "https://api.openai.com/v1/images/edits");
  assert.equal(request.options.body.get("model"), "image-test");
  assert.equal(request.options.body.get("size"), "1024x1024");
});

test("OpenAI image provider can select a dedicated outfit model", async () => {
  let request;
  const provider = createOpenAIImageProvider({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_IMAGE_MODEL: "image-test",
      OPENAI_OUTFIT_MODEL: "outfit-test",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("outfit").toString("base64") }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await provider.edit({
    purpose: "outfit",
    prompt: "test outfit",
    images: [
      { data: Buffer.from("identity"), mime: "image/png", name: "identity.png" },
      { data: Buffer.from("top"), mime: "image/png", name: "top.png" },
      { data: Buffer.from("bottom"), mime: "image/png", name: "bottom.png" },
    ],
    size: { width: 1536, height: 1536 },
  });

  assert.equal(request.options.body.get("model"), "outfit-test");
  assert.equal(request.options.body.getAll("image[]").length, 3);
});
