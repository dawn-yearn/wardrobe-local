import { localMutationHandler, readLocalJson } from "./local-store.mjs";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createImageProvider, createVisionProvider } from "./providers/index.mjs";
import { authenticateRequest, jsonError } from "./auth.mjs";
import { requireAiAccess } from "./ai-access.mjs";
import { reviewActionState } from "../src/import-job-state.js";

const API_ROOT = "/api/import/jobs";
const ASSET_ROOT = "/api/import/assets";
const LIBRARY_ASSET_ROOT = "/api/import/library";
const STAGES = new Set(["crop", "garment", "modeled"]);
const DECISIONS = new Set(["approve", "reject"]);
const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Expected a JSON request body"), { status: 400 }); }
}

function publicJob(job) {
  const copy = structuredClone(job);
  delete copy.internal;
  return copy;
}

function extension(mime = "image/png") {
  return ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" })[mime] || "png";
}

function normalizeMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const color = typeof metadata.color === "string" && HEX_COLOR.test(metadata.color) ? metadata.color.toLowerCase() : "#d8d0c2";
  const secondaryColor = typeof metadata.secondaryColor === "string" && HEX_COLOR.test(metadata.secondaryColor) ? metadata.secondaryColor.toLowerCase() : null;
  return {
    name: typeof metadata.name === "string" ? metadata.name.trim().slice(0, 120) || "New piece" : "New piece",
    part: PARTS.has(metadata.part) ? metadata.part : "upperbody",
    color,
    secondaryColor,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 12) : [],
    boundingBox: normalizeBoundingBox(metadata.boundingBox),
  };
}

function normalizeBoundingBox(value = {}) {
  const box = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback) => Number.isFinite(Number(box[key])) ? Math.round(Number(box[key])) : fallback;
  const x = Math.max(0, Math.min(999, number("x", 0)));
  const y = Math.max(0, Math.min(999, number("y", 0)));
  const width = Math.max(1, Math.min(1000 - x, number("width", 1000 - x)));
  const height = Math.max(1, Math.min(1000 - y, number("height", 1000 - y)));
  return { x, y, width, height };
}

async function normalizeImage(bytes) {
  return sharp(bytes).rotate().toColorspace("srgb").png().toBuffer();
}

export function normalizeManualMetadata(value = {}) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = (name, limit) => typeof metadata[name] === "string" ? metadata[name].trim().slice(0, limit) : "";
  const part = text("part", 40) || text("category", 40);
  const color = text("color", 20) || text("primaryColor", 20);
  const secondaryColor = text("secondaryColor", 20);
  return {
    name: text("name", 120),
    part: PARTS.has(part) ? part : null,
    color: HEX_COLOR.test(color) ? color.toLowerCase() : null,
    secondaryColor: HEX_COLOR.test(secondaryColor) ? secondaryColor.toLowerCase() : null,
    tags: Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean).slice(0, 20) : text("tags", 500).split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 20),
  };
}

async function normalizeProviderImage(image) {
  return {
    ...image,
    data: await normalizeImage(image.data),
    mime: "image/png",
    name: image.name?.replace(/\.[^.]+$/, ".png") || "image.png",
  };
}

async function cropDetectedItem(bytes, boundingBox) {
  const normalized = await normalizeImage(bytes);
  const { width, height } = await sharp(normalized).metadata();
  const box = normalizeBoundingBox(boundingBox);
  const rawLeft = (box.x / 1000) * width;
  const rawTop = (box.y / 1000) * height;
  const rawWidth = (box.width / 1000) * width;
  const rawHeight = (box.height / 1000) * height;
  const padding = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
  const left = Math.max(0, Math.floor(rawLeft - padding));
  const top = Math.max(0, Math.floor(rawTop - padding));
  const right = Math.min(width, Math.ceil(rawLeft + rawWidth + padding));
  const bottom = Math.min(height, Math.ceil(rawTop + rawHeight + padding));
  return sharp(normalized).extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }).png().toBuffer();
}

