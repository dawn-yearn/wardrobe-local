import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import sharp from "sharp";
import { createCloudPersistence } from "../../scripts/cloud-persistence.mjs";
import { createOutfitService } from "../../scripts/outfit-service.mjs";
import { wardrobeOutfitApi } from "../../scripts/outfit-api.mjs";
import { wardrobeImportApi } from "../../scripts/import-job-api.mjs";
import { isDirectStorageUrl } from "../../src/image-url.js";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const selection = { topId: "import-top-test", bottomId: "import-bottom-test" };

async function fixture(t) {
  const roots = [];
  t.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
  const newRoot = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-cloud-images-"));
    roots.push(root);
    return root;
  };
  const bytes = await Promise.all(["#555555", "#cc3333", "#3333cc"].map((background) =>
    sharp({ create: { width: 4, height: 4, channels: 4, background } }).png().toBuffer()));
  const referenceKey = `users/${USER}/profile/reference/person.png`;
  const tables = {
    wardrobe_items: [], generation_jobs: [], outfits: [],
    user_profiles: [{ user_id: USER, invite_activated: true, reference_image_key: referenceKey }],
  };
  const assets = new Map([[referenceKey, bytes[0]]]);
  const downloads = [];
  // Only the database/Storage transport is replaced; use the production persistence methods.
  const client = {
    storage: {
      async createBucket() { return {}; }, async updateBucket() { return {}; },
      from() { return {
        async upload(key, data) { assets.set(key, Buffer.from(data)); return {}; },
        async remove(keys) { for (const key of keys) assets.delete(key); return {}; },
        async download(key) {
          downloads.push(key);
          return assets.has(key) ? { data: new Blob([assets.get(key)]) } : { error: { message: "missing object" } };
        },
      }; },
    },
    from(table) {
      const filters = [];
      const matches = () => structuredClone(tables[table].filter((row) => filters.every(([field, value]) => row[field] === value)));
      const query = {
        select() { return query; }, eq(field, value) { filters.push([field, value]); return query; },
        order() { return query; },
        async maybeSingle() { return { data: matches()[0] || null }; },
        then(resolve, reject) { return Promise.resolve({ data: matches() }).then(resolve, reject); },
        async upsert(row) {
          tables[table] = [...tables[table].filter((value) => value.id !== row.id), structuredClone(row)];
          return {};
        },
      };
      return query;
    },
  };
  const cloud = createCloudPersistence({ env: { SUPABASE_URL: "https://storage.example.test", SUPABASE_SERVICE_ROLE_KEY: "test-only" }, client });
  for (const [index, id, part] of [[1, selection.topId, "upperbody"], [2, selection.bottomId, "lowerbody"]]) {
    await cloud.upsertWardrobeRecord({ id, part, name: part, image: `/api/import/library/${id}-garment.png` }, { image: bytes[index] }, USER);
  }
  const calls = [];
  const imageProvider = {
    id: "test", isConfigured: () => true, configurationIssues: () => [],
    async edit(input) { calls.push(input); return bytes[0]; },
  };
  const root = await newRoot();
  const service = createOutfitService({ root, cloud, imageProvider });
  await service.init();
  return { root, newRoot, cloud, service, tables, assets, downloads, bytes, calls, imageProvider };
}

test("cloud imports display and generate top + bottom on a fresh instance without local wardrobe assets", async (t) => {
  const f = await fixture(t);
  const displayed = await f.cloud.listWardrobeRecords(USER);
  assert.equal(displayed.length, 2);
  for (const item of displayed) assert.equal(isDirectStorageUrl(item.image), true);
  const job = await f.service.createJob(selection, USER);
  const result = await f.service.waitForIdle(job.id, USER);
  assert.equal(result.status, "review", result.error);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].images.map((image) => image.name), ["model-reference.png", "top.png", "bottom.png"]);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await sharp(f.calls[0].images[index].data).raw().toBuffer(), await sharp(f.bytes[index]).raw().toBuffer());
  }
  assert.deepEqual(await readdir(path.join(f.root, "data", "users", USER, "imported")), []);
  // A second instance starts with no copied files and resolves the same selection from cloud state.
  const second = createOutfitService({ root: await f.newRoot(), cloud: f.cloud, imageProvider: f.imageProvider });
  await second.init();
  await second.validateSelection(selection, USER);
});

test("legacy row JSON is canonicalized using its migrated owner-scoped image_key", async (t) => {
  const f = await fixture(t);
  f.tables.wardrobe_items[0].record_json.image = "/api/import/library/old-top.png";
  const job = await f.service.createJob(selection, USER);
  assert.equal((await f.service.waitForIdle(job.id, USER)).status, "review");
  assert.equal(f.tables.wardrobe_items[0].record_json.image, "/api/import/library/old-top.png");
});

