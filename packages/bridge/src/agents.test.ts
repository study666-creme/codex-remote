import assert from "node:assert/strict";
import test from "node:test";

import { codexNotificationErrorMessage, normalizeCodexNotification, parseActiveTurnMismatch } from "./agents.js";

test("extracts the current turn id from a Codex steer mismatch", () => {
  assert.deepEqual(
    parseActiveTurnMismatch(
      new Error("expected active turn id `019f78eb-6237-7d51-a2e4-1646dca322d7` but found `019f78eb-5ca2-7c83-a66b-4b35a3e17b3a`"),
    ),
    {
      expected: "019f78eb-6237-7d51-a2e4-1646dca322d7",
      found: "019f78eb-5ca2-7c83-a66b-4b35a3e17b3a",
    },
  );
});

test("ignores unrelated Codex errors", () => {
  assert.equal(parseActiveTurnMismatch(new Error("Codex app-server request timed out: turn/steer")), null);
});

test("extracts a detailed nested Codex error", () => {
  const message = "503 Service Unavailable: No available channel for model missing-model, url: https://api.example.invalid/v1/responses";
  assert.equal(codexNotificationErrorMessage({ error: { message } }), message);
  assert.deepEqual(normalizeCodexNotification("error", { error: { message }, willRetry: false }), {
    type: "error",
    message,
    will_retry: false,
  });
});

test("normalizes a failed completed turn as an error instead of success", () => {
  const message = "The selected model is unavailable.";
  assert.deepEqual(normalizeCodexNotification("turn/completed", {
    turn: { id: "turn-test", status: "failed", error: { message } },
  }), {
    type: "error",
    message,
  });
});

test("keeps a successful completed turn as completed", () => {
  assert.deepEqual(normalizeCodexNotification("turn/completed", {
    turn: { id: "turn-test", status: "completed", error: null },
  }), {
    type: "turn.completed",
    usage: null,
  });
});
