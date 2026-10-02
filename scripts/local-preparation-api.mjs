// Stage 0 only. Replace this gate when the local APIs and UI are implemented.
// Do not mount the old Auth/Storage APIs or load the old browser auth entry point.
const page = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open Wardrobe · 本地化准备</title>
<style>body{margin:12vh auto;padding:0 24px;max-width:640px;background:#f4f0e8;color:#292720;font:18px/1.8 system-ui,sans-serif}h1{font-size:30px}p{margin:16px 0}</style>
<h1>本地衣橱正在准备中</h1>
<p>阶段 0：已隔离云端启动入口。当前不会连接 Meoo、登录服务或调用 AI。</p>
<p>衣物和图片保留在本机。完成阶段 1、2 后再开放衣橱操作。</p>
<p>可以关闭此窗口及服务；后续步骤见项目中的《本地化改造方案》。</p></html>`;

export function localPreparationApi() {
  const handler = (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Cache-Control", "no-store");
    if (pathname === "/api/local/status" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ mode: "local-preparation", stage: 0, cloudEnabled: false, businessReady: false }));
      return;
    }
    if ((pathname === "/" || pathname === "/index.html") && ["GET", "HEAD"].includes(req.method)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(req.method === "HEAD" ? undefined : page);
      return;
    }
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ code: "LOCAL_PREPARATION", error: "本地化阶段 0：业务接口尚未开放" }));
  };
  return {
    name: "wardrobe-local-preparation",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}
