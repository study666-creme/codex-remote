import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const tempRoot = path.join(root, ".tmp");
const tempHome = path.join(tempRoot, "bridge-smoke-home");
const port = 17479;
const env = { ...process.env, USERPROFILE: tempHome, HOME: tempHome };
const fakeThreadId = "11111111-1111-1111-1111-111111111111";

if (!tempHome.startsWith(`${tempRoot}${path.sep}`)) throw new Error("Unsafe smoke-test temp path.");
await fs.rm(tempHome, { recursive: true, force: true });
await fs.mkdir(tempHome, { recursive: true });
await writeFakeSession();

const entry = path.join(root, "packages", "bridge", "dist", "index.js");
await testAttachments();
await testEventReplay();
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
  assert(/^[0-9a-f]{64}$/.test(stored.token), "Setup did not generate a 32-byte random token.");
  const authorized = await fetch(`http://127.0.0.1:${port}/agent/codex/workspace`, {
    headers: {
      Origin: "https://console.example.com",
      "x-codex-remote-token": stored.token,
    },
  });
  assert(authorized.status === 200, `Authorized workspace request failed (${authorized.status}).`);
  assert(authorized.headers.get("access-control-allow-origin") === "https://console.example.com", "Allowed CORS origin was not returned.");
  const fastHistory = await fetch(`http://127.0.0.1:${port}/agent/codex/threads/${fakeThreadId}/resume`, {
    method: "POST",
    headers: {
      Origin: "https://console.example.com",
      "Content-Type": "application/json",
      "x-codex-remote-token": stored.token,
    },
    body: JSON.stringify({ workspaceId: "default", workspacePath: root }),
  }).then((response) => response.json());
  assert(fastHistory.fastHistory === true, "Bridge did not use the fast local session history.");
  assert(fastHistory.messages?.some((message) => message.role === "user" && message.text === "Fast history request"), "Fast history omitted the user message.");
  assert(fastHistory.messages?.some((message) => message.role === "assistant" && message.text === "Fast history response"), "Fast history omitted the assistant response.");
  console.log("Bridge smoke test passed: attachments, fast history, SSE replay, setup, fixed URL, auth, workspace and CORS.");
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

async function testAttachments() {
  const agents = await import(pathToFileURL(path.join(root, "packages", "bridge", "dist", "agents.js")).href);
  const markdown = "# Mobile acceptance\n\n- document upload\n";
  const prepared = await agents.prepareAttachmentFiles([
    { name: "reference.png", type: "image/png", kind: "image", dataUrl: `data:image/png;base64,${Buffer.from("image").toString("base64")}` },
    { name: "acceptance.md", type: "text/markdown", kind: "document", dataUrl: `data:text/markdown;base64,${Buffer.from(markdown).toString("base64")}` },
  ]);
  const imagePath = prepared.images[0];
  const documentPath = prepared.documents[0]?.path;
  try {
    assert(Boolean(imagePath), "Image attachment was not prepared.");
    assert(Boolean(documentPath), "Document attachment was not prepared as a mention.");
    assert(await fs.readFile(documentPath, "utf8") === markdown, "Document attachment contents changed.");
  } finally {
    await agents.cleanupPreparedAttachments(prepared);
  }
  await fs.access(imagePath).then(() => { throw new Error("Image attachment was not cleaned up."); }, () => undefined);
  await fs.access(documentPath).then(() => { throw new Error("Document attachment was not cleaned up."); }, () => undefined);

  let rejected = false;
  try {
    await agents.prepareAttachmentFiles([{ name: "unsafe.exe", type: "application/octet-stream", kind: "document", dataUrl: `data:application/octet-stream;base64,${Buffer.from("binary").toString("base64")}` }]);
  } catch {
    rejected = true;
  }
  assert(rejected, "Unsupported document type was accepted.");
}

async function testEventReplay() {
  class FakeEventResponse extends EventEmitter {
    chunks = [];
    headers = {};
    destroyed = false;
    socket = { setKeepAlive() {} };

    writeHead(_status, headers) {
      this.headers = headers;
    }

    flushHeaders() {}

    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    }

    end() {
      this.close();
    }

    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("close");
    }
  }

  const { EventHub } = await import(pathToFileURL(path.join(root, "packages", "bridge", "dist", "events.js")).href);
  const hub = new EventHub();
  const first = new FakeEventResponse();
  hub.openEvents(new URL("http://127.0.0.1/events?clientId=mobile-test"), first);
  hub.emitAll("agent_event", { sequence: 1 });
  hub.emitAll("agent_event", { sequence: 2 });
  first.close();

  const resumed = new FakeEventResponse();
  hub.openEvents(new URL("http://127.0.0.1/events?clientId=mobile-test"), resumed, "1");
  const replay = resumed.chunks.join("");
  assert(!replay.includes('"sequence":1'), "SSE replay resent an event the client had already received.");
  assert(replay.includes('"sequence":2'), "SSE replay did not restore the event missed during reconnect.");
  assert(resumed.headers["Cache-Control"] === "no-cache, no-transform", "SSE response did not disable proxy transformation.");
  resumed.close();

  const contextual = new FakeEventResponse();
  hub.openEvents(new URL("http://127.0.0.1/events?clientId=mobile-context"), contextual);
  hub.emitAll("agent_event", { type: "item.updated" }, { threadId: "thread-a", turnId: "turn-a" });
  const contextualPayload = contextual.chunks.join("");
  assert(contextualPayload.includes('"thread_id":"thread-a"'), "SSE event omitted its thread id.");
  assert(contextualPayload.includes('"turn_id":"turn-a"'), "SSE event omitted its turn id.");
  contextual.close();
}

async function writeFakeSession() {
  const sessionDir = path.join(tempHome, ".codex", "sessions", "2026", "07", "12");
  await fs.mkdir(sessionDir, { recursive: true });
  const rows = [
    { timestamp: "2026-07-12T00:00:00.000Z", type: "session_meta", payload: { id: fakeThreadId, session_id: fakeThreadId, cwd: root } },
    { timestamp: "2026-07-12T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-fast" } },
    { timestamp: "2026-07-12T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "Fast history request" } },
    { timestamp: "2026-07-12T00:00:03.000Z", type: "response_item", payload: { type: "function_call", id: "tool-fast", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) } },
    { timestamp: "2026-07-12T00:00:04.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Fast history response" } },
    { timestamp: "2026-07-12T00:00:05.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-fast" } },
  ];
  await fs.writeFile(path.join(sessionDir, `rollout-2026-07-12T00-00-00-${fakeThreadId}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
