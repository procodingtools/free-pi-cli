// ACP (Agent Client Protocol) tests: dispatch, headless gating, protocol
// framing, and an integration run through the REAL production wiring
// (buildAgentRuntime) against a stub upstream — mirroring no-subagents SB2.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HELP_TEXT, parseCliArgs } from "../src/cli-args";
import { runFreePiAcp } from "../src/acp-command";
import { AcpServer } from "../src/acp/index";
import { ACP_ERROR, acpError, acpSuccess, parseAcpLine } from "../src/acp/protocol";
import { saveJwt } from "../src/credentials";
import { ALLOWED_TOOL_NAMES, buildAgentRuntime, type AgentRuntimeHandles } from "../src/pi-launch";
import { MODEL_ID } from "../src/provider";

function tempDir(prefix = "free-pi-acp-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function endedInput(): PassThrough {
  const pt = new PassThrough();
  pt.end();
  return pt;
}

function collectOutput(): { chunks: string[]; stream: PassThrough } {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on("data", (d) => chunks.push(String(d)));
  return { chunks, stream };
}

describe("acp cli dispatch", () => {
  test("acp -> { kind: acp }", () => {
    expect(parseCliArgs(["acp"])).toEqual({ kind: "acp" });
  });

  test("trailing args after acp -> unknown (never silently start a session)", () => {
    expect(parseCliArgs(["acp", "--help"])).toEqual({ kind: "unknown", arg: "--help" });
  });

  test("HELP_TEXT lists the acp command", () => {
    expect(HELP_TEXT).toContain("free-pi-cli acp");
  });
});

describe("acp protocol framing", () => {
  test("parses a request line", () => {
    const parsed = parseAcpLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  });

  test("blank lines are skipped", () => {
    expect(parseAcpLine("   \n")).toBeUndefined();
  });

  test("invalid JSON becomes a parse error, not a throw", () => {
    const parsed = parseAcpLine("not json");
    expect(parsed).toEqual({ parseError: expect.stringContaining("invalid JSON") });
  });

  test("success/error frames round-trip as JSON-RPC", () => {
    expect(JSON.parse(acpSuccess(1, { a: 1 }))).toEqual({ jsonrpc: "2.0", id: 1, result: { a: 1 } });
    expect(JSON.parse(acpError(2, ACP_ERROR.METHOD_NOT_FOUND, "nope"))).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "nope" },
    });
  });
});

describe("runFreePiAcp headless gate", () => {
  test("no JWT exits non-zero with a sign-in message; stdout stays protocol-clean", async () => {
    const dir = tempDir();
    const stderr: string[] = [];
    const frames: string[] = [];
    const out = collectOutput();
    const code = await runFreePiAcp({
      baseUrl: "http://127.0.0.1:1",
      agentDir: dir,
      credentialsPath: join(dir, "credentials.json"),
      log: (m) => stderr.push(m),
      notify: (f) => frames.push(f),
      input: endedInput(),
      output: out.stream,
      checkClientVersion: async () => {
        throw new Error("must not check version without consent");
      },
    });
    expect(code).not.toBe(0);
    expect(stderr.join("\n")).toMatch(/sign in|free-pi-cli/);
    expect(frames).toHaveLength(0);
    expect(out.chunks.join("")).toBe("");
  });

  test("expired JWT (401) exits non-zero telling the user to sign in interactively", async () => {
    const dir = tempDir();
    const credentialsPath = join(dir, "credentials.json");
    await saveJwt(credentialsPath, "stale-jwt");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/me") return new Response(null, { status: 401 });
        return new Response("not found", { status: 404 });
      },
    });
    const stderr: string[] = [];
    try {
      const code = await runFreePiAcp({
        baseUrl: `http://localhost:${server.port}`,
        agentDir: dir,
        credentialsPath,
        log: (m) => stderr.push(m),
        notify: () => {},
        input: endedInput(),
        checkClientVersion: async () => ({ action: "ok" }),
      });
      expect(code).not.toBe(0);
      expect(stderr.join("\n")).toMatch(/sign in/);
    } finally {
      server.stop(true);
    }
  });

  test("valid JWT + EOF stdin exits 0 with no stdout bytes (gate is protocol-clean)", async () => {
    const dir = tempDir();
    const credentialsPath = join(dir, "credentials.json");
    await saveJwt(credentialsPath, "good-jwt");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/me") return Response.json({ user_id: "u1", consent_version: "4" });
        if (url.pathname === "/client-version") return Response.json({ min: "0.0.1", latest: "0.0.1" });
        return new Response("not found", { status: 404 });
      },
    });
    const stderr: string[] = [];
    const frames: string[] = [];
    const out = collectOutput();
    try {
      const code = await runFreePiAcp({
        baseUrl: `http://localhost:${server.port}`,
        agentDir: dir,
        credentialsPath,
        log: (m) => stderr.push(m),
        notify: (f) => frames.push(f),
        input: endedInput(),
        output: out.stream,
      });
      expect(code).toBe(0);
      expect(out.chunks.join("")).toBe("");
      expect(frames).toHaveLength(0);
      void stderr;
    } finally {
      server.stop(true);
    }
  });
});

