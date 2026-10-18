export const TEXT_MEMO_MAX_BYTES = 28;

/** Reject malformed Unicode rather than silently replacing it during signing. */
export function isTextMemo(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= TEXT_MEMO_MAX_BYTES
    && Buffer.from(value, "utf8").toString("utf8") === value;
}
