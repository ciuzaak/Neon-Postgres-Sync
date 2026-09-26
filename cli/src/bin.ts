import { defaultContext } from './context';
import { main } from './main';

// `neon-sync status | head -1`: the reader went away. Stop quietly, with the
// status a process killed by SIGPIPE would have, instead of a stack trace.
// (A pipe says EPIPE; a socket pair — stdio from another Node process on
// macOS — may say ENOTCONN or ECONNRESET.)
const READER_GONE = new Set(['EPIPE', 'ENOTCONN', 'ECONNRESET']);
for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: NodeJS.ErrnoException) => {
        if (READER_GONE.has(e.code ?? '')) process.exit(141);
        throw e;
    });
}

main(process.argv.slice(2), defaultContext()).then((code) => {
    process.exitCode = code;
});
