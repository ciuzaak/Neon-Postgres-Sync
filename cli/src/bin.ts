import { defaultContext } from './context';
import { main } from './main';

main(process.argv.slice(2), defaultContext()).then((code) => {
    process.exitCode = code;
});
