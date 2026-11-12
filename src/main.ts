import { dirname, join } from "node:path";
import { openBrowser } from "./browser";
import { HELP_TEXT, parseCliArgs, versionLine } from "./cli-args";
import { clearJwt, loadJwt } from "./credentials";
import { resolveBaseUrl } from "./env";
import { runLogout } from "./logout";
import { runFreePiMcp } from "./mcp-command";
import { runFreePiAcp } from "./acp-command";
import { getCredentialsPath, getFreePiAgentDir } from "./paths";
import { startGravityPixel } from "./gravity-pixel";
import { launchPi } from "./pi-launch";
import { promptConsentInteractive } from "./prompt";
import { run } from "./run";
import { checkClientVersion } from "./update-check";

async function main(): Promise<void> {
  // Local commands dispatch before run(): none of these contact the server,
  // so the consent/privacy invariants of the run() flow are never in play.
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === "version") {
    console.log(versionLine());
    process.exit(0);
  }
  if (command.kind === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (command.kind === "unknown") {
    console.error(`free-pi-cli: unknown argument "${command.arg}"\n\n${HELP_TEXT}`);
    process.exit(2);
  }
  if (command.kind === "logout") {
    const logoutCode = await runLogout({
      credentialsPath: getCredentialsPath(),
      loadJwt,
      clearJwt,
      log: (message) => console.log(message),
    });
    process.exit(logoutCode);
  }

  if (command.kind === "mcp") {
    const mcpCode = await runFreePiMcp(command.args, {
      cwd: process.cwd(),
      agentDir: getFreePiAgentDir(),
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    });
    process.exit(mcpCode);
  }

  const agentDir = getFreePiAgentDir();

  if (command.kind === "acp") {
    // ACP mode: stdout is the JSON-RPC protocol channel. Every human-facing
    // log routes to stderr; only protocol frames may touch stdout.
    const acpCode = await runFreePiAcp({
      baseUrl: resolveBaseUrl(),
      agentDir,
      credentialsPath: getCredentialsPath(agentDir),
      log: (line) => console.error(line),
      notify: (frame) => process.stdout.write(`${frame}\n`),
    });
    process.exit(acpCode);
  }
  const code = await run({
    baseUrl: resolveBaseUrl(),
    agentDir,
    credentialsPath: getCredentialsPath(agentDir),
    promptConsent: promptConsentInteractive,
    openBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    launchPi,
    log: (message) => console.log(message),
    checkClientVersion,
    startGravityPixel: (jwt) => startGravityPixel(jwt, join(dirname(agentDir), "gravity")),
  });
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
