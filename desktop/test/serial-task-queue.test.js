import assert from "node:assert/strict";
import test from "node:test";

import { SerialTaskQueue } from "../renderer/lib/serial-task-queue.js";

test("queued tasks cannot finish out of order", async () => {
  const queue = new SerialTaskQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return "first";
  });
  const second = queue.enqueue(async () => {
    events.push("second:start");
    events.push("second:end");
    return "second";
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  await queue.whenIdle();
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("a rejected task does not wedge later work or the idle boundary", async () => {
  const queue = new SerialTaskQueue();
  const failed = queue.enqueue(async () => {
    throw new Error("expected failure");
  });
  const recovered = queue.enqueue(async () => "recovered");

  await assert.rejects(failed, /expected failure/);
  assert.equal(await recovered, "recovered");
  await queue.whenIdle();
});
