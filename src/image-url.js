export function isDirectStorageUrl(src) {
  return typeof src === "string" && /^https?:\/\/[^/]+\/storage\/v1\/object\/public\//i.test(src);
}
