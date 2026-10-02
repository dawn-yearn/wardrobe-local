import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildOutfitPrompt } from "./outfit-prompts.mjs";

const LIBRARY_ASSET_PREFIX = "/api/import/library/";
const OUTFIT_PREVIEW_PREFIX = "/api/outfits/assets";
const OUTFIT_IMAGE_PREFIX = "/api/outfits/images";
const SELECTION_KEYS = new Set([
  "topId",
  "bottomId",
  "outerwearId",
  "shoesId",
  "accessoryId",
]);

export class OutfitServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "OutfitServiceError";
    this.status = status;
  }
}

export function normalizeOutfitSelection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OutfitServiceError("selection must be an object");
  }
  const unknown = Object.keys(input).filter((key) => !SELECTION_KEYS.has(key));
  if (unknown.length) {
    throw new OutfitServiceError(`selection contains unsupported fields: ${unknown.join(", ")}`);
  }
  const requiredId = (key) => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.length > 200) {
      throw new OutfitServiceError(`${key} is required`);
    }
    return value.trim();
  };
  const optionalId = (key) => {
    const value = input[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 200) {
      throw new OutfitServiceError(`${key} must be a wardrobe item id or null`);
    }
    return value.trim();
  };

  const selection = {
    topId: requiredId("topId"),
    bottomId: requiredId("bottomId"),
    outerwearId: optionalId("outerwearId"),
    shoesId: optionalId("shoesId"),
    accessoryId: optionalId("accessoryId"),
  };
  if (selection.topId === selection.bottomId) {
    throw new OutfitServiceError("topId and bottomId must be different wardrobe items");
  }
  for (const key of ["outerwearId", "shoesId", "accessoryId"]) {
    if (selection[key]) {
      throw new OutfitServiceError(`${key} is reserved for a future release and must be null`);
    }
  }
  return selection;
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

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

function safeId(id) {
  return typeof id === "string" && /^[a-z0-9-]{8,200}$/i.test(id);
}

function garmentSnapshot(role, item) {
  return {
    role,
    itemId: item.id,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : role,
    part: item.part,
    color: typeof item.color === "string" ? item.color : null,
    secondaryColor: typeof item.secondaryColor === "string" ? item.secondaryColor : null,
    image: item.image,
  };
}

async function normalizedProviderImage(source, name) {
  const data = await sharp(Buffer.isBuffer(source) ? source : await readFile(source)).rotate().toColorspace("srgb").png().toBuffer();
  return { data, mime: "image/png", name };
}

