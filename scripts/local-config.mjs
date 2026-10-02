import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

export const LOCAL_PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

// Local entry point: do not pass copied Meoo/Supabase credentials to services.
const LOCAL_ENV_KEYS = [
  "WARDROBE_VISION_PROVIDER", "WARDROBE_IMAGE_PROVIDER",
  "WARDROBE_DATA_DIR", "WARDROBE_MODEL_REFERENCE",
  "DASHSCOPE_API_KEY", "DASHSCOPE_COMPATIBLE_BASE_URL", "DASHSCOPE_API_BASE_URL",
  "DASHSCOPE_VISION_MODEL", "DASHSCOPE_IMAGE_MODEL", "DASHSCOPE_OUTFIT_MODEL",
  "OPENAI_API_KEY", "OPENAI_API_BASE_URL", "OPENAI_VISION_MODEL",
  "OPENAI_IMAGE_MODEL", "OPENAI_OUTFIT_MODEL", "OPENAI_IMAGE_QUALITY",
];

export function loadLocalConfig(mode = "development") {
  const source = loadEnv(mode, LOCAL_PROJECT_ROOT, "");
  const env = Object.fromEntries(LOCAL_ENV_KEYS.filter((key) => source[key] !== undefined)
    .map((key) => [key, source[key]]));
  for (const key of ["WARDROBE_VISION_PROVIDER", "WARDROBE_IMAGE_PROVIDER"]) {
    env[key] = env[key]?.trim().toLowerCase() || "dashscope";
    if (!["dashscope", "openai"].includes(env[key])) {
      throw new Error(`${key} must be dashscope or openai in this local copy`);
    }
  }
  env.WARDROBE_DATA_DIR ||= "data";
  env.WARDROBE_MODEL_REFERENCE ||= path.join(env.WARDROBE_DATA_DIR, "model-reference.png");
  return {
    root: LOCAL_PROJECT_ROOT,
    env,
    paths: {
      dataRoot: path.resolve(LOCAL_PROJECT_ROOT, env.WARDROBE_DATA_DIR),
      referenceFile: path.resolve(LOCAL_PROJECT_ROOT, env.WARDROBE_MODEL_REFERENCE),
    },
  };
}
