import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

let transportOptions;
if (!isProduction) {
  try {
    // Check if pino-pretty is resolvable
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
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: transportOptions,
});
