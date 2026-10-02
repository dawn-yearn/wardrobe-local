import sharp from "sharp";
import {
  ProviderRequestError,
  WARDROBE_ANALYSIS_PROMPT,
  WARDROBE_ITEMS_SCHEMA,
  parseWardrobeItems,
  setting,
} from "./contracts.mjs";

const DEFAULT_COMPATIBLE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_API_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const MAX_INLINE_VISION_BYTES = 7 * 1024 * 1024;
const MAX_DOWNLOADED_IMAGE_BYTES = 25 * 1024 * 1024;

function compatibleBaseUrl(env) {
  return setting(env, "DASHSCOPE_COMPATIBLE_BASE_URL", DEFAULT_COMPATIBLE_BASE_URL).replace(/\/$/, "");
}

function apiBaseUrl(env) {
  return setting(env, "DASHSCOPE_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/$/, "");
}

function requestId(response, result) {
  return response.headers.get("x-request-id")
    || result.request_id
    || result.requestId
    || null;
}

function dashScopeError(result, response, fallback) {
  return new ProviderRequestError(
    result.error?.message || result.message || result.code || fallback,
    {
      provider: "dashscope",
      status: response.status,
      requestId: requestId(response, result),
    },
  );
}

async function prepareVisionImage(image, mime) {
  if (image.length <= MAX_INLINE_VISION_BYTES) return { image, mime };
  const resized = await sharp(image)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return { image: resized, mime: "image/jpeg" };
}

async function prepareEditImage(image) {
  if (image.data.length <= MAX_INLINE_VISION_BYTES) {
    return { image: image.data, mime: image.mime || "image/png" };
  }
  const resized = await sharp(image.data)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  return { image: resized, mime: "image/jpeg" };
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

async function downloadPng(url, fetchImpl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ProviderRequestError("DashScope image response contained an invalid image URL", {
      provider: "dashscope",
    });
  }
  if (!["https:", "http:"].includes(parsedUrl.protocol)) {
    throw new ProviderRequestError("DashScope image response used an unsupported URL protocol", {
      provider: "dashscope",
    });
  }

  const response = await fetchImpl(parsedUrl.href, {
    method: "GET",
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!response.ok) {
    throw new ProviderRequestError(`DashScope image download failed (${response.status})`, {
      provider: "dashscope",
      status: response.status,
      requestId: response.headers.get("x-request-id"),
    });
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_DOWNLOADED_IMAGE_BYTES) {
    throw new ProviderRequestError("DashScope image download exceeded the 25 MB limit", {
      provider: "dashscope",
    });
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  if (!downloaded.length) {
    throw new ProviderRequestError("DashScope image download was empty", {
      provider: "dashscope",
    });
  }
  if (downloaded.length > MAX_DOWNLOADED_IMAGE_BYTES) {
    throw new ProviderRequestError("DashScope image download exceeded the 25 MB limit", {
      provider: "dashscope",
    });
  }
  try {
    return await sharp(downloaded).rotate().toColorspace("srgb").png().toBuffer();
  } catch {
    throw new ProviderRequestError("DashScope image download was not a valid image", {
      provider: "dashscope",
    });
  }
}

export function createDashScopeVisionProvider({ env = {}, fetchImpl = fetch } = {}) {
  const configurationIssues = () => [
    !setting(env, "DASHSCOPE_API_KEY").trim() && "DASHSCOPE_API_KEY",
  ].filter(Boolean);

  return {
    id: "dashscope",
    credentialLabel: "DASHSCOPE_API_KEY",
    configurationIssues,
    isConfigured: () => configurationIssues().length === 0,
    async analyze({ image, mime = "image/png" }) {
      const key = setting(env, "DASHSCOPE_API_KEY");
      if (!key) {
        throw new ProviderRequestError("DASHSCOPE_API_KEY is not configured", {
          provider: "dashscope",
        });
      }

      const prepared = await prepareVisionImage(image, mime);
      const response = await fetchImpl(`${compatibleBaseUrl(env)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: setting(env, "DASHSCOPE_VISION_MODEL", "qwen3.6-flash"),
          messages: [{
            role: "user",
            content: [
              {
                type: "text",
                text: `${WARDROBE_ANALYSIS_PROMPT}\nReturn a JSON object with a top-level "items" array (even for one garment). Each array element must contain actual observed values for name, part, color, secondaryColor, tags and boundingBox. Do not return the schema itself. If no garment is visible, return {"items":[]}. Your output must conform to this JSON Schema:\n${JSON.stringify(WARDROBE_ITEMS_SCHEMA)}`,
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${prepared.mime};base64,${prepared.image.toString("base64")}`,
                },
              },
            ],
          }],
          stream: false,
          enable_thinking: false,
          response_format: { type: "json_object" },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw dashScopeError(result, response, `DashScope vision request failed (${response.status})`);
      }

      const outputText = contentText(result.choices?.[0]?.message?.content);
      if (!outputText) {
        throw new ProviderRequestError("DashScope vision response did not contain JSON text", {
          provider: "dashscope",
          requestId: requestId(response, result),
        });
      }
      try {
        return parseWardrobeItems(outputText);
      } catch (error) {
        throw new ProviderRequestError(`DashScope vision response was invalid: ${error.message}`, {
          provider: "dashscope",
          requestId: requestId(response, result),
        });
      }
    },
  };
}

