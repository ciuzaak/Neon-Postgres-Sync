import * as jsoncParser from 'jsonc-parser';

export type KeyPath = ReadonlyArray<string>;

export class JsoncFilterParseError extends Error {
    constructor(
        public readonly side: 'local' | 'remote',
        public readonly errors: ReadonlyArray<jsoncParser.ParseError>
    ) {
        super(`Failed to parse ${side} as JSONC: ${formatParseErrors(errors)}`);
        this.name = 'JsoncFilterParseError';
    }
}

export class JsoncFilterMergeError extends Error {
    constructor(public readonly path: KeyPath, public readonly cause: unknown) {
        super(
            `Failed to splice destination value back at path "${path.join('.')}": ` +
            `the candidate's structure makes this path unreachable. ` +
            `Edit the candidate so the path's parents are objects, or remove the candidate's edits in that area.`
        );
        this.name = 'JsoncFilterMergeError';
    }
}

const PARSE_OPTIONS: jsoncParser.ParseOptions = {
    disallowComments: false,
    allowTrailingComma: true,
    allowEmptyContent: false
};

/**
 * Throws JsoncFilterParseError if `text` is not parseable as JSONC (comments
 * and trailing commas allowed, empty input rejected).
 */
export function assertJsonc(text: string, side: 'local' | 'remote'): void {
    const errors: jsoncParser.ParseError[] = [];
    jsoncParser.parse(text, errors, PARSE_OPTIONS);
    if (errors.length > 0) {
        throw new JsoncFilterParseError(side, errors);
    }
}

function formatParseErrors(errors: ReadonlyArray<jsoncParser.ParseError>): string {
    if (errors.length === 0) return 'unknown error';
    return errors.map((e) => `${parseErrorCodeName(e.error)} at offset ${e.offset}`).join('; ');
}

function parseErrorCodeName(code: jsoncParser.ParseErrorCode): string {
    // jsonc-parser exports ParseErrorCode as a numeric enum. Map the few we care
    // about for nicer messages; fall back to the raw number otherwise.
    const names: Record<number, string> = {
        1: 'InvalidSymbol',
        2: 'InvalidNumberFormat',
        3: 'PropertyNameExpected',
        4: 'ValueExpected',
        5: 'ColonExpected',
        6: 'CommaExpected',
        7: 'CloseBraceExpected',
        8: 'CloseBracketExpected',
        9: 'EndOfFileExpected',
        10: 'InvalidCommentToken',
        11: 'UnexpectedEndOfComment',
        12: 'UnexpectedEndOfString',
        13: 'UnexpectedEndOfNumber',
        14: 'InvalidUnicode',
        15: 'InvalidEscapeCharacter',
        16: 'InvalidCharacter'
    };
    return names[code] ?? `ParseErrorCode(${code})`;
}

const MODIFY_OPTIONS: jsoncParser.ModificationOptions = {
    formattingOptions: { tabSize: 4, insertSpaces: true }
};

/**
 * Returns `text` with every key at the given paths removed. Comments and
 * formatting on remaining keys are preserved. No-op when a path does not exist
 * in the input. Paths are processed deepest-first so that removing an outer
 * node does not invalidate positions still pointing inside it.
 */
export function stripKeys(text: string, paths: ReadonlyArray<KeyPath>): string {
    if (paths.length === 0) return text;

    const ordered = [...paths].sort((a, b) => b.length - a.length);
    let current = text;
    for (const path of ordered) {
        let edits: jsoncParser.Edit[];
        try {
            edits = jsoncParser.modify(current, [...path], undefined, MODIFY_OPTIONS);
        } catch {
            // path does not exist or is unreachable — treat as no-op
            continue;
        }
        if (edits.length === 0) continue;
        current = jsoncParser.applyEdits(current, edits);
    }
    return current;
}

/**
 * Returns `candidateText` with every path's value reset to whatever
 * `destinationOriginal` holds at that same path:
 *   - destination has path → set candidate at path to destination's value
 *   - destination missing path → remove path from candidate (if present)
 *
 * Comments/formatting elsewhere in candidateText are preserved. Intermediate
 * objects are created in candidate as needed (jsonc-parser modify default).
 *
 * Paths are processed deepest-first to keep edit offsets stable.
 */
export function mergeBack(
    candidateText: string,
    destinationOriginal: string,
    paths: ReadonlyArray<KeyPath>
): string {
    if (paths.length === 0) return candidateText;

    const destTree = jsoncParser.parseTree(destinationOriginal, [], PARSE_OPTIONS);

    const ordered = [...paths].sort((a, b) => b.length - a.length);
    let current = candidateText;
    for (const path of ordered) {
        const destNode = destTree ? jsoncParser.findNodeAtLocation(destTree, [...path]) : undefined;
        const replacement = destNode ? jsoncParser.getNodeValue(destNode) : undefined;
        // `replacement === undefined` deletes the key in candidate via modify().
        let edits: jsoncParser.Edit[];
        try {
            edits = jsoncParser.modify(current, [...path], replacement, MODIFY_OPTIONS);
        } catch (e) {
            if (replacement === undefined) {
                // Destination has no value for this path; we wanted to delete
                // from candidate, but the path is unreachable there too. No-op.
                continue;
            }
            // Destination has a value but candidate's structure blocks restoring it.
            // Silent swallow would lose the destination value — surface to caller.
            throw new JsoncFilterMergeError(path, e);
        }
        if (edits.length === 0) continue;
        current = jsoncParser.applyEdits(current, edits);
    }
    return current;
}

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
        const segments = trimmed.split('.').map((s) => s.trim());
        // Reject lines with empty segments (e.g. "a.", ".a", "a..b") — these
        // are almost certainly typos; silently normalizing them to "a" would
        // accidentally match the wrong top-level key.
        if (segments.length === 0 || segments.some((s) => s.length === 0)) continue;
        const key = segments.join('\x00'); // null-byte joiner: safe vs any user input
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(segments);
    }
    return out;
}
