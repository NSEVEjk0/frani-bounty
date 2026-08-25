/**
 * frani-bounty — lightweight leveled logger
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Zero-dependency, low-overhead console logger. Timestamped, level-gated,
 * and tag-aware so each subsystem (bounty, commands, agent, ...) is easy to grep.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Resolve the active level once at import time; default to `info`.
const activeName = (process.env.LOG_LEVEL || 'info').toLowerCase();
const activeLevel = LEVELS[activeName] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function emit(level, tag, args) {
  if (LEVELS[level] > activeLevel) return;
  const prefix = `${ts()} [${level.toUpperCase()}]${tag ? ` (${tag})` : ''}`;
  // Route warn/error to stderr, everything else to stdout.
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(prefix, ...args);
}

/**
 * Create a logger bound to a subsystem tag.
 * @param {string} [tag] e.g. 'bounty', 'commands', 'agent'
 */
export function createLogger(tag) {
  return {
    error: (...a) => emit('error', tag, a),
    warn: (...a) => emit('warn', tag, a),
    info: (...a) => emit('info', tag, a),
    debug: (...a) => emit('debug', tag, a),
    /** Derive a sub-tagged child logger. */
    child: (sub) => createLogger(tag ? `${tag}:${sub}` : sub),
  };
}

export const log = createLogger();
export default createLogger;
