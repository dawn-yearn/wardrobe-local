import { localMutationHandler } from "./local-store.mjs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createImageProvider } from "./providers/index.mjs";
import { createOutfitService, OutfitServiceError } from "./outfit-service.mjs";
import { authenticateRequest, jsonError } from "./auth.mjs";
import { requireAiAccess } from "./ai-access.mjs";

const API_ROOT = "/api/outfits";

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new OutfitServiceError("Request body too large", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OutfitServiceError("Expected a JSON request body");
  }
}

export function wardrobeOutfitApi(options = {}) {
  let service;
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const imageProvider = options.imageProvider || createImageProvider({ env: options.env });

  async function servePng(res, file, cacheControl) {
    if (!file) throw new OutfitServiceError("Image not found", 404);
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
    } catch {
      throw new OutfitServiceError("Image not found", 404);
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", cacheControl);
    res.end(await readFile(file));
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(API_ROOT)) return next();
    try {
      const user = options.local ? { id: "local" } : await authenticateRequest(req, { env: options.env, verify: options.verify });
      if (!options.local && !options.cloud?.enabled) throw Object.assign(new Error("Cloud persistence is required for multi-user mode"), { status: 503 });
      const profile = options.local ? await options.local.profile() : await options.cloud.ensureUserProfile(user);
      const userId = user.id;
      if (url.pathname === API_ROOT && req.method === "GET") {
        return json(res, 200, await service.listOutfits(userId));
      }
      const aiRoute = url.pathname === `${API_ROOT}/config`
        || (url.pathname === `${API_ROOT}/jobs` && req.method === "POST")
        || Boolean(url.pathname.match(/^\/api\/outfits\/jobs\/[^/]+\/regenerate$/i));
      if (aiRoute && !(options.local && url.pathname === `${API_ROOT}/config`)) {
        requireAiAccess(profile);
        if (!profile.reference_image_key) throw Object.assign(new Error("请先在“用户信息”上传人物参考照片"), { status: 409 });
      }
      if (url.pathname === `${API_ROOT}/config` && req.method === "GET") {
        return json(res, 200, await service.configuration(userId));
      }
      if (url.pathname === `${API_ROOT}/jobs` && req.method === "GET") {
        return json(res, 200, await service.listJobs(userId));
      }
      if (url.pathname === `${API_ROOT}/jobs` && req.method === "POST") {
        const input = await body(req);
        return json(res, 202, await service.createJob(input, userId));
      }

      const previewMatch = url.pathname.match(/^\/api\/outfits\/assets\/([a-z0-9-]{8,200})\/([\w.-]+)$/i);
      if (previewMatch && req.method === "GET") {
        const previewJob = await service.getJob(previewMatch[1], userId);
        if (!previewJob) throw new OutfitServiceError("Outfit job not found", 404);
        return servePng(
          res,
          service.previewAssetPath(previewMatch[1], path.basename(previewMatch[2]), userId),
          "no-store",
        );
      }
      const imageMatch = url.pathname.match(/^\/api\/outfits\/images\/([\w.-]+)$/i);
      if (imageMatch && req.method === "GET") {
        return servePng(
          res,
          service.outfitImagePath(path.basename(imageMatch[1]), userId),
          "public, max-age=31536000, immutable",
        );
      }

      const jobMatch = url.pathname.match(/^\/api\/outfits\/jobs\/([a-z0-9-]{8,200})(?:\/(accept|regenerate))?$/i);
      if (!jobMatch) return json(res, 404, { error: "Not found" });
      const [, id, action] = jobMatch;
      if (!action && req.method === "GET") {
        const job = await service.getJob(id, userId);
        if (!job) throw new OutfitServiceError("Outfit job not found", 404);
        return json(res, 200, job);
      }
      if (!action && req.method === "DELETE") {
        return json(res, 200, await service.deleteJob(id, userId));
      }
      if (action === "accept" && req.method === "POST") {
        return json(res, 200, await service.acceptJob(id, userId));
      }
      if (action === "regenerate" && req.method === "POST") {
        const input = await body(req);
        return json(res, 202, await service.regenerateJob(id, userId, input.prompt));
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      const statusCode = error.status || (error.code === "ENOENT" ? 404 : 500);
      return jsonError(res, error);
    }
  }

  return {
    name: "wardrobe-outfit-api",
    apply: "serve",
    async configResolved(config) {
      service = createOutfitService({
        root: config.root,
        dataDir: setting("WARDROBE_DATA_DIR", "data"),
        modelReference: setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"),
        imageProvider,
        cloud: options.cloud,
        local: options.local,
      });
      await service.init();
    },
    configureServer(server) {
      server.middlewares.use(options.local ? localMutationHandler(options.local, handler, ["/api/outfits"]) : handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(options.local ? localMutationHandler(options.local, handler, ["/api/outfits"]) : handler);
    },
  };
}
