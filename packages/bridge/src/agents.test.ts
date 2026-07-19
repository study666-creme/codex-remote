import assert from "node:assert/strict";
import test from "node:test";

import { parseActiveTurnMismatch } from "./agents.js";

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
