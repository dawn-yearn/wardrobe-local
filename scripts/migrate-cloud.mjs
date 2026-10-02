import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCloudPersistence } from "./cloud-persistence.mjs";

const root = process.cwd();
const dataRoot = path.resolve(root, process.env.WARDROBE_DATA_DIR || "data");
const libraryFile = path.join(dataRoot, "library.json");
const outfitsFile = path.join(dataRoot, "outfits.json");
const importedDir = path.join(dataRoot, "imported");
const outfitImagesDir = path.join(dataRoot, "outfit-images");
const modelReferenceFile = path.resolve(root, process.env.WARDROBE_MODEL_REFERENCE || "data/model-reference.png");
const cloud = createCloudPersistence({ env: process.env });
const targetUserId = process.env.TARGET_USER_ID;

if (!cloud.enabled) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required; run meoo cloud pull-env first");
if (!targetUserId) throw new Error("TARGET_USER_ID is required; use scripts/migrate-multi-user.mjs for the legacy migration");
await cloud.ensureReady();

const library = JSON.parse(await readFile(libraryFile, "utf8"));
for (const record of library) {
  const image = path.join(importedDir, path.basename(record.image));
  const modeledImage = record.modeledImage ? path.join(importedDir, path.basename(record.modeledImage)) : null;
  await cloud.upsertWardrobeRecord(record, { image, modeledImage }, targetUserId);
}

const outfitsManifest = JSON.parse(await readFile(outfitsFile, "utf8"));
for (const record of outfitsManifest.outfits || []) {
  await cloud.upsertOutfitRecord(record, path.join(outfitImagesDir, path.basename(record.image)), targetUserId);
}

await cloud.uploadUserReference(targetUserId, await readFile(modelReferenceFile), "image/png", "legacy-reference");
console.log(`Cloud migration complete for user ${targetUserId}: wardrobe_items=${library.length}, outfits=${(outfitsManifest.outfits || []).length}, bucket=${cloud.bucket}`);
