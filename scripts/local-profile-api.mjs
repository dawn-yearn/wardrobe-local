import { readFile } from "node:fs/promises";
import { localMutationHandler } from "./local-store.mjs";

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}
async function bytes(req, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error("上传文件过大。"), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function input(req) {
  try { return JSON.parse((await bytes(req, 128 * 1024)).toString("utf8")); }
  catch (error) { if (error.status) throw error; throw Object.assign(new Error("请求格式应为 JSON。"), { status: 400 }); }
}
export function localProfileApi(local) {
  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/profile") && !url.pathname.startsWith("/api/uploads") && url.pathname !== "/api/local/status") return next();
    try {
      if (url.pathname === "/api/local/status" && req.method === "GET") return json(res, 200, { mode: "local", stage: 5, cloudEnabled: false, businessReady: true });
      if (url.pathname === "/api/uploads" && req.method === "POST") {
        if (!/^image\//.test(req.headers["content-type"] || "")) throw Object.assign(new Error("请选择图片文件。"), { status: 400 });
        return json(res, 201, await local.saveUpload(await bytes(req, 15 * 1024 * 1024), url.searchParams.get("scope")));
      }
      const uploadMatch = url.pathname.match(/^\/api\/uploads\/([a-z0-9-]+)$/i);
      if (uploadMatch && req.method === "DELETE") {
        await local.removeUpload(uploadMatch[1], url.searchParams.get("scope"));
        return json(res, 200, { deleted: true });
      }
      if (url.pathname === "/api/profile") {
        if (req.method === "GET") return json(res, 200, await local.profile());
        if (["PATCH", "PUT"].includes(req.method)) return json(res, 200, await local.updateProfile((await input(req)).nickname));
      }
      if (url.pathname === "/api/profile/reference") {
        if (req.method === "GET") {
          const image = await readFile(local.paths.referenceFile);
          res.setHeader("Content-Type", "image/png"); res.setHeader("Cache-Control", "no-store"); return res.end(image);
        }
        if (req.method === "POST") return json(res, 200, await local.setReference((await input(req)).upload_id));
        if (req.method === "DELETE") return json(res, 200, await local.clearReference());
      }
      return json(res, 404, { error: "接口不存在。" });
    } catch (error) { return json(res, error.status || (error.code === "ENOENT" ? 404 : 500), { error: error.message }); }
  }
  const route = localMutationHandler(local, handler, ["/api/profile", "/api/uploads", "/api/local/status"]);
  // The guard runs before every business API, including unauthenticated local writes.
  const guard = (req, res, next) => {
    if (req.url.startsWith("/sb-api")) return json(res, 410, { error: "本地版不使用云端登录。" });
    if (!req.url.startsWith("/api/")) return next();
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: "请从本地衣橱页面操作。" });
    return next();
  };
  return {
    name: "wardrobe-local-profile", apply: "serve",
    async configResolved() { await local.init(); },
    configureServer(server) { server.middlewares.use(guard); server.middlewares.use(route); },
    configurePreviewServer(server) { server.middlewares.use(guard); server.middlewares.use(route); },
  };
}