// --- fake runtime for dispatch unit tests (same seam shape, no SDK) ---

interface FakeSessionState {
  prompts: string[];
  aborted: boolean;
  modelSet: unknown;
  listeners: Set<(e: never) => void>;
}

function fakeBuildRuntime(state: FakeSessionState) {
  return async (): Promise<AgentRuntimeHandles> => {
    const session = {
      subscribe: (fn: (e: never) => void) => {
        state.listeners.add(fn);
        return () => {
          state.listeners.delete(fn);
        };
      },
      prompt: async (text: string) => {
        state.prompts.push(text);
        const emit = (e: never) => {
          for (const fn of state.listeners) fn(e);
        };
        emit({ type: "message_start" } as never);
        emit({ type: "message_update", assistantMessageEvent: { delta: "hello " } } as never);
        emit({ type: "message_update", assistantMessageEvent: { delta: "world" } } as never);
        emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" } as never);
        emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "file!" } as never);
        emit({ type: "message_end", message: { content: "hello world" } } as never);
        emit({ type: "agent_settled", aborted: false } as never);
      },
      abort: async () => {
        state.aborted = true;
      },
      scopedModels: [{ model: { id: MODEL_ID } }],
      setModel: async (m: unknown) => {
        state.modelSet = m;
      },
    };
    const sm = SessionManager.inMemory(tempDir("free-pi-acp-fake-cwd-"));
    return {
      runtime: { session, services: { modelRuntime: { getModel: (_p: string, id: string) => ({ id }) } }, dispose: async () => {} } as unknown as AgentRuntimeHandles["runtime"],
      sessionManager: sm,
      sessionId: sm.getSessionId(),
    };
  };
}

function testServer(opts: { state?: FakeSessionState; agentDir?: string } = {}): { server: AcpServer; frames: string[]; state: FakeSessionState } {
  const state: FakeSessionState = opts.state ?? { prompts: [], aborted: false, modelSet: undefined, listeners: new Set() };
  const frames: string[] = [];
  const server = new AcpServer({
    baseUrl: "http://127.0.0.1:1",
    jwt: "test-jwt",
    agentDir: opts.agentDir ?? tempDir("free-pi-acp-agent-"),
    log: () => {},
    notify: (f) => frames.push(f),
    buildRuntime: fakeBuildRuntime(state),
    fetchImpl: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
  });
  return { server, frames, state };
}

async function call(server: AcpServer, id: number, method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const frame = await server.dispatch({ jsonrpc: "2.0", id, method, params });
  expect(frame).not.toBeNull();
  const body = JSON.parse(frame!) as Record<string, unknown>;
  return { ok: "result" in body, body };
}

