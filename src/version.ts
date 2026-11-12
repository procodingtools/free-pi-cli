// SPOOFED VERSION — local builds only, never upstream.
//
// The tree underneath is 0.4.10-era source (+ local ACP + no-auto-update
// changes), but the server refuses anything below minCliVersion (0.6.19), so
// a truthful 0.4.10 binary can never start a session against prod. This
// constant claims 0.6.19 so the gate lets us through.
//
// Know what this means: if the server moved any API under us since 0.4.10,
// turns can fail in confusing ways — that is the accepted cost of running a
// stale client. Do NOT merge this file upstream; the real fix is a maintainer
// release cut from current monorepo source.
export const CLI_VERSION = "0.6.19";
