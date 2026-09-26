import { defaultContext } from './context';
import { main } from './main';

// `neon-sync status | head -1`: the reader went away. Stop quietly, with the
// status a process killed by SIGPIPE would have, instead of a stack trace.
for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EPIPE') process.exit(141);
        throw e;
    });
}

main(process.argv.slice(2), defaultContext()).then((code) => {
    process.exitCode = code;
});
