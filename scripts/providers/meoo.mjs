import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import sharp from "sharp";
import {
  ProviderRequestError,
  WARDROBE_ANALYSIS_PROMPT,
  WARDROBE_ITEMS_SCHEMA,
  parseWardrobeItems,
  setting,
} from "./contracts.mjs";

const DEFAULT_COMPATIBLE_BASE_URL = "https://api.meoo.host/meoo-ai/compatible-mode/v1";
const DEFAULT_IMAGE_URL = "https://api.meoo.host/meoo-ai/api/v1/services/aigc/image-generation/generation";
const MAX_INLINE_BYTES = 7 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 1_500_000;
const MAX_DOWNLOADED_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_DOWNLOAD_ATTEMPTS = 3;

function compatibleBaseUrl(env) {
  return setting(env, "MEOO_AI_COMPATIBLE_BASE_URL", DEFAULT_COMPATIBLE_BASE_URL).replace(/\/$/, "");
}

function imageGenerationUrl(env) {
  return setting(env, "MEOO_AI_IMAGE_URL", DEFAULT_IMAGE_URL).replace(/\/$/, "");
}

function requestId(response, result) {
  return response.headers.get("x-request-id")
    || result.request_id
    || result.requestId
    || null;
}

function meooError(result, response, fallback, details = {}) {
  return new ProviderRequestError(
    result.error?.message || result.message || result.code || fallback,
    { provider: "meoo", status: response.status, requestId: requestId(response, result), ...details },
  );
}

async function responsePayload(response) {
  const responseBody = await response.text().catch(() => "");
  let result = {};
  try { result = responseBody ? JSON.parse(responseBody) : {}; } catch { /* retain raw provider body for diagnostics */ }
  return { result, responseBody };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : part?.text)
    .filter((part) => typeof part === "string")
    .join("\n");
}

function outputImageUrl(result) {
  const content = result.output?.choices
    ?.flatMap((choice) => choice.message?.content || []);
  return content?.find((part) => typeof part?.image === "string")?.image || null;
}

async function compactImage(image) {
  return {
    image: await sharp(image.data)
      .rotate()
      .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 60, mozjpeg: true })
      .toBuffer(),
    mime: "image/jpeg",
  };
}

async function prepareImage(image, { forceCompact = false } = {}) {
  if (!forceCompact && image.data.length <= MAX_INLINE_BYTES) {
    return { image: image.data, mime: image.mime || "image/png" };
  }
  return compactImage(image);
}

function downloadWithNodeHttp(url) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsGet : httpGet)(url, {
      family: 4,
      headers: { Accept: "image/*" },
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_DOWNLOADED_IMAGE_BYTES) request.destroy(new Error("image exceeded 25 MB"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.setTimeout(5 * 60 * 1000, () => request.destroy(new Error("download timed out")));
    request.on("error", reject);
  });
}

async function normalizeDownloadedImage(downloaded) {
  if (!downloaded.length || downloaded.length > MAX_DOWNLOADED_IMAGE_BYTES) {
    throw new ProviderRequestError("Meoo image download was empty or exceeded the 25 MB limit", { provider: "meoo" });
  }
  try {
    return await sharp(downloaded).rotate().toColorspace("srgb").png().toBuffer();
  } catch {
    throw new ProviderRequestError("Meoo image download was not a valid image", { provider: "meoo" });
  }
}

function imagePart(prepared) {
  return { image: `data:${prepared.mime};base64,${prepared.image.toString("base64")}` };
}

function bodyWithImages(model, prompt, preparedImages, size) {
  return {
    model,
    input: {
      messages: [{
        role: "user",
        content: [...preparedImages.map(imagePart), { text: prompt }],
      }],
    },
    parameters: { size: `${size.width}*${size.height}` },
  };
}

async function downloadPng(url, fetchImpl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ProviderRequestError("Meoo image response contained an invalid image URL", { provider: "meoo" });
  }
  if (!["https:", "http:"].includes(parsedUrl.protocol)) {
    throw new ProviderRequestError("Meoo image response used an unsupported URL protocol", { provider: "meoo" });
  }

  let response;
  let lastError;
  for (let attempt = 1; attempt <= IMAGE_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      response = await fetchImpl(parsedUrl.href, {
        method: "GET",
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < IMAGE_DOWNLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** (attempt - 1))));
    }
  }
  if (!response) {
    const causeCode = lastError?.cause?.code || lastError?.cause?.errors?.find((cause) => cause?.code)?.code || "";
    const suffix = causeCode ? ` (${causeCode})` : "";
    try {
      return normalizeDownloadedImage(await downloadWithNodeHttp(parsedUrl));
    } catch (fallbackError) {
      throw new ProviderRequestError(`Meoo image result download failed: ${lastError?.message || "fetch failed"}${suffix}; fallback: ${fallbackError.message}`, { provider: "meoo" });
    }
  }
  if (!response.ok) {
    throw new ProviderRequestError(`Meoo image download failed (${response.status})`, {
      provider: "meoo",
      status: response.status,
      requestId: response.headers.get("x-request-id"),
    });
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_DOWNLOADED_IMAGE_BYTES) {
    throw new ProviderRequestError("Meoo image download exceeded the 25 MB limit", { provider: "meoo" });
  }
  return normalizeDownloadedImage(Buffer.from(await response.arrayBuffer()));
}

