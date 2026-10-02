import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  imageKeyPayload,
  createStorageFetch,
  prepareAndUploadImageWithClient,
  uploadImageRawWithClient,
  storageImageKey,
  uploadImageWithClient,
  WARDROBE_DIRECT_SUPABASE_URL,
  WARDROBE_STORAGE_BUCKET,
} from "../../src/storage-upload-core.js";
import { TARGET_STORAGE_IMAGE_BYTES } from "../../src/storage-image-compression.js";
import { isImageFile, selectedImageFiles, wardrobeImportRoute } from "../../src/upload-image.js";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeClient() {
  const uploads = [];
  return {
    uploads,
    auth: {
      async getUser() { return { data: { user: { id: USER } }, error: null }; },
      async getSession() { return { data: { session: { access_token: "not-logged", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }; },
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, WARDROBE_STORAGE_BUCKET);
        return { async upload(path, file, options) { uploads.push({ path, file, options }); return { data: { path }, error: null }; } };
      },
    },
  };
}

async function phonePhoto(megabytes) {
  const jpeg = await sharp({
    create: { width: 4032, height: 3024, channels: 3, background: { r: 116, g: 83, b: 54 } },
  }).jpeg({ quality: 94 }).toBuffer();
  const targetBytes = megabytes * 1024 * 1024;
  assert.ok(jpeg.length < targetBytes);
  const file = new Blob([jpeg, new Uint8Array(targetBytes - jpeg.length)], { type: "image/jpeg" });
  Object.defineProperty(file, "name", { value: `phone-${megabytes}.jpg` });
  return file;
}

const sharpRuntime = {
  async decode(file) {
    const input = Buffer.from(await file.arrayBuffer());
    const metadata = await sharp(input).metadata();
    return {
      width: metadata.autoOrient.width,
      height: metadata.autoOrient.height,
      async encode(width, height, quality) {
        const output = await sharp(input)
          .autoOrient()
          .resize(width, height, { fit: "fill" })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: Math.round(quality * 100) })
          .toBuffer();
        return new Blob([output], { type: "image/jpeg" });
      },
    };
  },
};

test("mobile file selection accepts image MIME types and extension fallbacks", () => {
  const jpeg = { name: "camera.jpg", type: "image/jpeg" };
  const heicWithoutMime = { name: "IMG_0001.HEIC", type: "" };
  const pdf = { name: "notes.pdf", type: "application/pdf" };
  assert.equal(isImageFile(jpeg), true);
  assert.equal(isImageFile(heicWithoutMime), true);
  assert.equal(isImageFile(pdf), false);
  assert.deepEqual(selectedImageFiles([jpeg, heicWithoutMime, pdf]), [jpeg, heicWithoutMime]);
});

test("AI access only chooses the post-selection import branch", () => {
  assert.equal(wardrobeImportRoute(true), "ai");
  assert.equal(wardrobeImportRoute(false), "manual");
});

for (const megabytes of [2, 5, 10]) {
  test(`${megabytes} MiB phone image is compressed before Storage and never enters business JSON`, async () => {
    const client = fakeClient();
    const file = await phonePhoto(megabytes);
    const result = await prepareAndUploadImageWithClient(
      client,
      file,
      "jobs",
      { uuid: () => "job-upload" },
      sharpRuntime,
    );
    assert.notEqual(client.uploads[0].file, file);
    assert.equal(client.uploads[0].file.type, "image/jpeg");
    assert.ok(client.uploads[0].file.size <= TARGET_STORAGE_IMAGE_BYTES);
    assert.equal(result.preparation.originalBytes, megabytes * 1024 * 1024);
    assert.equal(result.preparation.compressedBytes, client.uploads[0].file.size);
    assert.equal(result.imageKey, `users/${USER}/jobs/job-upload/source.jpg`);
    const payload = imageKeyPayload(result.imageKey, { name: "phone" });
    assert.deepEqual(payload, { image_key: result.imageKey, metadata: { name: "phone" } });
    assert.doesNotMatch(JSON.stringify(payload), /imageDataUrl|imageBase64|data:image|base64/);
    assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < 1024);
  });
}

test("AI, manual, and profile uploads share the authenticated Storage helper", async () => {
  for (const scope of ["jobs", "wardrobe", "profile"]) {
    const client = fakeClient();
    const file = await phonePhoto(5);
    const result = await prepareAndUploadImageWithClient(client, file, scope, { uuid: () => "fixed" }, sharpRuntime);
    assert.match(result.imageKey, new RegExp(`^users/${USER}/${scope === "profile" ? "profile/reference" : scope}/`));
    assert.notEqual(client.uploads[0].file, file);
    assert.ok(client.uploads[0].file.size <= TARGET_STORAGE_IMAGE_BYTES);
    assert.equal(client.uploads[0].options.upsert, false);
  }
});

test("business API contracts contain image_key and never image bytes", () => {
  const key = storageImageKey(USER, "wardrobe", { name: "coat.jpg", type: "image/jpeg" }, "fixed");
  assert.deepEqual(imageKeyPayload(key), { image_key: key });
  assert.deepEqual(imageKeyPayload(key, {}), { image_key: key, metadata: {} });
  assert.doesNotMatch(JSON.stringify(imageKeyPayload(key, {})), /imageDataUrl|imageBase64|data:image|base64/);
});

test("phone image uploads bypass the Image Deploy /sb-api body-size gateway", () => {
  assert.equal(WARDROBE_DIRECT_SUPABASE_URL, "https://storage.example.test");
  assert.doesNotMatch(WARDROBE_DIRECT_SUPABASE_URL, /meoo-app\.fun|\/sb-api/);
});

