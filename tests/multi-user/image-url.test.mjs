import assert from "node:assert/strict";
import test from "node:test";
import { isDirectStorageUrl } from "../../src/image-url.js";

test("Supabase public object URLs bypass unsupported image render routes", () => {
  assert.equal(isDirectStorageUrl("https://storage.example.test/storage/v1/object/public/wardrobe-assets/users/a/wardrobe/item.png"), true);
  assert.equal(isDirectStorageUrl("https://storage.example.test/storage/v1/render/image/public/wardrobe-assets/users/a/wardrobe/item.png"), false);
  assert.equal(isDirectStorageUrl("/api/import/assets/job/item.png"), false);
});
