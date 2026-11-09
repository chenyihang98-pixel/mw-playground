# 锁文件摘要：334fcae → HEAD

生成命令：`npm run lock-summary -- 334fcae HEAD`

写入文件时加 `-s` 去掉 npm 自己的命令回显：`npm run -s lock-summary -- 334fcae HEAD > <文件>`。脚本只用 git 读取两个提交里的 package-lock.json，不读工作区，不写文件。

| | 引用 | package-lock.json |
|---|---|---|
| 起点 | `334fcae` | blob `842aad1c1a6034c168c7c771fca0e3e0aaf9cac2`，lockfileVersion 3，194 个包条目 |
| 终点 | `HEAD` | blob `139d07f4e0e3093607c7a56f338c7ef91c45ff89`，lockfileVersion 3，219 个包条目 |

## 概览

- 新增：25
- 删除：0
- 版本有变化：0
- 版本没变但 resolved 或 integrity 有变化：0
- 终点缺 integrity：0
- 终点带 hasInstallScript：2
- 终点包条目总数：219

## 新增的包（25）

| 名称 | 安装路径 | 旧版本 | 新版本 | 标记 |
|---|---|---|---|---|
| @cfworker/json-schema | node_modules/@cfworker/json-schema | — | 4.1.1 | — |
| @langchain/core | node_modules/@langchain/core | — | 1.3.0 | — |
| @langchain/langgraph | node_modules/@langchain/langgraph | — | 1.5.3 | — |
| @langchain/langgraph-checkpoint | node_modules/@langchain/langgraph-checkpoint | — | 1.2.1 | — |
| @langchain/langgraph-sdk | node_modules/@langchain/langgraph-sdk | — | 1.12.8 | — |
| eventemitter3 | node_modules/@langchain/langgraph-sdk/node_modules/eventemitter3 | — | 5.0.4 | — |
| p-queue | node_modules/@langchain/langgraph-sdk/node_modules/p-queue | — | 9.3.5 | — |
| p-timeout | node_modules/@langchain/langgraph-sdk/node_modules/p-timeout | — | 7.0.2 | — |
| @langchain/ollama | node_modules/@langchain/ollama | — | 1.3.0 | — |
| @langchain/openai | node_modules/@langchain/openai | — | 1.7.0 | — |
| @langchain/protocol | node_modules/@langchain/protocol | — | 0.0.20 | — |
| @standard-schema/spec | node_modules/@standard-schema/spec | — | 1.1.0 | — |
| base64-js | node_modules/base64-js | — | 1.5.1 | — |
| eventemitter3 | node_modules/eventemitter3 | — | 4.0.7 | — |
| is-network-error | node_modules/is-network-error | — | 1.3.2 | — |
| js-tiktoken | node_modules/js-tiktoken | — | 1.0.21 | — |
| langsmith | node_modules/langsmith | — | 0.11.1 | — |
| mustache | node_modules/mustache | — | 4.2.0 | — |
| ollama | node_modules/ollama | — | 0.6.4 | — |
| openai | node_modules/openai | — | 7.45.0 | — |
| p-finally | node_modules/p-finally | — | 1.0.0 | — |
| p-queue | node_modules/p-queue | — | 6.6.2 | — |
| p-retry | node_modules/p-retry | — | 7.1.1 | — |
| p-timeout | node_modules/p-timeout | — | 3.2.0 | — |
| whatwg-fetch | node_modules/whatwg-fetch | — | 3.6.20 | — |

## 删除的包（0）

（无）

## 版本有变化的包（0）

（无）

## 版本没变但 resolved 或 integrity 有变化的包（0）

（无）

## resolved 来源主机汇总（1）

| 来源 | 起点包数 | 终点包数 |
|---|---|---|
| https://registry.npmjs.org | 194 | 219 |

## 终点缺 integrity 的包（不含 link 条目）（0）

（无）

## 终点带 hasInstallScript 的包（2）

| 名称 | 安装路径 | 版本 | 标记 |
|---|---|---|---|
| esbuild | node_modules/esbuild | 0.28.2 | dev |
| fsevents | node_modules/fsevents | 2.3.3 | dev, optional |
