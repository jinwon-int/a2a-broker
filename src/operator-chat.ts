import type { InMemoryA2ABroker } from "./core/broker.js";
import {
  applyKnownA2APartyDisplayName,
  resolveKnownA2ADisplayName,
} from "./core/display-names.js";
import type {
  A2AExchangeDecision,
  A2AExchangeIntent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  A2APartyRef,
} from "./core/types.js";

const OPERATOR_CHAT_TARGETS = ["bangtong", "dungae"] as const;
const DEFAULT_TIMELINE_LIMIT = 200;
const MAX_TIMELINE_LIMIT = 500;

export type OperatorChatTarget = (typeof OPERATOR_CHAT_TARGETS)[number] | "all";

export interface OperatorChatTimelineItem {
  id: string;
  exchangeId: string;
  rootMessageId: string;
  parentMessageId?: string;
  kind: A2AExchangeMessageRecord["kind"];
  body: string;
  createdAt: string;
  updatedAt: string;
  author: A2APartyRef;
  target: A2APartyRef;
  targetNodeId: string;
  assignedWorkerId?: string;
  decision?: A2AExchangeDecision;
  intent: A2AExchangeIntent;
  exchangeStatus: A2AExchangeState["status"];
}

export interface OperatorChatConversation {
  exchangeId: string;
  rootMessageId: string;
  target: A2APartyRef;
  status: A2AExchangeState["status"];
  intent: A2AExchangeIntent;
  messageCount: number;
  lastMessageAt: string;
  activeTaskId?: string;
}

export interface OperatorChatReadModel {
  generatedAt: string;
  actor: A2APartyRef;
  requiresEdgeSecret: boolean;
  availableTargets: Array<{ id: OperatorChatTarget; label: string }>;
  conversations: OperatorChatConversation[];
  items: OperatorChatTimelineItem[];
}

export interface OperatorChatDelivery {
  target: A2APartyRef;
  exchange: A2AExchangeState;
  message: A2AExchangeMessageRecord;
  createdExchange: boolean;
}

export function readOperatorChat(
  broker: InMemoryA2ABroker,
  options: { requiresEdgeSecret: boolean; limit?: number },
): OperatorChatReadModel {
  const exchanges = broker.listExchanges().filter(isOperatorChatExchange);
  const limit = clampTimelineLimit(options.limit);
  const items = exchanges
    .flatMap((exchange) =>
      broker.listExchangeMessages(exchange.id).map((message) => mapTimelineItem(exchange, message)),
    )
    .sort(sortTimelineAscending)
    .slice(-limit);

  return {
    generatedAt: new Date().toISOString(),
    actor: operatorParty(),
    requiresEdgeSecret: options.requiresEdgeSecret,
    availableTargets: [
      { id: "bangtong", label: displayLabelForTarget("bangtong") },
      { id: "dungae", label: displayLabelForTarget("dungae") },
      { id: "all", label: "전체" },
    ],
    conversations: exchanges.map((exchange) => ({
      exchangeId: exchange.id,
      rootMessageId: exchange.rootMessageId,
      target: decorateTarget(exchange.target),
      status: exchange.status,
      intent: exchange.intent,
      messageCount: exchange.messageCount,
      lastMessageAt: exchange.lastMessageAt,
      activeTaskId: exchange.activeTaskId,
    })),
    items,
  };
}

export function sendOperatorChatMessage(
  broker: InMemoryA2ABroker,
  request: { message: string; target: OperatorChatTarget },
): OperatorChatDelivery[] {
  const message = request.message.trim();
  if (!message) {
    throw new Error("message is required");
  }

  return resolveRequestedTargets(request.target).map((targetId) => {
    const existingExchange = findLatestOperatorExchange(broker, targetId);
    if (existingExchange) {
      const nextMessage = broker.addExchangeMessage(existingExchange.id, {
        actor: operatorParty(),
        message,
        parentMessageId: existingExchange.latestMessageId,
        via: operatorChatVia(),
      });
      return {
        target: decorateTarget(existingExchange.target),
        exchange: broker.getExchange(existingExchange.id) ?? existingExchange,
        message: nextMessage,
        createdExchange: false,
      } satisfies OperatorChatDelivery;
    }

    const target = targetParty(broker, targetId);
    const exchange = broker.startExchange({
      requester: operatorParty(),
      target,
      message,
      intent: "chat",
      via: operatorChatVia(),
    });
    const rootMessage = broker.listExchangeMessages(exchange.id).find((item) => item.id === exchange.rootMessageId);
    if (!rootMessage) {
      throw new Error(`missing root message for exchange ${exchange.id}`);
    }
    return {
      target: decorateTarget(target),
      exchange,
      message: rootMessage,
      createdExchange: true,
    } satisfies OperatorChatDelivery;
  });
}

