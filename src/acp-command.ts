// `free-pi-cli acp`: headless Agent Client Protocol server over stdio.
//
// Runs the SAME pre-launch gate as the TUI (runPrelaunchGate, headless mode:
// no prompts, no device-flow login, no browser) and then serves JSON-RPC on
// stdin/stdout. stdout is the protocol channel — every human-facing log
// routes to stderr, and the resume-line stdout patch is restored before the
// first frame so pi's exit path can never write branding bytes mid-protocol.
import { checkClientVersion } from "./update-check";
import { runPrelaunchGate, type PrelaunchDeps } from "./run";
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
