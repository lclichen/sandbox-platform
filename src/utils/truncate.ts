/**
 * Output truncation for tool results, mirroring pi's behavior: cap both bytes
 * and lines so large outputs do not blow up the LLM context window.
 */

export interface TruncateOptions {
  maxBytes?: number;
  maxLines?: number;
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

export const DEFAULT_MAX_BYTES = 50_000;
export const DEFAULT_MAX_LINES = 2000;

export function truncate(input: string, opts: TruncateOptions = {}): TruncateResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

  const totalBytes = Buffer.byteLength(input, "utf8");
  const allLines = input.split("\n");
  const totalLines = allLines.length;

  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return { content: input, truncated: false, totalLines, totalBytes };
  }

  // Take the leading maxLines lines, then trim to maxBytes.
  const headLines = allLines.slice(0, maxLines);
  let content = headLines.join("\n");
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    // Byte-trim without splitting a multibyte char: cut then validate.
    // Byte-accurate trim: slicing the STRING cuts UTF-16 code units, which
    // can still exceed maxBytes on multibyte content and splits surrogate pairs.
    content = Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  return { content, truncated: true, totalLines, totalBytes };
}