export function isValidOperatorChatTarget(value: string | undefined): value is OperatorChatTarget {
  return value === "all" || OPERATOR_CHAT_TARGETS.includes(value as (typeof OPERATOR_CHAT_TARGETS)[number]);
}

export function renderOperatorChatHtml(requiresEdgeSecret: boolean): string {
  const bootPayload = JSON.stringify({
    apiPath: "/operator/chat",
    requiresEdgeSecret,
  });

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>A2A Operator Chat</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #08111f;
        color: #e5eefc;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: linear-gradient(180deg, #08111f 0%, #111d30 100%);
      }
      main {
        width: min(960px, calc(100vw - 24px));
        margin: 0 auto;
        padding: 24px 0 40px;
      }
      .panel {
        background: rgba(9, 17, 30, 0.88);
        border: 1px solid rgba(139, 164, 199, 0.2);
        border-radius: 16px;
        padding: 18px;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.25);
      }
      h1 {
        margin: 0;
        font-size: 1.5rem;
      }
      p, label, input, textarea, select, button {
        font: inherit;
      }
      .subtle {
        color: #91a4c2;
      }
      .toolbar {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        margin-top: 16px;
        align-items: end;
      }
      .toolbar-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .field {
        display: grid;
        gap: 6px;
        min-width: 180px;
        flex: 1;
      }
      input, textarea, select {
        width: 100%;
        border-radius: 10px;
        border: 1px solid rgba(139, 164, 199, 0.28);
        background: rgba(10, 20, 34, 0.95);
        color: #f3f7ff;
        padding: 10px 12px;
      }
      textarea {
        min-height: 104px;
        resize: vertical;
      }
      button {
        border: 0;
        border-radius: 10px;
        padding: 10px 14px;
        background: #6ea8fe;
        color: #08111f;
        cursor: pointer;
        font-weight: 700;
      }
      button.secondary {
        background: rgba(139, 164, 199, 0.18);
        color: #e5eefc;
      }
      button:disabled {
        opacity: 0.6;
        cursor: wait;
      }
      #status {
        margin-top: 12px;
        min-height: 22px;
        color: #cbd8eb;
      }
      #timeline {
        display: grid;
        gap: 12px;
        margin-top: 18px;
      }
      .message {
        border-radius: 14px;
        border: 1px solid rgba(139, 164, 199, 0.18);
        background: rgba(13, 22, 38, 0.9);
        padding: 14px;
      }
      .message.mine {
        border-color: rgba(110, 168, 254, 0.45);
        background: rgba(15, 33, 57, 0.95);
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 12px;
        align-items: center;
        color: #91a4c2;
        font-size: 0.9rem;
      }
      .author {
        color: #f3f7ff;
        font-weight: 700;
      }
      .body {
        margin-top: 10px;
        white-space: pre-wrap;
        line-height: 1.45;
      }
      .ids {
        margin-top: 10px;
        font-size: 0.8rem;
        color: #7690b7;
        word-break: break-all;
      }
      .empty {
        padding: 24px;
        border: 1px dashed rgba(139, 164, 199, 0.22);
        border-radius: 14px;
        color: #91a4c2;
        text-align: center;
      }
      @media (max-width: 720px) {
        .toolbar {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>A2A operator chat</h1>
        <p class="subtle">서서가 방통, 등애와 주고받는 A2A 대화를 한 화면에서 보고 보낼 수 있습니다.</p>
        <div class="toolbar">
          <div class="toolbar-row">
            <label class="field">
              <span>Edge secret</span>
              <input id="edge-secret" type="password" autocomplete="off" placeholder="브로커에 EDGE_SECRET이 있으면 입력" />
            </label>
          </div>
          <button id="reload" class="secondary" type="button">새로고침</button>
        </div>
        <div id="status" role="status" aria-live="polite"></div>
        <div id="timeline"></div>
      </section>

      <section class="panel" style="margin-top: 16px;">
        <form id="composer">
          <div class="toolbar-row">
            <label class="field" style="max-width: 220px; flex: 0 0 220px;">
              <span>보낼 대상</span>
              <select id="target">
                <option value="bangtong">방통</option>
                <option value="dungae">등애</option>
                <option value="all">전체</option>
              </select>
            </label>
          </div>
          <label class="field" style="margin-top: 14px;">
            <span>메시지</span>
            <textarea id="message" placeholder="서서로서 보낼 메시지를 입력하세요."></textarea>
          </label>
          <div style="margin-top: 14px; display: flex; justify-content: flex-end;">
            <button id="send" type="submit">보내기</button>
          </div>
        </form>
      </section>
    </main>

    <script>
      const config = ${bootPayload};
      const storageKey = 'a2a-operator-chat-edge-secret';
      const timelineEl = document.getElementById('timeline');
      const statusEl = document.getElementById('status');
      const secretEl = document.getElementById('edge-secret');
      const targetEl = document.getElementById('target');
      const messageEl = document.getElementById('message');
      const sendEl = document.getElementById('send');
      const reloadEl = document.getElementById('reload');
      let refreshTimer = null;

      const savedSecret = window.localStorage.getItem(storageKey);
      if (savedSecret) {
        secretEl.value = savedSecret;
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function currentSecret() {
        const value = secretEl.value.trim();
        if (value) {
          window.localStorage.setItem(storageKey, value);
        } else {
          window.localStorage.removeItem(storageKey);
        }
        return value;
      }

      function requestHeaders() {
        const headers = { accept: 'application/json' };
        const secret = currentSecret();
        if (secret) {
          headers['x-a2a-edge-secret'] = secret;
        }
        return headers;
      }

      function setStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.style.color = isError ? '#ff9a9a' : '#cbd8eb';
      }

      function renderTimeline(items) {
        if (!Array.isArray(items) || items.length === 0) {
          timelineEl.innerHTML = '<div class="empty">아직 표시할 대화가 없습니다.</div>';
          return;
        }
        timelineEl.innerHTML = items.map((item) => {
          const author = item.author?.displayName || item.author?.id || 'unknown';
          const target = item.target?.displayName || item.target?.id || item.targetNodeId || 'unknown';
          const mine = item.author?.id === 'seoseo' ? ' mine' : '';
          const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : '';
          const metaParts = [
            '<span class="author">' + escapeHtml(author) + '</span>',
            when ? '<span>' + escapeHtml(when) + '</span>' : '',
            '<span>대상 ' + escapeHtml(target) + '</span>',
            item.decision ? '<span>decision ' + escapeHtml(item.decision) + '</span>' : '',
            '<span>status ' + escapeHtml(item.exchangeStatus) + '</span>',
          ].filter(Boolean).join('');
          const ids = [
            'exchange ' + item.exchangeId,
            'message ' + item.id,
            item.parentMessageId ? 'parent ' + item.parentMessageId : '',
            'root ' + item.rootMessageId,
            item.assignedWorkerId ? 'worker ' + item.assignedWorkerId : '',
          ].filter(Boolean).join(' · ');
          return '<article class="message' + mine + '">' +
            '<div class="meta">' + metaParts + '</div>' +
            '<div class="body">' + escapeHtml(item.body || '') + '</div>' +
            '<div class="ids">' + escapeHtml(ids) + '</div>' +
            '</article>';
        }).join('');
      }

      async function loadTimeline() {
        try {
          setStatus(config.requiresEdgeSecret && !secretEl.value.trim() ? 'Edge secret을 입력하면 API 호출이 됩니다.' : '불러오는 중...');
          const res = await fetch(config.apiPath, { headers: requestHeaders() });
          if (!res.ok) {
            const detail = await res.json().catch(() => null);
            throw new Error(detail?.error?.message || ('HTTP ' + res.status));
          }
          const body = await res.json();
          renderTimeline(body.items || []);
          setStatus('마지막 갱신 ' + new Date(body.generatedAt || Date.now()).toLocaleTimeString());
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), true);
          if (!timelineEl.innerHTML) {
            timelineEl.innerHTML = '<div class="empty">대화를 불러오지 못했습니다.</div>';
          }
        }
      }

      async function sendMessage(event) {
        event.preventDefault();
        const message = messageEl.value.trim();
        if (!message) {
          setStatus('메시지를 입력해 주세요.', true);
          return;
        }
        sendEl.disabled = true;
        try {
          setStatus('보내는 중...');
          const res = await fetch(config.apiPath, {
            method: 'POST',
            headers: {
              ...requestHeaders(),
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              target: targetEl.value,
              message,
            }),
          });
          if (!res.ok) {
            const detail = await res.json().catch(() => null);
            throw new Error(detail?.error?.message || ('HTTP ' + res.status));
          }
          const body = await res.json();
          messageEl.value = '';
          setStatus('전송 완료 (' + (body.deliveries?.length || 0) + '건)');
          await loadTimeline();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), true);
        } finally {
          sendEl.disabled = false;
        }
      }

      reloadEl.addEventListener('click', () => {
        void loadTimeline();
      });
      secretEl.addEventListener('change', () => {
        void loadTimeline();
      });
      document.getElementById('composer').addEventListener('submit', sendMessage);

      void loadTimeline();
      refreshTimer = window.setInterval(() => {
        void loadTimeline();
      }, 5000);
      window.addEventListener('beforeunload', () => {
        if (refreshTimer) {
          window.clearInterval(refreshTimer);
        }
      });
    </script>
  </body>
