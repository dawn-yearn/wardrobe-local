import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import sharp from "sharp";
import { createLocalStore } from "../../scripts/local-store.mjs";
import { localProfileApi } from "../../scripts/local-profile-api.mjs";
import { wardrobeImportApi } from "../../scripts/import-job-api.mjs";
import { wardrobeOutfitApi } from "../../scripts/outfit-api.mjs";

const base = fileURLToPath(new URL("../../backups/local-tests/", import.meta.url));
const png = () => sharp({ create: { width: 80, height: 80, channels: 4, background: "#555555" } }).png().toBuffer();

async function fixture(t, { configured = true } = {}) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  const calls = [];
  let failVision = false;
  const visionProvider = { id: "test", isConfigured: () => configured, configurationIssues: () => configured ? [] : ["TEST_KEY"], async analyze() {
    calls.push("vision");
    if (failVision) throw new Error("模拟网络中断");
    return [{ name: "测试上衣", part: "upperbody", color: "#555555", tags: ["测试"], boundingBox: { x: 0, y: 0, width: 1000, height: 1000 } }];
  } };
  const imageProvider = { id: "test", isConfigured: () => configured, configurationIssues: () => configured ? [] : ["TEST_KEY"], async edit(input) {
    calls.push({ purpose: input.purpose, images: input.images.length });
    if (input.purpose === "garment") {
      const key = input.prompt.match(/uniform solid (#[a-f0-9]{6})/i)[1];
      return sharp(Buffer.from(`<svg width="128" height="128"><rect width="128" height="128" fill="${key}"/><rect x="35" y="20" width="58" height="88" fill="#555555"/></svg>`)).png().toBuffer();
    }
    return png();
  } };
  let server;
  const env = { WARDROBE_DATA_DIR: "data", WARDROBE_MODEL_REFERENCE: "data/model-reference.png" };
  async function start() {
    const local = createLocalStore({ root, env, visionProvider, imageProvider });
    const options = { local, env, visionProvider, imageProvider };
    const handlers = [];
    for (const plugin of [localProfileApi(local), wardrobeImportApi(options), wardrobeOutfitApi(options)]) {
      await plugin.configResolved({ root });
      plugin.configureServer({ middlewares: { use(fn) { handlers.push(fn); } } });
    }
    server = http.createServer((req, res) => {
      let index = 0;
      const next = error => {
        if (error) { res.statusCode = 500; return res.end(JSON.stringify({ error: error.message })); }
        const handler = handlers[index++];
        if (!handler) { res.statusCode = 404; return res.end(); }
        Promise.resolve(handler(req, res, next)).catch(next);
      };
      next();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  }
  async function stop() { if (server) { await new Promise(resolve => server.close(resolve)); server = null; } }
  await start();
  t.after(async () => {
    await stop();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(base) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  });
  async function request(route, method = "GET", payload, headers = {}) {
    const body = Buffer.isBuffer(payload) ? payload : payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, path: route, method, headers: { ...(body ? { "Content-Type": Buffer.isBuffer(payload) ? "image/png" : "application/json" } : {}), ...headers } }, res => {
        const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks), headers: res.headers }));
      });
      req.on("error", reject); req.setTimeout(15000, () => req.destroy(new Error("Test request timed out"))); req.end(body);
    });
    if ((response.headers["content-type"] || "").includes("json")) response.value = JSON.parse(response.bytes.toString());
    return response;
  }
  async function upload(scope) { const res = await request(`/api/uploads?scope=${scope}`, "POST", await png()); assert.equal(res.status, 201, JSON.stringify(res.value)); return res.value.upload_id; }
  async function add(name, part) {
    const res = await request("/api/import/wardrobe", "POST", { upload_id: await upload("wardrobe"), metadata: { name, part } });
    assert.equal(res.status, 201, JSON.stringify(res.value)); return res.value;
  }
  return { root, calls, request, upload, add, restart: async () => { await stop(); await start(); }, stop, start, setFailVision: value => { failVision = value; } };
}

