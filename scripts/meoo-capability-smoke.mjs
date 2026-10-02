import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiKey = process.env.MEOO_PROJECT_API_KEY;
if (!apiKey) throw new Error("MEOO_PROJECT_API_KEY is not available in the environment");

const chatUrl = "https://api.meoo.host/meoo-ai/compatible-mode/v1/chat/completions";
const imageUrl = "https://api.meoo.host/meoo-ai/api/v1/services/aigc/image-generation/generation";

const paths = {
  model: path.join(root, "data", "model-reference.png"),
  garmentA: path.join(root, "data", "imported", "import-0eaa9275-8fc2-4702-b38e-7e04166a1a57-garment.png"),
  garmentB: path.join(root, "data", "imported", "import-2e51c3d4-7de7-409c-8792-eeeb8968df4c-garment.png"),
};

async function dataUrl(filePath) {
  const bytes = await readFile(filePath);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function compactDataUrl(filePath) {
  const bytes = await sharp(await readFile(filePath))
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 70, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function responseShape(value) {
  if (!value || typeof value !== "object") return { type: typeof value };
  const output = value.output;
  const choices = Array.isArray(value.choices) ? value.choices : null;
  return {
    topLevelKeys: Object.keys(value).slice(0, 20),
    outputKeys: output && typeof output === "object" ? Object.keys(output).slice(0, 20) : [],
    choiceCount: choices?.length ?? 0,
    hasImageSignal: /image|url|result/i.test(JSON.stringify(value).slice(0, 20000)),
  };
}

function errorShape(value) {
  if (!value || typeof value !== "object") return String(value).slice(0, 1200);
  const error = value.error;
  return {
    topLevelKeys: Object.keys(value).slice(0, 20),
    nonJsonBody: value.nonJsonBody,
    error: error && typeof error === "object" ? {
      code: error.code,
      message: error.message,
      type: error.type,
    } : error,
    message: value.message,
    requestId: value.request_id ?? value.requestId,
  };
}

async function call(name, url, body, requestSummary) {
  const bodyText = JSON.stringify(body);
  console.log(`REQUEST|${name}|${JSON.stringify({ ...requestSummary, bodyBytes: Buffer.byteLength(bodyText) })}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: bodyText,
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = { nonJsonBody: raw.slice(0, 1200) };
  }
  const responseDetails = response.ok ? responseShape(parsed) : {
    ...errorShape(parsed),
    responseBodyBytes: Buffer.byteLength(raw),
    responseContentType: response.headers.get("content-type"),
    requestId: response.headers.get("x-request-id"),
  };
  console.log(`RESPONSE|${name}|status=${response.status}|${JSON.stringify(responseDetails)}`);
  return { ok: response.ok, status: response.status, body: parsed };
}

const refDataUrl = process.env.COMPACT_REFS === "1" ? compactDataUrl : dataUrl;
const [model, garmentA, garmentB] = await Promise.all([
  refDataUrl(paths.model),
  refDataUrl(paths.garmentA),
  refDataUrl(paths.garmentB),
]);

const only = new Set((process.env.SMOKE_ONLY || "").split(",").filter(Boolean));
const shouldRun = (name) => only.size === 0 || only.has(name);
const results = [];
if (shouldRun("vision-single")) results.push(await call(
  "vision-single",
  chatUrl,
  {
    model: "qwen3-vl-plus",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "请识别这件衣物，并只返回合法 JSON，字段包括 category、color、material、style、season。" },
        { type: "image_url", image_url: { url: garmentA } },
      ],
    }],
    stream: false,
  },
  { endpoint: "compatible-chat", model: "qwen3-vl-plus", imageCount: 1, contentKinds: ["text", "image_url"] },
));

if (shouldRun("image-text-to-image")) results.push(await call(
  "image-text-to-image",
  imageUrl,
  {
    model: "qwen-image-2.0",
    input: { messages: [{ role: "user", content: [{ text: "一件简洁的米白色针织衫，纯色背景，商品摄影" }] }] },
    parameters: { size: "1024*1024" },
  },
  { endpoint: "image-generation", model: "qwen-image-2.0", imageCount: 0, contentKinds: ["text"] },
));

for (const [name, images] of [
  ["image-single-reference", [garmentA]],
  ["image-double-reference", [model, garmentA]],
  ["image-triple-reference", [model, garmentA, garmentB]],
]) {
  if (!shouldRun(name)) continue;
  results.push(await call(
    name,
    imageUrl,
    {
      model: "qwen-image-2.0",
      input: {
        messages: [{
          role: "user",
          content: [
            ...images.map((image) => ({ image })),
            { text: "保留参考图中的人物和衣物身份，生成自然、完整、真实的穿搭效果图，背景简洁。" },
          ],
        }],
      },
      parameters: { size: "1024*1024" },
    },
    { endpoint: "image-generation", model: "qwen-image-2.0", imageCount: images.length, contentKinds: [...images.map(() => "image"), "text"] },
  ));
}

const failed = results.filter((result) => !result.ok);
console.log(`SUMMARY|total=${results.length}|passed=${results.length - failed.length}|failed=${failed.length}`);
if (failed.length) process.exitCode = 2;
