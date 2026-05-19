import * as jsoncParser from 'jsonc-parser';

export type KeyPath = ReadonlyArray<string>;

/**
 * Normalize raw path strings (one per textarea line / one per JSON array entry)
 * into KeyPath arrays. Trims, splits on '.', drops empty results, dedupes by
 * full-path string equality, preserves first-seen order.
 */
export function parsePaths(raw: ReadonlyArray<string>): KeyPath[] {
    const seen = new Set<string>();
    const out: KeyPath[] = [];
    for (const line of raw) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const segments = trimmed.split('.').map((s) => s.trim()).filter((s) => s.length > 0);
        if (segments.length === 0) continue;
        const key = segments.join('\x00'); // null-byte joiner: safe vs any user input
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(segments);
    }
    return out;
}
