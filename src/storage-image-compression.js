export const TARGET_STORAGE_IMAGE_BYTES = 650 * 1024;

const JPEG_STEPS = [
  [1600, 0.70],
  [1440, 0.65],
  [1280, 0.60],
  [1152, 0.56],
  [1024, 0.52],
  [960, 0.48],
];

function loadBrowserImage(file) {
  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({
      width: Number(image.naturalWidth || image.width),
      height: Number(image.naturalHeight || image.height),
      async encode(width, height, quality) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("当前浏览器无法处理图片。");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        return new Promise((resolveBlob, rejectBlob) => canvas.toBlob(
          (blob) => blob ? resolveBlob(blob) : rejectBlob(new Error("无法压缩这张图片。")),
          "image/jpeg",
          quality,
        ));
      },
      dispose() { URL.revokeObjectURL(objectUrl); },
    });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("无法处理这张图片，请选择 JPEG、PNG、WebP 或手机拍摄的照片。"));
    };
    image.src = objectUrl;
  });
}

export async function prepareStorageImage(file, runtime = {}) {
  const imageByMime = String(file?.type || "").toLowerCase().startsWith("image/");
  const imageByName = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i.test(String(file?.name || ""));
  if (!file || (!imageByMime && !imageByName)) {
    throw new Error("请选择图片文件。");
  }
  const decode = runtime.decode || loadBrowserImage;
  const decoded = await decode(file);
  const originalWidth = Number(decoded.width);
  const originalHeight = Number(decoded.height);
  if (!originalWidth || !originalHeight || typeof decoded.encode !== "function") {
    decoded.dispose?.();
    throw new Error("无法读取这张图片的尺寸。");
  }

  const attempts = [];
  try {
    for (const [targetSide, quality] of JPEG_STEPS) {
      const scale = Math.min(1, targetSide / Math.max(originalWidth, originalHeight));
      const width = Math.max(1, Math.round(originalWidth * scale));
      const height = Math.max(1, Math.round(originalHeight * scale));
      const blob = await decoded.encode(width, height, quality);
      attempts.push({ width, height, quality, bytes: Number(blob.size) || 0 });
      if (blob.size <= TARGET_STORAGE_IMAGE_BYTES) {
        return {
          blob,
          mimeType: "image/jpeg",
          originalBytes: Number(file.size) || 0,
          compressedBytes: Number(blob.size) || 0,
          originalDimensions: { width: originalWidth, height: originalHeight },
          dimensions: { width, height },
          quality,
          attempts,
        };
      }
    }
    const last = attempts.at(-1);
    const error = new Error(`图片压缩后仍超过 Storage 上传上限（${last?.bytes || 0} bytes > ${TARGET_STORAGE_IMAGE_BYTES} bytes）。`);
    error.code = "STORAGE_IMAGE_COMPRESSION_LIMIT";
    error.attempts = attempts;
    throw error;
  } finally {
    decoded.dispose?.();
  }
}
