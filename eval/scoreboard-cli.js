// `npm run scoreboard` renders the red-team scoreboard from eval/results; it never runs a model.
import { renderScoreboard } from './scoreboard.js';

process.stdout.write(renderScoreboard({ resultsDir: process.env.EVAL_RESULTS_DIR }));