export function createDashScopeImageProvider({ env = {}, fetchImpl = fetch } = {}) {
  const configurationIssues = () => [
    !setting(env, "DASHSCOPE_API_KEY").trim() && "DASHSCOPE_API_KEY",
  ].filter(Boolean);

  return {
    id: "dashscope",
    credentialLabel: "DASHSCOPE_API_KEY",
    configurationIssues,
    isConfigured: () => configurationIssues().length === 0,
    async edit({ purpose, prompt, images, size }) {
      const key = setting(env, "DASHSCOPE_API_KEY");
      if (!key) {
        throw new ProviderRequestError("DASHSCOPE_API_KEY is not configured", {
          provider: "dashscope",
        });
      }
      const expectedImages = {
        garment: 1,
        modeled: 2,
        outfit: 3,
      }[purpose];
      if (!expectedImages) {
        throw new ProviderRequestError(`DashScope image purpose is unsupported: ${purpose}`, {
          provider: "dashscope",
        });
      }
      if (!Array.isArray(images) || images.length !== expectedImages) {
        throw new ProviderRequestError(
          `DashScope ${purpose} image edit requires exactly ${expectedImages} input image${expectedImages === 1 ? "" : "s"}`,
          { provider: "dashscope" },
        );
      }

      const preparedImages = await Promise.all(images.map(prepareEditImage));
      const content = preparedImages.map((image) => ({
        image: `data:${image.mime};base64,${image.image.toString("base64")}`,
      }));
      content.push({ text: prompt });
      const model = purpose === "outfit"
        ? setting(
          env,
          "DASHSCOPE_OUTFIT_MODEL",
          setting(env, "DASHSCOPE_IMAGE_MODEL", "qwen-image-2.0"),
        )
        : setting(env, "DASHSCOPE_IMAGE_MODEL", "qwen-image-2.0");

      const response = await fetchImpl(`${apiBaseUrl(env)}/services/aigc/multimodal-generation/generation`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: {
            messages: [{
              role: "user",
              content,
            }],
          },
          parameters: {
            n: 1,
            size: `${size.width}*${size.height}`,
            watermark: false,
            ...(purpose === "outfit" ? { prompt_extend: false } : {}),
          },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw dashScopeError(result, response, `DashScope image request failed (${response.status})`);
      }

      const temporaryUrl = outputImageUrl(result);
      if (!temporaryUrl) {
        throw new ProviderRequestError("DashScope image response did not contain an image URL", {
          provider: "dashscope",
          requestId: requestId(response, result),
        });
      }
      return downloadPng(temporaryUrl, fetchImpl);
    },
  };
}
