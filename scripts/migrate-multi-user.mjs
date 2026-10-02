import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCloudPersistence } from "./cloud-persistence.mjs";

const targetUserId = process.env.TARGET_USER_ID;
if (!targetUserId) throw new Error("TARGET_USER_ID is required; no user id is hard-coded in this migration");

const root = process.cwd();
const dataRoot = path.resolve(root, process.env.WARDROBE_DATA_DIR || "data");
const libraryFile = path.join(dataRoot, "library.json");
const outfitsFile = path.join(dataRoot, "outfits.json");
const importedDir = path.join(dataRoot, "imported");
const outfitImagesDir = path.join(dataRoot, "outfit-images");
const modelReferenceFile = path.resolve(root, process.env.WARDROBE_MODEL_REFERENCE || "data/model-reference.png");
const cloud = createCloudPersistence({ env: process.env });

if (!cloud.enabled) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
await cloud.ensureReady();
const legacy = await cloud.migrateLegacyData(targetUserId);

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

const profile = await cloud.ensureUserProfile({ id: targetUserId });
if (modelReferenceFile) {
  await cloud.uploadUserReference(targetUserId, await readFile(modelReferenceFile), "image/png", "legacy-reference");
}
console.log(`Legacy migration prepared for user ${targetUserId}: cloud_rows=${JSON.stringify(legacy)}, local_wardrobe=${library.length}, local_outfits=${(outfitsManifest.outfits || []).length}, profile=${profile.nickname}`);
console.log("Existing legacy storage objects are preserved; verify the new users/<user_id>/ paths before cleanup.");