function chooseChromaKey(primary = "#808080") {
  const value = HEX_COLOR.test(primary) ? primary : "#808080";
  const source = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const candidates = [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
  const selected = candidates.sort((a, b) => {
    const distance = (color) => color.reduce((total, channel, index) => total + ((channel - source[index]) ** 2), 0);
    return distance(b) - distance(a);
  })[0];
  return `#${selected.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function buildGarmentPrompt(metadata = {}, chromaKey = "#00ff00") {
  const name = metadata.name || "clothing item";
  const category = metadata.part || "wardrobe item";
  const primary = metadata.color || "the exact visible color";
  const secondary = metadata.secondaryColor ? ` with distinct secondary color ${metadata.secondaryColor}` : "";
  const details = Array.isArray(metadata.tags) && metadata.tags.length
    ? metadata.tags.join(", ")
    : "all visible construction and design details";

  return `Use case: background-extraction
Asset type: ecommerce catalog product cutout source

Input image: The reference photograph shows the exact garment, either by itself or worn by a person. Use it only to identify and reconstruct the garment.

Primary request: Reconstruct ONLY the complete empty ${name} (${category}) as a clean, front-facing ecommerce catalog product photograph. If a wearer is present, remove them. Remove every other garment, object, and background element. Show the complete item naturally arranged and symmetrical, with no person, body, mannequin, or hanger visible.

Garment fidelity: Preserve the reference garment's exact primary color ${primary}${secondary}, material and texture, silhouette, neckline, sleeves, fastenings, pattern, and distinctive details (${details}). Preserve any clearly legible existing graphic or logo exactly, but do not invent or reinterpret uncertain logos, text, pockets, seams, hardware, colors, or decoration.

Composition: Centered straight-on product view. Keep the entire garment inside the frame with generous, even padding on every side. No cropping or truncation.

Background: Perfectly flat, absolutely uniform solid ${chromaKey} chroma-key color, edge-to-edge. No shadows, gradient, texture, vignette, floor, horizon, reflection, or lighting variation.

Lighting: Neutral diffuse product lighting contained on the garment only.

Avoid: person, body, skin, hair, mannequin, hanger, props, other garments, retail tags, cast shadow, contact shadow, reflection, watermark, caption, border, background variation, or chroma spill.

Critical: Use no ${chromaKey} anywhere in the garment. Produce exactly one complete garment with a crisp, separable outer silhouette.`;
}

function cleanupTolerance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(18, Math.min(110, Math.round(parsed))) : 46;
}

function removeKeyedSpill(data, index, keyedChannels, neutralLevel) {
  let remaining = Math.ceil(keyedChannels.reduce((total, channel) => total + data[index + channel], 0) - (neutralLevel * keyedChannels.length));
  let active = keyedChannels.filter((channel) => data[index + channel] > 0);
  while (remaining > 0 && active.length) {
    const share = Math.ceil(remaining / active.length);
    const next = [];
    for (const channel of active) {
      const reduction = Math.min(data[index + channel], share, remaining);
      data[index + channel] -= reduction;
      remaining -= reduction;
      if (data[index + channel] > 0) next.push(channel);
    }
    active = next;
  }
}

export async function processChromaBackground(bytes, key, options = {}) {
  const tolerance = cleanupTolerance(options.tolerance);
  const feather = 80;
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += 4) {
    const distance = Math.sqrt(
      ((data[index] - target[0]) ** 2)
      + ((data[index + 1] - target[1]) ** 2)
      + ((data[index + 2] - target[2]) ** 2),
    );
    if (distance <= tolerance) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    } else {
      if (distance < tolerance + feather) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / feather));
      const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
      const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
      const spill = Math.max(0, keyedLevel - neutralLevel);
      if (spill > 0) {
        const spillAlpha = Math.max(0, 1 - (Math.max(0, spill - 4) / 150));
        data[index + 3] = Math.round(data[index + 3] * spillAlpha);
        removeKeyedSpill(data, index, keyedChannels, neutralLevel);
      }
      if (data[index + 3] <= 8) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
      }
    }
  }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill > 0) {
      removeKeyedSpill(data, index, keyedChannels, neutralLevel);
    }
  }
  const keyedOutput = await sharp(data, { raw: info }).png().toBuffer();
  const framedOutput = await frameTransparentGarment(keyedOutput);
  const { data: framedData, info: framedInfo } = await sharp(framedOutput).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < framedData.length; index += 4) {
    if (framedData[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + framedData[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + framedData[index + channel], 0) / neutralChannels.length;
    const residualSpill = Math.max(0, keyedLevel - neutralLevel);
    if (residualSpill <= 0) continue;
    removeKeyedSpill(framedData, index, keyedChannels, neutralLevel);
  }
  const output = await sharp(framedData, { raw: framedInfo }).png().toBuffer();
  const verification = await verifyNoChromaSpill(output, key);
  return { bytes: output, verification, tolerance };
}

export async function removeChromaBackground(bytes, key, options = {}) {
  const result = await processChromaBackground(bytes, key, options);
  if (options.strict !== false && result.verification.contaminatedPixels > 1) {
    throw new Error(`Background cleanup left ${result.verification.contaminatedPixels} chroma-contaminated pixels`);
  }
  return result.bytes;
}

export async function frameTransparentGarment(bytes, canvasSize = 1024, occupancy = 0.88) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index + 3] <= 8) continue;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error("Background removal did not leave a visible garment");

  const trimmed = await sharp(data, { raw: info })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
  const targetSize = Math.max(1, Math.round(canvasSize * Math.max(0.5, Math.min(0.96, occupancy))));
  const resized = await sharp(trimmed)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.floor((canvasSize - resized.info.width) / 2);
  const top = Math.floor((canvasSize - resized.info.height) / 2);
  return sharp({ create: { width: canvasSize, height: canvasSize, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

async function verifyNoChromaSpill(bytes, key) {
  const target = [1, 3, 5].map((offset) => Number.parseInt(key.slice(offset, offset + 2), 16));
  const keyedChannels = target.map((channel, index) => channel > 200 ? index : null).filter((index) => index !== null);
  const neutralChannels = target.map((channel, index) => channel < 55 ? index : null).filter((index) => index !== null);
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let contaminatedPixels = 0;
  let maxSpill = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const keyedLevel = keyedChannels.reduce((total, channel) => total + data[index + channel], 0) / keyedChannels.length;
    const neutralLevel = neutralChannels.reduce((total, channel) => total + data[index + channel], 0) / neutralChannels.length;
    const spill = Math.max(0, keyedLevel - neutralLevel);
    maxSpill = Math.max(maxSpill, spill);
    if (spill > 1.5) contaminatedPixels += 1;
  }
  return { contaminatedPixels, maxSpill };
}

async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(tmp, file);
  } catch (error) {
    if (!["EBUSY", "EXDEV", "EPERM"].includes(error.code)) {
      await rm(tmp, { force: true });
      throw error;
    }
    await copyFile(tmp, file);
    await rm(tmp, { force: true });
  }
}

function stageState() {
  return { status: "pending", decision: null, attempts: 0, assetUrl: null, failedAssetUrl: null, cleanupPreviewUrl: null, cleanupTolerance: 46, cleanupDiagnostics: null, error: null, prompt: null, updatedAt: null };
}

export function wardrobeImportApi(options = {}) {
  let root;
  let dataRoot;
  const running = new Map();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const visionProvider = options.visionProvider || createVisionProvider({ env: options.env });
  const imageProvider = options.imageProvider || createImageProvider({ env: options.env });

  function scope(userId) {
    if (options.local) return options.local.paths;
    const root = path.join(dataRoot, "users", userId);
    return {
      root,
      jobsDir: path.join(root, "jobs"),
      importedFile: path.join(root, "library.json"),
      libraryAssetDir: path.join(root, "imported"),
      referenceFile: path.join(root, "profile-reference.png"),
    };
  }

  async function currentUser(req) {
    if (options.local) return options.local.currentUser();
    const user = await authenticateRequest(req, { env: options.env, verify: options.verify });
    if (!options.cloud?.enabled) throw Object.assign(new Error("Cloud persistence is required for multi-user mode"), { status: 503 });
    const profile = await options.cloud.ensureUserProfile(user);
    return { user, profile };
  }

  async function consumeStorageImage(input, userId, storageScope, onPhase = () => {}) {
    if (options.local) return options.local.readUpload(input?.upload_id, storageScope);
    onPhase("image_key_validation");
    if (input?.imageDataUrl || input?.imageBase64) {
      throw Object.assign(new Error("Base64 image payloads are no longer accepted; upload to Storage and submit image_key"), { status: 400 });
    }
    if (typeof input?.image_key !== "string" || !input.image_key) {
      throw Object.assign(new Error("image_key is required"), { status: 400 });
    }
    onPhase("storage_read");
    const data = await options.cloud.downloadUserImage(userId, input.image_key, storageScope);
    if (!data?.length) throw Object.assign(new Error("Storage image is empty"), { status: 400 });
    return { data, imageKey: input.image_key };
  }

  async function removeConsumedImage(userId, imageKey, storageScope) {
    if (options.local) return options.local.removeUpload(imageKey, storageScope);
    try { await options.cloud.removeUserImage?.(userId, imageKey, storageScope); }
    catch (error) { console.error("Temporary Storage image cleanup failed", { storageScope, message: error.message }); }
  }

  async function modelReferencePath(userId) {
    const paths = scope(userId);
    if (options.cloud?.enabled && options.cloud.ensureUserReferenceFile) {
      return (await options.cloud.ensureUserReferenceFile(userId, paths.referenceFile)) ? paths.referenceFile : null;
    }
    if (options.local) {
      try { return (await stat(options.local.paths.referenceFile)).isFile() ? options.local.paths.referenceFile : null; }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }
    const referenceSetting = setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png");
    const file = path.resolve(root, referenceSetting);
    try { return (await stat(file)).isFile() ? file : null; } catch { return null; }
  }

  async function setupStatus(userId, profile) {
    const hasApiKey = visionProvider.isConfigured() && imageProvider.isConfigured();
    const missingConfiguration = [
      ...(visionProvider.configurationIssues?.() || []),
      ...(imageProvider.configurationIssues?.() || []),
    ].filter((value, index, values) => values.indexOf(value) === index);
    const referenceSetting = profile?.reference_image_url || "用户信息中的人物参考照片";
    const referencePath = await modelReferencePath(userId);
    const hasModelReference = Boolean(referencePath);
    return {
      // Importing and saving a garment is a wardrobe capability; the person
      // reference is only required by the optional modeled-image stage.
      ready: hasApiKey,
      hasApiKey,
      hasModelReference,
      modelReference: referenceSetting,
      visionProvider: visionProvider.id,
      imageProvider: imageProvider.id,
      missingConfiguration,
    };
  }

  function jobAssetNames(job) {
    const names = new Set([job.internal?.originalFile, job.internal?.cropFile]);
    for (const stage of Object.values(job.stages || {})) {
      for (const value of [stage?.assetUrl, stage?.failedAssetUrl, stage?.cleanupPreviewUrl]) {
        if (typeof value !== "string") continue;
        names.add(path.basename(new URL(value, "http://localhost").pathname));
      }
    }
    return [...names].filter(Boolean);
  }

  async function ensureJobAssets(job, userId) {
    if (!options.cloud?.enabled || !options.cloud.downloadJobAsset) return;
    const { jobsDir } = scope(userId);
    const dir = path.join(jobsDir, job.id);
    await mkdir(dir, { recursive: true });
    for (const filename of jobAssetNames(job)) {
      const file = path.join(dir, filename);
      try {
        if ((await stat(file)).isFile()) continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const bytes = await options.cloud.downloadJobAsset(userId, job.id, filename);
      if (bytes) await writeFile(file, bytes);
    }
  }

  async function loadJob(id, userId) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    if (options.cloud?.enabled && options.cloud.getGenerationJob) {
      const cloudJob = await options.cloud.getGenerationJob(id, userId);
      if (cloudJob) {
        await ensureJobAssets(cloudJob, userId);
        await atomicJson(path.join(scope(userId).jobsDir, id, "job.json"), cloudJob);
        return cloudJob;
      }
    }
    try { return JSON.parse(await readFile(path.join(scope(userId).jobsDir, id, "job.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  async function saveJob(job, userId, assets = []) {
    const { jobsDir } = scope(userId);
    job.updatedAt = new Date().toISOString();
    await mkdir(path.join(jobsDir, job.id), { recursive: true });
    await atomicJson(path.join(jobsDir, job.id, "job.json"), job);
    if (options.cloud?.enabled) {
      for (const filename of [...new Set(assets)].filter(Boolean)) {
        await options.cloud.uploadJobAsset(userId, job.id, filename, path.join(jobsDir, job.id, filename));
      }
      await options.cloud.upsertGenerationJob(job, { jobType: "import", userId });
    }
  }

  async function deleteJob(job, userId) {
    const { jobsDir } = scope(userId);
    await rm(path.join(jobsDir, job.id), { recursive: true, force: true });
    if (options.cloud?.enabled) {
      await options.cloud.deleteGenerationJob(job.id, userId);
      await options.cloud.deleteJobAssets(userId, job.id, jobAssetNames(job));
    }
  }

  async function loadImported(userId) {
    const { importedFile, libraryAssetDir } = scope(userId);
    if (options.cloud?.enabled) {
      await mkdir(libraryAssetDir, { recursive: true });
      await options.cloud.hydrateWardrobe({ userId, libraryFile: importedFile, libraryAssetDir });
    }
    if (options.local) {
      const records = await readLocalJson(importedFile, []);
      if (!Array.isArray(records)) throw new Error("library.json 必须包含衣物数组，请从备份恢复。");
      return records;
    }
    try { return JSON.parse(await readFile(importedFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async function persistImported(job, userId, includeModeled = false) {
    const { jobsDir, importedFile, libraryAssetDir } = scope(userId);
    const id = `import-${job.id}`;
    await mkdir(libraryAssetDir, { recursive: true });
    const garmentName = `${id}-garment.png`;
    const garmentSource = job.stages.garment.assetUrl
      ? path.basename(new URL(job.stages.garment.assetUrl, "http://localhost").pathname)
      : `garment-${job.stages.garment.attempts}.png`;
    await copyFile(path.join(jobsDir, job.id, garmentSource), path.join(libraryAssetDir, garmentName));
    let modeledImage = null;
    if (includeModeled) {
      const modeledName = `${id}-modeled.png`;
      const modeledSource = job.stages.modeled.assetUrl
        ? path.basename(new URL(job.stages.modeled.assetUrl, "http://localhost").pathname)
        : `modeled-${job.stages.modeled.attempts}.png`;
      await copyFile(path.join(jobsDir, job.id, modeledSource), path.join(libraryAssetDir, modeledName));
      modeledImage = `${LIBRARY_ASSET_ROOT}/${modeledName}`;
    }
    const metadata = job.metadata || {};
    const records = await loadImported(userId);
    const existing = records.find((record) => record.id === id);
    let record = {
      id,
      name: metadata.name || "New piece",
      part: metadata.part || "upperbody",
      color: metadata.color || "#d8d0c2",
      secondaryColor: metadata.secondaryColor || null,
      palette: [metadata.color, metadata.secondaryColor].filter(Boolean),
      tags: Array.isArray(metadata.tags) ? metadata.tags : [],
      image: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      thumbnail: `${LIBRARY_ASSET_ROOT}/${garmentName}`,
      modeledImage: modeledImage || existing?.modeledImage || null,
      importJobId: job.id,
    };
    if (options.cloud?.enabled) {
      record = (await options.cloud.upsertWardrobeRecord(record, {
        image: path.join(libraryAssetDir, garmentName),
        modeledImage: modeledImage ? path.join(libraryAssetDir, path.basename(modeledImage)) : null,
      }, userId)) || record;
    }
    const next = [...records.filter((item) => item.id !== id), record];
    await atomicJson(importedFile, next);
    return record;
  }

  async function generate(job, userId, stageName) {
    const lock = `${job.id}:${stageName}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const current = await loadJob(job.id, userId);
      const stage = current.stages[stageName];
      stage.status = "processing"; stage.decision = null; stage.error = null; stage.attempts += 1; stage.updatedAt = new Date().toISOString();
      await saveJob(current, userId);
      let failedAssetUrl = null;
      let chromaKeyUsed = null;
      try {
        const dir = path.join(scope(userId).jobsDir, current.id);
        const output = path.join(dir, `${stageName}-${stage.attempts}.png`);
        const sourceFile = stageName === "garment" && current.internal.cropFile ? current.internal.cropFile : current.internal.originalFile;
        const original = { data: await readFile(path.join(dir, sourceFile)), mime: "image/png", name: sourceFile };
        let bytes;
        if (stageName === "garment") {
          chromaKeyUsed = chooseChromaKey(current.metadata.color);
          const basePrompt = options.garmentPrompt || buildGarmentPrompt(current.metadata, chromaKeyUsed);
          bytes = await imageProvider.edit({
            purpose: "garment",
            images: [await normalizeProviderImage(original)],
            prompt: current.stages.garment.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.garment.prompt}` : basePrompt,
            size: { width: 1024, height: 1024 },
          });
          const rawName = `${stageName}-${stage.attempts}-source.png`;
          await writeFile(path.join(dir, rawName), bytes);
          failedAssetUrl = `${ASSET_ROOT}/${current.id}/${rawName}`;
          bytes = await removeChromaBackground(bytes, chromaKeyUsed);
        } else {
          const garmentName = current.stages.garment.assetUrl
            ? path.basename(new URL(current.stages.garment.assetUrl, "http://localhost").pathname)
            : `garment-${current.stages.garment.attempts}.png`;
          const garmentFile = path.join(dir, garmentName);
          const garment = { data: await readFile(garmentFile), mime: "image/png", name: "garment.png" };
          const modelPath = await modelReferencePath(userId);
          let modelData;
          try {
            modelData = await readFile(modelPath);
          } catch (error) {
            if (error.code === "ENOENT" || !modelPath) throw new Error("请先在“用户信息”上传人物参考照片");
            throw error;
          }
          const model = { data: modelData, mime: "image/png", name: "model.png" };
          const basePrompt = options.modeledPrompt || "Create a professional horizontal 3:2 editorial fashion photograph of the person in Image 1 wearing the exact garment from Image 2. Preserve the person's recognizable identity, face, hair, age and proportions. Preserve every garment color, material, fit, construction, graphic, logo and distinctive detail. Keep the complete featured item clearly visible and unobstructed, use understated neutral supporting clothes, realistic anatomy, natural light, authentic fabric, a tasteful real-world setting, and leave environmental space around the model. No text, watermark, product mockup, or synthetic appearance.";
          bytes = await imageProvider.edit({
            purpose: "modeled",
            images: await Promise.all([model, garment].map(normalizeProviderImage)),
            prompt: current.stages.modeled.prompt ? `${basePrompt}\nUser regeneration direction: ${current.stages.modeled.prompt}` : basePrompt,
            size: { width: 1536, height: 1024 },
          });
        }
        await writeFile(output, bytes);
        const fresh = await loadJob(current.id, userId);
        fresh.stages[stageName].status = "review";
        fresh.stages[stageName].assetUrl = `${ASSET_ROOT}/${fresh.id}/${path.basename(output)}`;
        fresh.stages[stageName].failedAssetUrl = null;
        fresh.stages[stageName].cleanupPreviewUrl = null;
        fresh.stages[stageName].cleanupDiagnostics = null;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        fresh.stages[stageName].updatedAt = new Date().toISOString();
        await saveJob(fresh, userId, [path.basename(output), failedAssetUrl ? path.basename(new URL(failedAssetUrl, "http://localhost").pathname) : null]);
      } catch (error) {
        const fresh = await loadJob(current.id, userId);
        fresh.stages[stageName].status = "failed"; fresh.stages[stageName].error = error.message; fresh.stages[stageName].updatedAt = new Date().toISOString();
        if (typeof failedAssetUrl === "string") fresh.stages[stageName].failedAssetUrl = failedAssetUrl;
        if (chromaKeyUsed) fresh.stages[stageName].chromaKey = chromaKeyUsed;
        await saveJob(fresh, userId, [fresh.stages[stageName].failedAssetUrl ? path.basename(new URL(fresh.stages[stageName].failedAssetUrl, "http://localhost").pathname) : null]);
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/import/")) return next();
    res.setHeader("X-Open-Wardrobe-Handler", "import-v30");
    const requestId = randomUUID();
    let phase = "request_validation";
    let userId = null;
    let imageKey = null;
    try {
      const { user, profile } = await currentUser(req);
      userId = user.id;
      if (url.pathname === "/api/import/wardrobe" && req.method === "GET") {
        if (options.cloud?.listWardrobeRecords) return json(res, 200, await options.cloud.listWardrobeRecords(userId));
        return json(res, 200, await loadImported(userId));
      }
      if (url.pathname === "/api/import/wardrobe" && req.method === "POST") {
        const input = await body(req);
        const image = await consumeStorageImage(input, userId, "wardrobe");
        const normalized = await normalizeImage(image.data);
        const id = `import-${randomUUID()}`;
        const { importedFile, libraryAssetDir } = scope(userId);
        await mkdir(libraryAssetDir, { recursive: true });
        const filename = `${id}-garment.png`;
        await writeFile(path.join(libraryAssetDir, filename), normalized);
        const metadata = normalizeManualMetadata(input.metadata);
        let record = {
          id,
          ...metadata,
          image: `${LIBRARY_ASSET_ROOT}/${filename}`,
          thumbnail: `${LIBRARY_ASSET_ROOT}/${filename}`,
          modeledImage: null,
          palette: [],
        };
        const records = options.cloud?.listWardrobeRecords ? await options.cloud.listWardrobeRecords(userId) : await loadImported(userId);
        if (options.cloud?.enabled) {
          // Cloud persistence owns both the Storage key and its canonical URL.
          // The manual flow never persists its browser preview or a legacy API path.
          record = (await options.cloud.upsertWardrobeRecord(record, { image: path.join(libraryAssetDir, filename) }, userId)) || record;
        }
        await atomicJson(importedFile, [...records.filter((item) => item.id !== id), record]);
        await removeConsumedImage(userId, image.imageKey, "wardrobe");
        return json(res, 201, record);
      }
      if (url.pathname === "/api/import/config" && req.method === "GET") {
        requireAiAccess(profile);
        return json(res, 200, await setupStatus(userId, profile));
      }
      const wardrobeDeleteMatch = url.pathname.match(options.local ? /^\/api\/import\/wardrobe\/([a-z0-9_-]{1,200})$/i : /^\/api\/import\/wardrobe\/(import-[a-f0-9-]{36})$/i);
      if (wardrobeDeleteMatch && req.method === "PATCH") {
        const id = wardrobeDeleteMatch[1];
        const input = await body(req, 2 * 1024 * 1024);
        const records = options.cloud?.listWardrobeRecords ? await options.cloud.listWardrobeRecords(userId) : await loadImported(userId);
        const existing = records.find((item) => item.id === id);
        if (!existing) throw Object.assign(new Error("Imported wardrobe item not found"), { status: 404 });
        const metadata = normalizeManualMetadata(input.metadata ?? input);
        let updated = { ...existing, ...metadata };
        if (options.cloud?.enabled && options.cloud.updateWardrobeRecord) {
          updated = await options.cloud.updateWardrobeRecord(updated, userId);
        }
        await mkdir(scope(userId).root, { recursive: true });
        await atomicJson(scope(userId).importedFile, records.map((item) => item.id === id ? updated : item));
        return json(res, 200, updated);
      }
      if (wardrobeDeleteMatch && req.method === "DELETE") {
        const id = wardrobeDeleteMatch[1];
        const { importedFile, libraryAssetDir } = scope(userId);
        const records = options.cloud?.listWardrobeRecords ? await options.cloud.listWardrobeRecords(userId) : await loadImported(userId);
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return json(res, 404, { error: "Imported wardrobe item not found" });
        await atomicJson(importedFile, next);
        await Promise.all([
          rm(path.join(libraryAssetDir, `${id}-garment.png`), { force: true }),
          rm(path.join(libraryAssetDir, `${id}-modeled.png`), { force: true }),
        ]);
        if (options.cloud?.enabled) await options.cloud.deleteWardrobeRecord(records.find((record) => record.id === id), userId);
        return json(res, 200, { deleted: true, id });
      }
      const libraryAssetMatch = url.pathname.match(/^\/api\/import\/library\/([\w.-]+)$/i);
      if (libraryAssetMatch && req.method === "GET") {
        const { libraryAssetDir } = scope(userId);
        const file = path.join(libraryAssetDir, path.basename(libraryAssetMatch[1]));
        await stat(file);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return res.end(await readFile(file));
      }
      const assetMatch = url.pathname.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/i);
      if (assetMatch && req.method === "GET") {
        const job = await loadJob(assetMatch[1], userId);
        if (!job) throw Object.assign(new Error("Job not found"), { status: 404 });
        const file = path.join(scope(userId).jobsDir, assetMatch[1], path.basename(assetMatch[2]));
        await stat(file);
        res.setHeader("Content-Type", file.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.end(await readFile(file));
      }
      if (url.pathname === API_ROOT && req.method === "POST") {
        requireAiAccess(profile);
        const setup = await setupStatus(userId, profile);
        if (!setup.ready) {
          const missing = [
            ...setup.missingConfiguration.map((name) => `${name} in .env`),
            !setup.hasModelReference && `a PNG photo of yourself at ${setup.modelReference}`,
          ].filter(Boolean).join(" and ");
          return json(res, 503, { error: `Setup required: add ${missing}, then restart the app.` });
        }
        phase = "request_body";
        const input = await body(req);
        const image = await consumeStorageImage(input, userId, "jobs", (nextPhase) => { phase = nextPhase; });
        imageKey = image.imageKey;
        phase = "image_prepare";
        const normalizedImage = await normalizeImage(image.data);
        phase = "ai_vision_inference";
        const detected = (await visionProvider.analyze({ image: normalizedImage, mime: "image/png" })).map(normalizeMetadata);
        // A zero-item vision response must not strand an AI user before the
        // review flow. Keep the complete upload as a conservative crop; the
        // garment model can still isolate the subject after the user confirms it.
        const candidates = detected.length ? detected : [normalizeMetadata({
          ...(input.metadata || {}),
          name: input.metadata?.name || "新单品",
          boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
        })];
        phase = "job_persistence";
        const jobs = [];
        for (const metadata of candidates) {
          const id = randomUUID();
          const { jobsDir } = scope(userId);
          const dir = path.join(jobsDir, id); await mkdir(dir, { recursive: true });
          const originalFile = "original.png";
          const cropFile = "crop.png";
          const croppedImage = await cropDetectedItem(normalizedImage, metadata.boundingBox);
          await writeFile(path.join(dir, originalFile), normalizedImage);
          await writeFile(path.join(dir, cropFile), croppedImage);
          const now = new Date().toISOString();
          const cropStage = { ...stageState(), status: "review", assetUrl: `${ASSET_ROOT}/${id}/${cropFile}`, updatedAt: now };
          const job = { id, status: "active", metadata, stages: { crop: cropStage, garment: stageState(), modeled: stageState() }, detectionFallback: detected.length === 0, createdAt: now, updatedAt: now, internal: { originalFile, cropFile, originalMime: "image/png" } };
          job.originalAssetUrl = `${ASSET_ROOT}/${id}/${originalFile}`;
          await saveJob(job, userId, [originalFile, cropFile]); jobs.push(publicJob(job));
        }
        await removeConsumedImage(userId, image.imageKey, "jobs");
        return json(res, 202, { jobs, noClothingDetected: false, usedFullImageFallback: detected.length === 0 });
      }
      if (url.pathname === API_ROOT && req.method === "GET") {
        requireAiAccess(profile);
        const loadedJobs = options.cloud?.enabled
          ? await options.cloud.listGenerationJobs("import", userId)
          : (await Promise.all((await readdir(scope(userId).jobsDir).catch(() => [])).map((id) => loadJob(id, userId)))).filter(Boolean);
        const hiddenJobs = loadedJobs.filter((job) => job.status === "complete" || job.stages.crop?.status === "rejected" || job.stages.garment.status === "rejected" || job.stages.modeled.status === "rejected");
        await Promise.all(hiddenJobs.map((job) => deleteJob(job, userId)));
        const jobs = loadedJobs.filter((job) => !hiddenJobs.includes(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json(res, 200, jobs.map(publicJob));
      }
      const match = url.pathname.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/i);
      if (!match) return json(res, 404, { error: "Not found" });
      requireAiAccess(profile);
      const job = await loadJob(match[1], userId);
      if (!job) return json(res, 404, { error: "Job not found" });
      const action = match[2] || "";
      if (!action && req.method === "GET") return json(res, 200, publicJob(job));
      if (!action && req.method === "DELETE") {
        await deleteJob(job, userId);
        return json(res, 200, { deleted: true, id: job.id });
      }
      if (action === "metadata" && (req.method === "PATCH" || req.method === "PUT")) {
        const input = await body(req);
        if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) throw Object.assign(new Error("metadata must be an object"), { status: 400 });
        job.metadata = normalizeMetadata({ ...job.metadata, ...input.metadata }); await saveJob(job, userId);
        return json(res, 200, publicJob(job));
      }
      const cleanupAction = action.match(/^stages\/garment\/(cleanup-preview|cleanup-accept)$/);
      if (cleanupAction && req.method === "POST") {
        const stage = job.stages.garment;
        if (stage.status !== "failed" || !stage.failedAssetUrl) {
          throw Object.assign(new Error("No failed garment source is available for cleanup"), { status: 409 });
        }
        const input = await body(req);
        const tolerance = cleanupTolerance(input.tolerance);
        const sourceName = path.basename(new URL(stage.failedAssetUrl, "http://localhost").pathname);
        const { jobsDir } = scope(userId);
        const source = await readFile(path.join(jobsDir, job.id, sourceName));
        const key = stage.chromaKey || chooseChromaKey(job.metadata?.color);
        const cleaned = await processChromaBackground(source, key, { tolerance });
        const previewName = `garment-${stage.attempts}-cleanup-${tolerance}.png`;
        const previewUrl = `${ASSET_ROOT}/${job.id}/${previewName}`;
        await writeFile(path.join(jobsDir, job.id, previewName), cleaned.bytes);
        stage.chromaKey = key;
        stage.cleanupTolerance = cleaned.tolerance;
        stage.cleanupDiagnostics = cleaned.verification;
        stage.cleanupPreviewUrl = previewUrl;
        stage.updatedAt = new Date().toISOString();
        if (cleanupAction[1] === "cleanup-accept") {
          stage.status = "review";
          stage.decision = null;
          stage.error = null;
          stage.assetUrl = previewUrl;
        }
        await saveJob(job, userId);
        return json(res, 200, publicJob(job));
      }
      const stageMatch = action.match(/^stages\/(crop|garment|modeled)\/(approve|reject|regenerate)$/);
      if (stageMatch && req.method === "POST") {
        const [, stageName, decision] = stageMatch;
        if (!STAGES.has(stageName)) throw Object.assign(new Error("Invalid stage"), { status: 400 });
        if (decision === "regenerate") {
          if (!imageProvider.isConfigured()) throw Object.assign(new Error("请在 .env 配置图像服务 Key 并重启；手动添加仍可使用。"), { status: 503 });
          if (stageName === "modeled" && !await modelReferencePath(userId)) throw Object.assign(new Error("请先在本地设置上传人物参考照片。"), { status: 409 });
          if (stageName === "crop") throw Object.assign(new Error("Upload the image again to create new crops"), { status: 400 });
          const input = await body(req);
          job.stages[stageName].prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1200) || null : null;
          job.stages[stageName].status = "queued";
          job.stages[stageName].decision = null;
          await saveJob(job, userId);
          await generate(job, userId, stageName);
          const updated = await loadJob(job.id, userId);
          return json(res, 200, publicJob(updated));
        }
        const actionState = reviewActionState(job, stageName, decision);
        if (!DECISIONS.has(decision) || actionState.kind === "invalid") {
          throw Object.assign(new Error("Invalid review action"), { status: 400 });
        }
        if (actionState.kind === "duplicate") {
          let persistedRecord = null;
          if (decision === "approve" && stageName !== "crop") {
            const records = options.cloud?.listWardrobeRecords ? await options.cloud.listWardrobeRecords(userId) : await loadImported(userId);
            persistedRecord = records.find((record) => record.importJobId === job.id || record.id === `import-${job.id}`) || null;
          }
          return json(res, 200, { ...publicJob(job), ...(persistedRecord ? { persistedRecord } : {}) });
        }
        if (actionState.kind !== "ready") {
          throw Object.assign(new Error(`Stage is not ready for review${actionState.reviewStage ? `; current review stage is ${actionState.reviewStage}` : ""}`), { status: 409 });
        }
        const previousStatus = job.stages[stageName].status;
        const previousDecision = job.stages[stageName].decision;
        const previousJobStatus = job.status;
        let persistedRecord = null;
        job.stages[stageName].decision = decision === "approve" ? "approved" : "rejected";
        job.stages[stageName].status = job.stages[stageName].decision;
        job.stages[stageName].error = null;
        job.stages[stageName].updatedAt = new Date().toISOString();
        const startGarment = stageName === "crop" && decision === "approve" && job.stages.garment.status === "pending";
        const startModeled = stageName === "garment" && decision === "approve" && job.stages.modeled.status === "pending" && Boolean(await modelReferencePath(userId));
        if (stageName === "garment" && decision === "approve" && !startModeled && job.stages.modeled.status === "pending") {
          job.stages.modeled.status = "failed";
          job.stages.modeled.error = "衣物已保存。上传人物参考照片后，可重试真人展示图；也可删除此任务。";
        }
        if (stageName === "modeled" && decision === "approve") job.status = "complete";
        await saveJob(job, userId);
        if (decision === "approve" && stageName !== "crop") {
          try {
            persistedRecord = await persistImported(job, userId, stageName === "modeled");
          } catch (error) {
            job.stages[stageName].status = previousStatus;
            job.stages[stageName].decision = previousDecision;
            job.status = previousJobStatus;
            await saveJob(job, userId);
            throw error;
          }
        }
        if (decision === "reject") await deleteJob(job, userId);
        if (startGarment) await generate(job, userId, "garment");
        if (startModeled) await generate(job, userId, "modeled");
        const latestJob = decision === "reject" ? job : (await loadJob(job.id, userId)) || job;
        const response = { ...publicJob(latestJob), ...(persistedRecord ? { persistedRecord } : {}) };
        if (job.status === "complete") await deleteJob(job, userId);
        return json(res, 200, response);
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.code === "ENOENT" ? 404 : error.status || 500;
      const diagnostics = {
        request_id: requestId,
        phase,
        ...(error.provider ? { provider: error.provider } : {}),
        ...(error.provider && Number.isFinite(error.status) ? { provider_status: error.status } : {}),
        ...(error.requestId ? { provider_request_id: error.requestId } : {}),
        ...(error.endpoint ? { provider_endpoint: error.endpoint } : {}),
        ...(Number.isFinite(error.requestBytes) ? { provider_request_bytes: error.requestBytes } : {}),
        ...(error.responseBody ? { provider_response_body: error.responseBody } : {}),
      };
      console.error("AI import request failed", {
        requestId,
        phase,
        userId,
        imageKey,
        statusCode,
        message: error.message,
        stack: error.stack,
        ...diagnostics,
      });
      return json(res, statusCode, { error: error.message || "Internal server error", ...diagnostics });
    }
  }

  return {
    name: "wardrobe-import-job-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataRoot = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      if (options.local) {
        await options.local.init();
        for (const id of await readdir(scope().jobsDir)) {
          const job = await loadJob(id, "local");
          if (!job) continue;
          let changed = false;
          for (const [name, stage] of Object.entries(job.stages || {})) {
            const stranded = stage.status === "pending" && ((name === "garment" && job.stages.crop?.status === "approved") || (name === "modeled" && job.stages.garment?.status === "approved"));
            if (["queued", "processing"].includes(stage.status) || stranded) {
              stage.status = "failed"; stage.error = "上次生成已中断，请手动重试或删除；不会自动重新调用 AI。"; changed = true;
            }
          }
          if (changed) await saveJob(job, "local");
        }
      } else await mkdir(path.join(dataRoot, "users"), { recursive: true });
      if (options.cloud?.enabled) {
        await options.cloud.ensureReady();
        const startupJobs = options.cloud.listGenerationJobsWithOwners ? await options.cloud.listGenerationJobsWithOwners("import") : [];
        for (const candidate of startupJobs) {
          const userId = candidate.userId;
          const job = candidate.job?.id ? await loadJob(candidate.job.id, userId) : null;
          if (!job) continue;
          if (job.status === "complete") {
            try { await persistImported(job, userId, true); await deleteJob(job, userId); } catch { /* leave for the owning user to review */ }
            continue;
          }
          if (job.stages?.crop?.status === "rejected" || job.stages?.garment?.status === "rejected" || job.stages?.modeled?.status === "rejected") continue;
          if (job.stages?.crop?.status !== "approved") continue;
          if (job.stages?.garment?.status === "queued") { job.stages.garment.status = "pending"; await saveJob(job, userId); void generate(job, userId, "garment"); }
          else if (job.stages?.garment?.status === "approved" && job.stages?.modeled?.status === "queued") { job.stages.modeled.status = "pending"; await saveJob(job, userId); void generate(job, userId, "modeled"); }
        }
      }
    },
    configureServer(server) { server.middlewares.use(options.local ? localMutationHandler(options.local, handler, ["/api/import/"]) : handler); },
    configurePreviewServer(server) { server.middlewares.use(options.local ? localMutationHandler(options.local, handler, ["/api/import/"]) : handler); },
  };
}
