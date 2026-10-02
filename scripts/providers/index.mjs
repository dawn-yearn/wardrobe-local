import { createDashScopeImageProvider, createDashScopeVisionProvider } from "./dashscope.mjs";
import { createOpenAIImageProvider, createOpenAIVisionProvider } from "./openai.mjs";
import { setting } from "./contracts.mjs";

function providerId(env, name, fallback) {
  return setting(env, name, fallback).trim().toLowerCase();
}

function defaultProvider(env) {
  return "dashscope";
}

export function createVisionProvider({ env = {}, fetchImpl = fetch } = {}) {
  const id = providerId(env, "WARDROBE_VISION_PROVIDER", defaultProvider(env));
  if (id === "openai") return createOpenAIVisionProvider({ env, fetchImpl });
  if (id === "dashscope") return createDashScopeVisionProvider({ env, fetchImpl });
  throw new Error(`Unsupported wardrobe vision provider: ${id}`);
}

export function createImageProvider({ env = {}, fetchImpl = fetch } = {}) {
  const id = providerId(env, "WARDROBE_IMAGE_PROVIDER", defaultProvider(env));
  if (id === "openai") return createOpenAIImageProvider({ env, fetchImpl });
  if (id === "dashscope") return createDashScopeImageProvider({ env, fetchImpl });
  throw new Error(`Unsupported wardrobe image provider: ${id}`);
}
