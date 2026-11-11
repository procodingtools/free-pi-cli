// `free-pi-cli acp`: headless Agent Client Protocol server over stdio.
//
// Runs the SAME pre-launch gate as the TUI (runPrelaunchGate, headless mode:
// no prompts, no device-flow login, no browser) and then serves JSON-RPC on
// stdin/stdout. stdout is the protocol channel — every human-facing log
// routes to stderr, and the resume-line stdout patch is restored before the
// first frame so pi's exit path can never write branding bytes mid-protocol.
import { realpathSync } from "node:fs";
import { checkClientVersion } from "./update-check";
import { maybeSelfUpdate } from "./self-update";
import { runPrelaunchGate, type PrelaunchDeps } from "./run";
import { readAutoUpdate } from "./cli-config";
import { getConfigPath } from "./paths";
import { createRealSpawn } from "./real-spawn";
import { AcpServer } from "./acp/index";

export interface AcpCommandDeps {
  baseUrl: string;
  agentDir: string;
  credentialsPath: string;
  /** stderr sink in production. Tests pass a collector. */
  log: (message: string) => void;
  /** Protocol sink: process.stdout in production. Tests pass a collector. */
  notify: (frame: string) => void;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  checkClientVersion?: PrelaunchDeps["checkClientVersion"];
  maybeSelfUpdate?: PrelaunchDeps["maybeSelfUpdate"];
  startGravityPixel?: PrelaunchDeps["startGravityPixel"];
  /** Test seam: replaces the real runtime construction (identical wiring in prod). */
  buildRuntime?: ConstructorParameters<typeof AcpServer>[0]["buildRuntime"];
}

/**
 * Runs the ACP server. Returns the process exit code. Writes NOTHING to
 * stdout except JSON-RPC frames (and nothing at all before the gate passes).
 */
export async function runFreePiAcp(deps: AcpCommandDeps): Promise<number> {
  const gate = await runPrelaunchGate(
    {
      baseUrl: deps.baseUrl,
      agentDir: deps.agentDir,
      credentialsPath: deps.credentialsPath,
      // Headless: these are unreachable (no-JWT and re-consent paths exit
      // before calling them), but keep safe defaults that never block.
      promptConsent: async () => false,
      openBrowser: () => {},
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: deps.log,
      checkClientVersion: deps.checkClientVersion ?? checkClientVersion,
      // No relaunch in ACP mode: relaunchLatest would exec a child onto the
      // same stdio mid-protocol. The gate falls back to the manual message.
      relaunchLatest: undefined,
      maybeSelfUpdate: deps.maybeSelfUpdate ?? maybeSelfUpdateDefault,
      startGravityPixel: deps.startGravityPixel,
    },
    [],
    { headless: true },
  );
  if (!gate.ok) return gate.exitCode;

  const server = new AcpServer({
    baseUrl: deps.baseUrl,
    jwt: gate.jwt,
    agentDir: deps.agentDir,
    model: gate.model,
    models: gate.models,
    fusion: gate.fusion,
    updateLatest: gate.updateLatest,
    getGravityContext: gate.getGravityContext,
    log: deps.log,
    notify: deps.notify,
    buildRuntime: deps.buildRuntime,
  });
  await server.serve(deps.input ?? process.stdin, deps.output ?? process.stdout);
  return 0;
}

/** Default self-update wiring: mirrors main.ts's TUI wiring, but logs to stderr. */
function maybeSelfUpdateDefault(
  action: "notice" | "block",
  latest: string | undefined,
): ReturnType<PrelaunchDeps["maybeSelfUpdate"]> {
  let cliRealpath = "";
  try {
    cliRealpath = realpathSync(process.argv[1] ?? "");
  } catch {
    // Fail safe: never matches a real `npm root -g` path.
  }
  return maybeSelfUpdate(action, latest, {
    env: process.env,
    autoUpdateEnabled: () => readAutoUpdate(getConfigPath()),
    spawn: createRealSpawn(),
    cliRealpath,
    // Self-update already logs its own line — in ACP mode that must be stderr.
    log: (message) => console.error(message),
  });
}
