// 工坊服务的日志（P8）：一行一条，写到标准错误。每一行都先经过脱敏（Redactor），密钥不会出现在日志里。
// 只记事件和归好类的原因，不记玩家的一句话、名册快照和模型的原文。

import type { Redactor } from './errors';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(redactor: Redactor, write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>) => {
    const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    write(redactor.redact(`[workshop] ${new Date().toISOString()} ${level} ${message}${extra}`));
  };
  return {
    info: (m, f) => {
      emit('INFO', m, f);
    },
    warn: (m, f) => {
      emit('WARN', m, f);
    },
    error: (m, f) => {
      emit('ERROR', m, f);
    },
  };
}
