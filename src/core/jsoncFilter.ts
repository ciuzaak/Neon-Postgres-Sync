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

/** A concrete path, unambiguous about which dots are inside key names: `"a" → "b.c"`. */
export function describePath(path: KeyPath): string {
    return path.map((segment) => JSON.stringify(segment)).join(' → ');
}

export class JsoncFilterMergeError extends Error {
    constructor(public readonly path: KeyPath, public readonly cause: unknown) {
        super(
            `Failed to splice destination value back at ${describePath(path)}: ` +
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

// ── Text surgery ─────────────────────────────────────────────────────────
//
// stripKeys / mergeBack edit the text directly rather than via jsonc-parser's
// modify(): its delete swallows the neighbouring key's comments and its insert
// moves them onto the new key's line — silent comment loss once written back.
// Rules: every comment that isn't the removed property's own same-line comment
// survives; line breaks are \n, \r\n or a bare \r (as jsonc-parser treats
// them); duplicate keys resolve like JSON.parse (last wins).

function isTrivia(kind: jsoncParser.SyntaxKind): boolean {
    return kind === jsoncParser.SyntaxKind.Trivia
        || kind === jsoncParser.SyntaxKind.LineBreakTrivia
        || kind === jsoncParser.SyntaxKind.LineCommentTrivia
        || kind === jsoncParser.SyntaxKind.BlockCommentTrivia;
}

/** First non-trivia token at or after `offset` (whitespace, line breaks and comments skipped). */
function nextSignificantToken(text: string, offset: number): { kind: jsoncParser.SyntaxKind; offset: number } {
    const scanner = jsoncParser.createScanner(text.slice(offset), false);
    for (;;) {
        const kind = scanner.scan();
        if (!isTrivia(kind)) {
            return { kind, offset: offset + scanner.getTokenOffset() };
        }
    }
}

/** Offset of the last `,` before `offset` if only trivia separates them, else -1. */
function precedingComma(text: string, objectStart: number, offset: number): number {
    const scanner = jsoncParser.createScanner(text.slice(objectStart, offset), false);
    let lastSignificant: { kind: jsoncParser.SyntaxKind; offset: number } | undefined;
    for (let kind = scanner.scan(); kind !== jsoncParser.SyntaxKind.EOF; kind = scanner.scan()) {
        if (!isTrivia(kind)) {
            lastSignificant = { kind, offset: objectStart + scanner.getTokenOffset() };
        }
    }
    return lastSignificant?.kind === jsoncParser.SyntaxKind.CommaToken ? lastSignificant.offset : -1;
}

const isBreak = (ch: string | undefined) => ch === '\n' || ch === '\r';
const isBlank = (ch: string | undefined) => ch === ' ' || ch === '\t';

/** Offset where the line containing `offset` starts. */
function lineStartOf(text: string, offset: number): number {
    let i = offset;
    while (i > 0 && !isBreak(text[i - 1])) i--;
    return i;
}

/** Offset of the line break ending the line that contains `offset` (text.length if none). */
function lineContentEndOf(text: string, offset: number): number {
    let i = offset;
    while (i < text.length && !isBreak(text[i])) i++;
    return i;
}

/** Offset just past the line break at `i` (a no-op at end of text). */
function pastLineBreak(text: string, i: number): number {
    if (text[i] === '\r' && text[i + 1] === '\n') return i + 2;
    return i < text.length ? i + 1 : i;
}

/** [from, to) holds only blanks and complete same-line comments. */
function onlyInlineTrivia(text: string, from: number, to: number): boolean {
    const scanner = jsoncParser.createScanner(text.slice(from, to), false);
    for (let kind = scanner.scan(); kind !== jsoncParser.SyntaxKind.EOF; kind = scanner.scan()) {
        if (scanner.getTokenError() !== jsoncParser.ScanError.None) return false; // e.g. unterminated /*
        if (kind === jsoncParser.SyntaxKind.Trivia || kind === jsoncParser.SyntaxKind.LineCommentTrivia) continue;
        if (kind === jsoncParser.SyntaxKind.BlockCommentTrivia && !/[\r\n]/.test(scanner.getTokenValue())) continue;
        return false;
    }
    return true;
}

function detectEol(text: string): string {
    if (text.includes('\r\n')) return '\r\n';
    if (text.includes('\r')) return '\r';
    return '\n';
}

/** The line break at `i` if there is one, else the document's usual one (mixed-EOL files stay stable). */
function lineBreakAt(text: string, i: number): string {
    if (text[i] === '\r' && text[i + 1] === '\n') return '\r\n';
    return isBreak(text[i]) ? text[i] : detectEol(text);
}

/** Indent unit of the document: the first indented line's leading whitespace, else 4 spaces. */
function detectIndentUnit(text: string): string {
    const m = /[\r\n]([ \t]+)\S/.exec(text);
    if (!m) return '    ';
    return m[1].startsWith('\t') ? '\t' : m[1];
}

/** Leading whitespace of the line containing `offset`. */
function indentOfLine(text: string, offset: number): string {
    return /^[ \t]*/.exec(text.slice(lineStartOf(text, offset)))![0];
}

/** Whether `offset` is the first non-blank position on its line. */
function startsLine(text: string, offset: number): boolean {
    return /^[ \t]*$/.test(text.slice(lineStartOf(text, offset), offset));
}

/** Property nodes of `obj` whose key is `key`, in document order. */
function propertiesNamed(obj: jsoncParser.Node, key: string): jsoncParser.Node[] {
    return (obj.children ?? []).filter((p) => p.type === 'property' && p.children?.[0]?.value === key);
}

/** Value node at `path`, resolving duplicate keys like JSON.parse (last wins). */
function findValue(root: jsoncParser.Node, path: KeyPath): jsoncParser.Node | undefined {
    let node: jsoncParser.Node | undefined = root;
    for (const segment of path) {
        if (!node || node.type !== 'object') return undefined;
        const props = propertiesNamed(node, segment);
        node = props[props.length - 1]?.children?.[1];
    }
    return node;
}

/**
 * Every node at `path`, following all duplicate keys along the way (not just
 * the last-wins one). Used for removal, so a shadowed duplicate parent can't
 * keep carrying a hidden value in the text.
 */
function findAllValues(root: jsoncParser.Node, path: KeyPath): jsoncParser.Node[] {
    let nodes = [root];
    for (const segment of path) {
        nodes = nodes.flatMap((node) =>
            node.type === 'object'
                ? propertiesNamed(node, segment).map((p) => p.children?.[1]).filter((v): v is jsoncParser.Node => !!v)
                : []
        );
    }
    return nodes;
}

/**
 * The concrete key paths in `root` that a written path matches. Each dot in
 * the written path either separates levels or belongs to a key name, so
 * `editor.fontSize` matches the flat key `"editor.fontSize"` (as VS Code
 * writes settings) as well as `fontSize` nested in `editor`. Only keys that
 * exist are followed, through every duplicate, so this stays small however
 * many dots a path has.
 */
function concretePaths(root: jsoncParser.Node | undefined, written: KeyPath): KeyPath[] {
    const found = new Map<string, KeyPath>();
    const walk = (node: jsoncParser.Node, rest: KeyPath, prefix: string[]): void => {
        if (node.type !== 'object') return;
        for (let take = 1; take <= rest.length; take++) {
            const key = rest.slice(0, take).join('.');
            const props = propertiesNamed(node, key);
            if (props.length === 0) continue;
            const path = [...prefix, key];
            if (take === rest.length) {
                found.set(path.join('\x00'), path);
            } else {
                for (const p of props) {
                    const value = p.children?.[1];
                    if (value) walk(value, rest.slice(take), path);
                }
            }
        }
    };
    if (root) walk(root, written, []);
    return [...found.values()];
}

/**
 * Whether `text` holds any written path in a form other than plain nesting
 * (a key name containing a dot). Without such forms, matching strips exactly
 * what the older nesting-only matching did.
 */
export function hasFlatForms(text: string, paths: ReadonlyArray<KeyPath>): boolean {
    const tree = jsoncParser.parseTree(text, [], PARSE_OPTIONS);
    return paths.some((p) => p.length > 1 && concretePaths(tree, p).some((c) => c.length !== p.length));
}

/** Delete [start, end) — widened to whole lines when it has its line(s) to itself. */
function spanOrLinesEdit(text: string, start: number, end: number): jsoncParser.Edit {
    const lineEnd = lineContentEndOf(text, end);
    if (startsLine(text, start) && onlyInlineTrivia(text, end, lineEnd)) {
        const from = lineStartOf(text, start);
        return { offset: from, length: pastLineBreak(text, lineEnd) - from, content: '' };
    }
    return { offset: start, length: end - start, content: '' };
}

/** Edits deleting one object property; see the rules above. */
function propertyRemovalEdits(text: string, property: jsoncParser.Node): jsoncParser.Edit[] {
    const start = property.offset;
    const end = property.offset + property.length;
    const next = nextSignificantToken(text, end);

    if (next.kind === jsoncParser.SyntaxKind.CommaToken) {
        const comma = next.offset;
        if (!/^[ \t]*$/.test(text.slice(end, comma))) {
            // Comments or line breaks sit between the value and its comma:
            // delete the property and the comma separately, keeping them.
            return [spanOrLinesEdit(text, start, end), { offset: comma, length: 1, content: '' }];
        }
        const whole = spanOrLinesEdit(text, start, comma + 1);
        if (whole.offset !== start) return [whole];
        // Inline: take the blanks after the comma too — or, when this was the
        // last property (trailing comma), the blanks before it instead.
        let from = start;
        let to = comma + 1;
        if (nextSignificantToken(text, to).kind === jsoncParser.SyntaxKind.CloseBraceToken) {
            while (from > 0 && isBlank(text[from - 1])) from--;
        } else {
            while (isBlank(text[to])) to++;
        }
        return [{ offset: from, length: to - from, content: '' }];
    }

    // Last property without a trailing comma: the comma before it goes too.
    const prev = property.parent ? precedingComma(text, property.parent.offset + 1, start) : -1;
    const own = spanOrLinesEdit(text, start, end);
    if (prev === -1) return [own];
    if (own.offset === start && /^[ \t]*$/.test(text.slice(prev + 1, start))) {
        return [{ offset: prev, length: end - prev, content: '' }]; // inline `, "k": v`
    }
    return [own, { offset: prev, length: 1, content: '' }];
}

/**
 * Remove every property at `path` — every duplicate, under every duplicate
 * parent — so no shadowed copy is left carrying the hidden value in the
 * text; no-op if absent or unreachable. Only object properties are
 * addressable (see parsePaths). One property is removed per pass (offsets
 * shift), last in the document first.
 */
function removeProperty(text: string, path: KeyPath): string {
    const matches = (t: string): jsoncParser.Node[] => {
        const tree = jsoncParser.parseTree(t, [], PARSE_OPTIONS);
        if (!tree) return [];
        const key = path[path.length - 1];
        return findAllValues(tree, path.slice(0, -1))
            .filter((parent) => parent.type === 'object')
            .flatMap((parent) => propertiesNamed(parent, key))
            .sort((a, b) => b.offset - a.offset);
    };

    let current = text;
    const initial = matches(current).length;
    for (let pass = 0; pass <= initial; pass++) {
        const [last] = matches(current);
        if (!last) return current;
        current = jsoncParser.applyEdits(current, propertyRemovalEdits(current, last));
    }
    // Each pass removes exactly one property, so this is unreachable unless
    // an edit failed to remove its target — never return a partial strip.
    throw new Error(`Failed to remove "${path.join('.')}": property still present after ${initial} removals.`);
}

/**
 * Edits appending `"key": rawValue` as the last property of `obj`: the
 * separating comma goes right after the last value, the new member on its
 * own line after that line's trailing comments, matching the indentation
 * and trailing-comma style already in use.
 */
function propertyInsertEdits(text: string, obj: jsoncParser.Node, key: string, rawValue: string): jsoncParser.Edit[] {
    const children = obj.children ?? [];
    const memberWith = (eol: string) => `${JSON.stringify(key)}: ${rawValue.replace(/\r\n|\r|\n/g, eol)}`;

    if (children.length === 0) {
        const open = obj.offset + 1;
        const close = obj.offset + obj.length - 1;
        if (!/[\r\n]/.test(text.slice(open, close))) {
            return [{ offset: open, length: 0, content: memberWith(detectEol(text)) }];
        }
        const lineEnd = lineContentEndOf(text, open);
        const at = onlyInlineTrivia(text, open, lineEnd) ? lineEnd : open;
        const eol = lineBreakAt(text, lineEnd);
        return [{ offset: at, length: 0, content: `${eol}${indentOfLine(text, obj.offset)}${detectIndentUnit(text)}${memberWith(eol)}` }];
    }

    const last = children[children.length - 1];
    const lastEnd = last.offset + last.length;
    const next = nextSignificantToken(text, lastEnd);
    const trailingComma = next.kind === jsoncParser.SyntaxKind.CommaToken;
    const anchor = trailingComma ? next.offset + 1 : lastEnd;
    const suffix = trailingComma ? ',' : '';

    // Whenever the rest of the anchor's line is only blanks/comments, start a
    // new line after it — inserting inline would put the new key in front of
    // that line's trailing comment, which would then count as the new key's own.
    const lineEnd = lineContentEndOf(text, anchor);
    if (lineEnd < text.length && onlyInlineTrivia(text, anchor, lineEnd)) {
        const eol = lineBreakAt(text, lineEnd);
        const indent = startsLine(text, last.offset)
            ? indentOfLine(text, last.offset)
            : indentOfLine(text, obj.offset) + detectIndentUnit(text);
        const insert = { offset: lineEnd, length: 0, content: `${eol}${indent}${memberWith(eol)}${suffix}` };
        return trailingComma ? [insert] : [{ offset: lastEnd, length: 0, content: ',' }, insert];
    }
    return [{ offset: anchor, length: 0, content: `${trailingComma ? '' : ','} ${memberWith(detectEol(text))}${suffix}` }];
}

/**
 * Set the value at `path` to `rawValue` (JSON text). Replaces an existing
 * value in place; otherwise appends the missing part of the path to the
 * deepest existing object, creating intermediate objects inline. Throws
 * JsoncFilterMergeError when a non-object blocks the path.
 */
function setRawValue(text: string, path: KeyPath, rawValue: string): string {
    const tree = jsoncParser.parseTree(text, [], PARSE_OPTIONS);
    if (!tree || tree.type !== 'object') {
        throw new JsoncFilterMergeError(path, new Error('candidate root is not an object'));
    }

    const existing = findValue(tree, path);
    if (existing) {
        const content = rawValue.replace(/\r\n|\r|\n/g, detectEol(text));
        return jsoncParser.applyEdits(text, [{ offset: existing.offset, length: existing.length, content }]);
    }

    let obj = tree;
    let depth = 0;
    for (; depth < path.length - 1; depth++) {
        const child = findValue(obj, [path[depth]]);
        if (!child) break;
        if (child.type !== 'object') {
            throw new JsoncFilterMergeError(path, new Error(`"${path.slice(0, depth + 1).join('.')}" is not an object`));
        }
        obj = child;
    }

    let value = rawValue;
    for (let i = path.length - 1; i > depth; i--) {
        value = `{ ${JSON.stringify(path[i])}: ${value} }`;
    }
    return jsoncParser.applyEdits(text, propertyInsertEdits(text, obj, path[depth], value));
}

/**
 * Returns `text` with every key at the given paths removed — in every form
 * the text has it, flat or nested (see concretePaths). Comments and
 * formatting on remaining keys are preserved. No-op when a path does not exist
 * in the input. Paths are processed deepest-first so that removing an outer
 * node does not invalidate positions still pointing inside it.
 */
export function stripKeys(text: string, paths: ReadonlyArray<KeyPath>): string {
    if (paths.length === 0) return text;

    const tree = jsoncParser.parseTree(text, [], PARSE_OPTIONS);
    const ordered = unique(paths.flatMap((p) => concretePaths(tree, p))).sort((a, b) => b.length - a.length);
    let current = text;
    for (const path of ordered) {
        current = removeProperty(current, path);
    }
    return current;
}

/**
 * Returns `candidateText` with every path's value reset to whatever
 * `destinationOriginal` holds at that same path, for each concrete form
 * (flat or nested, see concretePaths) either text has:
 *   - destination has it → set candidate there to destination's value
 *   - destination doesn't → remove it from candidate (if present)
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
    const candidateTree = jsoncParser.parseTree(candidateText, [], PARSE_OPTIONS);

    // Every concrete form either side has (flat "a.b" or nested a → b):
    // each gets the destination's value, or is removed where the destination
    // has none — so each side keeps its own keys in its own shape.
    const concrete = paths.flatMap((p) => [...concretePaths(destTree, p), ...concretePaths(candidateTree, p)]);
    const ordered = unique(concrete).sort((a, b) => b.length - a.length);
    let current = candidateText;
    for (const path of ordered) {
        const destNode = destTree ? findValue(destTree, path) : undefined;
        if (!destNode) {
            // Destination has no value: delete from candidate without eating
            // neighbouring comments. No-op if candidate can't reach the path.
            current = removeProperty(current, path);
            continue;
        }
        // Splice the destination's raw text, so formatting and comments inside
        // the value survive (re-serializing would drop them).
        const rawValue = destinationOriginal.slice(destNode.offset, destNode.offset + destNode.length);
        current = setRawValue(current, path, rawValue);
    }
    return current;
}

function unique(paths: ReadonlyArray<KeyPath>): KeyPath[] {
    const seen = new Map<string, KeyPath>();
    for (const p of paths) seen.set(p.join('\x00'), p);
    return [...seen.values()];
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
