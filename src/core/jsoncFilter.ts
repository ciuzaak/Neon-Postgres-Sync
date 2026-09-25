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

/** First non-trivia token at or after `offset` (whitespace, line breaks and comments skipped). */
function nextSignificantToken(text: string, offset: number): { kind: jsoncParser.SyntaxKind; offset: number } {
    const scanner = jsoncParser.createScanner(text.slice(offset), false);
    for (;;) {
        const kind = scanner.scan();
        if (
            kind !== jsoncParser.SyntaxKind.Trivia
            && kind !== jsoncParser.SyntaxKind.LineBreakTrivia
            && kind !== jsoncParser.SyntaxKind.LineCommentTrivia
            && kind !== jsoncParser.SyntaxKind.BlockCommentTrivia
        ) {
            return { kind, offset: offset + scanner.getTokenOffset() };
        }
    }
}

/** Offset of the last `,` before `offset` if only trivia separates them, else -1. */
function precedingComma(text: string, objectStart: number, offset: number): number {
    const scanner = jsoncParser.createScanner(text.slice(objectStart, offset), false);
    let lastSignificant: { kind: jsoncParser.SyntaxKind; offset: number } | undefined;
    for (let kind = scanner.scan(); kind !== jsoncParser.SyntaxKind.EOF; kind = scanner.scan()) {
        if (
            kind !== jsoncParser.SyntaxKind.Trivia
            && kind !== jsoncParser.SyntaxKind.LineBreakTrivia
            && kind !== jsoncParser.SyntaxKind.LineCommentTrivia
            && kind !== jsoncParser.SyntaxKind.BlockCommentTrivia
        ) {
            lastSignificant = { kind, offset: objectStart + scanner.getTokenOffset() };
        }
    }
    return lastSignificant?.kind === jsoncParser.SyntaxKind.CommaToken ? lastSignificant.offset : -1;
}

/**
 * Edits that delete one object property while leaving every comment that
 * isn't the property's own in place. jsonc-parser's `modify(…, undefined)`
 * deletes from the previous comma, which swallows the neighbouring key's
 * trailing comment (and any comment lines above the removed key) — silent
 * data loss once the text is written back.
 *
 * Rules:
 * - The property's own span always goes, plus its trailing comma if any.
 * - If it sits alone on its line(s), the whole line goes, including a
 *   trailing `//` comment on that same line (that comment is about it).
 * - If it is the last property, the comma before it goes (just that one
 *   character; comments after the comma stay).
 */
function propertyRemovalEdits(text: string, property: jsoncParser.Node): jsoncParser.Edit[] {
    const start = property.offset;
    const end = property.offset + property.length;
    const next = nextSignificantToken(text, end);
    const hasTrailingComma = next.kind === jsoncParser.SyntaxKind.CommaToken;
    const removeTo = hasTrailingComma ? next.offset + 1 : end;

    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const newline = text.indexOf('\n', removeTo);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    const ownsLine = /^[ \t]*$/.test(text.slice(lineStart, start))
        && /^[ \t]*(\/\/[^\n]*)?\r?\n?$/.test(text.slice(removeTo, lineEnd));

    let inlineEnd = removeTo;
    if (hasTrailingComma) {
        while (text[inlineEnd] === ' ' || text[inlineEnd] === '\t') inlineEnd++;
    }
    const edits: jsoncParser.Edit[] = ownsLine
        ? [{ offset: lineStart, length: lineEnd - lineStart, content: '' }]
        : [{ offset: start, length: inlineEnd - start, content: '' }];

    if (!hasTrailingComma && property.parent) {
        const comma = precedingComma(text, property.parent.offset + 1, start);
        if (comma !== -1) edits.push({ offset: comma, length: 1, content: '' });
    }
    return edits;
}

/**
 * Remove the property at `path` if it exists (no-op otherwise). Returns the
 * new text. Only object properties are addressable (see parsePaths).
 */
function removeProperty(text: string, path: KeyPath): string {
    const tree = jsoncParser.parseTree(text, [], PARSE_OPTIONS);
    const valueNode = tree ? jsoncParser.findNodeAtLocation(tree, [...path]) : undefined;
    const property = valueNode?.parent;
    if (!property || property.type !== 'property') return text;
    return jsoncParser.applyEdits(text, propertyRemovalEdits(text, property));
}

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
        current = removeProperty(current, path);
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
        if (replacement === undefined) {
            // Destination has no value: delete from candidate without eating
            // neighbouring comments. No-op if candidate can't reach the path.
            current = removeProperty(current, path);
            continue;
        }
        let edits: jsoncParser.Edit[];
        try {
            edits = jsoncParser.modify(current, [...path], replacement, MODIFY_OPTIONS);
        } catch (e) {
            // Destination has a value but candidate's structure blocks restoring it.
            // Silent swallow would lose the destination value — surface to caller.
            throw new JsoncFilterMergeError(path, e);
        }
        if (edits.length === 0) continue;
        current = jsoncParser.applyEdits(current, edits);
    }
    return current;
}

// v1 supports only dot-separated literal key names. Wildcards (`*`) and array
// index syntax (`[0]`, `[*]`) are reserved for future versions; reject any
// segment containing these so we don't silently match a literal key like "*".
const UNSUPPORTED_SEGMENT_CHARS_RE = /[*\[\]]/;

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
        if (segments.some((s) => UNSUPPORTED_SEGMENT_CHARS_RE.test(s))) continue;
        const key = segments.join('\x00'); // null-byte joiner: safe vs any user input
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(segments);
    }
    return out;
}
