/**
 * Lets Node load the app's own modules the way Vite does: the app's imports
 * may leave off the .js / .jsx extension. Used by the tests and the backtest,
 * so both run the DATA FLOW itself (flow/score-flow.js) rather than a copy.
 *
 *   node --import ./scripts/node-loader.mjs scripts/backtest-early.mjs ...
 */
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('.') || specifier.startsWith('/');
    if (!relative || /\\.[cm]?jsx?$/.test(specifier)) throw error;
    for (const ext of ['.js', '.jsx']) {
      try { return await next(specifier + ext, context); } catch (e) { /* try the next */ }
    }
    throw error;
  }
}
`), import.meta.url);
