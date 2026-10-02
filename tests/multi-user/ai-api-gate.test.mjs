import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import sharp from "sharp";
import { wardrobeImportApi } from "../../scripts/import-job-api.mjs";
import { wardrobeOutfitApi } from "../../scripts/outfit-api.mjs";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function request(url, method, payload = null) {
  const req = Readable.from(payload === null ? [] : [Buffer.from(JSON.stringify(payload))]);
  req.url = url;
  req.method = method;
  req.headers = { authorization: "Bearer test-token" };
  return req;
}

function response() {
  let output = "";
  return {
    statusCode: 200,
    setHeader() {},
    end(value = "") { output += value; },
    json() { return JSON.parse(output || "{}"); },
  };
}

function cloudFor(profile) {
  return {
    enabled: true,
    async ensureReady() {},
    async ensureUserProfile() { return profile; },
    async hydrateWardrobe() {},
    async listGenerationJobs() { return []; },
    async listGenerationJobsWithOwners() { return []; },
    async getUserProfile() { return profile; },
    async downloadUserImage() { return PNG_BYTES; },
    async removeUserImage() {},
  };
}

async function install(plugin, root) {
  await plugin.configResolved({ root });
  let handler;
  plugin.configureServer({ middlewares: { use(next) { handler = next; } } });
  return handler;
}

