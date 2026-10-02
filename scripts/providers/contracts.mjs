export const WARDROBE_PARTS = Object.freeze([
  "upperbody",
  "wholebody_up",
  "lowerbody",
  "accessories_up",
  "shoes",
]);

export const WARDROBE_ANALYSIS_PROMPT = "Identify every distinct wearable clothing item visible in this image. A photo may show one isolated garment or a person wearing several items. Return one record per actual item that should enter a wardrobe. Ignore the person's body and non-wearable background objects. For each item, include a tight bounding box around only that item using integer coordinates normalized to a 1000 by 1000 image: x and y are the top-left corner, followed by width and height. Boxes may overlap when garments overlap, but each box must focus on one distinct item. Use only these category ids: upperbody, wholebody_up, lowerbody, accessories_up, shoes. Suggest a concise specific name, primary hex color, optional genuinely distinct secondary hex color, and 1-4 useful lowercase detail tags. Return JSON only.";

export const WARDROBE_ITEMS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          part: { type: "string", enum: WARDROBE_PARTS },
          color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
          secondaryColor: {
            anyOf: [
              { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
              { type: "null" },
            ],
          },
          tags: { type: "array", items: { type: "string" }, maxItems: 4 },
          boundingBox: {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "integer", minimum: 0, maximum: 999 },
              y: { type: "integer", minimum: 0, maximum: 999 },
              width: { type: "integer", minimum: 1, maximum: 1000 },
              height: { type: "integer", minimum: 1, maximum: 1000 },
            },
            required: ["x", "y", "width", "height"],
          },
        },
        required: ["name", "part", "color", "secondaryColor", "tags", "boundingBox"],
      },
    },
  },
  required: ["items"],
});

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PART_SET = new Set(WARDROBE_PARTS);

export function setting(env, name, fallback = "") {
  return env?.[name] || process.env[name] || fallback;
}

export function parseJsonText(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Model response did not contain JSON text");
  }

  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace > 0 || lastBrace < candidate.length - 1) {
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("Model response did not contain a JSON object");
    }
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("Model response contained invalid JSON");
  }
}

export function validateWardrobeItems(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.items)) {
    throw new Error("Model response must contain an items array");
  }
  if (value.items.length > 8) throw new Error("Model response contained more than 8 clothing items");

  for (const [index, item] of value.items.entries()) {
    const label = `items[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} must be an object`);
    if (typeof item.name !== "string" || !item.name.trim()) throw new Error(`${label}.name must be a non-empty string`);
    if (!PART_SET.has(item.part)) throw new Error(`${label}.part is invalid`);
    if (typeof item.color !== "string" || !HEX_COLOR.test(item.color)) throw new Error(`${label}.color must be a six-digit hex color`);
    if (item.secondaryColor !== null && (typeof item.secondaryColor !== "string" || !HEX_COLOR.test(item.secondaryColor))) {
      throw new Error(`${label}.secondaryColor must be null or a six-digit hex color`);
    }
    if (!Array.isArray(item.tags) || item.tags.length > 4 || item.tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`${label}.tags must be an array of at most 4 strings`);
    }
    const box = item.boundingBox;
    if (!box || typeof box !== "object" || Array.isArray(box)) throw new Error(`${label}.boundingBox must be an object`);
    for (const [field, minimum, maximum] of [
      ["x", 0, 999],
      ["y", 0, 999],
      ["width", 1, 1000],
      ["height", 1, 1000],
    ]) {
      if (!Number.isInteger(box[field]) || box[field] < minimum || box[field] > maximum) {
        throw new Error(`${label}.boundingBox.${field} is invalid`);
      }
    }
  }

  return value.items;
}

export function parseWardrobeItems(text) {
  return validateWardrobeItems(parseJsonText(text));
}

export class ProviderRequestError extends Error {
  constructor(message, { provider, status = null, requestId = null, endpoint = null, responseBody = null, requestBytes = null } = {}) {
    super(message);
    this.name = "ProviderRequestError";
    this.provider = provider || "unknown";
    this.status = status;
    this.requestId = requestId;
    this.endpoint = endpoint;
    this.responseBody = typeof responseBody === "string" ? responseBody.slice(0, 4000) : null;
    this.requestBytes = Number.isFinite(requestBytes) ? requestBytes : null;
  }
}
