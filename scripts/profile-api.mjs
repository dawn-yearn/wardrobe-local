import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { authenticateRequest, jsonError, maskPhone } from "./auth.mjs";

// Beta demo fallback intentionally stays server-side. It is never imported by the React bundle.
const BETA_INVITE_CODE = process.env.BETA_INVITE_CODE || "closai-ward26";
const BETA_MAX_USERS = Number(process.env.BETA_MAX_USERS || 20);

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function body(req, limit = 15 * 1024 * 1024) {
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

export function wardrobeProfileApi(options = {}) {
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const cloud = options.cloud;

  async function currentUser(req) {
    const user = await authenticateRequest(req, { env: options.env, verify: options.verify });
    if (!cloud?.enabled) throw Object.assign(new Error("Cloud persistence is required for multi-user mode"), { status: 503 });
    const profile = await cloud.ensureUserProfile(user);
    return { user, profile };
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/profile")) return next();
    try {
      const { user, profile } = await currentUser(req);
      if (url.pathname === "/api/profile" && req.method === "GET") {
        return json(res, 200, { ...profile, phone: maskPhone(user.phone) });
      }
      if (url.pathname === "/api/profile" && (req.method === "PATCH" || req.method === "PUT")) {
        const input = await body(req, 256 * 1024);
        const nickname = typeof input.nickname === "string" ? input.nickname.trim().slice(0, 40) : "";
        if (!nickname) throw Object.assign(new Error("Nickname is required"), { status: 400 });
        return json(res, 200, { ...(await cloud.updateUserProfile(user.id, { nickname })), phone: maskPhone(user.phone) });
      }
      if (url.pathname === "/api/profile/redeem-invite" && req.method === "POST") {
        const input = await body(req, 64 * 1024);
        const code = typeof input.code === "string" ? input.code.trim() : "";
        const next = await cloud.redeemInvite(user.id, code, BETA_INVITE_CODE, BETA_MAX_USERS);
        return json(res, 200, { ...next, phone: maskPhone(user.phone) });
      }
      if (url.pathname === "/api/profile/reference" && req.method === "POST") {
        const input = await body(req);
        if (input?.imageDataUrl || input?.imageBase64) throw Object.assign(new Error("Base64 image payloads are no longer accepted; upload to Storage and submit image_key"), { status: 400 });
        if (typeof input?.image_key !== "string" || !input.image_key) throw Object.assign(new Error("image_key is required"), { status: 400 });
        const source = await cloud.downloadUserImage(user.id, input.image_key, "profile");
        const normalized = await sharp(source).rotate().toColorspace("srgb").png().toBuffer();
        const next = await cloud.uploadUserReference(user.id, normalized, "image/png", randomUUID());
        try { await cloud.removeUserImage?.(user.id, input.image_key, "profile"); }
        catch (error) { console.error("Temporary profile image cleanup failed", { message: error.message }); }
        return json(res, 200, { ...next, phone: maskPhone(user.phone) });
      }
      if (url.pathname === "/api/profile/reference" && req.method === "DELETE") {
        const next = await cloud.clearUserReference(user.id);
        return json(res, 200, { ...next, phone: maskPhone(user.phone) });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      return jsonError(res, error);
    }
  }

  return {
    name: "wardrobe-profile-api",
    apply: "serve",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