function configurationIssues(env) {
  return [!setting(env, "MEOO_PROJECT_API_KEY").trim() && "MEOO_PROJECT_API_KEY"].filter(Boolean);
}

export function createMeooVisionProvider({ env = {}, fetchImpl = fetch } = {}) {
  return {
    id: "meoo",
    credentialLabel: "MEOO_PROJECT_API_KEY",
    configurationIssues: () => configurationIssues(env),
    isConfigured: () => configurationIssues(env).length === 0,
    async analyze({ image, mime = "image/png" }) {
      const key = setting(env, "MEOO_PROJECT_API_KEY");
      if (!key) throw new ProviderRequestError("MEOO_PROJECT_API_KEY is not configured", { provider: "meoo" });

      let prepared = image.length > MAX_INLINE_BYTES
        ? await compactImage({ data: image, mime })
        : { image, mime };
      const endpoint = `${compatibleBaseUrl(env)}/chat/completions`;
      const buildRequestBody = (input) => JSON.stringify({
        model: setting(env, "MEOO_VISION_MODEL", "qwen3-vl-plus"),
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `${WARDROBE_ANALYSIS_PROMPT}\nThe required JSON shape is:\n${JSON.stringify(WARDROBE_ITEMS_SCHEMA)}` },
            { type: "image_url", image_url: { url: `data:${input.mime};base64,${input.image.toString("base64")}` } },
          ],
        }],
        stream: false,
      });
      let requestBody = buildRequestBody(prepared);
      if (Buffer.byteLength(requestBody) > MAX_REQUEST_BODY_BYTES) {
        prepared = await compactImage({ data: image, mime });
        requestBody = buildRequestBody(prepared);
      }
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: requestBody,
      });
      const { result, responseBody } = await responsePayload(response);
      if (!response.ok) throw meooError(result, response, `Meoo vision request failed (${response.status})`, { endpoint, responseBody, requestBytes: Buffer.byteLength(requestBody) });

      const outputText = contentText(result.choices?.[0]?.message?.content);
      if (!outputText) throw new ProviderRequestError("Meoo vision response did not contain JSON text", {
        provider: "meoo",
        requestId: requestId(response, result),
      });
      try {
        return parseWardrobeItems(outputText);
      } catch (error) {
        throw new ProviderRequestError(`Meoo vision response was invalid: ${error.message}`, {
          provider: "meoo",
          requestId: requestId(response, result),
        });
      }
    },
  };
}

export function createMeooImageProvider({ env = {}, fetchImpl = fetch } = {}) {
  return {
    id: "meoo",
    credentialLabel: "MEOO_PROJECT_API_KEY",
    configurationIssues: () => configurationIssues(env),
    isConfigured: () => configurationIssues(env).length === 0,
    async edit({ purpose, prompt, images, size }) {
      const key = setting(env, "MEOO_PROJECT_API_KEY");
      if (!key) throw new ProviderRequestError("MEOO_PROJECT_API_KEY is not configured", { provider: "meoo" });
      const expectedImages = { garment: 1, modeled: 2, outfit: 3 }[purpose];
      if (!expectedImages) throw new ProviderRequestError(`Meoo image purpose is unsupported: ${purpose}`, { provider: "meoo" });
      if (!Array.isArray(images) || images.length !== expectedImages) {
        throw new ProviderRequestError(
          `Meoo ${purpose} image edit requires exactly ${expectedImages} input image${expectedImages === 1 ? "" : "s"}`,
          { provider: "meoo" },
        );
      }

      let preparedImages = await Promise.all(images.map((image) => prepareImage(image)));
      let body = bodyWithImages(
        purpose === "outfit"
          ? setting(env, "MEOO_OUTFIT_MODEL", setting(env, "MEOO_IMAGE_MODEL", "qwen-image-2.0"))
          : setting(env, "MEOO_IMAGE_MODEL", "qwen-image-2.0"),
        prompt,
        preparedImages,
        size,
      );
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BODY_BYTES) {
        preparedImages = await Promise.all(images.map((image) => prepareImage(image, { forceCompact: true })));
        body = bodyWithImages(body.model, prompt, preparedImages, size);
      }

      const endpoint = imageGenerationUrl(env);
      const requestBody = JSON.stringify(body);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: requestBody,
        });
      } catch (error) {
        throw new ProviderRequestError(`Meoo image generation request failed: ${error.message || "fetch failed"}`, { provider: "meoo" });
      }
      const { result, responseBody } = await responsePayload(response);
      if (!response.ok) throw meooError(result, response, `Meoo image request failed (${response.status})`, { endpoint, responseBody, requestBytes: Buffer.byteLength(requestBody) });
      const temporaryUrl = outputImageUrl(result);
      if (!temporaryUrl) throw new ProviderRequestError("Meoo image response did not contain an image URL", {
        provider: "meoo",
        requestId: requestId(response, result),
      });
      return downloadPng(temporaryUrl, fetchImpl);
    },
  };
}
