const levels = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const configuredLevel = String(process.env.LOG_LEVEL || 'INFO').toUpperCase();
const minLevel = levels[configuredLevel] ?? levels.INFO;
const seenErrors = new Map();

function normalizeMeta(meta) {
  if (meta == null) return undefined;
  if (meta instanceof Error) {
    return {
      error: {
        name: meta.name,
        message: meta.message,
        stack: meta.stack
      }
    };
  }
  if (Array.isArray(meta)) return meta.map((item) => normalizeMeta(item));
  if (typeof meta !== 'object') return { value: meta };

  return Object.fromEntries(Object.entries(meta).map(([key, value]) => {
    if (value instanceof Error) {
      return [key, { name: value.name, message: value.message, stack: value.stack }];
    }
    return [key, value];
  }));
}

function safeJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) return '[Circular]';
      seen.add(current);
    }
    return current;
  });
}

function emit(level, context, message, meta) {
  if ((levels[level] ?? levels.INFO) < minLevel) return;
  const normalizedMeta = normalizeMeta(meta);
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...context,
    ...(normalizedMeta ? { meta: normalizedMeta } : {})
  };
  const line = safeJson(payload);
  if (level === 'ERROR' || level === 'WARN') {
    console.error(line);
    return;
  }
  console.log(line);
}

function createLogger(context = {}) {
  return {
    child(extraContext = {}) {
      return createLogger({ ...context, ...extraContext });
    },
    debug(message, meta) {
      emit('DEBUG', context, message, meta);
    },
    info(message, meta) {
      emit('INFO', context, message, meta);
    },
    warn(message, meta) {
      emit('WARN', context, message, meta);
    },
    error(message, meta) {
      emit('ERROR', context, message, meta);
    },
    errorOnce(key, message, meta) {
      const normalizedMeta = normalizeMeta(meta) || {};
      const fingerprint = safeJson({ message, context, meta: normalizedMeta });
      if (seenErrors.get(key) === fingerprint) return;
      seenErrors.set(key, fingerprint);
      emit('ERROR', context, message, normalizedMeta);
    },
    clearError(key) {
      seenErrors.delete(key);
    }
  };
}

export const logger = createLogger();
