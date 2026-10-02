import { prepareStorageImage } from "./storage-image-compression.js";

export const WARDROBE_STORAGE_BUCKET = "wardrobe-assets";
// Legacy cloud upload helper retained for compatibility tests.
// The local app does not import this module. This placeholder is not a live project.
export const WARDROBE_DIRECT_SUPABASE_URL = "https://storage.example.test";
export const STORAGE_UPLOAD_ERROR = "图片上传失败，请重试。";

export function createStorageFetch(baseFetch = globalThis.fetch, onRequest = () => {}) {
  return async (input, init = {}) => {
    // Constructing a Request here makes the browser materialize the multipart
    // boundary while retaining the SDK-created FormData body. Do not set a
    // Content-Type header: fetch owns the boundary for multipart requests.
    const request = new Request(input, init);
    const sourceBody = init.body;
    const formDataParts = typeof FormData !== "undefined" && sourceBody instanceof FormData
      ? Array.from(sourceBody.entries()).map(([name, value]) => ({
        name,
        bytes: Number(value?.size) || (typeof value === "string" ? new TextEncoder().encode(value).byteLength : 0),
        mimeType: value?.type || null,
        constructor: value?.constructor?.name || typeof value,
      }))
      : null;
    const bodyBytes = request.body ? (await request.clone().arrayBuffer()).byteLength : 0;
    const requestInfo = {
      method: request.method,
      contentType: request.headers.get("content-type"),
      hasBody: bodyBytes > 0,
      bodyBytes,
      bodyType: sourceBody?.constructor?.name || null,
      formDataParts,
    };
    onRequest(requestInfo);
    return baseFetch(request);
  };
}

const SCOPES = new Set(["jobs", "wardrobe", "profile"]);
const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export function storageImageKey(userId, scope, file, uuid = crypto.randomUUID()) {
  if (!userId || !SCOPES.has(scope)) throw new Error("Invalid Storage upload scope");
  const mime = String(file?.type || "").toLowerCase();
  const fallback = String(file?.name || "").match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  const extension = EXTENSIONS[mime] || fallback || "jpg";
  if (scope === "jobs") return `users/${userId}/jobs/${uuid}/source.${extension}`;
  if (scope === "wardrobe") return `users/${userId}/wardrobe/${uuid}-source.${extension}`;
  return `users/${userId}/profile/reference/${uuid}.${extension}`;
}

export function imageKeyPayload(imageKey, metadata) {
  if (typeof imageKey !== "string" || !imageKey) throw new Error("Invalid Storage image key");
  return metadata === undefined ? { image_key: imageKey } : { image_key: imageKey, metadata };
}

function maskedUserId(userId) {
  const value = String(userId || "");
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : (value || "none");
}

function safeResponseBody(value) {
  const text = typeof value === "string" ? value : "";
  return text ? text.slice(0, 800) : null;
}

export function storageDiagnosticMessage(diagnostics) {
  const value = diagnostics || {};
  return [
    STORAGE_UPLOAD_ERROR,
    `endpoint=${value.endpoint || "unknown"}`,
    `bucket=${value.bucket || "unknown"}`,
    `key=${value.objectKey || "unknown"}`,
    `user=${value.userId || "none"}`,
    `session=${value.hasValidSession ? "valid" : "missing/expired"}`,
    `http=${value.httpStatus ?? "none"}`,
    `code=${value.errorCode || "none"}`,
    `message=${value.errorMessage || "unknown"}`,
    `body=${value.responseBody || "none"}`,
    `original_bytes=${value.originalBytes ?? "unknown"}`,
    `upload_bytes=${value.uploadBytes ?? "unknown"}`,
    `mime=${value.mimeType || "unknown"}`,
    `dimensions=${value.dimensions || "unknown"}`,
    `request_method=${value.requestMethod || "unknown"}`,
    `request_content_type=${value.requestContentType || "unknown"}`,
    `request_body_bytes=${value.requestBodyBytes ?? "unknown"}`,
    `request_has_body=${value.requestHasBody == null ? "unknown" : value.requestHasBody}`,
    `request_parts=${value.requestParts || "unknown"}`,
    `input_is_blob=${value.inputIsBlob == null ? "unknown" : value.inputIsBlob}`,
    `input_constructor=${value.inputConstructor || "unknown"}`,
  ].join(" | ");
}

