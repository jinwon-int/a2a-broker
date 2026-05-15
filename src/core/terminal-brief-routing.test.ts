import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTerminalBriefTeamScope,
  resolveTerminalBriefParentOriginRoute,
  TERMINAL_BRIEF_PARENT_ORIGIN_METADATA_FIELDS,
} from "./terminal-brief-routing.js";

function expectRoute(input: Parameters<typeof resolveTerminalBriefParentOriginRoute>[0]) {
  const result = resolveTerminalBriefParentOriginRoute(input);
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
  return result.route;
}

test("normalizes Terminal Brief team scopes", () => {
  assert.equal(normalizeTerminalBriefTeamScope("team1"), "team1-only");
  assert.equal(normalizeTerminalBriefTeamScope("Team1 only"), "team1-only");
  assert.equal(normalizeTerminalBriefTeamScope("team1-only"), "team1-only");
  assert.equal(normalizeTerminalBriefTeamScope("team2"), "team2-only");
  assert.equal(normalizeTerminalBriefTeamScope("team1+team2"), "team1+team2");
  assert.equal(normalizeTerminalBriefTeamScope("team2+team1"), "team1+team2");
  assert.equal(normalizeTerminalBriefTeamScope("both"), "team1+team2");
  assert.equal(normalizeTerminalBriefTeamScope("unknown"), undefined);
});

test("case 1: Seoseo initiates Team1-only local Terminal Brief", () => {
  const route = expectRoute({ initiatingBrokerId: "seoseo", requestedTeamScope: "team1-only" });
  assert.equal(route.initiatingBrokerId, "seoseo");
  assert.equal(route.requestedTeamScope, "team1-only");
  assert.equal(route.parentBrokerId, "seoseo");
  assert.equal(route.originBrokerId, "seoseo");
  assert.equal(route.operatorFacingTerminalBriefSender, "seoseo");
  assert.deepEqual(route.localTeamIds, ["team1"]);
  assert.equal(route.handoff, null);
  assert.equal(route.executionPath, "local-only");
  assert.equal(route.childProjectionRequired, false);
  assert.equal(route.parentSeedRequired, false);
  assert.equal(route.notification.parentBrokerOnly, true);
  assert.equal(route.notification.childLocalNotificationSuppressedAfterRelaySuccess, false);
  assert.equal(route.notification.relayFailureFallsBackToLocalNotification, false);
});

test("case 2: Seoseo initiates Team1+Team2 with Gwakga child projections back to Seoseo", () => {
  const route = expectRoute({ initiatingBrokerId: "seoseo", requestedTeamScope: "team1+team2" });
  assert.equal(route.parentBrokerId, "seoseo");
  assert.equal(route.originBrokerId, "seoseo");
  assert.equal(route.operatorFacingTerminalBriefSender, "seoseo");
  assert.deepEqual(route.localTeamIds, ["team1"]);
  assert.deepEqual(route.handoff, {
    handoffBrokerId: "gwakga",
    handoffTeamIds: ["team2"],
    projectionDestinationBrokerId: "seoseo",
  });
  assert.equal(route.executionPath, "local-plus-cross-team-child-projection");
  assert.equal(route.childProjectionRequired, true);
  assert.equal(route.parentSeedRequired, true);
  assert.equal(route.notification.childLocalNotificationSuppressedAfterRelaySuccess, true);
  assert.equal(route.notification.relayFailureFallsBackToLocalNotification, true);
});

test("case 3: Gwakga initiates Team2-only local Terminal Brief", () => {
  const route = expectRoute({ initiatingBrokerId: "gwakga", requestedTeamScope: "team2-only" });
  assert.equal(route.initiatingBrokerId, "gwakga");
  assert.equal(route.parentBrokerId, "gwakga");
  assert.equal(route.originBrokerId, "gwakga");
  assert.equal(route.operatorFacingTerminalBriefSender, "gwakga");
  assert.deepEqual(route.localTeamIds, ["team2"]);
  assert.equal(route.handoff, null);
  assert.equal(route.executionPath, "local-only");
  assert.equal(route.childProjectionRequired, false);
  assert.equal(route.parentSeedRequired, false);
});

test("case 4: Gwakga initiates Team1+Team2 with Seoseo child projections back to Gwakga", () => {
  const route = expectRoute({ initiatingBrokerId: "gwakga", requestedTeamScope: "both" });
  assert.equal(route.parentBrokerId, "gwakga");
  assert.equal(route.originBrokerId, "gwakga");
  assert.equal(route.operatorFacingTerminalBriefSender, "gwakga");
  assert.deepEqual(route.localTeamIds, ["team2"]);
  assert.deepEqual(route.handoff, {
    handoffBrokerId: "seoseo",
    handoffTeamIds: ["team1"],
    projectionDestinationBrokerId: "gwakga",
  });
  assert.equal(route.executionPath, "local-plus-cross-team-child-projection");
  assert.equal(route.childProjectionRequired, true);
  assert.equal(route.parentSeedRequired, true);
  assert.equal(route.notification.childLocalNotificationSuppressedAfterRelaySuccess, true);
  assert.equal(route.notification.relayFailureFallsBackToLocalNotification, true);
});

test("Team2-only work cannot accidentally route through Seoseo", () => {
  const result = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId: "seoseo", requestedTeamScope: "team2-only" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "team_scope_not_owned_by_initiator");
  assert.match(result.reason, /Team2-only/);
});

test("Team1-only work cannot accidentally route through Gwakga", () => {
  const result = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId: "gwakga", requestedTeamScope: "team1-only" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "team_scope_not_owned_by_initiator");
  assert.match(result.reason, /Team1-only/);
});

test("all resolved routes preserve no-live and non-ACK safety boundaries", () => {
  for (const [initiatingBrokerId, requestedTeamScope] of [
    ["seoseo", "team1-only"],
    ["seoseo", "team1+team2"],
    ["gwakga", "team2-only"],
    ["gwakga", "team1+team2"],
  ] as const) {
    const route = expectRoute({ initiatingBrokerId, requestedTeamScope });
    assert.deepEqual(route.requiredMetadataFields, TERMINAL_BRIEF_PARENT_ORIGIN_METADATA_FIELDS);
    assert.equal(route.safety.liveProviderSend, false);
    assert.equal(route.safety.terminalOutboxAckMutated, false);
    assert.equal(route.safety.terminalAckReplay, false);
    assert.equal(route.safety.operatorApprovalInferred, false);
    assert.equal(route.parentBrokerId, route.initiatingBrokerId);
    assert.equal(route.originBrokerId, route.initiatingBrokerId);
    assert.equal(route.operatorFacingTerminalBriefSender, route.initiatingBrokerId);
  }
});

test("unknown broker and unsupported scope fail closed", () => {
  const unknownBroker = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId: "unknown", requestedTeamScope: "team1-only" });
  assert.equal(unknownBroker.ok, false);
  assert.equal(unknownBroker.code, "unknown_initiating_broker");

  const badScope = resolveTerminalBriefParentOriginRoute({ initiatingBrokerId: "seoseo", requestedTeamScope: "team3" });
  assert.equal(badScope.ok, false);
  assert.equal(badScope.code, "unsupported_team_scope");
});
