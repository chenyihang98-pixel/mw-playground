// 关卡工坊的本机服务入口（P8）：node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs server/main.ts
// （npm run workshop-server；npm run dev:workshop 同时起 Vite 和这个服务）。只监听 127.0.0.1。

import { loadConfig, modelNameOf } from './config';
import { Redactor } from './errors';
import { FakeProvider } from './fakeProvider';
import { createWorkshopServer, listen } from './http';
import { createLogger } from './log';
import { createProvider } from './providers';
import { JsonlStats } from './stats';
import { Workshop } from './workshop';

// 不把调用记录发给任何外部服务（LangChain 的追踪只在设了相应的环境变量时才会打开，这里显式关掉）
process.env.LANGCHAIN_TRACING_V2 = 'false';
process.env.LANGSMITH_TRACING = 'false';

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  for (const problem of loaded.problems) process.stderr.write(`[workshop] 配置有误：${problem}\n`);
  process.exit(1);
}
const config = loaded.config;
const redactor = new Redactor([config.openai.apiKey]);
const log = createLogger(redactor);
const provider = config.provider === 'fake' ? new FakeProvider({ delayMs: config.fakeDelayMs }) : createProvider(config);
const workshop = new Workshop({ config, provider, stats: new JsonlStats(config.statsPath), log });
const server = createWorkshopServer(workshop, { maxBodyBytes: config.limits.maxBodyBytes }, log);

const port = await listen(server, config.port);
// 测试读这一行拿到实际的端口
process.stdout.write(`工坊服务已启动：http://127.0.0.1:${String(port)}（提供方 ${config.provider}，模型 ${modelNameOf(config) ?? '无'}）\n`);

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
