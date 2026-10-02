import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import sharp from "sharp";

const queues = new Map();
export function serialMutation(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(key, current);
  return current.finally(() => { if (queues.get(key) === current) queues.delete(key); });
}

export async function readLocalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw Object.assign(new Error(`无法读取数据文件 ${path.basename(file)}，请检查或从备份恢复。`), { status: 500, cause: error });
  }
}

export async function atomicLocalWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export function createLocalStore({ root, env = {}, visionProvider, imageProvider }) {
  const dataRoot = path.resolve(root, env.WARDROBE_DATA_DIR || "data");
  const paths = {
    root: dataRoot, dataRoot,
    jobsDir: path.join(dataRoot, "jobs"),
    importedFile: path.join(dataRoot, "library.json"),
    libraryFile: path.join(dataRoot, "library.json"),
    libraryAssetDir: path.join(dataRoot, "imported"),
    importedDir: path.join(dataRoot, "imported"),
    outfitJobsDir: path.join(dataRoot, "outfit-jobs"),
    outfitImagesDir: path.join(dataRoot, "outfit-images"),
    outfitsFile: path.join(dataRoot, "outfits.json"),
    uploadsDir: path.join(dataRoot, "uploads"),
    profileFile: path.join(dataRoot, "profile.json"),
    referenceFile: path.resolve(root, env.WARDROBE_MODEL_REFERENCE || path.join(dataRoot, "model-reference.png")),
  };
  async function init() {
    for (const dir of [dataRoot, paths.jobsDir, paths.libraryAssetDir, paths.outfitJobsDir, paths.outfitImagesDir, paths.uploadsDir]) await mkdir(dir, { recursive: true });
  }
  function uploadFile(id, scope) {
    if (!["jobs", "wardrobe", "profile"].includes(scope) || typeof id !== "string" || !new RegExp(`^${scope}-[a-f0-9-]{36}$`, "i").test(id)) {
      throw Object.assign(new Error("上传图片标识无效或用途不匹配，请重新上传。"), { status: 400 });
    }
    return path.join(paths.uploadsDir, `${id}.png`);
  }
  async function profile() {
    const stored = await readLocalJson(paths.profileFile, { nickname: "我的衣橱" });
    let reference = null;
    try { reference = await stat(paths.referenceFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const hasReference = Boolean(reference?.isFile());
    return {
      user_id: "local", mode: "local", nickname: stored.nickname || "我的衣橱",
      // Compatibility inside the existing import service; no invitation is required locally.
      invite_activated: true,
      reference_image_key: hasReference ? "local-reference" : null,
      reference_image_url: hasReference ? `/api/profile/reference?v=${reference.mtimeMs}` : null,
      dataDirectory: dataRoot,
      ai: {
        visionProvider: visionProvider.id, imageProvider: imageProvider.id,
        visionModel: env[visionProvider.id === "dashscope" ? "DASHSCOPE_VISION_MODEL" : "OPENAI_VISION_MODEL"] || "默认模型",
        imageModel: env[imageProvider.id === "dashscope" ? "DASHSCOPE_IMAGE_MODEL" : "OPENAI_IMAGE_MODEL"] || "默认模型",
        outfitModel: env[imageProvider.id === "dashscope" ? "DASHSCOPE_OUTFIT_MODEL" : "OPENAI_OUTFIT_MODEL"] || "默认模型",
        importReady: visionProvider.isConfigured() && imageProvider.isConfigured(),
        outfitReady: imageProvider.isConfigured() && hasReference,
        missingConfiguration: [...new Set([...(visionProvider.configurationIssues?.() || []), ...(imageProvider.configurationIssues?.() || [])])],
      },
    };
  }
  return {
    paths, init, profile,
    async currentUser() { return { user: { id: "local" }, profile: await profile() }; },
    mutate(operation) { return serialMutation(dataRoot, operation); },
    async readUpload(id, scope) {
      try { return { data: await readFile(uploadFile(id, scope)), imageKey: id }; }
      catch (error) { if (error.code === "ENOENT") throw Object.assign(new Error("上传图片已失效，请重新选择。"), { status: 404 }); throw error; }
    },
    async removeUpload(id, scope) { await rm(uploadFile(id, scope), { force: true }); },
    async saveUpload(bytes, scope) {
      const id = `${scope}-${randomUUID()}`;
      const file = uploadFile(id, scope);
      let normalized;
      try { normalized = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().toColorspace("srgb").png().toBuffer(); }
      catch { throw Object.assign(new Error("无法读取图片，请选择有效的 PNG、JPEG 或 WebP。"), { status: 400 }); }
      await atomicLocalWrite(file, normalized);
      return { upload_id: id };
    },
    async updateProfile(nickname) {
      if (typeof nickname !== "string" || !nickname.trim()) throw Object.assign(new Error("请填写昵称。"), { status: 400 });
      await atomicLocalWrite(paths.profileFile, JSON.stringify({ nickname: nickname.trim().slice(0, 40) }, null, 2));
      return profile();
    },
    async setReference(id) {
      const { data } = await this.readUpload(id, "profile");
      await atomicLocalWrite(paths.referenceFile, data);
      await this.removeUpload(id, "profile");
      return profile();
    },
    async clearReference() { await rm(paths.referenceFile, { force: true }); return profile(); },
  };
}

export function localMutationHandler(local, handler, prefixes) {
  return (req, res, next) => {
    if (!prefixes.some(prefix => req.url.startsWith(prefix))) return next();
    const run = () => handler(req, res, next);
    const task = !["GET", "HEAD", "OPTIONS"].includes(req.method) ? local.mutate(run) : run();
    return Promise.resolve(task).catch(next);
  };
}
