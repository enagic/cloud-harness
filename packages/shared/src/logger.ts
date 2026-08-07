/**
 * Line-delimited JSON to stdout. The awslogs driver forwards it verbatim, so
 * CloudWatch Logs Insights can query fields without a parse expression.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVEL_ORDER[(process.env['LOG_LEVEL'] as Level) ?? 'info'] ?? LEVEL_ORDER.info;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a logger that stamps every line with the given fields. */
  child(fields: Record<string, unknown>): Logger;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < threshold) return;

    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...bindings,
    };

    for (const [key, value] of Object.entries(fields ?? {})) {
      payload[key] = key === 'err' || key === 'error' ? serializeError(value) : value;
    }

    const line = JSON.stringify(payload);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger({ ...bindings, ...fields }),
  };
}