test("local wardrobe works without keys: concurrent writes, profile, pictures and restart", async t => {
  const app = await fixture(t, { configured: false });
  const items = await Promise.all(Array.from({ length: 6 }, (_, i) => app.add(`单品${i}`, i % 2 ? "lowerbody" : "upperbody")));
  assert.equal((await app.request("/api/import/wardrobe")).value.length, 6);
  assert.equal((await app.request(items[0].image)).status, 200);
  assert.equal((await app.request(`/api/import/wardrobe/${items[0].id}`, "PATCH", { metadata: { name: "已改名", part: "upperbody" } })).status, 200);
  assert.equal((await app.request("/api/profile", "PATCH", { nickname: "我的本地衣橱" })).status, 200);
  const profile = await app.request("/api/profile/reference", "POST", { upload_id: await app.upload("profile") });
  assert.equal(profile.status, 200); assert.equal(profile.value.ai.importReady, false);
  assert.equal((await app.request(profile.value.reference_image_url)).status, 200);
  await app.restart();
  assert.equal((await app.request("/api/profile")).value.nickname, "我的本地衣橱");
  assert.equal((await app.request("/api/import/wardrobe")).value.find(i => i.id === items[0].id).name, "已改名");
  assert.equal((await app.request(`/api/import/wardrobe/${items[0].id}`, "DELETE")).status, 200);
  await app.restart(); assert.equal((await app.request("/api/import/wardrobe")).value.length, 5);
  assert.equal((await app.request("/api/import/config")).value.ready, false);
  assert.equal((await app.request("/api/outfits/config")).value.ready, false);
  assert.equal((await app.request("/api/import/jobs", "POST", { upload_id: await app.upload("jobs") })).status, 503);
  assert.equal((await app.request("/api/profile/reference", "DELETE")).status, 200);
  assert.equal((await app.request("/api/profile")).value.reference_image_key, null);
  assert.equal(app.calls.length, 0);
});

