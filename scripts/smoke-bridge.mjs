import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(root, ".tmp");
const tempHome = path.join(tempRoot, "bridge-smoke-home");
const port = 17479;
const env = { ...process.env, USERPROFILE: tempHome, HOME: tempHome };

if (!tempHome.startsWith(`${tempRoot}${path.sep}`)) throw new Error("Unsafe smoke-test temp path.");
await fs.rm(tempHome, { recursive: true, force: true });
await fs.mkdir(tempHome, { recursive: true });

const entry = path.join(root, "packages", "bridge", "dist", "index.js");
await runNode([
  entry,
  "setup",
  "--public-url",
  "https://agent.example.com",
  "--workspace",
  root,
  "--port",
  String(port),
  "--allowed-origin",
  "https://console.example.com",
]);

const child = spawn(process.execPath, [entry], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

try {
  await waitForServer(`http://127.0.0.1:${port}/health`);
  const config = await getJson(`http://127.0.0.1:${port}/config`);
  assert(config.url === "https://agent.example.com", "Bridge did not return the fixed public URL.");
  assert(config.fixedPublicUrl === true, "Bridge did not mark the public URL as fixed.");

  const unauthorized = await fetch(`http://127.0.0.1:${port}/agent/codex/workspace`);
  assert(unauthorized.status === 401, "Protected endpoint did not reject a missing token.");

  const stored = JSON.parse(await fs.readFile(path.join(tempHome, ".codex-remote", "config.json"), "utf8"));
  const authorized = await fetch(`http://127.0.0.1:${port}/agent/codex/workspace`, {
    headers: {
      Origin: "https://console.example.com",
      "x-codex-remote-token": stored.token,
    },
  });
  assert(authorized.status === 200, `Authorized workspace request failed (${authorized.status}).`);
  assert(authorized.headers.get("access-control-allow-origin") === "https://console.example.com", "Allowed CORS origin was not returned.");
  console.log("Bridge smoke test passed: setup, fixed URL, auth, workspace and CORS.");
} finally {
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));
  await fs.rm(tempHome, { recursive: true, force: true });
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(output || `Process exited with ${code}`)));
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Bridge did not start. ${output}`);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return response.json();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
