import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { setting } from "./providers/contracts.mjs";

const DEFAULT_BUCKET = "wardrobe-assets";

function filenameFromApiPath(value) {
  if (typeof value !== "string") return null;
  const filename = path.basename(value.split(/[?#]/, 1)[0]);
  return filename && filename !== "." ? filename : null;
}

function scopeUserId(userId) {
  if (typeof userId !== "string" || !/^[a-f0-9-]{8,100}$/i.test(userId)) throw new Error("A valid user id is required");
  return userId;
}

function storageKeyForLibrary(userId, filename) {
  return `users/${scopeUserId(userId)}/wardrobe/${filename}`;
}

function storageKeyForOutfit(userId, filename) {
  return `users/${scopeUserId(userId)}/outfits/${filename}`;
}

function storageKeyForJob(userId, jobId, filename) {
  return `users/${scopeUserId(userId)}/jobs/${jobId}/${filename}`;
}

function storageKeyForReference(userId, filename) {
  return `users/${scopeUserId(userId)}/profile/reference/${filename}`;
}

export function validateUserImageKey(userId, storageKey, scope) {
  const owner = scopeUserId(userId);
  const segment = ({ jobs: "jobs", wardrobe: "wardrobe", profile: "profile" })[scope];
  if (!segment || typeof storageKey !== "string") throw Object.assign(new Error("A valid image_key is required"), { status: 400 });
  const prefix = `users/${owner}/${segment}/`;
  if (!storageKey.startsWith(prefix) || storageKey.includes("\\") || storageKey.split("/").includes("..")) {
    throw Object.assign(new Error("image_key does not belong to the authenticated user"), { status: 403 });
  }
  return storageKey;
}

function cloudError(error, operation) {
  return new Error(`Meoo Cloud ${operation} failed: ${error?.message || String(error)}`);
}

export function createCloudPersistence({ env = {}, client: clientOverride = null } = {}) {
  const url = setting(env, "SUPABASE_URL");
  const serviceRoleKey = setting(env, "SUPABASE_SERVICE_ROLE_KEY");
  const bucket = setting(env, "WARDROBE_STORAGE_BUCKET", DEFAULT_BUCKET);
  const enabled = Boolean(url && serviceRoleKey);
  const client = enabled
    ? (clientOverride || createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }))
    : null;

  async function ensureReady() {
    if (!enabled) return false;
    const { error } = await client.storage.createBucket(bucket, { public: true });
    if (error && !/already exists|duplicate|conflict/i.test(error.message || "")) {
      throw cloudError(error, "Storage bucket creation");
    }
    const { error: visibilityError } = await client.storage.updateBucket(bucket, { public: true });
    if (visibilityError && !/not found|does not exist/i.test(visibilityError.message || "")) {
      throw cloudError(visibilityError, "Storage bucket visibility update");
    }
    return true;
  }

  async function upload(storageKey, fileOrBytes, contentType = "image/png") {
    if (!enabled) return;
    const data = Buffer.isBuffer(fileOrBytes) ? fileOrBytes : await readFile(fileOrBytes);
    const { error } = await client.storage.from(bucket).upload(storageKey, data, {
      contentType,
      upsert: true,
    });
    if (error) throw cloudError(error, `Storage upload ${storageKey}`);
  }

  async function download(storageKey) {
    if (!enabled) return null;
    const { data, error } = await client.storage.from(bucket).download(storageKey);
    if (error) throw cloudError(error, `Storage download ${storageKey}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async function remove(storageKeys) {
    if (!enabled || !storageKeys.length) return;
    const { error } = await client.storage.from(bucket).remove(storageKeys);
    if (error) throw cloudError(error, "Storage removal");
  }

  async function downloadUserImage(userId, storageKey, scope) {
    return download(validateUserImageKey(userId, storageKey, scope));
  }

  async function removeUserImage(userId, storageKey, scope) {
    await remove([validateUserImageKey(userId, storageKey, scope)]);
  }

  async function upsertWardrobeRecord(record, files = {}, userId) {
    if (!enabled) return;
    const owner = scopeUserId(userId);
    const imageFilename = filenameFromApiPath(record.image);
    const thumbnailFilename = filenameFromApiPath(record.thumbnail) || imageFilename;
    const modeledFilename = filenameFromApiPath(record.modeledImage);
    if (!imageFilename || !thumbnailFilename) throw new Error(`Wardrobe record ${record.id} has no valid image path`);
    await upload(storageKeyForLibrary(owner, imageFilename), files.image, "image/png");
    if (files.thumbnail && thumbnailFilename !== imageFilename) {
      await upload(storageKeyForLibrary(owner, thumbnailFilename), files.thumbnail, "image/png");
    }
    if (modeledFilename && files.modeledImage) {
      await upload(storageKeyForLibrary(owner, modeledFilename), files.modeledImage, "image/png");
    }
    const imageKey = storageKeyForLibrary(owner, imageFilename);
    const thumbnailKey = storageKeyForLibrary(owner, thumbnailFilename);
    const modeledImageKey = modeledFilename ? storageKeyForLibrary(owner, modeledFilename) : null;
    const canonical = {
      ...record,
      image: publicAssetUrl(imageKey),
      thumbnail: publicAssetUrl(thumbnailKey),
      modeledImage: modeledImageKey ? publicAssetUrl(modeledImageKey) : null,
    };
    const { error } = await client.from("wardrobe_items").upsert({
      id: record.id,
      user_id: owner,
      record_json: canonical,
      image_key: imageKey,
      thumbnail_key: thumbnailKey,
      modeled_image_key: modeledImageKey,
      updated_at: new Date().toISOString(),
    });
    if (error) throw cloudError(error, `wardrobe_items upsert ${record.id}`);
    return canonical;
  }

  async function updateWardrobeRecord(record, userId) {
    if (!enabled) return record;
    const owner = scopeUserId(userId);
    const { data: existing, error: readError } = await client
      .from("wardrobe_items")
      .select("image_key,thumbnail_key,modeled_image_key")
      .eq("id", record.id)
      .eq("user_id", owner)
      .maybeSingle();
    if (readError) throw cloudError(readError, `wardrobe_items metadata read ${record.id}`);
    if (!existing) throw Object.assign(new Error("Wardrobe item not found"), { status: 404 });
    const canonical = {
      ...record,
      image: publicAssetUrl(existing.image_key),
      thumbnail: publicAssetUrl(existing.thumbnail_key),
      modeledImage: existing.modeled_image_key ? publicAssetUrl(existing.modeled_image_key) : null,
    };
    const { error } = await client
      .from("wardrobe_items")
      .update({ record_json: canonical, updated_at: new Date().toISOString() })
      .eq("id", record.id)
      .eq("user_id", owner);
    if (error) throw cloudError(error, `wardrobe_items metadata update ${record.id}`);
    return canonical;
  }

  async function deleteWardrobeRecord(record, userId) {
    if (!enabled) return;
    const owner = scopeUserId(userId);
    const keys = [record.image, record.thumbnail, record.modeledImage]
      .map(filenameFromApiPath)
      .filter(Boolean)
      .map((filename) => storageKeyForLibrary(owner, filename));
    await remove([...new Set(keys)]);
    const { error } = await client.from("wardrobe_items").delete().eq("id", record.id).eq("user_id", owner);
    if (error) throw cloudError(error, `wardrobe_items deletion ${record.id}`);
  }

  function generationJobRow(job, jobType, userId = null) {
    const stages = job?.stages || {};
    const activeStage = Object.entries(stages).find(([, value]) => ["queued", "processing", "failed", "review"].includes(value?.status))?.[0] || null;
    const activeValue = activeStage ? stages[activeStage] : null;
    return {
      id: job.id,
      job_type: jobType,
      user_id: userId,
      status: job.status || activeValue?.status || "queued",
      stage: activeStage,
      progress: Number.isFinite(Number(job.progress)) ? Number(job.progress) : null,
      input_json: {
        metadata: job.metadata || null,
        selection: job.selection || null,
        garments: job.garments || null,
        regenerationPrompt: job.regenerationPrompt || null,
      },
      result_json: {
        stages: job.stages || null,
        previewUrl: job.previewUrl || null,
        garments: job.garments || null,
      },
      payload_json: job,
      error: job.error || activeValue?.error || null,
      created_at: job.createdAt || new Date().toISOString(),
      updated_at: job.updatedAt || new Date().toISOString(),
    };
  }

  async function upsertGenerationJob(job, { jobType, userId = null } = {}) {
    if (!enabled) return;
    if (!job?.id || !jobType) throw new Error("Generation job id and type are required");
    const { error } = await client.from("generation_jobs").upsert(generationJobRow(job, jobType, userId));
    if (error) throw cloudError(error, `generation_jobs upsert ${job.id}`);
  }

  async function getGenerationJob(id, userId) {
    if (!enabled) return null;
    const owner = scopeUserId(userId);
    const { data, error } = await client.from("generation_jobs").select("payload_json").eq("id", id).eq("user_id", owner).maybeSingle();
    if (error) throw cloudError(error, `generation_jobs read ${id}`);
    return data?.payload_json ? publicizeJobPayload(data.payload_json, owner) : null;
  }

  async function listGenerationJobs(jobType, userId) {
    if (!enabled) return [];
    const owner = scopeUserId(userId);
    const { data, error } = await client.from("generation_jobs").select("payload_json").eq("job_type", jobType).eq("user_id", owner).order("created_at", { ascending: true });
    if (error) throw cloudError(error, `generation_jobs list ${jobType}`);
    return (data || []).map((row) => publicizeJobPayload(row.payload_json, owner)).filter(Boolean);
  }

  async function listGenerationJobsWithOwners(jobType) {
    if (!enabled) return [];
    const { data, error } = await client.from("generation_jobs").select("payload_json,user_id").eq("job_type", jobType).order("created_at", { ascending: true });
    if (error) throw cloudError(error, `generation_jobs owner list ${jobType}`);
    return (data || []).map((row) => ({ userId: row.user_id, job: publicizeJobPayload(row.payload_json, row.user_id) })).filter((row) => row.userId && row.job);
  }

  async function deleteGenerationJob(id, userId) {
    if (!enabled) return;
    const owner = scopeUserId(userId);
    const { error } = await client.from("generation_jobs").delete().eq("id", id).eq("user_id", owner);
    if (error) throw cloudError(error, `generation_jobs deletion ${id}`);
  }

  async function uploadJobAsset(userId, jobId, filename, fileOrBytes, contentType = "image/png") {
    if (!enabled) return;
    await upload(storageKeyForJob(userId, jobId, filename), fileOrBytes, contentType);
  }

  async function downloadJobAsset(userId, jobId, filename) {
    if (!enabled) return null;
    return download(storageKeyForJob(userId, jobId, filename));
  }

  async function deleteJobAssets(userId, jobId, filenames = []) {
    if (!enabled || !filenames.length) return;
    await remove([...new Set(filenames.map((filename) => storageKeyForJob(userId, jobId, filename)))]);
  }

  async function upsertOutfitRecord(record, file, userId) {
    if (!enabled) return;
    const owner = scopeUserId(userId);
    const filename = filenameFromApiPath(record.image);
    if (!filename) throw new Error(`Outfit record ${record.id} has no valid image path`);
    await upload(storageKeyForOutfit(owner, filename), file, "image/png");
    const { error } = await client.from("outfits").upsert({
      id: record.id,
      user_id: owner,
      record_json: record,
      image_key: storageKeyForOutfit(owner, filename),
      updated_at: new Date().toISOString(),
    });
    if (error) throw cloudError(error, `outfits upsert ${record.id}`);
  }

  async function hydrateWardrobe({ userId, libraryFile, libraryAssetDir }) {
    if (!enabled) return false;
    const owner = scopeUserId(userId);
    const { data, error } = await client.from("wardrobe_items").select("*").eq("user_id", owner).order("updated_at", { ascending: true });
    if (error) throw cloudError(error, "wardrobe_items read");
    if (!data?.length) return false;
    await mkdir(libraryAssetDir, { recursive: true });
    const records = [];
    for (const row of data) {
      const record = structuredClone(row.record_json);
      const imageFilename = path.basename(row.image_key);
      const thumbnailFilename = path.basename(row.thumbnail_key);
      const modeledFilename = row.modeled_image_key ? path.basename(row.modeled_image_key) : null;
      await writeFile(path.join(libraryAssetDir, imageFilename), await download(row.image_key));
      if (thumbnailFilename !== imageFilename) await writeFile(path.join(libraryAssetDir, thumbnailFilename), await download(row.thumbnail_key));
      if (modeledFilename) await writeFile(path.join(libraryAssetDir, modeledFilename), await download(row.modeled_image_key));
      record.image = publicAssetUrl(row.image_key);
      record.thumbnail = publicAssetUrl(row.thumbnail_key);
      record.modeledImage = modeledFilename ? publicAssetUrl(row.modeled_image_key) : null;
      records.push(record);
    }
    await writeFile(libraryFile, `${JSON.stringify(records, null, 2)}\n`);
    return true;
  }

  async function listWardrobeRecords(userId) {
    if (!enabled) return [];
    const owner = scopeUserId(userId);
    const { data, error } = await client.from("wardrobe_items").select("*").eq("user_id", owner).order("updated_at", { ascending: true });
    if (error) throw cloudError(error, "wardrobe_items read");
    return (data || []).map((row) => {
      const record = structuredClone(row.record_json || {});
      record.image = publicAssetUrl(row.image_key);
      record.thumbnail = publicAssetUrl(row.thumbnail_key);
      record.modeledImage = row.modeled_image_key ? publicAssetUrl(row.modeled_image_key) : null;
      return record;
    });
  }

  async function hydrateOutfits({ userId, outfitsFile, outfitImagesDir }) {
    if (!enabled) return false;
    const owner = scopeUserId(userId);
    const { data, error } = await client.from("outfits").select("*").eq("user_id", owner).order("updated_at", { ascending: true });
    if (error) throw cloudError(error, "outfits read");
    if (!data?.length) return false;
    await mkdir(outfitImagesDir, { recursive: true });
    const records = [];
    for (const row of data) {
      const record = structuredClone(row.record_json);
      const filename = path.basename(row.image_key);
      await writeFile(path.join(outfitImagesDir, filename), await download(row.image_key));
      record.image = publicAssetUrl(row.image_key);
      records.push(record);
    }
    await writeFile(outfitsFile, `${JSON.stringify({ version: 1, outfits: records }, null, 2)}\n`);
    return true;
  }

  function publicizeJobPayload(payload, userId) {
    if (!payload || !userId) return payload;
    const owner = scopeUserId(userId);
    const replace = (value) => {
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
      if (typeof value !== "string") return value;
      const match = value.match(/^\/api\/(?:import\/assets|outfits\/assets)\/([a-z0-9-]{8,200})\/([\w.-]+)$/i);
      return match ? publicAssetUrl(storageKeyForJob(owner, match[1], path.basename(match[2]))) : value;
    };
    return replace(structuredClone(payload));
  }

  function publicAssetUrl(storageKey) {
    return `${url.replace(/\/$/, "")}/storage/v1/object/public/${encodeURIComponent(bucket)}/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
  }

  function nicknameFor(userId) {
    return `用户-${userId.replace(/-/g, "").slice(-4).toUpperCase()}`;
  }

  function publicProfile(profile) {
    if (!profile) return null;
    const copy = structuredClone(profile);
    if (copy.reference_image_key) copy.reference_image_url = publicAssetUrl(copy.reference_image_key);
    return copy;
  }

  async function ensureUserProfile(user) {
    const owner = scopeUserId(user.id);
    const { data, error } = await client.from("user_profiles").select("*").eq("user_id", owner).maybeSingle();
    if (error) throw cloudError(error, `user_profiles read ${owner}`);
    if (data) return publicProfile(data);
    const { data: created, error: createError } = await client.from("user_profiles").insert({ user_id: owner, nickname: nicknameFor(owner) }).select("*").single();
    if (createError) {
      const { data: retry, error: retryError } = await client.from("user_profiles").select("*").eq("user_id", owner).single();
      if (retryError) throw cloudError(retryError, `user_profiles create ${owner}`);
      return publicProfile(retry);
    }
    return publicProfile(created);
  }

  async function getUserProfile(userId) {
    const owner = scopeUserId(userId);
    const { data, error } = await client.from("user_profiles").select("*").eq("user_id", owner).maybeSingle();
    if (error) throw cloudError(error, `user_profiles read ${owner}`);
    return publicProfile(data);
  }

  async function updateUserProfile(userId, changes) {
    const owner = scopeUserId(userId);
    const { data, error } = await client.from("user_profiles").update({ ...changes, updated_at: new Date().toISOString() }).eq("user_id", owner).select("*").single();
    if (error) throw cloudError(error, `user_profiles update ${owner}`);
    return publicProfile(data);
  }

  async function redeemInvite(userId, code, expectedCode, maxUsers) {
    if (!expectedCode) throw Object.assign(new Error("Beta invite code is not configured"), { status: 503 });
    if (code !== expectedCode) throw Object.assign(new Error("邀请码不正确"), { status: 400 });
    const { data, error } = await client.rpc("redeem_beta_invite", {
      p_user_id: scopeUserId(userId),
      p_invite_code: code,
      p_expected_code: expectedCode,
      p_max_users: maxUsers,
    });
    if (error) {
      if (/capacity is full/i.test(error.message || "")) throw Object.assign(new Error("Beta 名额已满"), { status: 409 });
      throw cloudError(error, "beta invite redemption");
    }
    return structuredClone(Array.isArray(data) ? data[0] : data);
  }

  async function uploadUserReference(userId, bytes, contentType = "image/png", filename = randomUUID()) {
    const owner = scopeUserId(userId);
    const key = storageKeyForReference(owner, `${filename}.png`);
    await upload(key, bytes, contentType);
    const { data, error } = await client.from("user_profiles").update({ reference_image_key: key, reference_image_url: publicAssetUrl(key), updated_at: new Date().toISOString() }).eq("user_id", owner).select("*").single();
    if (error) throw cloudError(error, `user_profiles reference upload ${owner}`);
    return publicProfile(data);
  }

  async function clearUserReference(userId) {
    const owner = scopeUserId(userId);
    const profile = await getUserProfile(owner);
    if (profile?.reference_image_key) await remove([profile.reference_image_key]);
    const { data, error } = await client.from("user_profiles").update({ reference_image_key: null, reference_image_url: null, updated_at: new Date().toISOString() }).eq("user_id", owner).select("*").single();
    if (error) throw cloudError(error, `user_profiles reference removal ${owner}`);
    return publicProfile(data);
  }

  async function ensureUserReferenceFile(userId, file) {
    const profile = await getUserProfile(userId);
    if (!profile?.reference_image_key) return false;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await download(profile.reference_image_key));
    return true;
  }

  function jobAssetNamesFromPayload(payload) {
    const names = new Set();
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") {
        if (typeof value === "string") {
          const match = value.match(/^\/api\/(?:import\/assets|outfits\/assets)\/([a-z0-9-]{8,200})\/([\w.-]+)$/i);
          if (match) names.add(`${match[1]}\0${path.basename(match[2])}`);
        }
        return;
      }
      Object.values(value).forEach(visit);
    };
    visit(payload);
    return [...names];
  }

  async function migrateLegacyData(targetUserId) {
    const owner = scopeUserId(targetUserId);
    const result = { wardrobe_items: 0, outfits: 0, generation_jobs: 0, job_assets: 0 };
    const wardrobe = await client.from("wardrobe_items").select("*").is("user_id", null);
    if (wardrobe.error) throw cloudError(wardrobe.error, "legacy wardrobe read");
    for (const row of wardrobe.data || []) {
      const keyPairs = [[row.image_key, path.basename(row.image_key)], [row.thumbnail_key, path.basename(row.thumbnail_key)]];
      if (row.modeled_image_key) keyPairs.push([row.modeled_image_key, path.basename(row.modeled_image_key)]);
      const nextKeys = [];
      for (const [oldKey, filename] of keyPairs) {
        const nextKey = storageKeyForLibrary(owner, filename);
        await upload(nextKey, await download(oldKey));
        nextKeys.push(nextKey);
      }
      const { error } = await client.from("wardrobe_items").update({ user_id: owner, image_key: nextKeys[0], thumbnail_key: nextKeys[1], modeled_image_key: row.modeled_image_key ? nextKeys[2] : null }).eq("id", row.id).is("user_id", null);
      if (error) throw cloudError(error, `legacy wardrobe migration ${row.id}`);
      result.wardrobe_items += 1;
    }
    const outfits = await client.from("outfits").select("*").is("user_id", null);
    if (outfits.error) throw cloudError(outfits.error, "legacy outfits read");
    for (const row of outfits.data || []) {
      const nextKey = storageKeyForOutfit(owner, path.basename(row.image_key));
      await upload(nextKey, await download(row.image_key));
      const { error } = await client.from("outfits").update({ user_id: owner, image_key: nextKey }).eq("id", row.id).is("user_id", null);
      if (error) throw cloudError(error, `legacy outfit migration ${row.id}`);
      result.outfits += 1;
    }
    const jobs = await client.from("generation_jobs").select("*").is("user_id", null);
    if (jobs.error) throw cloudError(jobs.error, "legacy generation jobs read");
    for (const row of jobs.data || []) {
      for (const token of jobAssetNamesFromPayload(row.payload_json)) {
        const [jobId, filename] = token.split("\0");
        await upload(storageKeyForJob(owner, jobId, filename), await download(`jobs/${jobId}/${filename}`));
        result.job_assets += 1;
      }
      const { error } = await client.from("generation_jobs").update({ user_id: owner }).eq("id", row.id).is("user_id", null);
      if (error) throw cloudError(error, `legacy generation job migration ${row.id}`);
      result.generation_jobs += 1;
    }
    return result;
  }

  return {
    enabled,
    bucket,
    ensureReady,
    upload,
    downloadUserImage,
    removeUserImage,
    upsertWardrobeRecord,
    updateWardrobeRecord,
    deleteWardrobeRecord,
    upsertOutfitRecord,
    hydrateWardrobe,
    listWardrobeRecords,
    hydrateOutfits,
    storageKeyForLibrary,
    storageKeyForOutfit,
    storageKeyForJob,
    upsertGenerationJob,
    getGenerationJob,
    listGenerationJobs,
    listGenerationJobsWithOwners,
    deleteGenerationJob,
    uploadJobAsset,
    downloadJobAsset,
    deleteJobAssets,
    ensureUserProfile,
    getUserProfile,
    updateUserProfile,
    redeemInvite,
    uploadUserReference,
    clearUserReference,
    ensureUserReferenceFile,
    migrateLegacyData,
    publicAssetUrl,
  };
}
