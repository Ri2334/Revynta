import pino from 'pino';

export * from './errors.js';
export * from './metrics.js';
export * from './tracing.js';

const isProduction = process.env.NODE_ENV === 'production';

let transportOptions;
if (!isProduction) {
  try {
    require.resolve('pino-pretty');
    transportOptions = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  } catch {
    // Fail silently and use standard JSON logger
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  redact: {
    paths: [
      'password',
      'password_hash',
      'passwordHash',
      'accessToken',
      'accessTokenEncrypted',
      'rawKey',
      'key_hash',
      'keyHash',
      'appSecret',
      'authorization',
      'cookie',
      'encrypted_value',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.accessToken',
      '*.rawKey',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: transportOptions,
});