</html>`;
}

function findLatestOperatorExchange(
  broker: InMemoryA2ABroker,
  targetId: (typeof OPERATOR_CHAT_TARGETS)[number],
): A2AExchangeState | undefined {
  return broker
    .listExchanges()
    .find((exchange) => isOperatorChatExchange(exchange) && normalizePartyId(exchange.target.id) === targetId);
}

function isOperatorChatExchange(exchange: A2AExchangeState): boolean {
  if (exchange.intent !== "chat") {
    return false;
  }
  const partyIds = [exchange.requester.id, exchange.target.id].map(normalizePartyId);
  return partyIds.includes("seoseo") && partyIds.some((partyId) => isOperatorTargetId(partyId));
}

function mapTimelineItem(
  exchange: A2AExchangeState,
  message: A2AExchangeMessageRecord,
): OperatorChatTimelineItem {
  return {
    id: message.id,
    exchangeId: exchange.id,
    rootMessageId: exchange.rootMessageId,
    parentMessageId: message.parentMessageId,
    kind: message.kind,
    body: message.message,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    author: applyKnownA2APartyDisplayName(message.actor ?? message.requester ?? exchange.requester),
    target: decorateTarget(exchange.target),
    targetNodeId: message.targetNodeId ?? exchange.targetNodeId,
    assignedWorkerId: message.assignedWorkerId ?? exchange.assignedWorkerId,
    decision: message.decision,
    intent: exchange.intent,
    exchangeStatus: exchange.status,
  };
}

function targetParty(
  broker: InMemoryA2ABroker,
  targetId: (typeof OPERATOR_CHAT_TARGETS)[number],
): A2APartyRef {
  const alias = targetAlias(targetId);
  const worker = broker.getWorker(targetId) ?? (alias ? broker.getWorker(alias) : null);
  if (worker) {
    return {
      id: worker.nodeId,
      kind: "node",
      role: worker.role,
      displayName: worker.displayName,
    };
  }
  return {
    id: targetId,
    kind: "node",
    displayName: resolveKnownA2ADisplayName(targetId),
  };
}

function decorateTarget(target: A2APartyRef): A2APartyRef {
  const normalized = normalizePartyId(target.id);
  if (!isOperatorTargetId(normalized)) {
    return applyKnownA2APartyDisplayName(target);
  }
  return applyKnownA2APartyDisplayName({
    ...target,
    displayName: target.displayName ?? resolveKnownA2ADisplayName(normalized),
  });
}

function operatorParty(): A2APartyRef {
  return {
    id: "seoseo",
    kind: "user",
    role: "operator",
    displayName: resolveKnownA2ADisplayName("seoseo"),
  };
}

function operatorChatVia() {
  return {
    transport: "http",
    channel: "operator-chat",
  };
}

function normalizePartyId(value: string): (typeof OPERATOR_CHAT_TARGETS)[number] | "seoseo" | string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "dengae") {
    return "dungae";
  }
  return normalized;
}

function resolveRequestedTargets(
  value: OperatorChatTarget,
): (typeof OPERATOR_CHAT_TARGETS)[number][] {
  return value === "all" ? [...OPERATOR_CHAT_TARGETS] : [value];
}

function targetAlias(targetId: (typeof OPERATOR_CHAT_TARGETS)[number]): string | undefined {
  return targetId === "dungae" ? "dengae" : undefined;
}

function displayLabelForTarget(targetId: (typeof OPERATOR_CHAT_TARGETS)[number]): string {
  return resolveKnownA2ADisplayName(targetId) ?? targetId;
}

function isOperatorTargetId(value: string): value is (typeof OPERATOR_CHAT_TARGETS)[number] {
  return value === "bangtong" || value === "dungae";
}

function sortTimelineAscending(a: OperatorChatTimelineItem, b: OperatorChatTimelineItem): number {
  if (a.createdAt === b.createdAt) {
    return a.id.localeCompare(b.id);
  }
  return a.createdAt.localeCompare(b.createdAt);
}

function clampTimelineLimit(value: number | undefined): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value as number) : DEFAULT_TIMELINE_LIMIT;
  return Math.min(MAX_TIMELINE_LIMIT, Math.max(1, normalized));
}
