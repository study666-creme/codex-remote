import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { GitRemoteInfo, GitRepoInfo } from "@codex-remote/shared";

export function discoverGitRepos(workspacePath: string) {
  const repos = new Map<string, GitRepoInfo>();
  repoDiscoveryRoots(workspacePath).forEach((root) => collectGitRepos(root, repos, 0, 2));
  return [...repos.values()].sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

export function findRepoByPath(repos: GitRepoInfo[], repoPath: string) {
  return repos.find((repo) => samePath(repo.repoPath, repoPath));
}

export function resolveGitWorkspace(cwd: string) {
  const current = gitTopLevel(cwd);
  if (current) return current;
  try {
    for (const item of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const repo = gitTopLevel(path.join(cwd, item.name));
      if (repo) return repo;
    }
  } catch {
    return cwd;
  }
  return cwd;
}

export function safeGitRef(value: string, fallback: string) {
  const ref = value.trim() || fallback;
  if (!/^[a-zA-Z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/")) {
    throw new Error("Unsafe git push argument.");
  }
  return ref;
}

export function runGitPush(repoPath: string, remote: string, branch: string) {
  const topLevel = gitTopLevel(repoPath);
  if (!topLevel || !samePath(topLevel, repoPath)) throw new Error("Selected path is not a valid Git repository.");
  return new Promise<{ repoPath: string; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("git", ["push", remote, `HEAD:${branch}`], { cwd: repoPath, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ repoPath, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(new Error(`git push failed (${code ?? "unknown"}): ${(stderr || stdout || "no output").trim()}`));
    });
  });
}

function repoDiscoveryRoots(workspacePath: string) {
  const roots = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (fs.existsSync(resolved)) roots.add(resolved);
  };
  const workspace = path.resolve(workspacePath);
  add(workspace);
  const parent = path.dirname(workspace);
  if (parent !== workspace && parent !== path.parse(workspace).root) add(parent);
  String(process.env.CODEX_REMOTE_REPO_ROOTS || "")
    .split(path.delimiter)
    .filter(Boolean)
    .forEach(add);
  return [...roots].sort((a, b) => a.length - b.length);
}

function collectGitRepos(root: string, repos: Map<string, GitRepoInfo>, depth: number, maxDepth: number) {
  if (repos.size >= 80 || !fs.existsSync(root)) return;
  const topLevel = gitTopLevel(root);
  if (topLevel) {
    const repoPath = path.resolve(topLevel);
    const key = repoKey(repoPath);
    if (!repos.has(key)) repos.set(key, inspectGitRepo(repoPath));
    if (samePath(repoPath, root)) return;
  }
  if (depth >= maxDepth) return;
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of children) {
    if (!item.isDirectory() || ignoredGitSearchDir(item.name)) continue;
    collectGitRepos(path.join(root, item.name), repos, depth + 1, maxDepth);
    if (repos.size >= 80) return;
  }
}

function inspectGitRepo(repoPath: string): GitRepoInfo {
  const branch = gitOutput(repoPath, ["branch", "--show-current"]) || gitOutput(repoPath, ["rev-parse", "--short", "HEAD"]) || "detached";
  const remotes = parseGitRemotes(gitOutput(repoPath, ["remote", "-v"]));
  const defaultRemote = remotes.find((item) => item.name === "origin")?.name || remotes[0]?.name || "";
  const defaultBranch = (defaultRemote && remoteDefaultBranch(repoPath, defaultRemote)) || (branch === "detached" ? "main" : branch) || "main";
  const statusShort = gitOutput(repoPath, ["status", "--short"])
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 80);
  const warnings: string[] = [];
  if (!remotes.length) warnings.push("No git remote is configured.");
  if (statusShort.length) warnings.push("There are uncommitted changes; phone push sends committed HEAD only.");
  if (remotes.some((remote) => remote.name.toLowerCase() === "upstream")) warnings.push("An upstream remote exists. Push to your fork's origin unless you own upstream.");
  return {
    repoPath,
    branch,
    defaultRemote,
    defaultBranch,
    remotes,
    dirty: statusShort.length > 0,
    statusShort,
    warnings,
    pushBlocked: !remotes.length,
  };
}

function parseGitRemotes(value: string): GitRemoteInfo[] {
  const remotes = new Map<string, string>();
  value.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
    if (!match) return;
    const [, name, url, kind] = match;
    if (kind === "fetch" || !remotes.has(name)) remotes.set(name, url);
  });
  return [...remotes.entries()].map(([name, url]) => ({ name, url }));
}

function remoteDefaultBranch(repoPath: string, remote: string) {
  return gitOutput(repoPath, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]).replace(`${remote}/`, "");
}

function ignoredGitSearchDir(name: string) {
  return new Set([".git", ".next", ".turbo", ".vercel", "node_modules", "dist", "build", "coverage", ".cache"]).has(name);
}

function gitOutput(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

function gitTopLevel(cwd: string) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? path.resolve(result.stdout.trim()) : "";
}

function samePath(a: string, b: string) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function repoKey(repoPath: string) {
  const resolved = path.resolve(repoPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
