/**
 * Keep API keys out of every log line and error message, ported from ffpr_common/redact.py.
 * Python attaches a logging.Filter to each handler; here redactingLogger wraps a logger instead,
 * because dsh exports structured records rather than Python LogRecord objects.
 */

export const MASK = "***";
const SHORTEST_SECRET = 6;

export class Redactor {
  private readonly secrets = new Set<string>();

  add(value: string): void {
    // Very short values would mask ordinary words; real API keys are long.
    if (value.length >= SHORTEST_SECRET) this.secrets.add(value);
  }

  redact(text: string): string {
    let redacted = text;
    for (const secret of this.secrets) redacted = redacted.replaceAll(secret, MASK);
    return redacted;
  }
}

/** The four severity methods of a dsh logger, without importing dsh into the engine. */
export interface LogSink {
  error(format: unknown, ...params: unknown[]): void;
  info(format: unknown, ...params: unknown[]): void;
  warn(format: unknown, ...params: unknown[]): void;
  debug(format: unknown, ...params: unknown[]): void;
}

/**
 * Format and redact before handing a single string to the wrapped logger. Errors could otherwise
 * carry a key in their message, and dsh formats arguments only inside its exporters.
 */
export function redactingLogger(logger: LogSink, redactor: Redactor): LogSink {
  return {
    error: (format, ...params) => {
      logger.error(redactor.redact(formatLog(format, params)));
    },
    info: (format, ...params) => {
      logger.info(redactor.redact(formatLog(format, params)));
    },
    warn: (format, ...params) => {
      logger.warn(redactor.redact(formatLog(format, params)));
    },
    debug: (format, ...params) => {
      logger.debug(redactor.redact(formatLog(format, params)));
    },
  };
}

/** dsh's printf formatting (cordis Logger.format), enough to redact the finished text. */
function formatLog(format: unknown, params: readonly unknown[]): string {
  const values = [...params];
  let template: unknown = format;
  if (format instanceof Error) {
    template = "%s";
    values.unshift(format.stack || format.message);
  } else if (typeof format !== "string") {
    template = "%o";
    values.unshift(format);
  }
  let rendered = String(template);
  rendered = rendered.replace(/%([a-zA-Z%])/g, (match, char: string) => {
    if (match === "%%") return "%";
    if (char === "s") return String(values.shift());
    if (char === "d" || char === "i") return String(Math.trunc(Number(values.shift())));
    if (char === "f") return String(Number(values.shift()));
    if (char === "o" || char === "O") return json(values.shift());
    if (char === "c" || char === "C") {
      values.shift();
      return "";
    }
    return match;
  });
  for (const value of values) {
    rendered += ` ${typeof value === "object" && value !== null ? json(value) : String(value)}`;
  }
  return rendered;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
