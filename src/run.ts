import { checkToken, pollForToken, startDeviceFlow, submitConsent, submitUserConsent, UnauthorizedError } from "./auth-flow";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { clearJwt, loadJwt, saveJwt } from "./credentials";
import { CONSENT_VERSION, REPROMPT_CONSENT_TEXT } from "./consent";
import { showIntro } from "./onboarding";
import type { LaunchOptions } from "./pi-launch";
import type { CatalogModel } from "./provider";
import type { ClientVersionCheck } from "./update-check";
import { CLI_VERSION } from "./version";
import { maybeWhatsNew } from "./whats-new";

export interface RunDeps {
  baseUrl: string;
  agentDir: string;
  credentialsPath: string;
  /** Shows the consent screen, returns true on accept. */
  promptConsent: (text?: string) => Promise<boolean>;
  /** Best-effort browser open; must never throw or block. */
  openBrowser: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  launchPi: (opts: LaunchOptions) => Promise<string | void>;
  log: (message: string) => void;
  /**
   * Startup update check (#37 R5). Injectable so tests can stub it, mirroring
   * `launchPi`. Called only after the consent gate below has resolved — see
   * `run()`'s comment for why the ordering matters.
   */
  checkClientVersion: (baseUrl: string, cliVersion: string) => Promise<ClientVersionCheck>;
  /**
   * Starts Gravity's pixel in the background and returns the context getter for
   * the ads extension. Called only once the user has accepted the current
   * consent version (which discloses it). Must not block; run() swallows throws.
   */
  startGravityPixel?: (jwt: string) => (() => string | undefined) | undefined;
}

/** Runs the full device-flow login (device code -> consent -> poll), stores the JWT. */
async function loginFlow(deps: Pick<RunDeps, "baseUrl" | "credentialsPath" | "log" | "openBrowser" | "sleep">): Promise<string> {
  const device = await startDeviceFlow(deps.baseUrl);
  deps.log(`\nOpen ${device.verification_uri} and enter code: ${device.user_code}\n`);
  deps.openBrowser(device.verification_uri);

  await submitConsent(deps.baseUrl, device.session_id, CONSENT_VERSION);

  const token = await pollForToken(deps.baseUrl, device.session_id, device.interval, deps.sleep);
  await saveJwt(deps.credentialsPath, token);
  return token;
}

/** Everything run() needs before launchPi: the same deps minus the launcher. */
export type PrelaunchDeps = Omit<RunDeps, "launchPi">;

/** Headless callers (ACP) must route this log to stderr: stdout is the protocol channel. */
export interface PrelaunchSuccess {
  jwt: string;
  session?: string;
  model?: string;
  models?: CatalogModel[];
  fusion?: { planner: string; executor: string };
  updateLatest?: string;
  notice?: string;
  getGravityContext?: () => string | undefined;
}

export type PrelaunchResult = { ok: true } & PrelaunchSuccess | { ok: false; exitCode: number };

/** Shown when a headless run has no usable credential — login needs a terminal. */
export const HEADLESS_LOGIN_REQUIRED =
  "free-pi-cli is not signed in (or the sign-in expired). Run `free-pi-cli` once in a terminal to sign in, then retry.";

/**
 * Shared pre-launch gate: consent → login → token check → version check →
 * notices → Gravity pixel. Both the TUI path (run) and the
 * headless ACP path call this, so neither can drift weaker on auth/consent.
 *
 * headless=true changes only the interactive steps: no consent prompt, no
 * device-flow login, no re-consent prompt — each becomes a stderr message +
 * nonzero exit, never an accept-on-the-user's-behalf. The declined-consent
 * invariant (ZERO server calls) holds on both paths: every early return below
 * precedes checkClientVersion.
 */
