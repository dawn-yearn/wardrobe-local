import assert from "node:assert/strict";
import test from "node:test";
import { authenticateRequest } from "../../scripts/auth.mjs";
import { createCloudPersistence, validateUserImageKey } from "../../scripts/cloud-persistence.mjs";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("server auth context comes from the verified Auth user, not request data", async () => {
  const request = { headers: { authorization: "Bearer token-a" }, body: { user_id: USER_B } };
  const user = await authenticateRequest(request, { verify: async (token) => ({ id: token === "token-a" ? USER_A : USER_B }) });
  assert.equal(user.id, USER_A);
});

test("multi-user Storage keys cannot collide across users", () => {
  const cloud = createCloudPersistence({ env: {
    SUPABASE_URL: "https://example.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
  } });
  assert.notEqual(cloud.storageKeyForLibrary(USER_A, "item.png"), cloud.storageKeyForLibrary(USER_B, "item.png"));
  assert.equal(cloud.storageKeyForLibrary(USER_A, "item.png"), `users/${USER_A}/wardrobe/item.png`);
  assert.equal(cloud.storageKeyForOutfit(USER_B, "outfit.png"), `users/${USER_B}/outfits/outfit.png`);
  assert.equal(cloud.storageKeyForJob(USER_A, "job-1", "preview.png"), `users/${USER_A}/jobs/job-1/preview.png`);
});

test("business APIs accept only image keys inside the verified user's upload namespace", () => {
  assert.equal(validateUserImageKey(USER_A, `users/${USER_A}/jobs/job/source.jpg`, "jobs"), `users/${USER_A}/jobs/job/source.jpg`);
  assert.equal(validateUserImageKey(USER_A, `users/${USER_A}/wardrobe/source.jpg`, "wardrobe"), `users/${USER_A}/wardrobe/source.jpg`);
  assert.equal(validateUserImageKey(USER_A, `users/${USER_A}/profile/reference/source.jpg`, "profile"), `users/${USER_A}/profile/reference/source.jpg`);
  assert.throws(() => validateUserImageKey(USER_A, `users/${USER_B}/jobs/job/source.jpg`, "jobs"), /authenticated user/);
  assert.throws(() => validateUserImageKey(USER_A, `users/${USER_A}/wardrobe/source.jpg`, "jobs"), /authenticated user/);
  assert.throws(() => validateUserImageKey(USER_A, `users/${USER_A}/jobs/../wardrobe/source.jpg`, "jobs"), /authenticated user/);
});

test("cloud repository filters generation jobs by the verified owner", async () => {
  const rows = [
    { id: "job-a", user_id: USER_A, job_type: "outfit", created_at: "2026-01-01T00:00:00Z", payload_json: { id: "job-a" } },
    { id: "job-b", user_id: USER_B, job_type: "outfit", created_at: "2026-01-01T00:00:01Z", payload_json: { id: "job-b" } },
  ];
  const client = {
    from(table) {
      const filters = [];
      const builder = {
        select() { return builder; },
        eq(field, value) { filters.push([field, value]); return builder; },
        order() { return builder; },
        maybeSingle() { return Promise.resolve({ data: rows.filter((row) => filters.every(([field, value]) => row[field] === value))[0] || null, error: null }); },
        then(resolve, reject) { return Promise.resolve({ data: table === "generation_jobs" ? rows.filter((row) => filters.every(([field, value]) => row[field] === value)) : [], error: null }).then(resolve, reject); },
      };
      return builder;
    },
  };
  const cloud = createCloudPersistence({ env: { SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" }, client });
  assert.deepEqual((await cloud.listGenerationJobs("outfit", USER_A)).map((job) => job.id), ["job-a"]);
  assert.equal((await cloud.getGenerationJob("job-b", USER_A)), null);
  assert.equal((await cloud.getGenerationJob("job-b", USER_B)).id, "job-b");
});

test("wardrobe persistence writes one canonical Storage URL to the row and response", async () => {
  let savedRow;
  const client = {
    storage: {
      from() { return { upload: async () => ({ error: null }) }; },
    },
    from(table) {
      return {
        async upsert(row) {
          assert.equal(table, "wardrobe_items");
          savedRow = structuredClone(row);
          return { error: null };
        },
      };
    },
  };
  const cloud = createCloudPersistence({ env: { SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" }, client });
  const original = { id: "import-item", image: "/api/import/library/item.png", thumbnail: "/api/import/library/item.png" };
  const saved = await cloud.upsertWardrobeRecord(original, { image: Buffer.from("png") }, USER_A);
  assert.equal(savedRow.image_key, `users/${USER_A}/wardrobe/item.png`);
  assert.equal(savedRow.record_json.image, saved.image);
  assert.match(saved.image, new RegExp(`/storage/v1/object/public/wardrobe-assets/users/${USER_A}/wardrobe/item\\.png$`));
  assert.doesNotMatch(saved.image, /\/api\/import\/library\//);
});

test("profile reads resolve the reference image URL from its Storage key", async () => {
  const key = `users/${USER_B}/profile/reference/photo.png`;
  const client = {
    from() {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        maybeSingle() { return Promise.resolve({ data: { user_id: USER_B, reference_image_key: key, reference_image_url: "/stale/path.png" }, error: null }); },
      };
      return builder;
    },
  };
  const cloud = createCloudPersistence({ env: { SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" }, client });
  const profile = await cloud.getUserProfile(USER_B);
  assert.match(profile.reference_image_url, new RegExp(`/storage/v1/object/public/wardrobe-assets/users/${USER_B}/profile/reference/photo\\.png$`));
});
