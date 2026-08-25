/**
 * POSIX single-quote escaping, shared by the SSH and CLI executors.
 *
 * Wraps the string in single quotes and escapes any embedded single quote via
 * the standard `'\''` sequence. The result is safe to interpolate into a
 * shell command line — no value can break out of the quoting, so executor env
 * injection (e.g. `--env KEY=<quoted>`) cannot be turned into shell injection.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Environment-variable name validation. Apptainer `--env` keys must be valid
 * shell identifiers (letters/digits/_/., starting with a letter or _). Rejecting
 * anything else here is defense-in-depth against a malformed key sneaking shell
 * metacharacters past the value quoting.
 */
export function isValidEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name);
}
