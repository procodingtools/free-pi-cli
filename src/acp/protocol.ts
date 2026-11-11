// Agent Client Protocol (ACP) over stdio: JSON-RPC 2.0 messages, one object
// per line (NDJSON) on stdin/stdout — the same framing pi's own RPC mode
// (runRpcMode) uses. Method names follow the Zed ACP spec; the protocol
// evolves, so verify against the current spec before extending this.
//
// Headless by construction: no TTY, no readline, no browser. Everything
// human-facing goes to stderr; stdout carries ONLY JSON-RPC frames.

export const ACP_PROTOCOL_VERSION = "0.1.0";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

/** JSON-RPC error codes + one application code for auth/consent gating. */
export const ACP_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** Server rejected the turn (429/quota envelope) or the session errored. */
  PROMPT_REJECTED: -32000,
  /** No usable credential / consent not current — sign in interactively first. */
  AUTH_REQUIRED: -32001,
} as const;

export function acpSuccess(id: string | number | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function acpError(id: string | number | null, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

export function acpNotify(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

/** Parse one NDJSON line into a request/notification. Returns undefined for blank lines. */
export function parseAcpLine(line: string): JsonRpcRequest | JsonRpcNotification | { parseError: string } | undefined {
  if (line.trim() === "") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { parseError: `invalid JSON: ${line.slice(0, 120)}` };
  }
  if (typeof raw !== "object" || raw === null) return { parseError: "message must be an object" };
  const msg = raw as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { parseError: "message must carry jsonrpc 2.0 + method" };
  return msg as unknown as JsonRpcRequest | JsonRpcNotification;
}

function hasId(msg: JsonRpcRequest | JsonRpcNotification): msg is JsonRpcRequest {
  return "id" in msg && (typeof msg.id === "string" || typeof msg.id === "number");
}

export function isAcpRequest(msg: JsonRpcRequest | JsonRpcNotification): msg is JsonRpcRequest {
  return hasId(msg);
}

// --- ACP method params / results (subset free-pi implements) ---

export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  [key: string]: unknown;
}

export interface AcpInitializeParams {
  protocolVersion?: string;
  clientCapabilities?: AcpClientCapabilities;
}

export interface AcpSessionNewParams {
  cwd?: string;
  defaultModel?: string;
  /** Explicit trust signal from the client for this folder's project resources. Absent/false = untrusted. */
  trusted?: boolean;
}

export interface AcpSessionLoadParams {
  sessionId: string;
  cwd?: string;
}

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: string;
}

export interface AcpSessionCancelParams {
  sessionId: string;
}

export interface AcpSessionSetModelParams {
  sessionId: string;
  modelId: string;
}

export function acpSessionUpdate(sessionId: string, update: Record<string, unknown>): string {
  return acpNotify("session/update", { sessionId, update });
}