describe("AcpServer dispatch (fake runtime)", () => {
  test("initialize returns agent capabilities", async () => {
    const { server } = testServer();
    const { ok, body } = await call(server, 1, "initialize", { clientCapabilities: { terminal: true } });
    expect(ok).toBe(true);
    expect((body.result as Record<string, unknown>).protocolVersion).toBe("0.1.0");
  });

  test("unknown method -> METHOD_NOT_FOUND", async () => {
    const { server } = testServer();
    const { ok, body } = await call(server, 1, "nope/method");
    expect(ok).toBe(false);
    expect((body.error as { code: number }).code).toBe(ACP_ERROR.METHOD_NOT_FOUND);
  });

  test("session/new + session/prompt streams session/update frames", async () => {
    const { server, frames, state } = testServer();
    const created = await call(server, 1, "session/new", {});
    expect(created.ok).toBe(true);
    const sessionId = (created.body.result as { sessionId: string }).sessionId;
    expect(typeof sessionId).toBe("string");

    const prompted = await call(server, 2, "session/prompt", { sessionId, prompt: "hi" });
    expect(prompted.ok).toBe(true);
    expect(prompted.body.result).toEqual({ stopReason: "end_turn" });
    expect(state.prompts).toEqual(["hi"]);

    const updates = frames.map((f) => JSON.parse(f));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.jsonrpc).toBe("2.0");
      expect(u.method).toBe("session/update");
      expect(u.params.sessionId).toBe(sessionId);
    }
    const kinds = updates.map((u) => u.params.update.sessionUpdate);
    expect(kinds).toContain("agent_message_chunk");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
    const text = updates
      .filter((u) => u.params.update.sessionUpdate === "agent_message_chunk")
      .map((u) => u.params.update.content.text)
      .join("");
    expect(text).toContain("hello world");
  });

  test("session/prompt on an unknown session is an error, not a crash", async () => {
    const { server } = testServer();
    const { ok, body } = await call(server, 1, "session/prompt", { sessionId: "nope", prompt: "hi" });
    expect(ok).toBe(false);
    expect((body.error as { code: number }).code).toBe(ACP_ERROR.INVALID_PARAMS);
  });

  test("session/set_model rejects ids outside the catalog (model lock)", async () => {
    const { server } = testServer();
    const created = await call(server, 1, "session/new", {});
    const sessionId = (created.body.result as { sessionId: string }).sessionId;
    const bad = await call(server, 2, "session/set_model", { sessionId, modelId: "openai/gpt-99" });
    expect(bad.ok).toBe(false);
    expect((bad.body.error as { message: string }).message).toMatch(/model lock/);
  });

  test("session/set_model accepts a catalog id", async () => {
    const { server, state } = testServer();
    const created = await call(server, 1, "session/new", {});
    const sessionId = (created.body.result as { sessionId: string }).sessionId;
    const good = await call(server, 2, "session/set_model", { sessionId, modelId: MODEL_ID });
    expect(good.ok).toBe(true);
    expect(state.modelSet).toEqual({ id: MODEL_ID });
  });

  test("session/cancel aborts the session", async () => {
    const { server, state } = testServer();
    const created = await call(server, 1, "session/new", {});
    const sessionId = (created.body.result as { sessionId: string }).sessionId;
    const cancelled = await call(server, 2, "session/cancel", { sessionId });
    expect(cancelled.ok).toBe(true);
    expect(state.aborted).toBe(true);
  });

  test("session/load with an unknown id reuses the resume error", async () => {
    const { server } = testServer();
    const { ok, body } = await call(server, 1, "session/load", { sessionId: "missing" });
    expect(ok).toBe(false);
    expect((body.error as { message: string }).message).toMatch(/No session found/);
  });

  test("session/list returns session ids", async () => {
    const { server } = testServer();
    const { ok, body } = await call(server, 1, "session/list", {});
    expect(ok).toBe(true);
    expect(Array.isArray((body.result as { sessions: unknown[] }).sessions)).toBe(true);
  });

  test("usage answers from /me/stats via the shared fetcher", async () => {
    const frames: string[] = [];
    const server = new AcpServer({
      baseUrl: "http://127.0.0.1:1",
      jwt: "test-jwt",
      agentDir: tempDir("free-pi-acp-agent-"),
      log: () => {},
      notify: (f) => frames.push(f),
      buildRuntime: fakeBuildRuntime({ prompts: [], aborted: false, modelSet: undefined, listeners: new Set() }),
      fetchImpl: (async () =>
        Response.json({
          tier: "free",
          spent_usd_today: 1,
          cap_usd_today: 10,
          prompt_tokens_today: 5,
          completion_tokens_today: 6,
          lifetime: { prompt_tokens: 5, completion_tokens: 6 },
        })) as unknown as typeof fetch,
    });
    const { ok, body } = await call(server, 1, "usage", {});
    expect(ok).toBe(true);
    expect(((body.result as { text: string }).text ?? "")).toContain("tier: free");
  });
});

