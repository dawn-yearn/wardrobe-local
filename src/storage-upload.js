import { apiFetch } from "./api.js";
import { prepareStorageImage } from "./storage-image-compression.js";

export function uploadPayload(uploadId, metadata) {
  return { upload_id: uploadId, ...(metadata ? { metadata } : {}) };
}
export async function uploadLocalImage(file, scope) {
  const prepared = await prepareStorageImage(file);
  const response = await apiFetch('/api/uploads?scope=' + encodeURIComponent(scope), {
    method: "POST", headers: { "Content-Type": prepared.mimeType }, body: prepared.blob,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "图片上传失败，请重试。");
  return { uploadId: result.upload_id };
}
export async function discardLocalUpload(uploadId, scope) {
  return apiFetch('/api/uploads/' + encodeURIComponent(uploadId) + '?scope=' + encodeURIComponent(scope), { method: "DELETE" });
}