test("selection rejects another user's item id and a stale local cache", async (t) => {
  const f = await fixture(t);
  await f.service.configuration(USER);
  await writeFile(path.join(f.root, "data", "users", USER, "library.json"), JSON.stringify(f.tables.wardrobe_items.map((row) => row.record_json)));
  f.tables.wardrobe_items[0].user_id = OTHER;
  f.downloads.length = 0;
  await assert.rejects(f.service.validateSelection(selection, USER), /was not found/);
  assert.deepEqual(f.downloads, []);
});

test("cloud wardrobe keys reject traversal, filesystem paths, and cross-user objects before any read", async (t) => {
  const f = await fixture(t);
  const prefix = `users/${USER}/wardrobe/`;
  const unsafe = [
    "../../something", "/etc/passwd", "C:\\secret.png", "file:///etc/passwd",
    `users/${OTHER}/wardrobe/secret.png`, `${prefix}../../secret.png`,
    `${prefix}..\\secret.png`, `${prefix}%2e%2e%2fsecret.png`,
    `${prefix}C:secret.png`, `${prefix}.`, `${prefix}..`, `${prefix}bad\0.png`,
  ];
  for (const key of unsafe) {
    f.tables.wardrobe_items[0].image_key = key;
    f.downloads.length = 0;
    await assert.rejects(f.service.validateSelection(selection, USER), /unsafe image path/, key);
    assert.deepEqual(f.downloads, [], key);
  }
});

test("cloud resolver rejects foreign hosts, buckets, signed URLs and noncanonical URL traversal", async (t) => {
  const f = await fixture(t);
  const items = await f.cloud.listWardrobeRecords(USER);
  f.cloud.listWardrobeRecords = async () => items;
  const valid = items[0].image;
  for (const image of [
    valid.replace("storage.example.test", "attacker.test"),
    valid.replace("wardrobe-assets", "another-bucket"),
    `${valid}?token=untrusted`, valid.replace("/object/public/", "/object/sign/"),
    valid.replace("import-top-test-garment.png", "../wardrobe/import-top-test-garment.png"),
    valid.replace("import-top-test-garment.png", "%2e%2e%2fsecret.png"),
    "../../something", "file:///etc/passwd", "/api/import/library/top.png",
  ]) {
    items[0].image = image;
    f.downloads.length = 0;
    await assert.rejects(f.service.validateSelection(selection, USER), /unsafe image path/, image);
    assert.deepEqual(f.downloads, [], image);
  }
});

test("manual Storage import -> wardrobe display -> authenticated outfit POST reaches the provider", async (t) => {
  const f = await fixture(t);
  const importer = wardrobeImportApi({ cloud: f.cloud, imageProvider: f.imageProvider, visionProvider: { id: "unused" }, verify: async () => ({ id: USER }) });
  await importer.configResolved({ root: f.root });
  let importHandler;
  importer.configureServer({ middlewares: { use(value) { importHandler = value; } } });
  const uploadKey = `users/${USER}/wardrobe/manual-source.png`;
  f.assets.set(uploadKey, f.bytes[1]);
  const importRequest = Readable.from([Buffer.from(JSON.stringify({ image_key: uploadKey, metadata: { part: "upperbody", name: "Manual top" } }))]);
  Object.assign(importRequest, { url: "/api/import/wardrobe", method: "POST", headers: { authorization: "Bearer test-token" } });
  let imported;
  const importResponse = { statusCode: 0, setHeader() {}, end(value) { imported = JSON.parse(value); } };
  await importHandler(importRequest, importResponse, () => assert.fail("unhandled import"));
  assert.equal(importResponse.statusCode, 201, JSON.stringify(imported));
  assert.equal(isDirectStorageUrl(imported.image), true);
  assert.equal((await f.cloud.listWardrobeRecords(USER)).find((item) => item.id === imported.id).image, imported.image);
  // Outfit creation runs on an empty instance, independent of the importer's local files.
  const plugin = wardrobeOutfitApi({ cloud: f.cloud, imageProvider: f.imageProvider, verify: async () => ({ id: USER }) });
  await plugin.configResolved({ root: await f.newRoot() });
  let handler;
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  let complete;
  const finished = new Promise((resolve) => { complete = resolve; });
  const upsert = f.cloud.upsertGenerationJob;
  f.cloud.upsertGenerationJob = async (job, options) => {
    await upsert(job, options);
    if (["review", "failed"].includes(job.status)) complete(job);
  };
  const req = Readable.from([Buffer.from(JSON.stringify({ topId: imported.id, bottomId: selection.bottomId }))]);
  Object.assign(req, { url: "/api/outfits/jobs", method: "POST", headers: { authorization: "Bearer test-token" } });
  let body;
  const res = { statusCode: 0, setHeader() {}, end(value) { body = JSON.parse(value); } };
  await handler(req, res, () => assert.fail("unhandled request"));
  assert.equal(res.statusCode, 202, JSON.stringify(body));
  const result = await finished;
  assert.equal(result.status, "review", result.error);
  assert.equal(f.calls.length, 1);
});