export function createOutfitService({
  root,
  dataDir = "data",
  modelReference = "data/model-reference.png",
  imageProvider,
  cloud,
  local,
  idFactory = randomUUID,
  now = () => new Date().toISOString(),
} = {}) {
  if (!root) throw new Error("Outfit service root is required");
  if (!imageProvider) throw new Error("Outfit service imageProvider is required");

  const dataRoot = path.isAbsolute(dataDir) ? dataDir : path.resolve(root, dataDir);
  const legacyReferenceFile = path.isAbsolute(modelReference) ? modelReference : path.resolve(root, modelReference);
  const running = new Map();

  function scope(userId) {
    if (local) return { ...local.paths, jobsDir: local.paths.outfitJobsDir };
    const owner = userId || "local";
    const userRoot = cloud?.enabled && userId ? path.join(dataRoot, "users", owner) : dataRoot;
    return {
      root: userRoot,
      jobsDir: path.join(userRoot, "outfit-jobs"),
      outfitImagesDir: path.join(userRoot, "outfit-images"),
      outfitsFile: path.join(userRoot, "outfits.json"),
      libraryFile: path.join(userRoot, "library.json"),
      importedDir: path.join(userRoot, "imported"),
      referenceFile: path.join(userRoot, "profile-reference.png"),
    };
  }

  async function prepareUser(userId) {
    const paths = scope(userId);
    await mkdir(paths.root, { recursive: true });
    await mkdir(paths.jobsDir, { recursive: true });
    await mkdir(paths.outfitImagesDir, { recursive: true });
    await mkdir(paths.importedDir, { recursive: true });
    if (cloud?.enabled && userId) {
      if (cloud.hydrateOutfits) await cloud.hydrateOutfits({ userId, outfitsFile: paths.outfitsFile, outfitImagesDir: paths.outfitImagesDir });
      if (cloud.ensureUserReferenceFile) await cloud.ensureUserReferenceFile(userId, paths.referenceFile);
    }
    return paths;
  }

  async function loadLibrary(userId) {
    if (cloud?.enabled && userId) return cloud.listWardrobeRecords(userId);
    const library = await readJson(scope(userId).libraryFile, []);
    if (!Array.isArray(library)) {
      throw new OutfitServiceError("data/library.json must contain an array", 500);
    }
    return library;
  }

  async function loadOutfits(userId) {
    const value = await readJson(scope(userId).outfitsFile, { version: 1, outfits: [] });
    if (!value || value.version !== 1 || !Array.isArray(value.outfits)) {
      throw new OutfitServiceError("data/outfits.json has an unsupported structure", 500);
    }
    return value;
  }

  function jobFile(id, userId) {
    return path.join(scope(userId).jobsDir, id, "job.json");
  }

  async function ensureJobAssets(job, userId) {
    if (!cloud?.enabled || !cloud.downloadJobAsset || !job.previewUrl) return;
    const filename = path.basename(new URL(job.previewUrl, "http://localhost").pathname);
    const dir = path.join(scope(userId).jobsDir, job.id);
    const file = path.join(dir, filename);
    await mkdir(dir, { recursive: true });
    try {
      if ((await stat(file)).isFile()) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const bytes = userId
      ? await cloud.downloadJobAsset(userId, job.id, filename)
      : await cloud.downloadJobAsset(job.id, filename);
    if (bytes) await writeFile(file, bytes);
  }

  async function loadJob(id, userId) {
    if (!safeId(id)) return null;
    if (cloud?.enabled && cloud.getGenerationJob) {
      const cloudJob = userId ? await cloud.getGenerationJob(id, userId) : await cloud.getGenerationJob(id);
      if (cloudJob) {
        await ensureJobAssets(cloudJob, userId);
        await mkdir(path.join(scope(userId).jobsDir, id), { recursive: true });
        await atomicJson(jobFile(id, userId), cloudJob);
        return cloudJob;
      }
    }
    return readJson(jobFile(id, userId), null);
  }

  async function saveJob(job, userId, assets = []) {
    const { jobsDir } = scope(userId);
    job.updatedAt = now();
    await mkdir(path.join(jobsDir, job.id), { recursive: true });
    await atomicJson(jobFile(job.id, userId), job);
    if (cloud?.enabled) {
      for (const filename of [...new Set(assets)].filter(Boolean)) {
        if (userId) await cloud.uploadJobAsset(userId, job.id, filename, path.join(jobsDir, job.id, filename));
        else await cloud.uploadJobAsset(job.id, filename, path.join(jobsDir, job.id, filename));
      }
      await cloud.upsertGenerationJob(job, { jobType: "outfit", userId });
    }
  }

  async function removePersistedJob(job, userId) {
    await rm(path.join(scope(userId).jobsDir, job.id), { recursive: true, force: true });
    if (cloud?.enabled) {
      if (userId) await cloud.deleteGenerationJob(job.id, userId);
      else await cloud.deleteGenerationJob(job.id);
      const filenames = job.previewUrl ? [path.basename(new URL(job.previewUrl, "http://localhost").pathname)] : [];
      if (userId) await cloud.deleteJobAssets(userId, job.id, filenames);
      else await cloud.deleteJobAssets(job.id, filenames);
    }
  }

  async function resolveGarmentImage(item, userId) {
    if (typeof item.image !== "string") throw new OutfitServiceError(`Wardrobe item ${item.id} has no image`, 409);
    const cloudImage = cloud?.enabled && userId;
    const storagePrefix = cloudImage ? cloud.storageKeyForLibrary(userId, "") : null;
    const prefix = cloudImage ? cloud.publicAssetUrl(storagePrefix) : LIBRARY_ASSET_PREFIX;
    if (!item.image.startsWith(prefix)) {
      throw new OutfitServiceError(`Wardrobe item ${item.id} has an unsafe image path`, 409);
    }
    const pathname = item.image.slice(prefix.length);
    const encodedName = cloudImage ? pathname : pathname.split(/[?#]/, 1)[0];
    let filename;
    try {
      filename = decodeURIComponent(encodedName);
    } catch {
      throw new OutfitServiceError(`Wardrobe item ${item.id} has an invalid image path`, 409);
    }
    if (!filename || filename === "." || filename === ".." || /[\\/:%\x00-\x1f]/.test(filename)) {
      throw new OutfitServiceError(`Wardrobe item ${item.id} has an unsafe image path`, 409);
    }
    if (cloudImage) {
      const key = `${storagePrefix}${filename}`;
      // Accept only the canonical URL for this user's wardrobe in our configured bucket.
      // Download through the existing ownership validator; never fetch a record URL directly.
      if (cloud.publicAssetUrl(key) !== item.image) {
        throw new OutfitServiceError(`Wardrobe item ${item.id} has an unsafe image path`, 409);
      }
      return cloud.downloadUserImage(userId, key, "wardrobe");
    }
    const importedDir = scope(userId).importedDir;
    const file = path.resolve(importedDir, filename);
    if (path.dirname(file) !== path.resolve(importedDir)) {
      throw new OutfitServiceError(`Wardrobe item ${item.id} has an unsafe image path`, 409);
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
    } catch {
      throw new OutfitServiceError(`Local image for wardrobe item ${item.id} was not found`, 409);
    }
    return file;
  }

  async function validateSelection(input, userId) {
    const selection = normalizeOutfitSelection(input);
    const library = await loadLibrary(userId);
    const byId = new Map(library.map((item) => [item.id, item]));
    const top = byId.get(selection.topId);
    const bottom = byId.get(selection.bottomId);
    if (!top) throw new OutfitServiceError(`Top wardrobe item ${selection.topId} was not found`, 404);
    if (!bottom) throw new OutfitServiceError(`Bottom wardrobe item ${selection.bottomId} was not found`, 404);
    if (top.part !== "upperbody") {
      throw new OutfitServiceError(`Wardrobe item ${top.id} is not an upperbody item`);
    }
    if (bottom.part !== "lowerbody") {
      throw new OutfitServiceError(`Wardrobe item ${bottom.id} is not a lowerbody item`);
    }
    const topImage = await resolveGarmentImage(top, userId);
    const bottomImage = await resolveGarmentImage(bottom, userId);
    return {
      selection,
      top,
      bottom,
      topImage,
      bottomImage,
      garments: [
        garmentSnapshot("top", top),
        garmentSnapshot("bottom", bottom),
      ],
    };
  }

  async function configuration(userId) {
    const missingConfiguration = imageProvider.configurationIssues?.() || [];
    const paths = await prepareUser(userId);
    const referenceFile = local || (cloud?.enabled && userId) ? paths.referenceFile : legacyReferenceFile;
    let hasModelReference = false;
    try { hasModelReference = (await stat(referenceFile)).isFile(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return {
      ready: imageProvider.isConfigured() && hasModelReference,
      imageProvider: imageProvider.id,
      modelReference: cloud?.enabled && userId ? "用户信息中的人物参考照片" : modelReference,
      modelReferenceFile: referenceFile,
      hasModelReference,
      missingConfiguration,
    };
  }

  function startGeneration(id, userId) {
    const lock = `${userId || "local"}:${id}`;
    if (running.has(lock)) return running.get(lock);
    const task = (async () => {
      const job = await loadJob(id, userId);
      if (!job) return;
      job.status = "processing";
      job.attempts += 1;
      job.error = null;
      job.previewUrl = null;
      await saveJob(job, userId);
      try {
        const configured = await configuration(userId);
        if (!configured.ready) {
          const missing = [
            ...configured.missingConfiguration,
            !configured.hasModelReference && configured.modelReference,
          ].filter(Boolean).join(", ");
          throw new OutfitServiceError(`Outfit generation setup is incomplete: ${missing}`, 503);
        }
        const validated = await validateSelection(job.selection, userId);
        const images = await Promise.all([
          normalizedProviderImage(configured.modelReferenceFile, "model-reference.png"),
          normalizedProviderImage(validated.topImage, "top.png"),
          normalizedProviderImage(validated.bottomImage, "bottom.png"),
        ]);
        const generated = await imageProvider.edit({
          purpose: "outfit",
          images,
          prompt: buildOutfitPrompt({
            top: validated.top,
            bottom: validated.bottom,
            regenerationPrompt: job.regenerationPrompt,
          }),
          size: { width: 1536, height: 1536 },
        });
        const png = await sharp(generated).rotate().toColorspace("srgb").png().toBuffer();
        const filename = `outfit-${job.attempts}.png`;
        await writeFile(path.join(scope(userId).jobsDir, job.id, filename), png);
        const fresh = await loadJob(id, userId);
        if (!fresh) return;
        fresh.status = "review";
        fresh.previewUrl = `${OUTFIT_PREVIEW_PREFIX}/${fresh.id}/${filename}`;
        fresh.error = null;
        fresh.garments = validated.garments;
        await saveJob(fresh, userId, [filename]);
      } catch (error) {
        const fresh = await loadJob(id, userId);
        if (!fresh) return;
        fresh.status = "failed";
        fresh.error = error.message || "Outfit generation failed";
        await saveJob(fresh, userId);
      }
    })().finally(() => running.delete(lock));
    running.set(lock, task);
    return task;
  }

  async function init() {
    if (!local) await mkdir(path.join(dataRoot, "users"), { recursive: true });
    const localPaths = scope();
    await mkdir(localPaths.jobsDir, { recursive: true });
    await mkdir(localPaths.outfitImagesDir, { recursive: true });
    if (local) {
      for (const job of await listJobs("local")) {
        if (["queued", "processing"].includes(job.status)) {
          job.status = "failed"; job.error = "上次生成已中断，请手动重试或删除；不会自动重新调用 AI。";
          await saveJob(job, "local");
        }
      }
    }
    if (cloud?.enabled) {
      await cloud.ensureReady();
      const startupJobs = cloud.listGenerationJobsWithOwners ? await cloud.listGenerationJobsWithOwners("outfit") : [];
      for (const candidate of startupJobs) {
        const job = candidate.job?.id ? await loadJob(candidate.job.id, candidate.userId) : null;
        if (job?.status === "queued") startGeneration(job.id, candidate.userId);
      }
    }
  }

  async function createJob(input, userId) {
    const configured = await configuration(userId);
    if (!configured.ready) {
      throw new OutfitServiceError("Outfit generation setup is incomplete", 503);
    }
    if ((await listJobs(userId)).length) {
      throw new OutfitServiceError("Finish or delete the current outfit job before creating another", 409);
    }
    const validated = await validateSelection(input, userId);
    const id = idFactory();
    if (!safeId(id)) throw new Error("Outfit job idFactory returned an unsafe id");
    await mkdir(path.join(scope(userId).jobsDir, id), { recursive: true });
    const createdAt = now();
    const job = {
      id,
      status: "queued",
      selection: validated.selection,
      garments: validated.garments,
      attempts: 0,
      previewUrl: null,
      error: null,
      regenerationPrompt: null,
      createdAt,
      updatedAt: createdAt,
    };
    await saveJob(job, userId);
    startGeneration(id, userId);
    return structuredClone(job);
  }

  async function regenerateJob(id, userIdOrPrompt, regenerationPrompt) {
    const legacyCall = !local && regenerationPrompt === undefined && userIdOrPrompt && !/^[a-f0-9-]{8,100}$/i.test(userIdOrPrompt);
    const userId = legacyCall ? undefined : userIdOrPrompt;
    const prompt = legacyCall ? userIdOrPrompt : regenerationPrompt;
    if (!(await configuration(userId)).ready) throw new OutfitServiceError("请检查图像服务 Key 和人物参考照片，再重试。", 503);
    const job = await loadJob(id, userId);
    if (!job) throw new OutfitServiceError("Outfit job not found", 404);
    if (!["review", "failed"].includes(job.status)) {
      throw new OutfitServiceError("Outfit job is not ready to regenerate", 409);
    }
    job.status = "queued";
    job.error = null;
    job.previewUrl = null;
    job.regenerationPrompt = typeof prompt === "string"
      ? prompt.trim().slice(0, 1200) || null
      : null;
    await saveJob(job, userId);
    startGeneration(id, userId);
    return structuredClone(job);
  }

  async function acceptJob(id, userId) {
    const job = await loadJob(id, userId);
    if (!job) throw new OutfitServiceError("Outfit job not found", 404);
    if (job.status !== "review" || !job.previewUrl) {
      throw new OutfitServiceError("Outfit job is not ready to accept", 409);
    }
    const previewName = path.basename(new URL(job.previewUrl, "http://localhost").pathname);
    const previewFile = path.join(scope(userId).jobsDir, id, previewName);
    await stat(previewFile);
    const previewBytes = await readFile(previewFile);
    const filename = `${id}.png`;
    const finalFile = path.join(scope(userId).outfitImagesDir, filename);
    const manifest = await loadOutfits(userId);
    const createdAt = now();
    const record = {
      id,
      name: `${job.garments[0].name} + ${job.garments[1].name}`,
      image: `${OUTFIT_IMAGE_PREFIX}/${filename}`,
      selection: { ...job.selection },
      garments: job.garments.map((garment) => ({ ...garment })),
      createdAt,
      updatedAt: createdAt,
    };
    await writeFile(finalFile, previewBytes);
    try {
      manifest.outfits = [
        ...manifest.outfits.filter((outfit) => outfit.id !== id),
        record,
      ];
      await atomicJson(scope(userId).outfitsFile, manifest);
      if (cloud?.enabled) await cloud.upsertOutfitRecord(record, finalFile, userId);
    } catch (error) {
      await rm(finalFile, { force: true });
      throw error;
    }
    await removePersistedJob(job, userId);
    return record;
  }

  async function deleteJob(id, userId) {
    const job = await loadJob(id, userId);
    if (!job) throw new OutfitServiceError("Outfit job not found", 404);
    if (running.has(`${userId || "local"}:${id}`)) {
      throw new OutfitServiceError("Outfit generation is still running", 409);
    }
    await removePersistedJob(job, userId);
    return { deleted: true, id };
  }

  async function listJobs(userId) {
    await prepareUser(userId);
    const jobs = cloud?.enabled
      ? userId ? await cloud.listGenerationJobs("outfit", userId) : await cloud.listGenerationJobs("outfit")
      : (await Promise.all((await readdir(scope(userId).jobsDir).catch(() => [])).map((id) => loadJob(id, userId)))).filter(Boolean);
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function getJob(id, userId) {
    return loadJob(id, userId);
  }

  async function listOutfits(userId) {
    await prepareUser(userId);
    return (await loadOutfits(userId)).outfits;
  }

  async function waitForIdle(id, userId) {
    const task = running.get(`${userId || "local"}:${id}`);
    if (task) await task;
    return loadJob(id, userId);
  }

  function previewAssetPath(id, filename, userId) {
    if (!safeId(id) || path.basename(filename) !== filename) return null;
    return path.join(scope(userId).jobsDir, id, filename);
  }

  function outfitImagePath(filename, userId) {
    if (path.basename(filename) !== filename) return null;
    return path.join(scope(userId).outfitImagesDir, filename);
  }

  return {
    init,
    configuration,
    validateSelection,
    createJob,
    regenerateJob,
    acceptJob,
    deleteJob,
    listJobs,
    getJob,
    listOutfits,
    waitForIdle,
    previewAssetPath,
    outfitImagePath,
  };
}
