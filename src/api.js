export async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (typeof options.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  try { return await fetch(path, { ...options, headers, cache: options.cache || "no-store" }); }
  catch { throw new Error("无法连接本地衣橱服务，请确认服务仍在运行后重试。"); }
}
