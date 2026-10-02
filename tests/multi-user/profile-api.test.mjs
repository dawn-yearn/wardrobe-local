import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { wardrobeProfileApi } from "../../scripts/profile-api.mjs";

const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

test("an authenticated ordinary user can persist and read a reference image without AI access", async () => {
  let profile = { user_id: USER, invite_activated: false, reference_image_key: null, reference_image_url: null };
  let upload;
  const cloud = {
    enabled: true,
    async ensureUserProfile() { return structuredClone(profile); },
    async downloadUserImage(userId, imageKey, scope) {
      assert.equal(userId, USER);
      assert.equal(imageKey, `users/${USER}/profile/reference/browser-upload.png`);
      assert.equal(scope, "profile");
      return Buffer.from(PNG, "base64");
    },
    async removeUserImage() {},
    async uploadUserReference(userId, bytes, contentType) {
      upload = { userId, bytes, contentType };
      profile = {
        ...profile,
        reference_image_key: `users/${userId}/profile/reference/test.png`,
        reference_image_url: `https://storage.test/users/${userId}/profile/reference/test.png`,
      };
      return structuredClone(profile);
    },
  };
  const plugin = wardrobeProfileApi({ verify: async () => ({ id: USER, phone: "+8613000000000" }), cloud });
  let handler;
  plugin.configureServer({ middlewares: { use(next) { handler = next; } } });

  const uploadResponse = response();
  await handler(request("/api/profile/reference", "POST", { image_key: `users/${USER}/profile/reference/browser-upload.png` }), uploadResponse, () => {});
  assert.equal(uploadResponse.statusCode, 200, uploadResponse.json().error);
  assert.equal(upload.userId, USER);
  assert.equal(upload.contentType, "image/png");
  assert.ok(upload.bytes.length > 0);
  assert.match(uploadResponse.json().reference_image_key, new RegExp(`^users/${USER}/profile/reference/`));
  assert.equal(uploadResponse.json().invite_activated, false);

  const readResponse = response();
  await handler(request("/api/profile", "GET"), readResponse, () => {});
  assert.equal(readResponse.statusCode, 200);
  assert.equal(readResponse.json().reference_image_key, profile.reference_image_key);
  assert.equal(readResponse.json().reference_image_url, profile.reference_image_url);
});
