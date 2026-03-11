import fs from 'fs';
import path from 'path';
import util from 'util';

const isProduction = process.env.NODE_ENV === 'production';
const LOG_FILE = path.resolve(__dirname, '../../game.log');

type ConsoleArgs = unknown[];

const nativeConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug ? console.debug : console.log).bind(console),
};

function formatArgs(args: ConsoleArgs): string {
  return util.format(...(args as unknown[]));
}

function appendLogLine(level: string, args: ConsoleArgs): void {
  if (isProduction) {
    return;
  }
  const timestamp = new Date().toISOString();
  const rendered = formatArgs(args);
  const line = `[${timestamp}] [${level}] ${rendered}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // 生产环境静默失败
  }
}

export function getLogFilePath(): string {
  return LOG_FILE;
}

export function installConsoleFileLogging(): void {
  const key = Symbol.for('texas-holdem.console-file-logging.installed');
  const globalRef = globalThis as unknown as Record<symbol, boolean>;
  if (globalRef[key]) return;
  globalRef[key] = true;

  console.log = (...args: ConsoleArgs) => {
    nativeConsole.log(...(args as unknown[]));
    appendLogLine('INFO', args);
  };
  console.info = (...args: ConsoleArgs) => {
    nativeConsole.info(...(args as unknown[]));
    appendLogLine('INFO', args);
  };
  console.warn = (...args: ConsoleArgs) => {
    nativeConsole.warn(...(args as unknown[]));
    appendLogLine('WARN', args);
  };
  console.error = (...args: ConsoleArgs) => {
    nativeConsole.error(...(args as unknown[]));
    appendLogLine('ERROR', args);
  };
  console.debug = (...args: ConsoleArgs) => {
    nativeConsole.debug(...(args as unknown[]));
    appendLogLine('DEBUG', args);
  };

  process.on('uncaughtException', (error) => {
    appendLogLine('FATAL', [error]);
    nativeConsole.error(error);
  });

  process.on('unhandledRejection', (reason) => {
    appendLogLine('UNHANDLED_REJECTION', [reason]);
    nativeConsole.error(reason);
  });
}

export const logger = {
  info: (message: string, ...args: unknown[]) => {
    nativeConsole.info(message, ...args);
    appendLogLine('INFO', [message, ...args]);
  },
  error: (message: string, ...args: unknown[]) => {
    nativeConsole.error(message, ...args);
    appendLogLine('ERROR', [message, ...args]);
  },
  debug: (message: string, ...args: unknown[]) => {
    nativeConsole.debug(message, ...args);
    appendLogLine('DEBUG', [message, ...args]);
  },
};