export async function runPrelaunchGate(
  deps: PrelaunchDeps,
  argv: readonly string[] = process.argv,
  opts: { headless?: boolean } = {},
): Promise<PrelaunchResult> {
  const headless = opts.headless === true;
  const sessionArg = parseSessionArg(argv);
  if (sessionArg.error) {
    deps.log(sessionArg.error);
    return { ok: false, exitCode: 1 };
  }

  let jwt = await loadJwt(deps.credentialsPath);
  /** True once the user has accepted CONSENT_VERSION (the one that discloses the Gravity pixel). */
  let consentCurrent = false;

  if (jwt) {
    try {
      const serverConsent = await checkToken(deps.baseUrl, jwt);
      // Re-consent: undefined = old server that doesn't report it, so skip.
      // Declining asks again next startup (nothing is remembered locally).
      consentCurrent = serverConsent === CONSENT_VERSION;
      if (serverConsent !== undefined && serverConsent !== CONSENT_VERSION) {
        if (headless) {
          deps.log("free-pi's terms changed since you last signed in. Run `free-pi-cli` once in a terminal to review and accept, then retry.");
          return { ok: false, exitCode: 1 };
        }
        if (!(await deps.promptConsent(REPROMPT_CONSENT_TEXT))) {
          deps.log("Declined. free-pi needs you to accept the updated terms to continue; you will be asked again next time.");
          return { ok: false, exitCode: 1 };
        }
        consentCurrent = true;
        try {
          await submitUserConsent(deps.baseUrl, jwt, CONSENT_VERSION);
        } catch (err) {
          // A dead JWT goes to the outer handler (clear + re-login); anything
          // else just means it was not recorded and we ask again next startup.
          if (err instanceof UnauthorizedError) throw err;
        }
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await clearJwt(deps.credentialsPath);
        jwt = null;
      }
      // Non-401 errors (network blip, 5xx) are not our cue to re-login;
      // fall through and let pi surface the real problem on first use.
    }
  }

  if (!jwt) {
    if (headless) {
      deps.log(HEADLESS_LOGIN_REQUIRED);
      return { ok: false, exitCode: 1 };
    }
    const accepted = await deps.promptConsent();
    if (!accepted) {
      deps.log("Declined. Exiting without contacting the free-pi server.");
      return { ok: false, exitCode: 1 };
    }
    // #63: first-run onboarding — shown here (first-run only) above the
    // device-login instructions the user must read, so it survives the pi TUI
    // taking over the screen. Returning users (JWT on disk) skip this branch.
    showIntro(deps.log);
    jwt = await loginFlow(deps);
    consentCurrent = true;
  }

  // #37 R5 (privacy invariant): this must run only here — past the decline
  // early-return above — so a declined first-run still makes ZERO server
  // calls. By this point either a JWT already existed on disk (past consent)
  // or consent was just accepted and loginFlow() just ran, so a version
  // check is always warranted.
  const versionCheck = await deps.checkClientVersion(deps.baseUrl, CLI_VERSION);
  /** Set when a newer version exists: carried into the session header banner. */
  let updateLatest: string | undefined;
  // No self-update: a "block" is always a hard stop with the manual update
  // message; a "notice" rides into the session header banner (header.ts)
  // rather than a log line the TUI immediately scrolls past.
  if (versionCheck.action === "block") {
    deps.log("free-pi-cli is below the required minimum version; update with: npx free-pi-cli@latest");
    return { ok: false, exitCode: 1 };
  }
  if (versionCheck.action === "notice") {
    updateLatest = versionCheck.latest;
  }

  // 0.2.6: after an update, show what changed once (terminal-only, never enters
  // model context). Best-effort; a bad state file returns undefined, not a throw.
  const whatsNew = maybeWhatsNew(CLI_VERSION, deps.agentDir);
  if (whatsNew) deps.log(whatsNew);

  // Server-driven one-line notice (e.g. a data-handling disclosure during a
  // free-model trial). Printed to the terminal only — it never touches the
  // completion messages, so it cannot enter model context (same UI-only
  // guarantee the ad sandbox enforces).
  if (versionCheck.notice) deps.log(versionCheck.notice);

  let getGravityContext: (() => string | undefined) | undefined;
  if (consentCurrent) {
    try {
      getGravityContext = deps.startGravityPixel?.(jwt);
    } catch {
      // The pixel is optional; never let it stop startup.
    }
  }

  return {
    ok: true,
    jwt,
    session: sessionArg.session,
    model: versionCheck.model,
    models: versionCheck.models,
    fusion: versionCheck.fusion,
    updateLatest,
    notice: versionCheck.notice,
    getGravityContext,
  };
}

/** Orchestrates first-run consent, login, token validation, and pi launch. Returns the process exit code. */
function parseSessionArg(argv: readonly string[]): { session?: string; error?: string } {
  const flagIndex = argv.indexOf("--session");
  if (flagIndex === -1) return {};

  const value = argv[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    return { error: "Missing value for --session" };
  }

  try {
    // The public SDK entry point does not re-export assertValidSessionId in
    // 0.84.2, but SessionManager's public constructor invokes that exact SDK
    // validator. In-memory keeps this validation side-effect free.
    SessionManager.inMemory(process.cwd(), { id: value });
  } catch (err) {
    return { error: `Invalid --session value: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { session: value };
}

export async function run(deps: RunDeps, argv: readonly string[] = process.argv): Promise<number> {
  const gate = await runPrelaunchGate(deps, argv);
  if (!gate.ok) return gate.exitCode;

  const finalSessionId = await deps.launchPi({
    baseUrl: deps.baseUrl,
    jwt: gate.jwt,
    agentDir: deps.agentDir,
    session: gate.session,
    model: gate.model,
    models: gate.models,
    fusion: gate.fusion,
    updateLatest: gate.updateLatest,
    getGravityContext: gate.getGravityContext,
  });

  // First user feedback (2026-08-17): after closing the terminal, users didn't
  // know how to relaunch. The pi TUI's own exit line says `pi --session <id>`,
  // but our users installed `free-pi-cli` (via npx), not `pi`.
  deps.log(
    finalSessionId
      ? `\nfree-pi session ended. Start it again anytime:  npx free-pi-cli --session ${finalSessionId}`
      : "\nfree-pi session ended. Start it again anytime:  npx free-pi-cli",
  );
  deps.log("(or install once for a shorter command:  npm i -g free-pi-cli  →  free-pi-cli)\n");
  return 0;
}
