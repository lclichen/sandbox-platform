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
    content = content.slice(0, maxBytes);
  }
  return { content, truncated: true, totalLines, totalBytes };
}
