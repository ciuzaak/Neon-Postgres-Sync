// Bundles the CLI and src/core into one CommonJS file. Everything is inlined
// except @napi-rs/keyring (a native module, installed as the package's only
// runtime dependency and loaded lazily).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf-8'));

await build({
    entryPoints: [join(here, 'src', 'bin.ts')],
    outfile: join(here, 'dist', 'neon-sync.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // jsonc-parser's `main` is a UMD build esbuild can't follow; use its ESM build.
    mainFields: ['module', 'main'],
    external: ['@napi-rs/keyring'],
    banner: { js: '#!/usr/bin/env node' },
    define: { __NEON_SYNC_VERSION__: JSON.stringify(version) },
    legalComments: 'none',
    logLevel: 'warning'
});
