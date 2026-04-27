import type { A2AExchangeMessageRecord, A2AExchangeState } from "./types.js";

/**
 * Runtime seam for A2A exchange thread state.
 *
 * JSON/in-memory deployments continue to use the broker maps and canonical
 * snapshot saves. SQLite deployments can bind this interface to the
 * broker_exchanges hot table so exchange lifecycle reads and writes have a
 * table-native path while snapshots remain export-compatible.
 */
export interface ExchangeRuntimeRepository {
  getExchange(id: string): A2AExchangeState | null;
  listExchanges(): A2AExchangeState[];
  upsertExchange(exchange: A2AExchangeState): void;
}

/**
 * Runtime seam for A2A exchange message state.
 *
 * SQLite deployments can bind this interface to broker_exchange_messages so
 * threaded message reads/writes do not depend on snapshot hot-write hints.
 */
export interface ExchangeMessageRuntimeRepository {
  getExchangeMessage(id: string): A2AExchangeMessageRecord | null;
  listExchangeMessages(exchangeId: string): A2AExchangeMessageRecord[];
  upsertExchangeMessage(message: A2AExchangeMessageRecord): void;
}
