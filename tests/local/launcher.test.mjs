import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { PROJECT_ROOT, parseOptions, checkPrerequisites } from "../../scripts/start-local.mjs";

test("launcher validates ports and diagnoses missing runtime/dependencies", async () => {
  assert.deepEqual(parseOptions([]), { port: 5173, open: true });
  assert.deepEqual(parseOptions(["--no-open", "--port", "5182"]), { port: 5182, open: false });
  for (const value of ["80", "65536", "5173&echo", "NaN"]) assert.throws(() => parseOptions(["--port", value]));
  await assert.rejects(checkPrerequisites(PROJECT_ROOT, "18.0.0"), /Node.js 22/);
  await mkdir(path.join(PROJECT_ROOT, "backups/launcher-tests"), { recursive: true });
  const empty = await mkdtemp(path.join(PROJECT_ROOT, "backups/launcher-tests/missing-"));
  await assert.rejects(checkPrerequisites(empty), /npm.cmd ci/);
  await checkPrerequisites();
});

test("Windows cmd launcher works outside project, persists after restart and refuses occupied port", { skip: process.platform !== "win32", timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(PROJECT_ROOT, "backups/launcher-tests/session-"));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, WARDROBE_NO_PAUSE: "1", WARDROBE_DATA_DIR: root, WARDROBE_MODEL_REFERENCE: path.join(root, "model-reference.png"), DASHSCOPE_API_KEY: "", OPENAI_API_KEY: "" };
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.stdin.end("\n"); });
  function launch() {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `""${path.join(PROJECT_ROOT, "启动本地衣橱.cmd")}" --no-open --port ${port}"`], { cwd: root, env, windowsHide: true, windowsVerbatimArguments: true });
    children.push(child);
    let output = "";
    const exited = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code)); });
    const ready = new Promise((resolve, reject) => {
      const collect = bytes => { output += bytes.toString(); if (output.includes("本地衣橱已就绪")) resolve(); };
      child.stdout.on("data", collect); child.stderr.on("data", collect);
      child.on("error", reject); child.on("exit", code => reject(new Error(`Exited ${code}: ${output}`)));
    });
    return { child, ready, exited, output: () => output };
  }
  const url = `http://127.0.0.1:${port}`;
  const first = launch(); await first.ready;
  assert.equal((await (await fetch(`${url}/api/local/status`)).json()).cloudEnabled, false);
  assert.equal((await fetch(`${url}/api/profile`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname: "重启保留" }) })).status, 200);
  const conflict = launch(); conflict.ready.catch(() => {});
  assert.equal(await conflict.exited, 1); assert.match(conflict.output(), /已被占用/);
  first.child.stdin.end("\n"); assert.equal(await first.exited, 0);
  const second = launch(); await second.ready;
  assert.equal((await (await fetch(`${url}/api/profile`)).json()).nickname, "重启保留");
  assert.equal((await (await fetch(`${url}/api/import/config`)).json()).ready, false);
  second.child.stdin.end("\n"); assert.equal(await second.exited, 0);
});
