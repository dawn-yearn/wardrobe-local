import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import readline from "node:readline";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function parseOptions(args) {
  let port = 5173, open = true;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--no-open") open = false;
    else if (args[index] === "--port") {
      const value = args[++index];
      if (!/^\d+$/.test(value || "")) throw new Error("--port 后应填写 1024—65535 之间的端口。");
      port = Number(value);
    } else throw new Error(`无法识别启动参数：${args[index]}`);
  }
  if (port < 1024 || port > 65535) throw new Error("端口应在 1024—65535 之间。");
  return { port, open };
}

export async function checkPrerequisites(root = PROJECT_ROOT, version = process.versions.node) {
  if (Number(version.split(".")[0]) < 22) throw new Error("需要 Node.js 22 或更新版本。请安装后重新打开启动脚本。");
  const require = createRequire(path.join(root, "package.json"));
  for (const name of ["vite", "react", "react-dom/client", "@vitejs/plugin-react", "sharp", "ipx"]) {
    try {
      const resolved = require.resolve(name);
      if (!resolved.startsWith(path.join(root, "node_modules") + path.sep)) throw new Error("outside project");
    } catch {
      throw new Error(`缺少本项目依赖 ${name}。请在项目目录手动执行 npm.cmd ci 后重试；启动器不会自动安装。`);
    }
  }
  await access(path.join(root, "vite.config.mjs"));
}

export function readStatus(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/local/status`, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        try {
          const status = JSON.parse(text);
          if (response.statusCode !== 200 || status.mode !== "local" || !status.businessReady) throw new Error("本地 API 尚未就绪。");
          resolve(status);
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error("等待本地服务就绪超时。")));
    request.on("error", reject);
  });
}

export function openBrowser(url) {
  return new Promise((resolve, reject) => {
    // URL consists only of loopback and a validated numeric port.
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.unref();
      reject(new Error("打开默认浏览器超时。"));
    }, 8000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("无法打开默认浏览器。")); });
  });
}

export async function startLocal({ port = 5173, open = true, browser = openBrowser } = {}) {
  parseOptions(["--port", String(port)]);
  await checkPrerequisites();
  const { createServer } = await import("vite");
  let server;
  try {
    server = await createServer({ configFile: path.join(PROJECT_ROOT, "vite.config.mjs"), server: { host: "127.0.0.1", port, strictPort: true, open: false }, logLevel: "error" });
    await server.listen();
    const url = `http://127.0.0.1:${port}`;
    await readStatus(url);
    if (open) {
      try { await browser(url); }
      catch { console.warn(`未能自动打开浏览器，请手动打开 ${url}`); }
    }
    return { url, server, close: () => server.close() };
  } catch (error) {
    if (server) await server.close();
    if (error.code === "EADDRINUSE" || /already in use/.test(error.message)) throw new Error(`端口 ${port} 已被占用。若衣橱已运行，请使用已有窗口；否则关闭占用程序后重试。本次没有启动另一个实例。`);
    throw error;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  console.log("正在启动本地衣橱，请稍候…");
  const app = await startLocal(options);
  console.log(`本地衣橱已就绪：${app.url}`);
  console.log("保留此窗口。完成使用后，按 Enter 或 Ctrl+C 停止服务；关闭网页不会停止服务。");
  console.log("AI 生成期间请等任务完成后再关闭，以免中断请求。");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    terminal.close();
    await app.close();
    console.log("本地衣橱已停止。");
  };
  terminal.once("line", close);
  terminal.once("SIGINT", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
}