// --- integration: real production wiring through the ACP transport ---

function sseFrame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function toolCallSse(): string {
  const start = {
    id: "resp-1",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [
            { index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf ok" }) } },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const end = {
    id: "resp-1",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

function finalTextSse(): string {
  const start = {
    id: "resp-2",
    object: "chat.completion.chunk",
    created: 2,
    model: MODEL_ID,
    choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
  };
  const end = {
    id: "resp-2",
    object: "chat.completion.chunk",
    created: 2,
    model: MODEL_ID,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

describe("acp integration: real runtime + stub upstream through the ACP transport", () => {
  test("session/prompt emits update frames and only allowlisted tools run", async () => {
    const toolNamesSeen = new Set<string>();
    let callCount = 0;
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        const body = (await req.json()) as { messages?: Array<Record<string, unknown>> };
        for (const msg of body.messages ?? []) {
          const toolCalls = msg.tool_calls as Array<{ function?: { name?: string } }> | undefined;
          for (const tc of toolCalls ?? []) {
            if (tc.function?.name) toolNamesSeen.add(tc.function.name);
          }
        }
        const isFirstCall = callCount === 0;
        callCount++;
        return new Response(isFirstCall ? toolCallSse() : finalTextSse(), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const frames: string[] = [];
    try {
      const baseUrl = stub.url.toString().replace(/\/$/, "");
      const agentDir = tempDir("free-pi-acp-int-agent-");
      const cwd = tempDir("free-pi-acp-int-cwd-");
      const server = new AcpServer({
        baseUrl,
        jwt: "test-jwt",
        agentDir,
        cwd,
        log: () => {},
        notify: (f) => frames.push(f),
        // The REAL production runtime builder — not a fake.
        buildRuntime: (opts, rtCwd, sm, trusted) => buildAgentRuntime(opts, rtCwd, sm, trusted),
        fetchImpl: (async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
      });
      const created = await server.dispatch({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } });
      const createdBody = JSON.parse(created!) as { result: { sessionId: string } };
      const sessionId = createdBody.result.sessionId;

      const res = await server.dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId, prompt: "Run `printf ok` with the bash tool, then say you're done." },
      });
      const resBody = JSON.parse(res!) as { result?: unknown; error?: { message: string } };
      expect(resBody.error).toBeUndefined();
      expect(resBody.result).toEqual({ stopReason: "end_turn" });

      // The scripted bash call really ran through the guard-enforced path.
      expect(toolNamesSeen.size).toBeGreaterThan(0);
      for (const name of toolNamesSeen) expect(ALLOWED_TOOL_NAMES).toContain(name);

      const updates = frames.map((f) => JSON.parse(f) as { method: string; params: { sessionId: string; update: { sessionUpdate: string; content?: { text?: string }; title?: string } } });
      expect(updates.length).toBeGreaterThan(0);
      for (const u of updates) {
        expect(u.method).toBe("session/update");
        expect(u.params.sessionId).toBe(sessionId);
      }
      const kinds = updates.map((u) => u.params.update.sessionUpdate);
      expect(kinds).toContain("tool_call");
      const text = updates
        .filter((u) => typeof u.params.update.content?.text === "string")
        .map((u) => u.params.update.content!.text!)
        .join("");
      expect(text).toContain("done");
      await server.dispose();
    } finally {
      stub.stop(true);
    }
  }, 30_000);
});
