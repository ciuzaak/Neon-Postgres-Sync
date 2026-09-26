import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..', '..');
const CLI_SRC = path.join(REPO, 'cli', 'src');
const SPEC_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;

function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? tsFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []
    );
}

// The CLI may use src/core but never the extension's adapters or vscode.
test('cli/src imports only src/core from the extension, and never vscode', () => {
    const coreDir = path.join(REPO, 'src', 'core') + path.sep;
    const srcDir = path.join(REPO, 'src') + path.sep;
    const violations: string[] = [];
    for (const file of tsFiles(CLI_SRC)) {
        for (const m of fs.readFileSync(file, 'utf-8').matchAll(SPEC_RE)) {
            const spec = m.slice(1).find((g) => g !== undefined)!;
            if (spec === 'vscode') violations.push(`${file}: vscode`);
            if (!spec.startsWith('.')) continue;
            const target = path.resolve(path.dirname(file), spec) + path.sep;
            if (target.startsWith(srcDir) && !target.startsWith(coreDir)) violations.push(`${path.relative(REPO, file)}: ${spec}`);
        }
    }
    assert.deepEqual(violations, []);
});

test('the published package pins the same keychain version as the dev toolchain', () => {
    const root = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
    const cli = JSON.parse(fs.readFileSync(path.join(REPO, 'cli', 'package.json'), 'utf-8'));
    assert.equal(cli.dependencies['@napi-rs/keyring'], root.devDependencies['@napi-rs/keyring']);
    assert.deepEqual(Object.keys(cli.dependencies), ['@napi-rs/keyring'], 'everything else is bundled');
});