test("test providers complete crop, garment, modeled and outfit review/save without real AI", async t => {
  const app = await fixture(t);
  await app.request("/api/profile/reference", "POST", { upload_id: await app.upload("profile") });
  const created = await app.request("/api/import/jobs", "POST", { upload_id: await app.upload("jobs") });
  assert.equal(created.status, 202, JSON.stringify(created.value));
  const id = created.value.jobs[0].id;
  const crop = await app.request(`/api/import/jobs/${id}/stages/crop/approve`, "POST", {});
  assert.equal(crop.value.stages.garment.status, "review", JSON.stringify(crop.value));
  await app.restart();
  assert.equal((await app.request(`/api/import/jobs/${id}`)).value.stages.garment.status, "review");
  const garment = await app.request(`/api/import/jobs/${id}/stages/garment/approve`, "POST", {});
  assert.equal(garment.value.stages.modeled.status, "review", JSON.stringify(garment.value));
  const saved = await app.request(`/api/import/jobs/${id}/stages/modeled/approve`, "POST", {});
  assert.equal(saved.status, 200); assert.ok(saved.value.persistedRecord.modeledImage);
  assert.equal((await app.request(saved.value.persistedRecord.modeledImage)).status, 200);
  const bottom = await app.add("裤子", "lowerbody");
  const outfit = await app.request("/api/outfits/jobs", "POST", { topId: `import-${id}`, bottomId: bottom.id });
  assert.equal(outfit.status, 202, JSON.stringify(outfit.value));
  let result;
  for (let n = 0; n < 100; n++) {
    result = (await app.request(`/api/outfits/jobs/${outfit.value.id}`)).value;
    if (!["queued", "processing"].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(result.status, "review", JSON.stringify(result));
  await app.restart();
  assert.equal((await app.request(`/api/outfits/jobs/${result.id}`)).value.status, "review");
  const accepted = await app.request(`/api/outfits/jobs/${result.id}/accept`, "POST", {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
  assert.equal((await app.request(accepted.value.image)).status, 200);
  await app.restart();
  assert.equal((await app.request("/api/outfits")).value.length, 1);
  assert.deepEqual(app.calls, ["vision", { purpose: "garment", images: 1 }, { purpose: "modeled", images: 2 }, { purpose: "outfit", images: 3 }]);
});

test("interrupted import/outfit tasks become failed on restart, preserve assets, never auto-generate", async t => {
  const app = await fixture(t);
  const created = await app.request("/api/import/jobs", "POST", { upload_id: await app.upload("jobs") });
  const id = created.value.jobs[0].id;
  const file = path.join(app.root, "data/jobs", id, "job.json");
  const job = JSON.parse(await readFile(file, "utf8"));
  job.stages.crop.status = "approved"; job.stages.crop.decision = "approved"; job.stages.garment.status = "processing";
  await app.stop(); await writeFile(file, JSON.stringify(job));
  const oid = randomUUID(), dir = path.join(app.root, "data/outfit-jobs", oid);
  await mkdir(dir); await writeFile(path.join(dir, "job.json"), JSON.stringify({ id: oid, status: "queued", createdAt: new Date().toISOString(), previewUrl: null }));
  await app.start();
  assert.equal((await app.request(`/api/import/jobs/${id}`)).value.stages.garment.status, "failed");
  assert.equal((await app.request(`/api/outfits/jobs/${oid}`)).value.status, "failed");
  assert.equal((await app.request(created.value.jobs[0].originalAssetUrl)).status, 200);
  assert.deepEqual(app.calls, ["vision"]);
  assert.equal((await app.request(`/api/outfits/jobs/${oid}`, "DELETE")).status, 200);
  const retried = await app.request(`/api/import/jobs/${id}/stages/garment/regenerate`, "POST", {});
  assert.equal(retried.value.stages.garment.status, "review", JSON.stringify(retried.value));
  const saved = await app.request(`/api/import/jobs/${id}/stages/garment/approve`, "POST", {});
  assert.equal(saved.value.stages.modeled.status, "failed");
  assert.match(saved.value.stages.modeled.error, /人物参考/);
  assert.equal((await app.request("/api/import/wardrobe")).value.length, 1);
  assert.equal((await app.request(`/api/import/jobs/${id}`, "DELETE")).status, 200);
  assert.equal((await app.request("/api/import/wardrobe")).value.length, 1);
});

test("upload validation, failed vision retry, malformed library and foreign origins", async t => {
  const app = await fixture(t);
  assert.equal((await app.request("/api/uploads?scope=profile", "POST", Buffer.from("not an image"))).status, 400);
  assert.equal((await app.request("/api/profile/reference", "POST", { upload_id: "../../.env" })).status, 400);
  const wrongScope = await app.upload("jobs");
  assert.equal((await app.request("/api/profile/reference", "POST", { upload_id: wrongScope })).status, 400);
  assert.equal((await app.request("/api/profile", "PATCH", { nickname: "foreign" }, { Origin: "https://foreign.invalid" })).status, 403);
  app.setFailVision(true);
  assert.equal((await app.request("/api/import/jobs", "POST", { upload_id: wrongScope })).status, 500);
  assert.ok((await readdir(path.join(app.root, "data/uploads"))).includes(`${wrongScope}.png`));
  app.setFailVision(false);
  assert.equal((await app.request("/api/import/jobs", "POST", { upload_id: wrongScope })).status, 202);
  assert.ok(!(await readdir(path.join(app.root, "data/uploads"))).includes(`${wrongScope}.png`));
  const file = path.join(app.root, "data/library.json"); await writeFile(file, "{broken");
  assert.equal((await app.request("/api/import/wardrobe")).status, 500);
  assert.equal(await readFile(file, "utf8"), "{broken");
});
