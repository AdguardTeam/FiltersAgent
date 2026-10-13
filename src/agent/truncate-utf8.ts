/**
 * Byte-bounded UTF-8 truncation shared by the model-facing tool responses that carry repository or
 * artifact text.
 */

/**
 * Truncate a UTF-8 string at a byte boundary without emitting invalid replacement data.
 *
 * @param value - Content to bound.
 * @param maxBytes - Maximum UTF-8 byte count.
 * @returns Byte-bounded UTF-8 content.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
    const bytes = Buffer.from(value);
    if (bytes.length <= maxBytes) {
        return value;
    }
    return bytes.subarray(0, maxBytes).toString('utf8');
}
