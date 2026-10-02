import {
  ProviderRequestError,
  WARDROBE_ANALYSIS_PROMPT,
  WARDROBE_ITEMS_SCHEMA,
  parseWardrobeItems,
  setting,
} from "./contracts.mjs";

function apiBaseUrl(env) {
  return setting(env, "OPENAI_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
}

async function responseJson(response) {
  return response.json().catch(() => ({}));
}

function openAIError(result, response, fallback) {
  return new ProviderRequestError(result.error?.message || fallback, {
    provider: "openai",
    status: response.status,
    requestId: response.headers.get("x-request-id"),
  });
}

export function createOpenAIVisionProvider({ env = {}, fetchImpl = fetch } = {}) {
  const configurationIssues = () => [
    !setting(env, "OPENAI_API_KEY").trim() && "OPENAI_API_KEY",
  ].filter(Boolean);

  return {
    id: "openai",
    credentialLabel: "OPENAI_API_KEY",
    configurationIssues,
    isConfigured: () => configurationIssues().length === 0,
    async analyze({ image, mime = "image/png" }) {
      const key = setting(env, "OPENAI_API_KEY");
      if (!key) throw new ProviderRequestError("OPENAI_API_KEY is not configured", { provider: "openai" });
      const response = await fetchImpl(`${apiBaseUrl(env)}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: setting(env, "OPENAI_VISION_MODEL", "gpt-5.4-mini"),
          input: [{
            role: "user",
            content: [
              { type: "input_text", text: WARDROBE_ANALYSIS_PROMPT },
              { type: "input_image", image_url: `data:${mime};base64,${image.toString("base64")}` },
            ],
          }],
          text: {
            format: {
              type: "json_schema",
              name: "wardrobe_items",
              strict: true,
              schema: WARDROBE_ITEMS_SCHEMA,
            },
          },
        }),
      });
      const result = await responseJson(response);
      if (!response.ok) throw openAIError(result, response, `OpenAI analysis failed (${response.status})`);
      const outputText = result.output_text
        || result.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
      if (!outputText) throw new ProviderRequestError("OpenAI analysis returned no structured result", { provider: "openai" });
      return parseWardrobeItems(outputText);
    },
  };
}

export function createOpenAIImageProvider({ env = {}, fetchImpl = fetch } = {}) {
  const configurationIssues = () => [
    !setting(env, "OPENAI_API_KEY").trim() && "OPENAI_API_KEY",
  ].filter(Boolean);

  return {
    id: "openai",
    credentialLabel: "OPENAI_API_KEY",
    configurationIssues,
    isConfigured: () => configurationIssues().length === 0,
    async edit({ purpose, prompt, images, size }) {
      const key = setting(env, "OPENAI_API_KEY");
      if (!key) throw new ProviderRequestError("OPENAI_API_KEY is not configured", { provider: "openai" });
      const imageModel = setting(env, "OPENAI_IMAGE_MODEL", "gpt-image-2");
      const model = purpose === "garment"
        ? setting(env, "OPENAI_GARMENT_MODEL", imageModel)
        : purpose === "outfit"
          ? setting(env, "OPENAI_OUTFIT_MODEL", setting(env, "OPENAI_MODELED_MODEL", imageModel))
          : setting(env, "OPENAI_MODELED_MODEL", imageModel);
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      form.set("size", `${size.width}x${size.height}`);
      form.set("quality", setting(env, "OPENAI_IMAGE_QUALITY", "high"));
      form.set("output_format", "png");
      for (const [index, image] of images.entries()) {
        form.append(
          "image[]",
          new Blob([image.data], { type: image.mime || "image/png" }),
          image.name?.replace(/\.[^.]+$/, ".png") || `image-${index + 1}.png`,
        );
      }
      const response = await fetchImpl(`${apiBaseUrl(env)}/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      const result = await responseJson(response);
      if (!response.ok) throw openAIError(result, response, `OpenAI image request failed (${response.status})`);
      const encoded = result.data?.[0]?.b64_json;
      if (!encoded) throw new ProviderRequestError("OpenAI response did not contain image data", { provider: "openai" });
      return Buffer.from(encoded, "base64");
    },
  };
}
