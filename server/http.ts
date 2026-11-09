// 工坊服务的 HTTP 接口（P8），用 node:http，只监听 127.0.0.1。请求体有大小上限；请求和响应都用 zod 校验。
// 错误一律返回 { ok: false, error: { code, message } }，消息是固定的说法，不含密钥和提供方返回的原文。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { z } from 'zod';
import {
  ERROR_CODES,
  confirmRequestSchema,
  errorResponseSchema,
  finalizeResponseSchema,
  generateRequestSchema,
  generateResponseSchema,
  generationRefSchema,
  healthResponseSchema,
  okResponseSchema,
  type ErrorResponse,
} from '../src/workshop/protocol';
import { HOST } from './config';
import { WorkshopError } from './errors';
import type { Logger } from './log';
import type { Workshop } from './workshop';

const PREFIX = '/api/workshop/';

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: WorkshopError): void {
  const body: ErrorResponse = errorResponseSchema.parse({ ok: false, error: { code: error.code, message: error.message } });
  send(res, error.status, body);
}

/** 按 schema 校验后再发出去（发出的内容和接口约定一致）。 */
function sendValid<T>(res: ServerResponse, schema: z.ZodType<T>, body: unknown): void {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new WorkshopError(ERROR_CODES.internal, '服务的响应不合规');
  send(res, 200, parsed.data);
}

/** 读请求体，超过上限时拒绝（413）。 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > limit) {
      reject(new WorkshopError(ERROR_CODES.tooLarge, `请求体超过上限（${String(limit)} 字节）`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new WorkshopError(ERROR_CODES.tooLarge, `请求体超过上限（${String(limit)} 字节）`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!failed) reject(new WorkshopError(ERROR_CODES.badRequest, '请求体读取失败'));
    });
  });
}

async function readJson<T>(req: IncomingMessage, limit: number, schema: z.ZodType<T>): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new WorkshopError(ERROR_CODES.badRequest, '请求体必须是 JSON（content-type: application/json）');
  const text = await readBody(req, limit);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkshopError(ERROR_CODES.badRequest, '请求体不是合法的 JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new WorkshopError(ERROR_CODES.badRequest, `请求不合规：${first ? `${first.path.map(String).join('.') || '(根)'}：${first.message}` : '格式不对'}`);
  }
  return parsed.data;
}

export interface ServerOptions {
  readonly maxBodyBytes: number;
}

export function createWorkshopServer(workshop: Workshop, options: ServerOptions, log: Logger): Server {
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
    const method = req.method ?? 'GET';
    if (route === 'health' && method === 'GET') {
      sendValid(res, healthResponseSchema, await workshop.health());
      return;
    }
    if (method === 'POST' && route === 'generate') {
      const body = await readJson(req, options.maxBodyBytes, generateRequestSchema);
      // 浏览器断开（关页面、中止请求）时取消这次生成
      res.on('close', () => {
        if (!res.writableFinished) workshop.cancel(body.generationId);
      });
      sendValid(res, generateResponseSchema, await workshop.generate(body));
      return;
    }
    if (method === 'POST' && route === 'cancel') {
      const body = await readJson(req, options.maxBodyBytes, generationRefSchema);
      workshop.cancel(body.generationId);
      sendValid(res, okResponseSchema, { ok: true });
      return;
    }
    if (method === 'POST' && route === 'confirm') {
      const body = await readJson(req, options.maxBodyBytes, confirmRequestSchema);
      sendValid(res, finalizeResponseSchema, await workshop.confirm(body));
      return;
    }
    if (method === 'POST' && route === 'discard') {
      const body = await readJson(req, options.maxBodyBytes, generationRefSchema);
      await workshop.discard(body.generationId);
      sendValid(res, okResponseSchema, { ok: true });
      return;
    }
    throw new WorkshopError(ERROR_CODES.notFound, '没有这个接口');
  };

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof WorkshopError) {
        sendError(res, error);
        return;
      }
      log.error('处理请求时出错', { path: req.url?.split('?')[0] ?? '', error: error instanceof Error ? error.name : 'unknown' });
      sendError(res, new WorkshopError(ERROR_CODES.internal, '工坊服务内部错误'));
    });
  });
}

/** 只在 127.0.0.1 上监听。port 为 0 时由系统分配。返回实际的端口。 */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}
