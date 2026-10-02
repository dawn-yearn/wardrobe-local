import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  createOutfitService,
  normalizeOutfitSelection,
} from "../../scripts/outfit-service.mjs";

async function png(color) {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: color,
    },
  }).png().toBuffer();
}

function fakeCloud() {
  const jobs = new Map();
  const assets = new Map();
  return {
    enabled: true,
    async ensureReady() {},
    async hydrateOutfits() {},
    async upsertGenerationJob(job) { jobs.set(job.id, structuredClone(job)); },
    async getGenerationJob(id) { return structuredClone(jobs.get(id) || null); },
    async listGenerationJobs() { return [...jobs.values()].map((job) => structuredClone(job)); },
    async deleteGenerationJob(id) { jobs.delete(id); },
    async uploadJobAsset(id, filename, file) { assets.set(`${id}/${filename}`, await readFile(file)); },
    async downloadJobAsset(id, filename) { return assets.get(`${id}/${filename}`) || null; },
    async deleteJobAssets(id, filenames) { for (const filename of filenames) assets.delete(`${id}/${filename}`); },
    async upsertOutfitRecord() {},
  };
}

async function fixture({ provider, cloud } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-outfit-test-"));
  const dataDir = path.join(root, "data");
  const importedDir = path.join(dataDir, "imported");
  await mkdir(importedDir, { recursive: true });
  await writeFile(path.join(dataDir, "model-reference.png"), await png("#555555"));
  await writeFile(path.join(importedDir, "top.png"), await png("#cc3333"));
  await writeFile(path.join(importedDir, "bottom.png"), await png("#3333cc"));
  await writeFile(path.join(importedDir, "wrong.png"), await png("#999999"));
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify([
    {
      id: "top-item-1",
      name: "Red top",
      part: "upperbody",
      color: "#cc3333",
      image: "/api/import/library/top.png",
    },
    {
      id: "bottom-item-1",
      name: "Blue bottom",
      part: "lowerbody",
      color: "#3333cc",
      image: "/api/import/library/bottom.png",
    },
    {
      id: "wrong-item-1",
      name: "Wrong category",
      part: "upperbody",
      color: "#999999",
      image: "/api/import/library/wrong.png",
    },
  ]));
  const calls = [];
  const imageProvider = provider || {
    id: "test",
    isConfigured: () => true,
    configurationIssues: () => [],
    async edit(input) {
      calls.push(input);
      return png("#22aa66");
    },
  };
  const service = createOutfitService({
    root,
    imageProvider,
    cloud,
    idFactory: () => "outfit-test-0001",
    now: (() => {
      let tick = 0;
      return () => `2026-07-26T12:00:0${tick++}.000Z`;
    })(),
  });
  await service.init();
  return {
    root,
    dataDir,
    service,
    imageProvider,
    calls,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("selection requires one top and one bottom and reserves future slots", () => {
  assert.throws(
    () => normalizeOutfitSelection({ bottomId: "bottom-item-1" }),
    /topId is required/,
  );
  assert.throws(
    () => normalizeOutfitSelection({
      topId: "top-item-1",
      bottomId: "bottom-item-1",
      outerwearId: "future-item",
    }),
    /outerwearId is reserved for a future release/,
  );
  assert.deepEqual(
    normalizeOutfitSelection({ topId: "top-item-1", bottomId: "bottom-item-1" }),
    {
      topId: "top-item-1",
      bottomId: "bottom-item-1",
      outerwearId: null,
      shoesId: null,
      accessoryId: null,
    },
  );
});

test("service validates ids, categories, and server-side local library images", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      context.service.validateSelection({
        topId: "top-item-1",
        bottomId: "missing-item",
      }),
      /Bottom wardrobe item missing-item was not found/,
    );
    await assert.rejects(
      context.service.validateSelection({
        topId: "top-item-1",
        bottomId: "wrong-item-1",
      }),
      /is not a lowerbody item/,
    );
    await assert.rejects(
      context.service.validateSelection({
        topId: "top-item-1",
        bottomId: "bottom-item-1",
        image: "C:\\secret.png",
      }),
      /unsupported fields: image/,
    );
  } finally {
    await context.cleanup();
  }
});

test("offline legacy image paths retain traversal and filesystem protections", async () => {
  const context = await fixture();
  try {
    const libraryFile = path.join(context.dataDir, "library.json");
    const library = JSON.parse(await readFile(libraryFile, "utf8"));
    for (const image of [
      "../../something", "C:\\secret.png", "/etc/passwd", "file:///etc/passwd",
      "/api/import/library/../../something", "/api/import/library/%2e%2e%2fsecret.png",
      "/api/import/library/..%5csecret.png", "/api/import/library/C:secret.png",
    ]) {
      library[0].image = image;
      await writeFile(libraryFile, JSON.stringify(library));
      await assert.rejects(context.service.validateSelection({ topId: "top-item-1", bottomId: "bottom-item-1" }), /unsafe image path/);
    }
  } finally {
    await context.cleanup();
  }
});

