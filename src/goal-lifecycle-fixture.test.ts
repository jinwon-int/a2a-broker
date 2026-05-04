import assert from "node:assert/strict";
import test from "node:test";

import { buildGoalLifecycleSmokeFixture } from "./fixtures/goal-lifecycle.js";

test("goal lifecycle smoke fixture captures one goal with multiple child tasks", () => {
  const snapshot = buildGoalLifecycleSmokeFixture();
  const goal = snapshot.goals?.[0];
  assert.ok(goal);
  assert.equal(goal.status, "budget_limited");
  assert.equal(goal.outcome?.failed, false);

  const attachedChildIds = goal.taskAttachments
    .map((attachment) => attachment.taskId)
    .filter((taskId) => taskId !== "goal-smoke-parent");

  assert.deepEqual(attachedChildIds, [
    "goal-smoke-design",
    "goal-smoke-impl",
    "goal-smoke-smoke",
  ]);
  assert.equal(snapshot.tasks.filter((task) => task.parentTaskId === "goal-smoke-parent").length, 3);
  assert.equal(goal.history.at(-1)?.reason, "budget_exhausted");
});
