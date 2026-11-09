# 锁文件摘要：f178799 → HEAD

生成命令：`npm run lock-summary -- f178799 HEAD`

写入文件时加 `-s` 去掉 npm 自己的命令回显：`npm run -s lock-summary -- f178799 HEAD > <文件>`。脚本只用 git 读取两个提交里的 package-lock.json，不读工作区，不写文件。

| | 引用 | package-lock.json |
|---|---|---|
| 起点 | `f178799` | 不存在，按空锁文件处理 |
| 终点 | `HEAD` | blob `e9d8f1115301de37f49a60353d55fdc26b43b8fa`，lockfileVersion 3，193 个包条目 |

## 概览

- 新增：193
- 删除：0
- 版本有变化：0
- 版本没变但 resolved 或 integrity 有变化：0
- 终点缺 integrity：0
- 终点带 hasInstallScript：2
- 终点包条目总数：193

## 新增的包（193）

| 名称 | 安装路径 | 旧版本 | 新版本 | 标记 |
|---|---|---|---|---|
| @cacheable/memory | node_modules/@cacheable/memory | — | 2.2.0 | dev |
| @cacheable/utils | node_modules/@cacheable/utils | — | 2.5.0 | dev |
| @dimforge/rapier3d-compat | node_modules/@dimforge/rapier3d-compat | — | 0.12.0 | dev |
| @esbuild/aix-ppc64 | node_modules/@esbuild/aix-ppc64 | — | 0.28.2 | dev, optional |
| @esbuild/android-arm | node_modules/@esbuild/android-arm | — | 0.28.2 | dev, optional |
| @esbuild/android-arm64 | node_modules/@esbuild/android-arm64 | — | 0.28.2 | dev, optional |
| @esbuild/android-x64 | node_modules/@esbuild/android-x64 | — | 0.28.2 | dev, optional |
| @esbuild/darwin-arm64 | node_modules/@esbuild/darwin-arm64 | — | 0.28.2 | dev, optional |
| @esbuild/darwin-x64 | node_modules/@esbuild/darwin-x64 | — | 0.28.2 | dev, optional |
| @esbuild/freebsd-arm64 | node_modules/@esbuild/freebsd-arm64 | — | 0.28.2 | dev, optional |
| @esbuild/freebsd-x64 | node_modules/@esbuild/freebsd-x64 | — | 0.28.2 | dev, optional |
| @esbuild/linux-arm | node_modules/@esbuild/linux-arm | — | 0.28.2 | dev, optional |
| @esbuild/linux-arm64 | node_modules/@esbuild/linux-arm64 | — | 0.28.2 | dev, optional |
| @esbuild/linux-ia32 | node_modules/@esbuild/linux-ia32 | — | 0.28.2 | dev, optional |
| @esbuild/linux-loong64 | node_modules/@esbuild/linux-loong64 | — | 0.28.2 | dev, optional |
| @esbuild/linux-mips64el | node_modules/@esbuild/linux-mips64el | — | 0.28.2 | dev, optional |
| @esbuild/linux-ppc64 | node_modules/@esbuild/linux-ppc64 | — | 0.28.2 | dev, optional |
| @esbuild/linux-riscv64 | node_modules/@esbuild/linux-riscv64 | — | 0.28.2 | dev, optional |
| @esbuild/linux-s390x | node_modules/@esbuild/linux-s390x | — | 0.28.2 | dev, optional |
| @esbuild/linux-x64 | node_modules/@esbuild/linux-x64 | — | 0.28.2 | dev, optional |
| @esbuild/netbsd-arm64 | node_modules/@esbuild/netbsd-arm64 | — | 0.28.2 | dev, optional |
| @esbuild/netbsd-x64 | node_modules/@esbuild/netbsd-x64 | — | 0.28.2 | dev, optional |
| @esbuild/openbsd-arm64 | node_modules/@esbuild/openbsd-arm64 | — | 0.28.2 | dev, optional |
| @esbuild/openbsd-x64 | node_modules/@esbuild/openbsd-x64 | — | 0.28.2 | dev, optional |
| @esbuild/openharmony-arm64 | node_modules/@esbuild/openharmony-arm64 | — | 0.28.2 | dev, optional |
| @esbuild/sunos-x64 | node_modules/@esbuild/sunos-x64 | — | 0.28.2 | dev, optional |
| @esbuild/win32-arm64 | node_modules/@esbuild/win32-arm64 | — | 0.28.2 | dev, optional |
| @esbuild/win32-ia32 | node_modules/@esbuild/win32-ia32 | — | 0.28.2 | dev, optional |
| @esbuild/win32-x64 | node_modules/@esbuild/win32-x64 | — | 0.28.2 | dev, optional |
| @eslint-community/eslint-utils | node_modules/@eslint-community/eslint-utils | — | 4.10.1 | dev |
| eslint-visitor-keys | node_modules/@eslint-community/eslint-utils/node_modules/eslint-visitor-keys | — | 3.4.3 | dev |
| @eslint-community/regexpp | node_modules/@eslint-community/regexpp | — | 4.12.3 | dev |
| @eslint/config-array | node_modules/@eslint/config-array | — | 0.23.5 | dev |
| @eslint/config-helpers | node_modules/@eslint/config-helpers | — | 0.7.0 | dev |
| @eslint/core | node_modules/@eslint/core | — | 1.2.1 | dev |
| @eslint/object-schema | node_modules/@eslint/object-schema | — | 3.0.5 | dev |
| @eslint/plugin-kit | node_modules/@eslint/plugin-kit | — | 0.7.3 | dev |
| @humanfs/core | node_modules/@humanfs/core | — | 0.19.2 | dev |
| @humanfs/node | node_modules/@humanfs/node | — | 0.16.8 | dev |
| @humanfs/types | node_modules/@humanfs/types | — | 0.15.0 | dev |
| @humanwhocodes/module-importer | node_modules/@humanwhocodes/module-importer | — | 1.0.1 | dev |
| @humanwhocodes/retry | node_modules/@humanwhocodes/retry | — | 0.4.3 | dev |
| @jridgewell/resolve-uri | node_modules/@jridgewell/resolve-uri | — | 3.1.2 | dev |
| @jridgewell/sourcemap-codec | node_modules/@jridgewell/sourcemap-codec | — | 1.6.0 | dev |
| @jridgewell/trace-mapping | node_modules/@jridgewell/trace-mapping | — | 0.3.31 | dev |
| @keyv/bigmap | node_modules/@keyv/bigmap | — | 1.3.1 | dev |
| @keyv/serialize | node_modules/@keyv/serialize | — | 1.1.1 | dev |
| @oxc-project/types | node_modules/@oxc-project/types | — | 0.156.0 | dev |
| @playwright/test | node_modules/@playwright/test | — | 1.65.0 | dev |
| @rolldown/binding-android-arm-eabi | node_modules/@rolldown/binding-android-arm-eabi | — | 1.2.16 | dev, optional |
| @rolldown/binding-android-arm64 | node_modules/@rolldown/binding-android-arm64 | — | 1.2.16 | dev, optional |
| @rolldown/binding-darwin-arm64 | node_modules/@rolldown/binding-darwin-arm64 | — | 1.2.16 | dev, optional |
| @rolldown/binding-darwin-x64 | node_modules/@rolldown/binding-darwin-x64 | — | 1.2.16 | dev, optional |
| @rolldown/binding-freebsd-x64 | node_modules/@rolldown/binding-freebsd-x64 | — | 1.2.16 | dev, optional |
| @rolldown/binding-linux-arm-gnueabihf | node_modules/@rolldown/binding-linux-arm-gnueabihf | — | 1.2.16 | dev, optional |
| @rolldown/binding-linux-arm64-gnu | node_modules/@rolldown/binding-linux-arm64-gnu | — | 1.2.16 | dev, optional |
| @rolldown/binding-linux-arm64-musl | node_modules/@rolldown/binding-linux-arm64-musl | — | 1.2.16 | dev, optional |
| @rolldown/binding-linux-ppc64-gnu | node_modules/@rolldown/binding-linux-ppc64-gnu | — | 1.2.16 | dev, optional |
| @rolldown/binding-linux-s390x-gnu | node_modules/@rolldown/binding-linux-s390x-gnu | — | 1.2.16 | dev, optional |
| @rolldown/binding-linux-x64-gnu | node_modules/@rolldown/binding-linux-x64-gnu | — | 1.2.16 | dev, optional |
| @rolldown/binding-linux-x64-musl | node_modules/@rolldown/binding-linux-x64-musl | — | 1.2.16 | dev, optional |
| @rolldown/binding-openharmony-arm64 | node_modules/@rolldown/binding-openharmony-arm64 | — | 1.2.16 | dev, optional |
| @rolldown/binding-win32-arm64-msvc | node_modules/@rolldown/binding-win32-arm64-msvc | — | 1.2.16 | dev, optional |
| @rolldown/binding-win32-x64-msvc | node_modules/@rolldown/binding-win32-x64-msvc | — | 1.2.16 | dev, optional |
| @rolldown/pluginutils | node_modules/@rolldown/pluginutils | — | 1.0.1 | dev |
| @tweenjs/tween.js | node_modules/@tweenjs/tween.js | — | 23.1.3 | dev |
| @types/chai | node_modules/@types/chai | — | 5.2.3 | dev |
| @types/deep-eql | node_modules/@types/deep-eql | — | 4.0.2 | dev |
| @types/esrecurse | node_modules/@types/esrecurse | — | 4.3.1 | dev |
| @types/estree | node_modules/@types/estree | — | 1.0.10 | dev |
| @types/json-schema | node_modules/@types/json-schema | — | 7.0.15 | dev |
| @types/node | node_modules/@types/node | — | 24.19.2 | dev |
| @types/stats.js | node_modules/@types/stats.js | — | 0.17.4 | dev |
| @types/three | node_modules/@types/three | — | 0.187.0 | dev |
| @types/webxr | node_modules/@types/webxr | — | 0.5.24 | dev |
| @typescript-eslint/eslint-plugin | node_modules/@typescript-eslint/eslint-plugin | — | 8.72.1 | dev |
| ignore | node_modules/@typescript-eslint/eslint-plugin/node_modules/ignore | — | 7.0.14 | dev |
| @typescript-eslint/parser | node_modules/@typescript-eslint/parser | — | 8.72.1 | dev |
| @typescript-eslint/project-service | node_modules/@typescript-eslint/project-service | — | 8.72.1 | dev |
| @typescript-eslint/scope-manager | node_modules/@typescript-eslint/scope-manager | — | 8.72.1 | dev |
| @typescript-eslint/tsconfig-utils | node_modules/@typescript-eslint/tsconfig-utils | — | 8.72.1 | dev |
| @typescript-eslint/type-utils | node_modules/@typescript-eslint/type-utils | — | 8.72.1 | dev |
| @typescript-eslint/types | node_modules/@typescript-eslint/types | — | 8.72.1 | dev |
| @typescript-eslint/typescript-estree | node_modules/@typescript-eslint/typescript-estree | — | 8.72.1 | dev |
| @typescript-eslint/utils | node_modules/@typescript-eslint/utils | — | 8.72.1 | dev |
| @typescript-eslint/visitor-keys | node_modules/@typescript-eslint/visitor-keys | — | 8.72.1 | dev |
| @vitest/mocker | node_modules/@vitest/mocker | — | 5.1.0 | dev |
| @vitest/spy | node_modules/@vitest/spy | — | 5.1.0 | dev |
| acorn | node_modules/acorn | — | 8.19.0 | dev |
| acorn-jsx | node_modules/acorn-jsx | — | 5.3.2 | dev |
| ajv | node_modules/ajv | — | 6.15.0 | dev |
| assertion-error | node_modules/assertion-error | — | 2.0.1 | dev |
| balanced-match | node_modules/balanced-match | — | 4.0.4 | dev |
| brace-expansion | node_modules/brace-expansion | — | 5.0.12 | dev |
| cacheable | node_modules/cacheable | — | 2.5.0 | dev |
| chai | node_modules/chai | — | 6.3.0 | dev |
| cross-spawn | node_modules/cross-spawn | — | 7.0.6 | dev |
| debug | node_modules/debug | — | 4.4.3 | dev |
| deep-is | node_modules/deep-is | — | 0.1.4 | dev |
| detect-libc | node_modules/detect-libc | — | 2.1.2 | dev |
| es-module-lexer | node_modules/es-module-lexer | — | 2.3.2 | dev |
| esbuild | node_modules/esbuild | — | 0.28.2 | dev |
| escape-string-regexp | node_modules/escape-string-regexp | — | 4.0.0 | dev |
| eslint | node_modules/eslint | — | 10.14.0 | dev |
| eslint-scope | node_modules/eslint-scope | — | 9.1.2 | dev |
| eslint-visitor-keys | node_modules/eslint-visitor-keys | — | 5.0.1 | dev |
| espree | node_modules/espree | — | 11.2.0 | dev |
| esquery | node_modules/esquery | — | 1.7.0 | dev |
| esrecurse | node_modules/esrecurse | — | 4.3.0 | dev |
| estraverse | node_modules/estraverse | — | 5.3.0 | dev |
| estree-walker | node_modules/estree-walker | — | 3.0.3 | dev |
| esutils | node_modules/esutils | — | 2.0.3 | dev |
| expect-type | node_modules/expect-type | — | 1.4.0 | dev |
| fast-deep-equal | node_modules/fast-deep-equal | — | 3.1.3 | dev |
| fast-json-stable-stringify | node_modules/fast-json-stable-stringify | — | 2.1.0 | dev |
| fast-levenshtein | node_modules/fast-levenshtein | — | 2.0.6 | dev |
| fdir | node_modules/fdir | — | 6.5.0 | dev |
| fflate | node_modules/fflate | — | 0.8.3 | dev |
| file-entry-cache | node_modules/file-entry-cache | — | 11.1.5 | dev |
| find-up | node_modules/find-up | — | 5.0.0 | dev |
| flat-cache | node_modules/flat-cache | — | 6.1.23 | dev |
| flatted | node_modules/flatted | — | 3.4.4 | dev |
| fsevents | node_modules/fsevents | — | 2.3.3 | dev, optional |
| glob-parent | node_modules/glob-parent | — | 6.0.2 | dev |
| hashery | node_modules/hashery | — | 1.5.1 | dev |
| hookified | node_modules/hookified | — | 1.15.1 | dev |
| ignore | node_modules/ignore | — | 5.3.2 | dev |
| imurmurhash | node_modules/imurmurhash | — | 0.1.4 | dev |
| is-extglob | node_modules/is-extglob | — | 2.1.1 | dev |
| is-glob | node_modules/is-glob | — | 4.0.3 | dev |
| isexe | node_modules/isexe | — | 2.0.0 | dev |
| json-schema-traverse | node_modules/json-schema-traverse | — | 0.4.1 | dev |
| json-stable-stringify-without-jsonify | node_modules/json-stable-stringify-without-jsonify | — | 1.0.1 | dev |
| keyv | node_modules/keyv | — | 5.6.0 | dev |
| levn | node_modules/levn | — | 0.4.1 | dev |
| lightningcss | node_modules/lightningcss | — | 1.33.0 | dev |
| lightningcss-android-arm64 | node_modules/lightningcss-android-arm64 | — | 1.33.0 | dev, optional |
| lightningcss-darwin-arm64 | node_modules/lightningcss-darwin-arm64 | — | 1.33.0 | dev, optional |
| lightningcss-darwin-x64 | node_modules/lightningcss-darwin-x64 | — | 1.33.0 | dev, optional |
| lightningcss-freebsd-x64 | node_modules/lightningcss-freebsd-x64 | — | 1.33.0 | dev, optional |
| lightningcss-linux-arm-gnueabihf | node_modules/lightningcss-linux-arm-gnueabihf | — | 1.33.0 | dev, optional |
| lightningcss-linux-arm64-gnu | node_modules/lightningcss-linux-arm64-gnu | — | 1.33.0 | dev, optional |
| lightningcss-linux-arm64-musl | node_modules/lightningcss-linux-arm64-musl | — | 1.33.0 | dev, optional |
| lightningcss-linux-x64-gnu | node_modules/lightningcss-linux-x64-gnu | — | 1.33.0 | dev, optional |
| lightningcss-linux-x64-musl | node_modules/lightningcss-linux-x64-musl | — | 1.33.0 | dev, optional |
| lightningcss-win32-arm64-msvc | node_modules/lightningcss-win32-arm64-msvc | — | 1.33.0 | dev, optional |
| lightningcss-win32-x64-msvc | node_modules/lightningcss-win32-x64-msvc | — | 1.33.0 | dev, optional |
| locate-path | node_modules/locate-path | — | 6.0.0 | dev |
| magic-string | node_modules/magic-string | — | 1.4.5 | dev |
| meshoptimizer | node_modules/meshoptimizer | — | 1.1.1 | dev |
| minimatch | node_modules/minimatch | — | 10.2.6 | dev |
| ms | node_modules/ms | — | 2.1.3 | dev |
| nanoid | node_modules/nanoid | — | 3.3.20 | dev |
| natural-compare | node_modules/natural-compare | — | 1.4.0 | dev |
| obug | node_modules/obug | — | 3.0.0 | dev |
| optionator | node_modules/optionator | — | 0.9.4 | dev |
| p-limit | node_modules/p-limit | — | 3.1.0 | dev |
| p-locate | node_modules/p-locate | — | 5.0.0 | dev |
| path-exists | node_modules/path-exists | — | 4.0.0 | dev |
| path-key | node_modules/path-key | — | 3.1.1 | dev |
| picocolors | node_modules/picocolors | — | 1.1.1 | dev |
| picomatch | node_modules/picomatch | — | 4.0.7 | dev |
| playwright | node_modules/playwright | — | 1.65.0 | dev |
| playwright-core | node_modules/playwright-core | — | 1.65.0 | dev |
| postcss | node_modules/postcss | — | 8.5.32 | dev |
| prelude-ls | node_modules/prelude-ls | — | 1.2.1 | dev |
| punycode | node_modules/punycode | — | 2.3.1 | dev |
| qified | node_modules/qified | — | 0.10.1 | dev |
| hookified | node_modules/qified/node_modules/hookified | — | 2.2.0 | dev |
| rolldown | node_modules/rolldown | — | 1.2.16 | dev |
| semver | node_modules/semver | — | 7.8.6 | dev |
| shebang-command | node_modules/shebang-command | — | 2.0.0 | dev |
| shebang-regex | node_modules/shebang-regex | — | 3.0.0 | dev |
| source-map-js | node_modules/source-map-js | — | 1.2.2 | dev |
| std-env | node_modules/std-env | — | 4.3.0 | dev |
| three | node_modules/three | — | 0.187.0 | — |
| tinybench | node_modules/tinybench | — | 6.2.3 | dev |
| tinyexec | node_modules/tinyexec | — | 1.3.1 | dev |
| tinyglobby | node_modules/tinyglobby | — | 0.2.17 | dev |
| ts-api-utils | node_modules/ts-api-utils | — | 2.5.0 | dev |
| tsx | node_modules/tsx | — | 4.23.15 | dev |
| type-check | node_modules/type-check | — | 0.4.0 | dev |
| typescript | node_modules/typescript | — | 6.0.3 | dev |
| typescript-eslint | node_modules/typescript-eslint | — | 8.72.1 | dev |
| undici-types | node_modules/undici-types | — | 7.24.6 | dev |
| uri-js | node_modules/uri-js | — | 4.4.1 | dev |
| vite | node_modules/vite | — | 8.3.6 | dev |
| vitest | node_modules/vitest | — | 5.1.0 | dev |
| which | node_modules/which | — | 2.0.2 | dev |
| why-is-node-running | node_modules/why-is-node-running | — | 3.2.1 | dev |
| word-wrap | node_modules/word-wrap | — | 1.2.5 | dev |
| yocto-queue | node_modules/yocto-queue | — | 0.1.0 | dev |
| zod | node_modules/zod | — | 4.6.7 | — |

## 删除的包（0）

（无）

## 版本有变化的包（0）

（无）

## 版本没变但 resolved 或 integrity 有变化的包（0）

（无）

## resolved 来源主机汇总（1）

| 来源 | 起点包数 | 终点包数 |
|---|---|---|
| https://registry.npmjs.org | 0 | 193 |

## 终点缺 integrity 的包（不含 link 条目）（0）

（无）

## 终点带 hasInstallScript 的包（2）

| 名称 | 安装路径 | 版本 | 标记 |
|---|---|---|---|
| esbuild | node_modules/esbuild | 0.28.2 | dev |
| fsevents | node_modules/fsevents | 2.3.3 | dev, optional |
