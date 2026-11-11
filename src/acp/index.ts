// Headless ACP (Agent Client Protocol) server.
//
// One process, many sessions: each `session/new` / `session/load` builds a
// full agent runtime through buildAgentRuntime() — the SAME helper the TUI
// uses — so extensions, tools, model lock, system prompt and skills are
// identical. The only differences from the TUI path are deliberate and
// documented below:
//
// - No InteractiveMode: prompts run via the headless AgentSession.prompt().
// - No TTY/readline/browser anywhere: trust defaults to UNTRUSTED unless the
//   client sends `trusted: true` (a cloned repo must not get code execution
//   by default — same threat model as project-trust.ts).
// - Ads: the Gravity pixel still runs (consent-gated, server-funded inference
//   depends on it) but banner/inline rendering is skipped — there is no
//   terminal to render into, and the ads extension's UI hooks are no-ops
//   without a TUI.
// - Buy flow: free_pi_buy_credits already returns the URL as tool-result text
//   (for SSH sessions with no browser) — in ACP mode the client opens it.
// - fs/read_text_file, fs/write_text_file, terminal/* client capabilities are
//   recorded but never required: all file/bash execution flows through the
//   allowlisted local read/bash/edit/write tools and the tool-guard, exactly
//   as in the TUI. The client caps only describe what the CLIENT offers; this
//   agent never calls back into them.
// - session/set_model accepts ONLY catalog ids (the model-lock invariant);
//   arbitrary model ids are rejected. When the SDK offers no model-switch API
//   the call would fail — but AgentSession.setModel exists, so it works.
//
// stdout carries ONLY JSON-RPC frames. Everything else goes to `log`
// (stderr in production).
import { createInterface } from "node:readline";
import {
  hasTrustRequiringProjectResources,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  buildAgentRuntime,
  catalogModelsFor,
  createSessionManager,
  getSessionDir,
  restoreResumeLinePatch,
  type AgentRuntimeHandles,
  type LaunchOptions,
} from "../pi-launch";
import { PROVIDER_NAME, type CatalogModel } from "../provider";
import { FUSION_PICKER_ID } from "../fusion";
import { fetchUsageText } from "../usage-tool";
import { formatLimitEnvelope, parseErrorEnvelope } from "../error-notice";
import { SLOW_LANE_METER_LINE } from "@freepi/shared";
import {
  ACP_ERROR,
  acpError,
  acpSessionUpdate,
  acpSuccess,
  isAcpRequest,
  parseAcpLine,
  type AcpClientCapabilities,
  type AcpSessionLoadParams,
  type AcpSessionNewParams,
  type AcpSessionPromptParams,
  type AcpSessionSetModelParams,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./protocol";

export interface AcpServerOptions {
  baseUrl: string;
  jwt: string;
  agentDir: string;
  model?: string;
  models?: CatalogModel[];
  fusion?: { planner: string; executor: string };
  updateLatest?: string;
  getGravityContext?: () => string | undefined;
  /** Working directory for new sessions. Defaults to process.cwd(). */
  cwd?: string;
  /** Human-facing log — wire to stderr, never stdout. */
  log: (message: string) => void;
  /** Emitted session/update frames — wire to stdout in production. */
  notify: (frame: string) => void;
  /** Test seam for the /me/stats usage fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: replaces buildAgentRuntime. Must use identical wiring in prod. */
  buildRuntime?: (
    opts: LaunchOptions,
    cwd: string,
    sm: SessionManager,
    projectTrusted: boolean,
  ) => Promise<AgentRuntimeHandles>;
}

interface AcpSessionEntry {
  handles: AgentRuntimeHandles;
  trusted: boolean;
  promptInFlight: boolean;
}

/** Thrown inside handlers to produce a JSON-RPC error response. */
export class AcpHandlerError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function stringParam(params: Record<string, unknown> | undefined, name: string): string | undefined {
  const v = params?.[name];
  return typeof v === "string" ? v : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort text delta from a message_update event (SDK shape varies). */
function textDeltaOf(event: AgentSessionEvent): string | undefined {
  const e = (event as unknown as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
  if (!e || typeof e !== "object") return undefined;
  if (typeof e.delta === "string" && e.delta !== "") return e.delta;
  if (typeof e.text === "string" && e.text !== "") return e.text;
  return undefined;
}

/** Full text of a finished assistant message (fallback when no deltas arrived). */
function fullTextOf(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string" && content !== "") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string")
      .map((c) => c.text);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  return undefined;
}

function toolIdentity(event: AgentSessionEvent): { id: string; name: string } {
  const e = event as unknown as Record<string, unknown>;
  const name =
    (typeof e.toolName === "string" && e.toolName) ||
    (typeof e.name === "string" && e.name) ||
    "tool";
  const id =
    (typeof e.toolCallId === "string" && e.toolCallId) ||
    (typeof e.id === "string" && e.id) ||
    `${name}-${Date.now()}`;
  return { id, name };
}

/** Context-overflow wording varies by provider; map it to a recovery hint, never a crash. */
function isOverflowMessage(text: string): boolean {
  return /context|overflow|too many tokens|maximum context|context length|out of context/i.test(text);
}

export class AcpServer {
  private readonly opts: AcpServerOptions;
  private readonly sessions = new Map<string, AcpSessionEntry>();
  private clientCapabilities: AcpClientCapabilities = {};
  private readonly rootCwd: string;

  constructor(opts: AcpServerOptions) {
    this.opts = opts;
    this.rootCwd = opts.cwd ?? process.cwd();
  }

  private launchOpts(): LaunchOptions {
    return {
      baseUrl: this.opts.baseUrl,
      jwt: this.opts.jwt,
      agentDir: this.opts.agentDir,
      model: this.opts.model,
      models: this.opts.models,
      fusion: this.opts.fusion,
      updateLatest: this.opts.updateLatest,
      getGravityContext: this.opts.getGravityContext,
    };
  }

  /** Catalog ids the model lock allows — session/set_model rejects anything else. */
  private allowedModelIds(): string[] {
    return [FUSION_PICKER_ID, ...catalogModelsFor(this.launchOpts()).map((m) => m.id)];
  }

  private resolveCwd(params: Record<string, unknown> | undefined): string {
    const cwd = stringParam(params, "cwd");
    return cwd && cwd.trim() !== "" ? cwd : this.rootCwd;
  }

  private getEntry(sessionId: string): AcpSessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, `unknown session '${sessionId}'`);
    return entry;
  }

  private update(sessionId: string, update: Record<string, unknown>): void {
    this.opts.notify(acpSessionUpdate(sessionId, update));
  }

  // --- method handlers (each returns the JSON-RPC result) ---

  private handleInitialize(params: Record<string, unknown> | undefined): unknown {
    const caps = (params?.clientCapabilities ?? params?.capabilities) as AcpClientCapabilities | undefined;
    if (caps && typeof caps === "object") this.clientCapabilities = caps;
    void this.clientCapabilities;
    return {
      protocolVersion: "0.1.0",
      agentCapabilities: {
        // What this server implements; method names follow the Zed ACP draft.
        sessionCapabilities: { new: true, load: true, list: true, cancel: true, setModel: true, usage: true },
        promptCapabilities: { text: true, images: false },
        // User-added MCP servers load through pi-mcp exactly as in the TUI.
        mcpCapabilities: { tools: true },
      },
    };
  }

  private async handleSessionNew(params: Record<string, unknown> | undefined): Promise<unknown> {
    const p = (params ?? {}) as AcpSessionNewParams;
    const cwd = typeof p.cwd === "string" && p.cwd.trim() !== "" ? p.cwd : this.rootCwd;
    // Trust: explicit client signal wins; otherwise only folders with nothing
    // to protect are trusted (same rule as decideProjectTrust, minus the TUI
    // prompt — headless clients cannot answer one).
    const trusted = p.trusted === true || !hasTrustRequiringProjectResources(cwd);
    const launchOpts = this.launchOpts();
    if (typeof p.defaultModel === "string" && p.defaultModel !== "") {
      if (!this.allowedModelIds().includes(p.defaultModel)) {
        throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, `unknown model '${p.defaultModel}' (model lock: only the free-pi catalog is selectable)`);
      }
      const models = catalogModelsFor(launchOpts);
      const chosen = models.find((m) => m.id === p.defaultModel) ?? { id: p.defaultModel, name: p.defaultModel };
      launchOpts.models = [chosen, ...models.filter((m) => m.id !== chosen.id)];
    }
    const sessionDir = getSessionDir(cwd, this.opts.agentDir);
    const sm = await SessionManager.create(cwd, sessionDir);
    const build = this.opts.buildRuntime ?? buildAgentRuntime;
    const handles = await build(launchOpts, cwd, sm, trusted);
    this.sessions.set(handles.sessionId, { handles, trusted, promptInFlight: false });
    return { sessionId: handles.sessionId };
  }

  private async handleSessionLoad(params: Record<string, unknown> | undefined): Promise<unknown> {
    const p = (params ?? {}) as unknown as AcpSessionLoadParams;
    if (typeof p.sessionId !== "string" || p.sessionId === "") {
      throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, "session/load needs a sessionId");
    }
    const cwd = typeof p.cwd === "string" && p.cwd.trim() !== "" ? p.cwd : this.rootCwd;
    const sessionDir = getSessionDir(cwd, this.opts.agentDir);
    let sm: SessionManager;
    try {
      // Reuses the TUI resume logic, including the "No session found" error.
      sm = await createSessionManager(cwd, sessionDir, p.sessionId);
    } catch (err) {
      throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, errorText(err));
    }
    const trusted = !hasTrustRequiringProjectResources(cwd);
    const build = this.opts.buildRuntime ?? buildAgentRuntime;
    const handles = await build(this.launchOpts(), cwd, sm, trusted);
    this.sessions.set(handles.sessionId, { handles, trusted, promptInFlight: false });
    return { sessionId: handles.sessionId };
  }

  private async handleSessionList(params: Record<string, unknown> | undefined): Promise<unknown> {
    const cwd = this.resolveCwd(params);
    const infos = await SessionManager.list(cwd, getSessionDir(cwd, this.opts.agentDir));
    return { sessions: infos.map((i) => ({ sessionId: i.id })) };
  }

  private async handleSessionPrompt(params: Record<string, unknown> | undefined): Promise<unknown> {
    const p = (params ?? {}) as unknown as AcpSessionPromptParams;
    if (typeof p.sessionId !== "string" || typeof p.prompt !== "string") {
      throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, "session/prompt needs sessionId + prompt");
    }
    const entry = this.getEntry(p.sessionId);
    if (entry.promptInFlight) {
      throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, "a prompt is already in flight for this session; cancel it first");
    }
    const session: AgentSession = entry.handles.runtime.session;
    entry.promptInFlight = true;
    let lastTurnError: string | undefined;
    let deltasForMessage = 0;
    let aborted = false;
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      try {
        this.forwardEvent(p.sessionId, event, {
          onTurnError: (text) => {
            lastTurnError = text;
          },
          onAborted: () => {
            aborted = true;
          },
          trackDelta: (n) => {
            deltasForMessage += n;
          },
          deltasForMessage: () => deltasForMessage,
          resetDeltas: () => {
            deltasForMessage = 0;
          },
        });
      } catch {
        // Event forwarding must never break the turn.
      }
    });
    try {
      await session.prompt(p.prompt);
    } catch (err) {
      const text = errorText(err);
      if (aborted || /abort|cancel/i.test(text)) return { stopReason: "cancelled" };
      const envelope = parseErrorEnvelope(extractEnvelopeText(text) ?? text);
      if (envelope) {
        throw new AcpHandlerError(
          ACP_ERROR.PROMPT_REJECTED,
          `${formatLimitEnvelope(envelope)}\nBuy more credits with /buy-credits in free-pi-cli (the free_pi_buy_credits tool also returns the buy page URL).`,
          { code: envelope.code, status: envelope.status },
        );
      }
      if (isOverflowMessage(text)) {
        throw new AcpHandlerError(ACP_ERROR.PROMPT_REJECTED, `${text}\nThe session ran out of context. Start a new session (session/new) to continue.`);
      }
      throw new AcpHandlerError(ACP_ERROR.PROMPT_REJECTED, text);
    } finally {
      unsubscribe();
      entry.promptInFlight = false;
    }
    if (lastTurnError !== undefined) {
      const envelope = parseErrorEnvelope(lastTurnError);
      if (envelope) {
        throw new AcpHandlerError(
          ACP_ERROR.PROMPT_REJECTED,
          `${formatLimitEnvelope(envelope)}\nBuy more credits with /buy-credits in free-pi-cli (the free_pi_buy_credits tool also returns the buy page URL).`,
          { code: envelope.code, status: envelope.status },
        );
      }
      if (isOverflowMessage(lastTurnError)) {
        throw new AcpHandlerError(ACP_ERROR.PROMPT_REJECTED, `${lastTurnError}\nThe session ran out of context. Start a new session (session/new) to continue.`);
      }
    }
    // Best-effort usage notice (same warning semantics as the TUI footer):
    // slow lane or nearly-spent allowance surfaces as a session/update notice.
    await this.maybeEmitUsageNotice(p.sessionId);
    return { stopReason: aborted ? "cancelled" : "end_turn" };
  }

  private async handleSessionCancel(params: Record<string, unknown> | undefined): Promise<unknown> {
    const sessionId = stringParam(params, "sessionId");
    if (!sessionId) throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, "session/cancel needs a sessionId");
    const entry = this.getEntry(sessionId);
    await entry.handles.runtime.session.abort();
    return {};
  }

  private async handleSessionSetModel(params: Record<string, unknown> | undefined): Promise<unknown> {
    const p = (params ?? {}) as unknown as AcpSessionSetModelParams;
    if (typeof p.sessionId !== "string" || typeof p.modelId !== "string") {
      throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, "session/set_model needs sessionId + modelId");
    }
    const entry = this.getEntry(p.sessionId);
    const session: AgentSession = entry.handles.runtime.session;
    // Prefer the live scope, fall back to the catalog (fail-open env opt-out).
    const scopedIds = session.scopedModels
      .map((s) => (s?.model as { id?: unknown } | undefined)?.id)
      .filter((id): id is string => typeof id === "string");
    const allowed = scopedIds.length > 0 ? scopedIds : this.allowedModelIds();
    if (!allowed.includes(p.modelId)) {
      throw new AcpHandlerError(ACP_ERROR.INVALID_PARAMS, `unknown model '${p.modelId}' (model lock: only the free-pi catalog is selectable)`);
    }
    const model = entry.handles.runtime.services.modelRuntime.getModel(PROVIDER_NAME, p.modelId);
    if (!model) throw new AcpHandlerError(ACP_ERROR.INTERNAL, `model '${p.modelId}' is not registered`);
    await session.setModel(model);
    return {};
  }

  private async handleUsage(): Promise<unknown> {
    const r = await fetchUsageText({ baseUrl: this.opts.baseUrl, getToken: () => this.opts.jwt, fetchImpl: this.opts.fetchImpl });
    if (!r.ok) throw new AcpHandlerError(ACP_ERROR.INTERNAL, r.text);
    return { text: r.text };
  }

  /** Dispatch one parsed message; returns the response frame, or null for notifications. */
  async dispatch(msg: JsonRpcRequest | JsonRpcNotification): Promise<string | null> {
    if (!isAcpRequest(msg)) {
      // Notification from the client (e.g. cancelled). Nothing to answer.
      if (msg.method === "session/cancel" && typeof msg.params === "object" && msg.params !== null) {
        try {
          await this.handleSessionCancel(msg.params as Record<string, unknown>);
        } catch {
          // Notifications carry no error channel.
        }
      }
      return null;
    }
    const params = (msg.params ?? {}) as Record<string, unknown>;
    try {
      let result: unknown;
      switch (msg.method) {
        case "initialize":
          result = this.handleInitialize(params);
          break;
        case "session/new":
          result = await this.handleSessionNew(params);
          break;
        case "session/load":
          result = await this.handleSessionLoad(params);
          break;
        case "session/list":
          result = await this.handleSessionList(params);
          break;
        case "session/prompt":
          result = await this.handleSessionPrompt(params);
          break;
        case "session/cancel":
          result = await this.handleSessionCancel(params);
          break;
        case "session/set_model":
          result = await this.handleSessionSetModel(params);
          break;
        case "usage":
          result = await this.handleUsage();
          break;
        default:
          return acpError(msg.id, ACP_ERROR.METHOD_NOT_FOUND, `unknown method '${msg.method}'`);
      }
      return acpSuccess(msg.id, result);
    } catch (err) {
      if (err instanceof AcpHandlerError) return acpError(msg.id, err.code, err.message, err.data);
      return acpError(msg.id, ACP_ERROR.INTERNAL, errorText(err));
    }
  }

  /**
   * Serve NDJSON JSON-RPC on input/output until EOF. stdout (output) carries
   * ONLY protocol frames — the resume-line patch from pi-launch.ts is
   * restored first so pi's exit path can never write branding bytes here.
   */
  async serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
    restoreResumeLinePatch();
    const rl = createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      const parsed = parseAcpLine(line);
      if (parsed === undefined) continue;
      if ("parseError" in parsed) {
        output.write(`${acpError(null, ACP_ERROR.PARSE, parsed.parseError)}\n`);
        continue;
      }
      const frame = await this.dispatch(parsed);
      if (frame !== null) output.write(`${frame}\n`);
    }
    await this.dispose();
  }

  async dispose(): Promise<void> {
    for (const [, entry] of this.sessions) {
      try {
        await entry.handles.runtime.dispose();
      } catch {
        // Best-effort teardown.
      }
    }
    this.sessions.clear();
  }

  // --- internals ---

  private forwardEvent(
    sessionId: string,
    event: AgentSessionEvent,
    hooks: {
      onTurnError: (text: string) => void;
      onAborted: () => void;
      trackDelta: (n: number) => void;
      deltasForMessage: () => number;
      resetDeltas: () => void;
    },
  ): void {
    switch (event.type) {
      case "message_start":
        hooks.resetDeltas();
        break;
      case "message_update": {
        const delta = textDeltaOf(event);
        if (delta !== undefined) {
          hooks.trackDelta(1);
          this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } });
        }
        break;
      }
      case "message_end": {
        if (hooks.deltasForMessage() === 0) {
          const text = fullTextOf((event as unknown as { message?: unknown }).message);
          if (text !== undefined) {
            this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
          }
        }
        break;
      }
      case "tool_execution_start": {
        const { id, name } = toolIdentity(event);
        this.update(sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: name, kind: toolKindFor(name), status: "in_progress" });
        break;
      }
      case "tool_execution_update": {
        const { id } = toolIdentity(event);
        this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
        break;
      }
      case "tool_execution_end": {
        const { id, name } = toolIdentity(event);
        const update: Record<string, unknown> = { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" };
        const resultText = toolResultText(event);
        if (resultText !== undefined) update.content = { type: "text", text: resultText };
        this.update(sessionId, update);
        // The todo tool persists the plan per session — surface it as a plan update.
        if (name === "todo" && resultText !== undefined) {
          this.update(sessionId, { sessionUpdate: "plan", entries: [{ content: resultText, status: "completed" }] });
        }
        break;
      }
      case "compaction_start": {
        const reason = (event as unknown as { reason?: unknown }).reason;
        this.update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `\n[compacting context${typeof reason === "string" ? `: ${reason}` : ""}…]\n` },
        });
        break;
      }
      case "compaction_end": {
        const err = (event as unknown as { errorMessage?: unknown }).errorMessage;
        this.update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: typeof err === "string" && err !== "" ? `\n[compaction failed: ${err}]\n` : "\n[context compacted]\n" },
        });
        break;
      }
      case "turn_end": {
        const message = (event as unknown as { message?: { stopReason?: unknown; errorMessage?: unknown } }).message;
        if (message?.stopReason === "error" && typeof message.errorMessage === "string") {
          hooks.onTurnError(message.errorMessage);
        }
        break;
      }
      case "agent_settled": {
        if ((event as unknown as { aborted?: unknown }).aborted === true) hooks.onAborted();
        break;
      }
      default:
        break;
    }
  }

  private async maybeEmitUsageNotice(sessionId: string): Promise<void> {
    try {
      const r = await fetchUsageText({ baseUrl: this.opts.baseUrl, getToken: () => this.opts.jwt, fetchImpl: this.opts.fetchImpl });
      if (!r.ok) return;
      const stats = r.stats as unknown as Record<string, unknown>;
      if (stats.lane === "fallback") {
        this.update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n${SLOW_LANE_METER_LINE}\n` } });
        return;
      }
      const remaining = stats.remaining_credits_today;
      const allowance = stats.allowance_credits;
      if (typeof remaining === "number" && typeof allowance === "number" && allowance > 0 && remaining / allowance <= 0.1) {
        this.update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `\nOnly ${Math.max(0, Math.round((remaining / allowance) * 100))}% of today's allowance left.\n` },
        });
        return;
      }
    } catch {
      // Usage is informational; never break the session for it.
    }
  }
}

function toolKindFor(name: string): string {
  if (name === "read" || name === "write" || name === "edit") return "read";
  if (name === "bash") return "execute";
  if (name === "grep" || name === "find" || name === "ls") return "search";
  return "other";
}

function toolResultText(event: AgentSessionEvent): string | undefined {
  const e = event as unknown as Record<string, unknown>;
  const result = e.result as { content?: unknown } | string | undefined;
  if (typeof result === "string" && result !== "") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text")
        .map((c) => (c as { text?: unknown }).text)
        .filter((t): t is string => typeof t === "string");
      if (parts.length > 0) return parts.join("");
    }
  }
  return undefined;
}

/** pi wraps the server envelope as "<status>: {json}" — unwrap raw text that isn't already that shape. */
function extractEnvelopeText(text: string): string | undefined {
  const m = /(\d{3}): (\{[\s\S]*\})\s*$/.exec(text);
  return m ? `${m[1]}: ${m[2]}` : undefined;
}
