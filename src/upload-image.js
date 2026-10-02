const IMAGE_EXTENSION = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i;

export function isImageFile(file) {
  if (!file) return false;
  if (typeof file.type === "string" && file.type.toLowerCase().startsWith("image/")) return true;
  return typeof file.name === "string" && IMAGE_EXTENSION.test(file.name);
}

export function selectedImageFiles(files) {
  return Array.from(files || []).filter(isImageFile);
}

export function wardrobeImportRoute(hasAiAccess) {
  return hasAiAccess ? "ai" : "manual";
}