test("a real Storage response keeps endpoint, auth state, HTTP status, code, message, and body", async () => {
  const responseBody = JSON.stringify({ statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
  const bucketClient = {
    fetch: async () => new Response(responseBody, { status: 400, headers: { "content-type": "application/json" } }),
    async upload(path, file) {
      const response = await this.fetch(`https://app.test/sb-api/storage/v1/object/${WARDROBE_STORAGE_BUCKET}/${path}`, { method: "POST", body: file });
      return { data: null, error: { status: response.status, statusCode: "403", code: "Unauthorized", message: "new row violates row-level security policy" } };
    },
  };
  const client = {
    auth: {
      async getUser() { return { data: { user: { id: USER } }, error: null }; },
      async getSession() { return { data: { session: { access_token: "not-logged", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }; },
    },
    storage: { from() { return bucketClient; } },
  };
  const file = new Blob(["probe"], { type: "text/plain" });
  Object.defineProperty(file, "name", { value: "probe.txt" });
  await assert.rejects(
    uploadImageWithClient(client, file, "wardrobe", { supabaseUrl: "https://app.test/sb-api", uuid: () => "failed" }),
    (error) => {
      assert.equal(error.diagnostics.endpoint, `https://app.test/sb-api/storage/v1/object/${WARDROBE_STORAGE_BUCKET}/users/${USER}/wardrobe/failed-source.txt`);
      assert.equal(error.diagnostics.httpStatus, 400);
      assert.equal(error.diagnostics.errorCode, "Unauthorized");
      assert.equal(error.diagnostics.hasValidSession, true);
      assert.equal(error.diagnostics.responseBody, responseBody);
      assert.match(error.message, /new row violates row-level security policy/);
      assert.doesNotMatch(error.message, /not-logged/);
      return true;
    },
  );
});

test("a Storage 413 reports the exact compressed Blob size instead of the original File size", async () => {
  const bucketClient = {
    fetch: async () => new Response("", { status: 413 }),
    async upload(path, file) {
      const response = await this.fetch(`https://storage.test/storage/v1/object/${WARDROBE_STORAGE_BUCKET}/${path}`, { method: "POST", body: file });
      return { data: null, error: { status: response.status, code: "413", message: "HTTP 413 error" } };
    },
  };
  const client = {
    auth: {
      async getUser() { return { data: { user: { id: USER } }, error: null }; },
      async getSession() { return { data: { session: { access_token: "not-logged", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }; },
    },
    storage: { from() { return bucketClient; } },
  };
  const file = await phonePhoto(2);
  await assert.rejects(
    prepareAndUploadImageWithClient(client, file, "jobs", { supabaseUrl: "https://storage.test", uuid: () => "failed" }, sharpRuntime),
    (error) => {
      assert.equal(error.diagnostics.httpStatus, 413);
      assert.equal(error.diagnostics.originalBytes, 2 * 1024 * 1024);
      assert.ok(error.diagnostics.uploadBytes <= TARGET_STORAGE_IMAGE_BYTES);
      assert.match(error.message, new RegExp(`upload_bytes=${error.diagnostics.uploadBytes}`));
      assert.match(error.message, /mime=image\/jpeg/);
      assert.match(error.message, /dimensions=1600x1200/);
      return true;
    },
  );
});

test("Storage transport preserves a non-empty multipart body and lets fetch set the boundary", async () => {
  let captured;
  const transport = createStorageFetch(async (request) => {
    captured = {
      method: request.method,
      contentType: request.headers.get("content-type"),
      authorization: request.headers.get("authorization"),
      bodyBytes: (await request.clone().arrayBuffer()).byteLength,
    };
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const form = new FormData();
  form.append("cacheControl", "3600");
  form.append("", new Blob(["hello storage"], { type: "text/plain" }));
  await transport("https://storage.test/storage/v1/object/wardrobe-assets/debug.txt", {
    method: "POST",
    headers: { Authorization: "Bearer redacted" },
    body: form,
  });
  assert.equal(captured.method, "POST");
  assert.match(captured.contentType, /^multipart\/form-data; boundary=/);
  assert.equal(captured.authorization, "Bearer redacted");
  assert.ok(captured.bodyBytes > 13);
});

test("raw Storage upload preserves auth headers and sends the Blob as the request body", async () => {
  const blob = new Blob(["raw storage bytes"], { type: "image/jpeg" });
  let captured;
  const client = {
    auth: {
      async getUser() { return { data: { user: { id: USER } }, error: null }; },
      async getSession() { return { data: { session: { access_token: "session-token", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }; },
    },
    async fetch(request) {
      captured = {
        method: request.method,
        contentType: request.headers.get("content-type"),
        authorization: request.headers.get("authorization"),
        apikey: request.headers.get("apikey"),
        upsert: request.headers.get("x-upsert"),
        bodyBytes: (await request.clone().arrayBuffer()).byteLength,
        isFormData: request.body?.constructor?.name === "FormData",
      };
      return new Response(JSON.stringify({ Key: "wardrobe-assets/raw", Id: "raw-id" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const result = await uploadImageRawWithClient(client, blob, "jobs", {
    supabaseUrl: "https://storage.test",
    apikey: "anon-key",
    uuid: () => "raw-upload",
  });
  assert.equal(result.imageKey, `users/${USER}/jobs/raw-upload/source.jpg`);
  assert.deepEqual(captured, {
    method: "POST",
    contentType: "image/jpeg",
    authorization: "Bearer session-token",
    apikey: "anon-key",
    upsert: "false",
    bodyBytes: blob.size,
    isFormData: false,
  });
});