test("ordinary users are rejected before the wardrobe AI endpoint reaches a model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-ai-gate-"));
  let visionCalls = 0;
  try {
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud: cloudFor({ invite_activated: false }),
      visionProvider: { id: "test-vision", isConfigured: () => true, analyze: async () => { visionCalls += 1; return []; } },
      imageProvider: { id: "test-image", isConfigured: () => true },
      env: {},
    }), root);
    const res = response();
    await handler(request("/api/import/jobs", "POST", { image_key: `users/${USER}/jobs/gated/source.png` }), res, () => {});
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "AI 功能尚未解锁，请在“用户信息”中填写邀请码");
    assert.equal(visionCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI import rejects another user's Storage key before reading the object", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-ai-key-owner-"));
  const otherUser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let storageReads = 0;
  try {
    const cloud = cloudFor({ invite_activated: true, reference_image_key: "reference.png" });
    cloud.downloadUserImage = async (_userId, key) => {
      storageReads += 1;
      if (!key.startsWith(`users/${USER}/`)) throw Object.assign(new Error("image_key does not belong to the authenticated user"), { status: 403 });
      return PNG_BYTES;
    };
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud,
      visionProvider: { id: "test-vision", isConfigured: () => true, analyze: async () => [] },
      imageProvider: { id: "test-image", isConfigured: () => true },
      env: {},
    }), root);
    const res = response();
    await handler(request("/api/import/jobs", "POST", { image_key: `users/${otherUser}/jobs/stolen/source.jpg` }), res, () => {});
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /authenticated user/);
    assert.equal(storageReads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new AI import requests reject legacy base64 image fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-ai-no-base64-"));
  try {
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud: cloudFor({ invite_activated: true, reference_image_key: "reference.png" }),
      visionProvider: { id: "test-vision", isConfigured: () => true, analyze: async () => [] },
      imageProvider: { id: "test-image", isConfigured: () => true },
      env: {},
    }), root);
    const res = response();
    await handler(request("/api/import/jobs", "POST", { imageDataUrl: "data:image/png;base64,AA==" }), res, () => {});
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /no longer accepted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI import exposes the exact failing phase when vision inference fails before job persistence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-ai-phase-diagnostics-"));
  try {
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud: cloudFor({ invite_activated: true, reference_image_key: "reference.png" }),
      visionProvider: {
        id: "meoo",
        isConfigured: () => true,
        analyze: async () => {
          throw Object.assign(new Error("upstream rejected image"), {
            status: 502,
            provider: "meoo",
            requestId: "req-upstream",
            endpoint: "https://api.meoo.host/meoo-ai/compatible-mode/v1/chat/completions",
            responseBody: "{\\\"error\\\":\\\"upstream rejected image\\\"}",
            requestBytes: 1234,
          });
        },
      },
      imageProvider: { id: "meoo", isConfigured: () => true },
      env: {},
    }), root);
    const res = response();
    await handler(request("/api/import/jobs", "POST", { image_key: `users/${USER}/jobs/phase/source.jpg` }), res, () => {});
    const value = res.json();
    assert.equal(res.statusCode, 502);
    assert.equal(value.error, "upstream rejected image");
    assert.equal(value.phase, "ai_vision_inference");
    assert.equal(value.provider, "meoo");
    assert.equal(value.provider_status, 502);
    assert.equal(value.provider_request_id, "req-upstream");
    assert.match(value.provider_response_body, /upstream rejected image/);
    assert.equal(value.provider_request_bytes, 1234);
    assert.match(value.request_id, /^[0-9a-f-]{36}$/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary users can save an original wardrobe image with empty metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-manual-save-"));
  try {
    const cloud = cloudFor({ invite_activated: false });
    let uploaded = false;
    cloud.upsertWardrobeRecord = async (record) => {
      uploaded = true;
      const image = `https://storage.test/users/${USER}/wardrobe/${record.id}-garment.png`;
      return { ...record, image, thumbnail: image };
    };
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud,
      visionProvider: { id: "test-vision", isConfigured: () => true, analyze: async () => { throw new Error("vision must not run"); } },
      imageProvider: { id: "test-image", isConfigured: () => true },
      env: {},
    }), root);
    const res = response();
    await handler(request("/api/import/wardrobe", "POST", { image_key: `users/${USER}/wardrobe/manual-source.png`, metadata: {} }), res, () => {});
    const saved = res.json();
    assert.equal(res.statusCode, 201, res.json().error);
    assert.equal(saved.name, "");
    assert.equal(saved.part, null);
    assert.equal(saved.color, null);
    assert.equal(saved.importJobId, undefined);
    assert.equal(saved.modeledImage, null);
    assert.match(saved.image, /^https:\/\/storage\.test\/users\//);
    assert.equal(uploaded, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual wardrobe endpoint preserves optional metadata without invoking AI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-manual-metadata-"));
  try {
    const cloud = cloudFor({ invite_activated: false });
    let uploadedRecord;
    cloud.upsertWardrobeRecord = async (record) => {
      const image = `https://storage.test/users/${USER}/wardrobe/${record.id}-garment.png`;
      uploadedRecord = { ...structuredClone(record), image, thumbnail: image };
      return structuredClone(uploadedRecord);
    };
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud,
      visionProvider: { id: "test-vision", isConfigured: () => true, analyze: async () => { throw new Error("vision must not run"); } },
      imageProvider: { id: "test-image", isConfigured: () => true },
      env: {},
    }), root);
    const res = response();
    await handler(request("/api/import/wardrobe", "POST", { image_key: `users/${USER}/wardrobe/manual-metadata.png`, metadata: { name: "猫咪挂件", part: "accessories_up", color: "#AABBCC", secondaryColor: "#112233", tags: "猫, 配饰" } }), res, () => {});
    const saved = res.json();
    assert.equal(res.statusCode, 201);
    assert.deepEqual({ name: saved.name, part: saved.part, color: saved.color, secondaryColor: saved.secondaryColor, tags: saved.tags }, {
      name: "猫咪挂件", part: "accessories_up", color: "#aabbcc", secondaryColor: "#112233", tags: ["猫", "配饰"],
    });
    assert.match(saved.image, /^https:\/\/storage\.test\/users\//);
    assert.match(uploadedRecord.image, /^https:\/\/storage\.test\/users\//);
    assert.doesNotMatch(uploadedRecord.image, /\/api\/import\/library\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wardrobe metadata edits persist through the authenticated PATCH route", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-manual-patch-"));
  const id = "import-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    const existing = {
      id,
      name: "",
      part: null,
      color: null,
      secondaryColor: null,
      tags: [],
      image: "https://storage.test/users/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/wardrobe/item.png",
      thumbnail: "https://storage.test/users/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/wardrobe/item.png",
      modeledImage: null,
      palette: [],
    };
    const cloud = cloudFor({ invite_activated: false });
    cloud.listWardrobeRecords = async () => [existing];
    let updatedRecord;
    cloud.updateWardrobeRecord = async (record) => {
      updatedRecord = structuredClone(record);
      return record;
    };
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud,
      visionProvider: { id: "test-vision", isConfigured: () => true },
      imageProvider: { id: "test-image", isConfigured: () => true },
      env: {},
    }), root);
    const res = response();
    await handler(request(`/api/import/wardrobe/${id}`, "PATCH", {
      metadata: { name: "猫咪挂件", category: "accessories_up", primaryColor: "#AABBCC", tags: ["猫", "配饰"] },
    }), res, () => {});
    assert.equal(res.statusCode, 200, res.json().error);
    assert.deepEqual(res.json(), {
      ...existing,
      name: "猫咪挂件",
      part: "accessories_up",
      color: "#aabbcc",
      tags: ["猫", "配饰"],
    });
    assert.equal(updatedRecord.part, "accessories_up");
    assert.equal(updatedRecord.color, "#aabbcc");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI review rejects stale stages but treats an already successful decision as idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-review-idempotency-"));
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let stored = {
    id,
    status: "active",
    stages: {
      crop: { status: "approved", decision: "approved" },
      garment: { status: "review", decision: null },
      modeled: { status: "pending", decision: null },
    },
    internal: { originalFile: "original.png", cropFile: "crop.png" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    const cloud = cloudFor({ invite_activated: true });
    cloud.getGenerationJob = async () => structuredClone(stored);
    cloud.downloadJobAsset = async () => null;
    cloud.listWardrobeRecords = async () => [];
    cloud.upsertGenerationJob = async (job) => { stored = structuredClone(job); };
    cloud.deleteGenerationJob = async () => {};
    cloud.deleteJobAssets = async () => {};
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud,
      visionProvider: { id: "test-vision", isConfigured: () => true },
      imageProvider: { id: "test-image", isConfigured: () => true },
      env: {},
    }), root);

    const duplicate = response();
    await handler(request(`/api/import/jobs/${id}/stages/crop/approve`, "POST"), duplicate, () => {});
    assert.equal(duplicate.statusCode, 200, duplicate.json().error);
    assert.equal(duplicate.json().stages.crop.status, "approved");
    assert.equal(duplicate.json().stages.garment.status, "review");

    const stale = response();
    await handler(request(`/api/import/jobs/${id}/stages/crop/reject`, "POST"), stale, () => {});
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json().error, /current review stage is garment/);

    const current = response();
    await handler(request(`/api/import/jobs/${id}/stages/garment/reject`, "POST"), current, () => {});
    assert.equal(current.statusCode, 200, current.json().error);
    assert.equal(current.json().stages.garment.status, "rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AI import falls back to a full-image crop and waits until garment review is persisted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-ai-crop-pipeline-"));
  const jobs = new Map();
  const assets = new Map();
  let imageCalls = 0;
  const cloud = cloudFor({ invite_activated: true });
  cloud.ensureReady = async () => true;
  cloud.listGenerationJobsWithOwners = async () => [];
  cloud.upsertGenerationJob = async (job) => { jobs.set(job.id, structuredClone(job)); };
  cloud.getGenerationJob = async (id) => jobs.has(id) ? structuredClone(jobs.get(id)) : null;
  cloud.uploadJobAsset = async (userId, jobId, filename, file) => { assets.set(`${userId}/${jobId}/${filename}`, await readFile(file)); };
  cloud.downloadJobAsset = async (userId, jobId, filename) => assets.get(`${userId}/${jobId}/${filename}`) || null;
  try {
    const garmentBytes = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#00ff00" } })
      .composite([{ input: await sharp({ create: { width: 72, height: 96, channels: 4, background: "#cc2233" } }).png().toBuffer(), left: 28, top: 16 }])
      .png()
      .toBuffer();
    const handler = await install(wardrobeImportApi({
      verify: async () => ({ id: USER }),
      cloud,
      visionProvider: { id: "test-vision", isConfigured: () => true, analyze: async () => [] },
      imageProvider: { id: "test-image", isConfigured: () => true, edit: async () => { imageCalls += 1; return garmentBytes; } },
      env: {},
    }), root);
    const created = response();
    await handler(request("/api/import/jobs", "POST", { image_key: `users/${USER}/jobs/fallback/source.png`, metadata: { name: "fallback item" } }), created, () => {});
    assert.equal(created.statusCode, 202, created.json().error);
    assert.equal(created.json().jobs.length, 1);
    assert.equal(created.json().usedFullImageFallback, true);
    const createdJob = created.json().jobs[0];
    assert.equal(createdJob.detectionFallback, true);
    assert.equal(createdJob.stages.crop.status, "review");

    const approved = response();
    await handler(request(`/api/import/jobs/${createdJob.id}/stages/crop/approve`, "POST"), approved, () => {});
    assert.equal(approved.statusCode, 200, approved.json().error);
    assert.equal(imageCalls, 1);
    assert.equal(approved.json().stages.crop.status, "approved");
    assert.equal(approved.json().stages.garment.status, "review");
    assert.match(approved.json().stages.garment.assetUrl, /garment-1\.png$/);
    assert.equal(jobs.get(createdJob.id).stages.garment.status, "review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary users are rejected before outfit generation starts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-outfit-gate-"));
  let imageCalls = 0;
  try {
    const handler = await install(wardrobeOutfitApi({
      verify: async () => ({ id: USER }),
      cloud: cloudFor({ invite_activated: false, reference_image_key: "reference.png" }),
      imageProvider: { id: "test-image", isConfigured: () => true, edit: async () => { imageCalls += 1; return Buffer.from("x"); } },
      env: {},
    }), root);
    const res = response();
    await handler(request("/api/outfits/jobs", "POST", {}), res, () => {});
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "AI 功能尚未解锁，请在“用户信息”中填写邀请码");
    assert.equal(imageCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
