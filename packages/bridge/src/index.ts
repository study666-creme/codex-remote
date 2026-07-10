#!/usr/bin/env node

import { CONFIG_FILE, configureBridge } from "./config.js";
import { startHttpServer } from "./http-server.js";

const [command] = process.argv.slice(2);

if (command === "setup") {
  const values = parseSetupArgs(process.argv.slice(3));
  const config = configureBridge(values);
  console.log(`Saved bridge settings to ${CONFIG_FILE}`);
  console.log(`Agent URL: ${config.url}`);
  console.log(`Connect token: ${config.token}`);
} else {
  startHttpServer();
}

function parseSetupArgs(args: string[]) {
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const origins = args.flatMap((item, index) => item === "--allowed-origin" && args[index + 1] ? [args[index + 1]] : []);
  const port = Number(value("--port") || 0) || undefined;
  return {
    publicUrl: value("--public-url"),
    token: value("--token"),
    workspacePath: value("--workspace"),
    listenHost: value("--host"),
    port,
    origins,
  };
}
