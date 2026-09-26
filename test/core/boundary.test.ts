import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as path from 'node:path';

// Compiled tests run from out-test/test/core; sources live at <repo>/src/core.
const CORE_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'core');

// Every way a TS file can name a module: `from '…'` (import/export),
// side-effect `import '…'`, dynamic/type `import('…')`, and `require('…')`.
const SPECIFIER_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function listTsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listTsFiles(full);
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

export function findBoundaryViolations(file: string, source: string): string[] {
    const violations: string[] = [];
    for (const match of source.matchAll(SPECIFIER_RE)) {
        const spec = match.slice(1).find((g) => g !== undefined)!;
        const rel = path.relative(CORE_DIR, file);
        if (spec === 'vscode') {
            violations.push(`${rel}: ${spec}`);
        } else if (spec.startsWith('.')) {
            const target = path.resolve(path.dirname(file), spec);
            if (path.relative(CORE_DIR, target).startsWith('..')) {
                violations.push(`${rel}: ${spec}`);
            }
        }
    }
    return violations;
}

// core/ must stay host-agnostic so a CLI (or any other front-end) can reuse
// it: no `vscode`, and no reaching back into the extension's adapter modules.
test('src/core imports neither vscode nor modules outside core', () => {
    const files = listTsFiles(CORE_DIR);
    assert.ok(files.length > 0, `no sources found in ${CORE_DIR}`);

    const violations = files.flatMap((file) => findBoundaryViolations(file, fs.readFileSync(file, 'utf-8')));

    assert.deepEqual(violations, []);
});

test('the boundary check catches every import form', () => {
    const file = path.join(CORE_DIR, 'sub', 'x.ts');
    const cases: Array<[string, boolean]> = [
        [`import * as vscode from 'vscode';`, true],
        [`import 'vscode';`, true],
        [`const v = await import('vscode');`, true],
        [`type V = typeof import("vscode");`, true],
        [`const v = require('vscode');`, true],
        [`export { x } from '../../config';`, true],
        [`import { x } from './../../config';`, true],
        [`import { x } from '../plan';`, false],            // sub/ → core/plan: still inside
        [`import { x } from './y';`, false],
        [`import * as fs from 'fs';`, false],
        [`import { neon } from '@neondatabase/serverless';`, false]
    ];

    for (const [source, expectViolation] of cases) {
        assert.equal(findBoundaryViolations(file, source).length > 0, expectViolation, source);
    }
});