export async function uploadImageWithClient(client, file, scope, options = {}) {
  const { data: { user }, error: userError } = await client.auth.getUser();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  const hasValidSession = Boolean(session?.access_token) && (!session.expires_at || session.expires_at * 1000 > Date.now());
  const endpoint = `${String(options.supabaseUrl || "").replace(/\/$/, "")}/storage/v1`;
  if (userError || sessionError || !user?.id || !hasValidSession) {
    const diagnostics = {
      endpoint,
      bucket: WARDROBE_STORAGE_BUCKET,
      objectKey: "not-created",
      userId: maskedUserId(user?.id),
      hasValidSession,
      httpStatus: null,
      errorCode: userError?.code || sessionError?.code || "AUTH_SESSION_MISSING",
      errorMessage: userError?.message || sessionError?.message || "No valid Supabase Auth session",
      responseBody: null,
    };
    throw Object.assign(new Error(storageDiagnosticMessage(diagnostics)), { cause: userError || sessionError, diagnostics });
  }
  const imageKey = storageImageKey(user.id, scope, file, options.uuid?.());
  const requestUrl = `${endpoint}/object/${WARDROBE_STORAGE_BUCKET}/${imageKey}`;
  const trace = { requestUrl, httpStatus: null, responseBody: null, networkError: null };
  const bucketClient = client.storage.from(WARDROBE_STORAGE_BUCKET);
  if (typeof bucketClient.fetch === "function") {
    const storageFetch = bucketClient.fetch;
    bucketClient.fetch = async (input, init) => {
      trace.requestUrl = typeof input === "string" ? input : input?.url || requestUrl;
      try {
        const response = await storageFetch(input, init);
        trace.httpStatus = response.status;
        if (!response.ok) trace.responseBody = safeResponseBody(await response.clone().text().catch(() => ""));
        return response;
      } catch (fetchError) {
        trace.networkError = fetchError?.message || String(fetchError);
        throw fetchError;
      }
    };
  }
  const { error } = await bucketClient.upload(imageKey, file, {
    contentType: file.type || "application/octet-stream",
    cacheControl: "3600",
    upsert: false,
  });
  if (error) {
    const diagnostics = {
      endpoint: trace.requestUrl,
      bucket: WARDROBE_STORAGE_BUCKET,
      objectKey: imageKey.replace(user.id, maskedUserId(user.id)),
      userId: maskedUserId(user.id),
      hasValidSession,
      httpStatus: trace.httpStatus ?? error.status ?? error.originalError?.status ?? null,
      errorCode: error.code || error.statusCode || error.name || null,
      errorMessage: error.message || trace.networkError || "Storage upload failed",
      responseBody: trace.responseBody,
      originalBytes: options.uploadInfo?.originalBytes ?? null,
      uploadBytes: Number(file.size) || 0,
      mimeType: file.type || "application/octet-stream",
      dimensions: options.uploadInfo?.dimensions
        ? `${options.uploadInfo.dimensions.width}x${options.uploadInfo.dimensions.height}`
        : null,
      requestMethod: options.requestInfo?.()?.method || null,
      requestContentType: options.requestInfo?.()?.contentType || null,
      requestBodyBytes: options.requestInfo?.()?.bodyBytes ?? null,
      requestHasBody: options.requestInfo?.()?.hasBody ?? null,
      requestParts: options.requestInfo?.()?.formDataParts
        ? JSON.stringify(options.requestInfo().formDataParts)
        : null,
      inputIsBlob: typeof Blob !== "undefined" && file instanceof Blob,
      inputConstructor: file?.constructor?.name || null,
    };
    throw Object.assign(new Error(storageDiagnosticMessage(diagnostics)), { cause: error, diagnostics });
  }
  return { imageKey, bucket: WARDROBE_STORAGE_BUCKET, bytes: Number(file.size) || 0, contentType: file.type || "application/octet-stream" };
}

