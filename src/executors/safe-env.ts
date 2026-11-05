/**
 * Minimal, non-secret process environment for host-side shells that run user
 * workloads (the mock executor's fake container and the local Apptainer PTY).
 *
 * The platform process env carries JWT_SECRET, DB credentials, SSH_PASSWORD and
 * LLM keys. Spreading it into a user-controlled shell hands all of that to the
 * user (`env` / `printenv`). Only variables a shell/coreutils/apptainer need to
 * function belong here; anything secret must be injected deliberately through
 * the container's own env.
 */
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "SYSTEMDRIVE",
  "ComSpec",
  "COMSPEC",
  "windir",
  "WINDIR",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  // Rootless Apptainer needs a runtime dir for its session state.
  "XDG_RUNTIME_DIR",
];

export function safeProcessEnvForHost(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Backwards-compatible alias used by the mock executor. */
export const safeProcessEnvForMock = safeProcessEnvForHost;
