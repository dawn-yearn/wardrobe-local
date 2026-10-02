import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createMeooImageProvider, createMeooVisionProvider } from "../../scripts/providers/meoo.mjs";

const item = {
  name: "Blue shirt",
  part: "upperbody",
  color: "#336699",
  secondaryColor: null,
  tags: ["cotton"],
  boundingBox: { x: 100, y: 100, width: 500, height: 600 },
};

async function png(color) {
  return sharp({
    create: { width: 2, height: 2, channels: 4, background: color },
  }).png().toBuffer();
}

async function noisyPng() {
  const width = 1200;
  const height = 1200;
  return sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
}

test("Meoo vision provider uses project Service AK and preserves wardrobe JSON contract", async () => {
  let request;
  const provider = createMeooVisionProvider({
    env: {
      MEOO_PROJECT_API_KEY: "project-service-key",
      MEOO_AI_COMPATIBLE_BASE_URL: "https://example.test/meoo-ai/compatible-mode/v1/",
      MEOO_VISION_MODEL: "qwen3-vl-test",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items: [item] }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await provider.analyze({ image: Buffer.from("image"), mime: "image/png" });
  const body = JSON.parse(request.options.body);

  assert.deepEqual(result, [item]);
  assert.equal(request.url, "https://example.test/meoo-ai/compatible-mode/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer project-service-key");
  assert.equal(body.model, "qwen3-vl-test");
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test("Meoo vision provider preserves upstream diagnostics without exposing credentials", async () => {
  const provider = createMeooVisionProvider({
    env: { MEOO_PROJECT_API_KEY: "project-service-key", MEOO_AI_COMPATIBLE_BASE_URL: "https://example.test/meoo-ai/compatible-mode/v1" },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "upstream rejected image" }, request_id: "req-upstream" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    }),
  });

  await assert.rejects(
    provider.analyze({ image: Buffer.from("image"), mime: "image/png" }),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.requestId, "req-upstream");
      assert.equal(error.endpoint, "https://example.test/meoo-ai/compatible-mode/v1/chat/completions");
      assert.match(error.responseBody, /upstream rejected image/);
      assert.ok(error.requestBytes > 0);
      assert.doesNotMatch(error.responseBody, /project-service-key/);
      return true;
    },
  );
});

test("Meoo vision provider compacts the serialized request below the gateway body budget", async () => {
  const input = await noisyPng();
  let requestBody;
  const provider = createMeooVisionProvider({
    env: { MEOO_PROJECT_API_KEY: "project-service-key" },
    fetchImpl: async (_url, options) => {
      requestBody = options.body;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items: [item] }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await provider.analyze({ image: input, mime: "image/png" });
  const body = JSON.parse(requestBody);

  assert.deepEqual(result, [item]);
  assert.ok(input.length < 7 * 1024 * 1024, "fixture must exercise the former raw-byte threshold gap");
  assert.ok(Buffer.byteLength(requestBody) < 1_500_000);
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test("Meoo image provider preserves one-reference editing and downloads returned PNG", async () => {
  const input = await png("#ff0000");
  const generated = await png("#00ff00");
  const requests = [];
  const provider = createMeooImageProvider({
    env: {
      MEOO_PROJECT_API_KEY: "project-service-key",
      MEOO_AI_IMAGE_URL: "https://example.test/meoo-ai/image-generation",
      MEOO_IMAGE_MODEL: "qwen-image-test",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "GET") return new Response(generated, { status: 200, headers: { "Content-Type": "image/png" } });
      return new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://temporary.example.test/generated.png" }] } }] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await provider.edit({
    purpose: "garment",
    prompt: "clean product image",
    images: [{ data: input, mime: "image/png", name: "garment.png" }],
    size: { width: 1024, height: 1024 },
  });
  const body = JSON.parse(requests[0].options.body);

  assert.equal(requests[0].url, "https://example.test/meoo-ai/image-generation");
  assert.equal(requests[0].options.headers.Authorization, "Bearer project-service-key");
  assert.equal(body.model, "qwen-image-test");
  assert.equal(body.parameters.size, "1024*1024");
  assert.equal(body.input.messages[0].content.filter((part) => part.image).length, 1);
  assert.deepEqual(body.input.messages[0].content.at(-1), { text: "clean product image" });
  assert.deepEqual(result.subarray(1, 4), Buffer.from("PNG"));
});

test("Meoo image provider retries transient result-image download failures", async () => {
  const input = await png("#ff0000");
  const generated = await png("#00ff00");
  let downloads = 0;
  const provider = createMeooImageProvider({
    env: { MEOO_PROJECT_API_KEY: "project-service-key" },
    fetchImpl: async (url, options) => {
      if (options.method === "GET") {
        downloads += 1;
        if (downloads < 3) throw new TypeError("fetch failed");
        return new Response(generated, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      return new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://temporary.example.test/retry.png" }] } }] },
      }), { status: 200 });
    },
  });

  const result = await provider.edit({
    purpose: "garment",
    prompt: "clean product image",
    images: [{ data: input, mime: "image/png" }],
    size: { width: 1024, height: 1024 },
  });

  assert.equal(downloads, 3);
  assert.deepEqual(result.subarray(1, 4), Buffer.from("PNG"));
});

test("Meoo image provider compresses oversized multi-reference payloads without changing image count", async () => {
  const identity = await noisyPng();
  const top = await noisyPng();
  const bottom = await noisyPng();
  const generated = await png("#777777");
  const requests = [];
  const provider = createMeooImageProvider({
    env: { MEOO_PROJECT_API_KEY: "project-service-key" },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "GET") return new Response(generated, { status: 200 });
      return new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://temporary.example.test/outfit.png" }] } }] },
      }), { status: 200 });
    },
  });

  await provider.edit({
    purpose: "outfit",
    prompt: "wear the exact top and bottom",
    images: [
      { data: identity, mime: "image/png" },
      { data: top, mime: "image/png" },
      { data: bottom, mime: "image/png" },
    ],
    size: { width: 1536, height: 1536 },
  });
  const bodyText = requests[0].options.body;
  const body = JSON.parse(bodyText);
  const content = body.input.messages[0].content;

  assert.ok(Buffer.byteLength(bodyText) < 1_500_000);
  assert.equal(content.filter((part) => part.image).length, 3);
  assert.ok(content.slice(0, 3).every((part) => part.image.startsWith("data:image/jpeg;base64,")));
  assert.deepEqual(content.at(-1), { text: "wear the exact top and bottom" });
});

test("Meoo image provider rejects a reference-count mismatch before fetch", async () => {
  const provider = createMeooImageProvider({
    env: { MEOO_PROJECT_API_KEY: "project-service-key" },
    fetchImpl: async () => { throw new Error("fetch should not be called"); },
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