test("job moves through processing to review with exactly three server-resolved images", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const context = await fixture({
    provider: {
      id: "test",
      isConfigured: () => true,
      configurationIssues: () => [],
      async edit(input) {
        calls.push(input);
        started();
        await gate;
        return png("#22aa66");
      },
    },
  });
  try {
    const created = await context.service.createJob({
      topId: "top-item-1",
      bottomId: "bottom-item-1",
    });
    assert.equal(created.status, "queued");
    await startedPromise;
    assert.equal((await context.service.getJob(created.id)).status, "processing");
    release();
    const reviewed = await context.service.waitForIdle(created.id);
    assert.equal(reviewed.status, "review");
    assert.equal(reviewed.attempts, 1);
    assert.match(reviewed.previewUrl, /^\/api\/outfits\/assets\//);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].purpose, "outfit");
    assert.equal(calls[0].images.length, 3);
    assert.deepEqual(calls[0].images.map((image) => image.name), [
      "model-reference.png",
      "top.png",
      "bottom.png",
    ]);
  } finally {
    release();
    await context.cleanup();
  }
});

test("accept saves the final PNG and versioned manifest, then removes the review job", async () => {
  const context = await fixture();
  try {
    const created = await context.service.createJob({
      topId: "top-item-1",
      bottomId: "bottom-item-1",
    });
    const reviewed = await context.service.waitForIdle(created.id);
    assert.equal(reviewed.status, "review");
    const accepted = await context.service.acceptJob(created.id);
    assert.equal(accepted.image, "/api/outfits/images/outfit-test-0001.png");
    assert.equal(accepted.selection.outerwearId, null);
    assert.deepEqual(accepted.garments.map((garment) => garment.role), ["top", "bottom"]);

    const savedImage = path.join(context.dataDir, "outfit-images", "outfit-test-0001.png");
    assert.equal((await stat(savedImage)).isFile(), true);
    const manifest = JSON.parse(await readFile(path.join(context.dataDir, "outfits.json"), "utf8"));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.outfits.length, 1);
    assert.equal(manifest.outfits[0].id, "outfit-test-0001");
    assert.equal(await context.service.getJob(created.id), null);
  } finally {
    await context.cleanup();
  }
});

test("review job can regenerate and then be deleted without saving an outfit", async () => {
  const context = await fixture();
  try {
    const created = await context.service.createJob({
      topId: "top-item-1",
      bottomId: "bottom-item-1",
    });
    await context.service.waitForIdle(created.id);
    await assert.rejects(
      context.service.createJob({
        topId: "top-item-1",
        bottomId: "bottom-item-1",
      }),
      /Finish or delete the current outfit job/,
    );
    await context.service.regenerateJob(created.id, "Use a brighter setting");
    const regenerated = await context.service.waitForIdle(created.id);
    assert.equal(regenerated.status, "review");
    assert.equal(regenerated.attempts, 2);
    await context.service.deleteJob(created.id);
    assert.equal(await context.service.getJob(created.id), null);
    assert.deepEqual(await context.service.listOutfits(), []);
  } finally {
    await context.cleanup();
  }
});

test("cloud job state and preview survive a second service instance", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const cloud = fakeCloud();
  const context = await fixture({
    cloud,
    provider: {
      id: "test",
      isConfigured: () => true,
      configurationIssues: () => [],
      async edit(input) {
        started();
        await gate;
        return png("#22aa66");
      },
    },
  });
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "wardrobe-outfit-instance-"));
  try {
    const created = await context.service.createJob({ topId: "top-item-1", bottomId: "bottom-item-1" });
    await startedPromise;
    const secondData = path.join(secondRoot, "data");
    await cp(context.dataDir, secondData, { recursive: true });
    await rm(path.join(secondData, "outfit-jobs"), { recursive: true, force: true });
    const secondService = createOutfitService({
      root: secondRoot,
      dataDir: secondData,
      modelReference: path.join(secondData, "model-reference.png"),
      imageProvider: context.imageProvider,
      cloud,
    });
    await secondService.init();
    assert.equal((await secondService.getJob(created.id)).status, "processing");
    release();
    assert.equal((await context.service.waitForIdle(created.id)).status, "review");
    const reviewedFromSecond = await secondService.getJob(created.id);
    assert.equal(reviewedFromSecond.status, "review");
    assert.equal((await stat(secondService.previewAssetPath(created.id, path.basename(reviewedFromSecond.previewUrl)))).isFile(), true);
  } finally {
    release();
    await context.cleanup();
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("cloud job state persists a failed generation for another instance", async () => {
  const cloud = fakeCloud();
  const context = await fixture({
    cloud,
    provider: {
      id: "test",
      isConfigured: () => true,
      configurationIssues: () => [],
      async edit() { throw new Error("simulated provider failure"); },
    },
  });
  try {
    const created = await context.service.createJob({ topId: "top-item-1", bottomId: "bottom-item-1" });
    const failed = await context.service.waitForIdle(created.id);
    assert.equal(failed.status, "failed");
    assert.equal((await context.service.getJob(created.id)).error, "simulated provider failure");
    assert.equal((await cloud.getGenerationJob(created.id)).status, "failed");
  } finally {
    await context.cleanup();
  }
});
