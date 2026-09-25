import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as path from 'node:path';

// Compiled tests run from out-test/test/core; sources live at <repo>/src/core.
const CORE_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'core');

const IMPORT_RE = /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

// core/ must stay host-agnostic so a CLI (or any other front-end) can reuse
// it: no `vscode`, and no reaching back into the extension's adapter modules.
test('src/core imports neither vscode nor modules outside core', () => {
    const files = fs.readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length > 0, `no sources found in ${CORE_DIR}`);

    const violations: string[] = [];
    for (const file of files) {
        const source = fs.readFileSync(path.join(CORE_DIR, file), 'utf-8');
        for (const match of source.matchAll(IMPORT_RE)) {
            const spec = match[1] ?? match[2];
            if (spec === 'vscode' || spec.startsWith('..')) {
                violations.push(`${file}: ${spec}`);
            }
        }
    }

    assert.deepEqual(violations, []);
});
