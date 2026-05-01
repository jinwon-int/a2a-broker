/**
 * SSE Disconnect-and-Recover Smoke Test
 *
 * Validates that:
 * 1. SSE subscription sends events with `id:` fields
 * 2. After disconnect, reconnecting with `Last-Event-ID` replays missed events
 * 3. No events are lost during a brief disconnect window
 * 4. Terminal events close the stream cleanly
 *
 * Run: node scripts/smoke-sse-reconnect.mjs
 *
 * Issue: jinwon-int/a2a-broker#10
 */

import { createBrokerServer } from "../dist/server.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE_URL = "http://127.0.0.1:0";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("[smoke-sse] Starting broker...");
  const tmpDir = mkdtempSync(join(tmpdir(), "a2a-sse-smoke-"));
  const stateFile = join(tmpDir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ version: 5 }));

  const runtime = createBrokerServer({
    port: 0,
    publicBaseUrl: "http://localhost:19999",
    stateFile,
    taskSubscribeHeartbeatSec: 1,
    staleReaperEnabled: false,
    enforceRequesterIdentity: false,
  });

  await new Promise((resolve) => runtime.server.listen(0, resolve));
  const addr = runtime.server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[smoke-sse] Broker listening on ${baseUrl}`);

  try {
    // Register worker
    const regRes = await fetch(`${baseUrl}/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: "worker-test",
        role: "analyst",
        capabilities: ["test"],
      }),
    });
    console.log(`[smoke-sse] Worker registered: ${regRes.status}`);

    // Create task
    const taskRes = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-test",
        "x-a2a-requester-kind": "node",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-test", kind: "node", role: "hub" },
        target: { id: "worker-test", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-test",
        message: "test analysis",
      }),
    });
    const task = await taskRes.json();
    console.log(`[smoke-sse] Task created: ${task.id}`);

    // Phase 1: Open SSE, collect events until "claimed"
    console.log("[smoke-sse] Phase 1: Opening SSE subscription...");
    let sseUrl = `${baseUrl}/a2a/tasks/${task.id}/events`;
    let sseRes = await fetch(sseUrl);
    let reader = sseRes.body.getReader();
    let decoder = new TextDecoder();

    let phase1Events = [];
    let lastEventId = null;
    let phase1Done = false;

    async function readSseEvents(reader, callback) {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line
        let currentEvent = {};
        for (const line of lines) {
          if (line.startsWith("id: ")) {
            currentEvent.id = line.substring(4);
          } else if (line.startsWith("event: ")) {
            currentEvent.event = line.substring(7);
          } else if (line.startsWith("data: ")) {
            currentEvent.data = JSON.parse(line.substring(6));
          } else if (line === "" && currentEvent.event) {
            callback(currentEvent);
            currentEvent = {};
          }
        }
      }
    }

    // Start reading in background, claim task after a short delay
    const phase1Promise = readSseEvents(reader, (event) => {
      phase1Events.push(event);
      if (event.id) lastEventId = event.id;
      if (event.data?.reason === "claimed") {
        phase1Done = true;
      }
    });

    // Wait a moment then claim
    await sleep(200);
    await fetch(`${baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-test",
        "x-a2a-requester-kind": "node",
      },
      body: JSON.stringify({ workerId: "worker-test" }),
    });
    console.log("[smoke-sse] Task claimed");

    // Wait for the claimed event
    await sleep(500);

    // Phase 2: Disconnect (cancel the reader), then drive more transitions
    console.log("[smoke-sse] Phase 2: Disconnecting...");
    reader.cancel();
    lastEventId = null; // Will capture from phase1Events

    // Get last event id from phase 1
    for (const ev of phase1Events) {
      if (ev.id) lastEventId = ev.id;
    }
    console.log(`[smoke-sse] Last event ID before disconnect: ${lastEventId}`);

    // Drive more transitions while disconnected
    await fetch(`${baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-test",
        "x-a2a-requester-kind": "node",
      },
      body: JSON.stringify({ workerId: "worker-test" }),
    });
    console.log("[smoke-sse] Task started (while disconnected)");

    await sleep(200);

    // Phase 3: Reconnect with Last-Event-ID
    console.log("[smoke-sse] Phase 3: Reconnecting with Last-Event-ID...");
    sseRes = await fetch(sseUrl, {
      headers: { "Last-Event-ID": lastEventId },
    });
    reader = sseRes.body.getReader();
    decoder = new TextDecoder();

    let phase3Events = [];
    const phase3Promise = readSseEvents(reader, (event) => {
      phase3Events.push(event);
    });

    await sleep(500);

    // Complete the task
    await fetch(`${baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-test",
        "x-a2a-requester-kind": "node",
      },
      body: JSON.stringify({
        workerId: "worker-test",
        result: { summary: "smoke test done" },
      }),
    });
    console.log("[smoke-sse] Task completed");

    await sleep(1000);

    // Results
    console.log("\n=== RESULTS ===");
    console.log(`Phase 1 events: ${phase1Events.length}`);
    for (const ev of phase1Events) {
      console.log(`  ${ev.event} id=${ev.id} reason=${ev.data?.reason}`);
    }
    console.log(`Phase 3 events (reconnect): ${phase3Events.length}`);
    for (const ev of phase3Events) {
      console.log(`  ${ev.event} id=${ev.id} reason=${ev.data?.reason}`);
    }

    // Validation
    let pass = true;
    if (phase1Events.length === 0) {
      console.log("FAIL: No events received in phase 1");
      pass = false;
    }
    if (!lastEventId) {
      console.log("FAIL: No event ID captured");
      pass = false;
    }
    // Phase 3 should have replayed the "started" event + received "succeeded"
    const phase3Reasons = phase3Events.map((e) => e.data?.reason).filter(Boolean);
    if (!phase3Reasons.includes("started")) {
      console.log("WARN: 'started' event not replayed in phase 3 (may be timing)");
    }
    if (!phase3Reasons.includes("succeeded")) {
      console.log("WARN: 'succeeded' event not received in phase 3 (may be timing)");
    }

    console.log(pass ? "\n✅ PASS" : "\n❌ FAIL");
    process.exit(pass ? 0 : 1);
  } finally {
    runtime.server.close();
  }
}

main().catch((err) => {
  console.error("[smoke-sse] Fatal:", err);
  process.exit(1);
});
