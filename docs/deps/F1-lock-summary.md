# 锁文件摘要：bac6687 → HEAD

生成命令：`npm run lock-summary -- bac6687 HEAD`

写入文件时加 `-s` 去掉 npm 自己的命令回显：`npm run -s lock-summary -- bac6687 HEAD > <文件>`。脚本只用 git 读取两个提交里的 package-lock.json，不读工作区，不写文件。

| | 引用 | package-lock.json |
|---|---|---|
| 起点 | `bac6687` | blob `e9d8f1115301de37f49a60353d55fdc26b43b8fa`，lockfileVersion 3，193 个包条目 |
| 终点 | `HEAD` | blob `842aad1c1a6034c168c7c771fca0e3e0aaf9cac2`，lockfileVersion 3，194 个包条目 |

## 概览

- 新增：1
- 删除：0
- 版本有变化：1
- 版本没变但 resolved 或 integrity 有变化：0
- 终点缺 integrity：0
- 终点带 hasInstallScript：2
- 终点包条目总数：194

## 新增的包（1）

| 名称 | 安装路径 | 旧版本 | 新版本 | 标记 |
|---|---|---|---|---|
| @isaacs/nonrecursive-glob-match | node_modules/@isaacs/nonrecursive-glob-match | — | 1.1.0 | dev |

## 删除的包（0）

（无）

## 版本有变化的包（1）

| 名称 | 安装路径 | 旧版本 | 新版本 |
|---|---|---|---|
| minimatch | node_modules/minimatch | 10.2.6 | 11.0.5 |

## 版本没变但 resolved 或 integrity 有变化的包（0）

（无）

## resolved 来源主机汇总（1）

| 来源 | 起点包数 | 终点包数 |
|---|---|---|
| https://registry.npmjs.org | 193 | 194 |

## 终点缺 integrity 的包（不含 link 条目）（0）

（无）

## 终点带 hasInstallScript 的包（2）

| 名称 | 安装路径 | 版本 | 标记 |
|---|---|---|---|
| esbuild | node_modules/esbuild | 0.28.2 | dev |
| fsevents | node_modules/fsevents | 2.3.3 | dev, optional |