export async function uploadImageRawWithClient(client, file, scope, options = {}) {
  const { data: { user }, error: userError } = await client.auth.getUser();
  const { data: { session }, error: sessionError } = await client.auth.getSession();
  const hasValidSession = Boolean(session?.access_token) && (!session.expires_at || session.expires_at * 1000 > Date.now());
  const endpoint = `${String(options.supabaseUrl || "").replace(/\/$/, "")}/storage/v1`;
  if (userError || sessionError || !user?.id || !hasValidSession) {
    const diagnostics = {
      endpoint,
      bucket: WARDROBE_STORAGE_BUCKET,
      objectKey: "not-created",
      userId: maskedUserId(user?.id),
      hasValidSession,
      httpStatus: null,
      errorCode: userError?.code || sessionError?.code || "AUTH_SESSION_MISSING",
      errorMessage: userError?.message || sessionError?.message || "No valid Supabase Auth session",
      responseBody: null,
    };
    throw Object.assign(new Error(storageDiagnosticMessage(diagnostics)), { cause: userError || sessionError, diagnostics });
  }
  const imageKey = storageImageKey(user.id, scope, file, options.uuid?.());
  const requestUrl = `${endpoint}/object/${WARDROBE_STORAGE_BUCKET}/${imageKey}`;
  const request = new Request(requestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: options.apikey || "",
      "Content-Type": file.type || "application/octet-stream",
      "cache-control": `max-age=${options.cacheControl || "3600"}`,
      "x-upsert": "false",
    },
    body: file,
  });
  let response;
  let responseBody = null;
  try {
    response = await client.fetch(request);
    responseBody = safeResponseBody(await response.clone().text().catch(() => ""));
  } catch (fetchError) {
    const requestInfo = options.requestInfo?.() || {};
    const diagnostics = {
      endpoint: requestUrl,
      bucket: WARDROBE_STORAGE_BUCKET,
      objectKey: imageKey.replace(user.id, maskedUserId(user.id)),
      userId: maskedUserId(user.id),
      hasValidSession,
      httpStatus: null,
      errorCode: "STORAGE_FETCH_FAILED",
      errorMessage: fetchError?.message || "Storage upload failed",
      responseBody: null,
      originalBytes: options.uploadInfo?.originalBytes ?? null,
      uploadBytes: Number(file.size) || 0,
      mimeType: file.type || "application/octet-stream",
      dimensions: options.uploadInfo?.dimensions
        ? `${options.uploadInfo.dimensions.width}x${options.uploadInfo.dimensions.height}`
        : null,
      requestMethod: requestInfo.method || "POST",
      requestContentType: requestInfo.contentType || file.type || null,
      requestBodyBytes: requestInfo.bodyBytes ?? Number(file.size) ?? 0,
      requestHasBody: requestInfo.hasBody ?? true,
      requestParts: null,
      inputIsBlob: typeof Blob !== "undefined" && file instanceof Blob,
      inputConstructor: file?.constructor?.name || null,
    };
    throw Object.assign(new Error(storageDiagnosticMessage(diagnostics)), { cause: fetchError, diagnostics });
  }
  if (!response.ok) {
    let parsed = null;
    try { parsed = responseBody ? JSON.parse(responseBody) : null; } catch {}
    const requestInfo = options.requestInfo?.() || {};
    const diagnostics = {
      endpoint: requestUrl,
      bucket: WARDROBE_STORAGE_BUCKET,
      objectKey: imageKey.replace(user.id, maskedUserId(user.id)),
      userId: maskedUserId(user.id),
      hasValidSession,
      httpStatus: response.status,
      errorCode: parsed?.code || parsed?.statusCode || String(response.status),
      errorMessage: parsed?.message || parsed?.error || `HTTP ${response.status} error`,
      responseBody,
      originalBytes: options.uploadInfo?.originalBytes ?? null,
      uploadBytes: Number(file.size) || 0,
      mimeType: file.type || "application/octet-stream",
      dimensions: options.uploadInfo?.dimensions
        ? `${options.uploadInfo.dimensions.width}x${options.uploadInfo.dimensions.height}`
        : null,
      requestMethod: requestInfo.method || "POST",
      requestContentType: requestInfo.contentType || request.headers.get("content-type"),
      requestBodyBytes: requestInfo.bodyBytes ?? Number(file.size) ?? 0,
      requestHasBody: requestInfo.hasBody ?? true,
      requestParts: null,
      inputIsBlob: typeof Blob !== "undefined" && file instanceof Blob,
      inputConstructor: file?.constructor?.name || null,
    };
    throw Object.assign(new Error(storageDiagnosticMessage(diagnostics)), { diagnostics });
  }
  return { imageKey, bucket: WARDROBE_STORAGE_BUCKET, bytes: Number(file.size) || 0, contentType: file.type || "application/octet-stream" };
}

export async function prepareAndUploadImageWithClient(client, file, scope, options = {}, runtime = {}) {
  const prepared = await prepareStorageImage(file, runtime);
  options.onPrepared?.(prepared);
  const uploaded = await uploadImageWithClient(client, prepared.blob, scope, {
    ...options,
    onPrepared: undefined,
    uploadInfo: prepared,
  });
  return { ...uploaded, preparation: prepared };
}

export async function prepareAndUploadImageWithRawClient(client, file, scope, options = {}, runtime = {}) {
  const prepared = await prepareStorageImage(file, runtime);
  options.onPrepared?.(prepared);
  const uploaded = await uploadImageRawWithClient(client, prepared.blob, scope, {
    ...options,
    onPrepared: undefined,
    uploadInfo: prepared,
  });
  return { ...uploaded, preparation: prepared };
}
