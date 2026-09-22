// Compatibility entry point: reset now always requires an explicit reviewed plan.
import { main } from './reset-content.js';
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
