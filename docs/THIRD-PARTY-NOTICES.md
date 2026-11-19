# LawLink 第三方开源组件许可清单（THIRD-PARTY NOTICES）

| 项 | 值 |
|---|---|
| 文档版本 | 1.0 |
| 生成日期 | 2026-11-19 |
| 适用产品 | LawLink（`package.json` name=`lawlink`，version=`2.0.1`） |
| 本项目许可 | MIT License，Copyright (c) 2026 叶森 (Sen Ye) |
| 清单基数 | **901** 个 `name@version`（含全部传递依赖，去重后） |
| 其中生产依赖 | 499 个 |
| 其中仅开发依赖 | 402 个 |
| 数据来源 | ① `package-lock.json`（lockfileVersion 3；981 个安装条目，另 1 条为根项目记录）；② 本机 `node_modules` 逐目录实读；③ 部署镜像 `lawlink-app:latest` 内 `/app/node_modules` 实读 |
| 复核方式 | 见 §9，命令可直接重跑 |

> **本文件是 LawLink 面向分发对象的第三方组件版权与许可声明载体。**
> 按 MIT / ISC / BSD / Apache-2.0 等许可证的要求，分发本产品（含 Docker 镜像、源码包、构建产物）时应随附本文件与项目根目录的 `LICENSE`。

---

## 1. 本项目自身的许可声明

LawLink 自身以 MIT 许可证发布。以下段落可直接随产品分发：

```text
LawLink — 开源中国律所案件管理系统
Copyright (c) 2026 叶森 (Sen Ye)

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

项目根目录的 `LICENSE` 文件与本段完全一致（已实读核对，见 §9 复核项 ④）。

---

## 2. 开源组件合规义务履行声明

> **本产品包含 MIT 许可的开源组件，已履行保留版权与许可声明的义务。**

义务的落地方式，逐项对应：

| 许可证要求 | LawLink 的履行方式 | 状态 |
|---|---|---|
| MIT：「上述版权声明和本许可声明应包含在软件的所有副本或实质部分中」 | ① 本文件保留每个组件的包名、版本与许可证标识；② 各组件自带的 `LICENSE`／`LICENSE.md`／`COPYING` 原文件随 `node_modules` 一同保留并随镜像分发（实测：本机已安装的 784 个组件中 737 个自带许可文本文件；其余 47 个由本清单承载声明，见 §6）；③ 分发时随附本文件 | 已履行 |
| ISC：「保留版权声明与许可声明」 | 同上；ISC 与 MIT 义务等价 | 已履行 |
| BSD-2/3-Clause：「保留版权声明、条件清单与免责声明；不得使用贡献者名称为产品背书」 | ① 同上保留原文；② 本项目未在任何宣传物料中使用第三方作者/机构名称背书 | 已履行 |
| Apache-2.0：「提供许可证副本、保留 NOTICE 文件、标注修改」 | ① 组件自带 `LICENSE` 保留；② **本项目未修改任何第三方源码**（实测：仓库无 `patches/` 目录、无 `patch-package`/`patchedDependencies`、无 `*.patch` 文件，`package.json` 的 `overrides` 仅调整版本解析、不改源码）；③ Apache-2.0 组件的 `NOTICE`（如有）随包保留 | 已履行 |
| MPL-2.0（文件级 copyleft）：「修改过的源文件须以 MPL 公开」 | 本项目未修改任何 MPL 组件的源文件（仅以未修改形式作为开发工具链依赖使用，见 §5.3） | 已履行（无修改即无公开义务） |
| LGPL-3.0-or-later：「动态链接使用须可替换／可重链接，并提供许可证副本与修改说明」 | libvips 以独立共享库 `libvips-cpp.so` 形式由 sharp 在运行时加载，未静态链接、未修改（见 §5.1、§7.2） | 有条件履行，见 §7.2 |

**未修改声明**：LawLink 对全部第三方组件均以「未修改的上游发布物」形式使用。唯一的例外性说明见 §7.1（`buffers@0.1.1` 无许可证声明）与 §5.2（`jszip`／`pizzip` 双许可择一）。

---

## 3. 许可证分布总览

| 许可证家族 | 组件数（去重） | 其中生产 | 其中开发 | 商用可用性 |
|---|---|---|---|---|
| MIT | 706 | 350 | 356 | 可用 |
| Apache-2.0 | 88 | 68 | 20 | 可用 |
| ISC | 52 | 44 | 8 | 可用 |
| BSD | 22 | 11 | 11 | 可用 |
| MPL-2.0 | 1 | 0 | 1 | 可用（文件级 copyleft） |
| LGPL-3.0-or-later | 14 | 14 | 0 | 有条件可用（动态链接） |
| 其他 | 18 | 12 | 6 | 可用（逐项见 §5） |
| **合计** | **901** | **499** | **402** | — |

统计口径说明：

- 计数单位为 `name@version`（同一包的多份副本按版本区分；同一版本只计一次）。
- 「生产／开发」取自 `package-lock.json` 的 `dev` 标记：只要能从 `dependencies` 到达即为生产依赖。
- `package-lock.json` 中另有 123 条带 `os`/`cpu` 约束的平台专用二进制记录；它们按平台择优安装，下表以「平台专用二进制」标注。

---

## 4. 分组清单

### 4.1 MIT 家族（MIT / MIT-0 / MIT/X11 / MIT AND ISC / MIT AND Zlib）
共 **706** 个（生产 350 / 开发 356）。含 MIT 变体与组合式 MIT 许可；义务等同于 MIT。

| 包名 | 版本 | 许可证（package.json 原值） | 依赖类型 | 平台限定 |
|---|---|---|---|---|
| `@adobe/css-tools` | 4.5.0 | MIT | 开发 | 全部 |
| `@alloc/quick-lru` | 5.2.0 | MIT | 生产 | 全部 |
| `@asamuzakjp/css-color` | 5.1.11 | MIT | 开发 | 全部 |
| `@asamuzakjp/dom-selector` | 7.1.1 | MIT | 开发 | 全部 |
| `@asamuzakjp/generational-cache` | 1.0.1 | MIT | 开发 | 全部 |
| `@asamuzakjp/nwsapi` | 2.3.9 | MIT | 开发 | 全部 |
| `@babel/code-frame` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/compat-data` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/core` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/generator` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/helper-compilation-targets` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/helper-globals` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/helper-module-imports` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/helper-module-transforms` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/helper-string-parser` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/helper-validator-identifier` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/helper-validator-option` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/helpers` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/parser` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/runtime` | 7.29.2 | MIT | 生产 | 全部 |
| `@babel/template` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/traverse` | 7.29.7 | MIT | 开发 | 全部 |
| `@babel/types` | 7.29.7 | MIT | 开发 | 全部 |
| `@bramus/specificity` | 2.4.2 | MIT | 开发 | 全部 |
| `@csstools/color-helpers` | 6.0.2 | MIT-0 | 开发 | 全部 |
| `@csstools/css-calc` | 3.2.1 | MIT | 开发 | 全部 |
| `@csstools/css-color-parser` | 4.1.1 | MIT | 开发 | 全部 |
| `@csstools/css-parser-algorithms` | 4.0.0 | MIT | 开发 | 全部 |
| `@csstools/css-syntax-patches-for-csstree` | 1.1.4 | MIT-0 | 开发 | 全部 |
| `@csstools/css-tokenizer` | 4.0.0 | MIT | 开发 | 全部 |
| `@date-fns/tz` | 1.5.0 | MIT | 生产 | 全部 |
| `@emnapi/runtime` | 1.11.3 | MIT | 生产 | 全部 |
| `@esbuild/aix-ppc64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/aix-ppc64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/android-arm` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/android-arm` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/android-arm64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/android-arm64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/android-x64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/android-x64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/darwin-arm64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/darwin-arm64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/darwin-x64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/darwin-x64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/freebsd-arm64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/freebsd-arm64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/freebsd-x64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/freebsd-x64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-arm` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-arm` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-arm64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-arm64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-ia32` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-ia32` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-loong64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-loong64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-mips64el` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-mips64el` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-ppc64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-ppc64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-riscv64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-riscv64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-s390x` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-s390x` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/linux-x64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/linux-x64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/netbsd-arm64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/netbsd-arm64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/netbsd-x64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/netbsd-x64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/openbsd-arm64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/openbsd-arm64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/openbsd-x64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/openbsd-x64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/openharmony-arm64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/openharmony-arm64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/sunos-x64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/sunos-x64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/win32-arm64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/win32-arm64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/win32-ia32` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/win32-ia32` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@esbuild/win32-x64` | 0.25.12 | MIT | 开发 | 平台专用二进制 |
| `@esbuild/win32-x64` | 0.28.1 | MIT | 生产 | 平台专用二进制 |
| `@eslint-community/eslint-utils` | 4.9.1 | MIT | 开发 | 全部 |
| `@eslint-community/regexpp` | 4.12.2 | MIT | 开发 | 全部 |
| `@eslint/eslintrc` | 3.3.5 | MIT | 开发 | 全部 |
| `@eslint/js` | 9.39.4 | MIT | 开发 | 全部 |
| `@exodus/bytes` | 1.15.1 | MIT | 开发 | 全部 |
| `@fast-csv/format` | 4.3.5 | MIT | 生产 | 全部 |
| `@fast-csv/parse` | 4.3.6 | MIT | 生产 | 全部 |
| `@floating-ui/core` | 1.7.5 | MIT | 生产 | 全部 |
| `@floating-ui/dom` | 1.7.6 | MIT | 生产 | 全部 |
| `@floating-ui/react-dom` | 2.1.8 | MIT | 生产 | 全部 |
| `@floating-ui/utils` | 0.2.11 | MIT | 生产 | 全部 |
| `@hookform/resolvers` | 3.10.0 | MIT | 生产 | 全部 |
| `@img/colour` | 1.1.0 | MIT | 生产 | 全部 |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT | 生产 | 全部 |
| `@jridgewell/remapping` | 2.3.5 | MIT | 开发 | 全部 |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | 生产 | 全部 |
| `@jridgewell/sourcemap-codec` | 1.5.5 | MIT | 生产 | 全部 |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | 生产 | 全部 |
| `@napi-rs/canvas` | 0.1.100 | MIT | 生产 | 全部 |
| `@napi-rs/canvas-android-arm64` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-darwin-arm64` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-darwin-x64` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-linux-arm-gnueabihf` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-linux-arm64-gnu` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-linux-arm64-musl` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-linux-riscv64-gnu` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-linux-x64-gnu` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-linux-x64-musl` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-win32-arm64-msvc` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@napi-rs/canvas-win32-x64-msvc` | 0.1.100 | MIT | 生产 | 平台专用二进制 |
| `@next/env` | 16.4.6 | MIT | 生产 | 全部 |
| `@next/eslint-plugin-next` | 16.4.6 | MIT | 开发 | 全部 |
| `@next/swc-darwin-arm64` | 16.4.6 | MIT | 生产 | 平台专用二进制 |
| `@next/swc-darwin-x64` | 16.4.6 | MIT | 生产 | 平台专用二进制 |
| `@next/swc-linux-arm64-gnu` | 16.4.6 | MIT | 生产 | 平台专用二进制 |
| `@next/swc-linux-arm64-musl` | 16.4.6 | MIT | 生产 | 平台专用二进制 |
| `@next/swc-linux-x64-gnu` | 16.4.6 | MIT | 生产 | 平台专用二进制 |
| `@next/swc-linux-x64-musl` | 16.4.6 | MIT | 生产 | 平台专用二进制 |
| `@next/swc-win32-arm64-msvc` | 16.4.6 | MIT | 生产 | 平台专用二进制 |
| `@next/swc-win32-x64-msvc` | 16.4.6 | MIT | 生产 | 平台专用二进制 |
| `@nodelib/fs.scandir` | 2.1.5 | MIT | 生产 | 全部 |
| `@nodelib/fs.stat` | 2.0.5 | MIT | 生产 | 全部 |
| `@nodelib/fs.walk` | 1.2.8 | MIT | 生产 | 全部 |
| `@nolyfill/is-core-module` | 1.0.39 | MIT | 开发 | 全部 |
| `@panva/hkdf` | 1.2.1 | MIT | 生产 | 全部 |
| `@pdf-lib/standard-fonts` | 1.0.0 | MIT | 生产 | 全部 |
| `@pdf-lib/upng` | 1.0.1 | MIT | 生产 | 全部 |
| `@pkgjs/parseargs` | 0.11.0 | MIT | 生产 | 全部 |
| `@radix-ui/number` | 1.1.1 | MIT | 生产 | 全部 |
| `@radix-ui/primitive` | 1.1.3 | MIT | 生产 | 全部 |
| `@radix-ui/primitive` | 1.1.4 | MIT | 生产 | 全部 |
| `@radix-ui/react-arrow` | 1.1.7 | MIT | 生产 | 全部 |
| `@radix-ui/react-avatar` | 1.1.11 | MIT | 生产 | 全部 |
| `@radix-ui/react-checkbox` | 1.3.3 | MIT | 生产 | 全部 |
| `@radix-ui/react-collection` | 1.1.7 | MIT | 生产 | 全部 |
| `@radix-ui/react-compose-refs` | 1.1.2 | MIT | 生产 | 全部 |
| `@radix-ui/react-compose-refs` | 1.1.3 | MIT | 生产 | 全部 |
| `@radix-ui/react-context` | 1.1.2 | MIT | 生产 | 全部 |
| `@radix-ui/react-context` | 1.1.3 | MIT | 生产 | 全部 |
| `@radix-ui/react-context` | 1.1.4 | MIT | 生产 | 全部 |
| `@radix-ui/react-dialog` | 1.1.16 | MIT | 生产 | 全部 |
| `@radix-ui/react-direction` | 1.1.1 | MIT | 生产 | 全部 |
| `@radix-ui/react-dismissable-layer` | 1.1.12 | MIT | 生产 | 全部 |
| `@radix-ui/react-dropdown-menu` | 2.1.16 | MIT | 生产 | 全部 |
| `@radix-ui/react-focus-guards` | 1.1.3 | MIT | 生产 | 全部 |
| `@radix-ui/react-focus-guards` | 1.1.4 | MIT | 生产 | 全部 |
| `@radix-ui/react-focus-scope` | 1.1.7 | MIT | 生产 | 全部 |
| `@radix-ui/react-focus-scope` | 1.1.9 | MIT | 生产 | 全部 |
| `@radix-ui/react-id` | 1.1.1 | MIT | 生产 | 全部 |
| `@radix-ui/react-id` | 1.1.2 | MIT | 生产 | 全部 |
| `@radix-ui/react-label` | 2.1.8 | MIT | 生产 | 全部 |
| `@radix-ui/react-menu` | 2.1.16 | MIT | 生产 | 全部 |
| `@radix-ui/react-popover` | 1.1.15 | MIT | 生产 | 全部 |
| `@radix-ui/react-popper` | 1.2.8 | MIT | 生产 | 全部 |
| `@radix-ui/react-portal` | 1.1.11 | MIT | 生产 | 全部 |
| `@radix-ui/react-portal` | 1.1.9 | MIT | 生产 | 全部 |
| `@radix-ui/react-presence` | 1.1.5 | MIT | 生产 | 全部 |
| `@radix-ui/react-presence` | 1.1.6 | MIT | 生产 | 全部 |
| `@radix-ui/react-primitive` | 2.1.3 | MIT | 生产 | 全部 |
| `@radix-ui/react-primitive` | 2.1.4 | MIT | 生产 | 全部 |
| `@radix-ui/react-primitive` | 2.1.5 | MIT | 生产 | 全部 |
| `@radix-ui/react-progress` | 1.1.8 | MIT | 生产 | 全部 |
| `@radix-ui/react-roving-focus` | 1.1.11 | MIT | 生产 | 全部 |
| `@radix-ui/react-scroll-area` | 1.2.10 | MIT | 生产 | 全部 |
| `@radix-ui/react-select` | 2.2.6 | MIT | 生产 | 全部 |
| `@radix-ui/react-separator` | 1.1.8 | MIT | 生产 | 全部 |
| `@radix-ui/react-slot` | 1.2.3 | MIT | 生产 | 全部 |
| `@radix-ui/react-slot` | 1.2.4 | MIT | 生产 | 全部 |
| `@radix-ui/react-slot` | 1.2.5 | MIT | 生产 | 全部 |
| `@radix-ui/react-switch` | 1.2.6 | MIT | 生产 | 全部 |
| `@radix-ui/react-tabs` | 1.1.13 | MIT | 生产 | 全部 |
| `@radix-ui/react-tooltip` | 1.2.8 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-callback-ref` | 1.1.1 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-callback-ref` | 1.1.2 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-controllable-state` | 1.2.2 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-controllable-state` | 1.2.3 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-effect-event` | 0.0.2 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-effect-event` | 0.0.3 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-escape-keydown` | 1.1.2 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-is-hydrated` | 0.1.0 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-layout-effect` | 1.1.1 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-layout-effect` | 1.1.2 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-previous` | 1.1.1 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-rect` | 1.1.1 | MIT | 生产 | 全部 |
| `@radix-ui/react-use-size` | 1.1.1 | MIT | 生产 | 全部 |
| `@radix-ui/react-visually-hidden` | 1.2.3 | MIT | 生产 | 全部 |
| `@radix-ui/rect` | 1.1.1 | MIT | 生产 | 全部 |
| `@rollup/rollup-android-arm-eabi` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-android-arm64` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-android-x64` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-darwin-arm64` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-darwin-x64` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-freebsd-arm64` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-freebsd-x64` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-arm-gnueabihf` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-arm-musleabihf` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-arm64-gnu` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-arm64-musl` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-loong64-gnu` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-loong64-musl` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-ppc64-gnu` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-ppc64-musl` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-riscv64-gnu` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-riscv64-musl` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-s390x-gnu` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-x64-gnu` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-linux-x64-musl` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-openbsd-x64` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-openharmony-arm64` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-win32-arm64-msvc` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-win32-ia32-msvc` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-win32-x64-gnu` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rollup/rollup-win32-x64-msvc` | 4.68.7 | MIT | 开发 | 平台专用二进制 |
| `@rtsao/scc` | 1.1.0 | MIT | 开发 | 全部 |
| `@standard-schema/spec` | 1.1.0 | MIT | 开发 | 全部 |
| `@tanstack/react-table` | 8.21.3 | MIT | 生产 | 全部 |
| `@tanstack/table-core` | 8.21.3 | MIT | 生产 | 全部 |
| `@testing-library/dom` | 10.4.1 | MIT | 开发 | 全部 |
| `@testing-library/jest-dom` | 6.9.1 | MIT | 开发 | 全部 |
| `@testing-library/react` | 16.3.2 | MIT | 开发 | 全部 |
| `@types/aria-query` | 5.0.4 | MIT | 开发 | 全部 |
| `@types/bcryptjs` | 2.4.6 | MIT | 开发 | 全部 |
| `@types/chai` | 5.2.3 | MIT | 开发 | 全部 |
| `@types/d3-array` | 3.2.2 | MIT | 生产 | 全部 |
| `@types/d3-color` | 3.1.3 | MIT | 生产 | 全部 |
| `@types/d3-ease` | 3.0.2 | MIT | 生产 | 全部 |
| `@types/d3-interpolate` | 3.0.4 | MIT | 生产 | 全部 |
| `@types/d3-path` | 3.1.1 | MIT | 生产 | 全部 |
| `@types/d3-scale` | 4.0.9 | MIT | 生产 | 全部 |
| `@types/d3-shape` | 3.1.8 | MIT | 生产 | 全部 |
| `@types/d3-time` | 3.0.4 | MIT | 生产 | 全部 |
| `@types/d3-timer` | 3.0.2 | MIT | 生产 | 全部 |
| `@types/deep-eql` | 4.0.2 | MIT | 开发 | 全部 |
| `@types/estree` | 1.0.10 | MIT | 开发 | 全部 |
| `@types/json-schema` | 7.0.15 | MIT | 开发 | 全部 |
| `@types/json5` | 0.0.29 | MIT | 开发 | 全部 |
| `@types/node` | 14.18.63 | MIT | 生产 | 全部 |
| `@types/node` | 22.19.19 | MIT | 开发 | 全部 |
| `@types/node` | 25.9.1 | MIT | 生产 | 全部 |
| `@types/node-cron` | 3.0.11 | MIT | 开发 | 全部 |
| `@types/nodemailer` | 8.0.1 | MIT | 开发 | 全部 |
| `@types/react` | 19.2.17 | MIT | 生产 | 全部 |
| `@types/react-dom` | 19.2.3 | MIT | 生产 | 全部 |
| `@typescript-eslint/eslint-plugin` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/parser` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/project-service` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/scope-manager` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/tsconfig-utils` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/type-utils` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/types` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/typescript-estree` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/utils` | 8.73.0 | MIT | 开发 | 全部 |
| `@typescript-eslint/visitor-keys` | 8.73.0 | MIT | 开发 | 全部 |
| `@vitest/expect` | 4.1.12 | MIT | 开发 | 全部 |
| `@vitest/mocker` | 4.1.12 | MIT | 开发 | 全部 |
| `@vitest/pretty-format` | 4.1.12 | MIT | 开发 | 全部 |
| `@vitest/runner` | 4.1.12 | MIT | 开发 | 全部 |
| `@vitest/snapshot` | 4.1.12 | MIT | 开发 | 全部 |
| `@vitest/spy` | 4.1.12 | MIT | 开发 | 全部 |
| `@vitest/utils` | 4.1.12 | MIT | 开发 | 全部 |
| `@xmldom/xmldom` | 0.8.15 | MIT | 生产 | 全部 |
| `@xmldom/xmldom` | 0.9.12 | MIT | 生产 | 全部 |
| `acorn` | 8.16.0 | MIT | 开发 | 全部 |
| `acorn-jsx` | 5.3.2 | MIT | 开发 | 全部 |
| `ajv` | 6.15.0 | MIT | 开发 | 全部 |
| `ansi-regex` | 5.0.1 | MIT | 生产 | 全部 |
| `ansi-regex` | 6.6.0 | MIT | 生产 | 全部 |
| `ansi-styles` | 4.3.0 | MIT | 生产 | 全部 |
| `ansi-styles` | 5.2.0 | MIT | 开发 | 全部 |
| `ansi-styles` | 6.2.3 | MIT | 生产 | 全部 |
| `any-promise` | 1.3.0 | MIT | 生产 | 全部 |
| `archiver` | 5.3.2 | MIT | 生产 | 全部 |
| `archiver-utils` | 2.1.0 | MIT | 生产 | 全部 |
| `archiver-utils` | 3.0.4 | MIT | 生产 | 全部 |
| `arg` | 5.0.2 | MIT | 生产 | 全部 |
| `argparse` | 1.0.10 | MIT | 生产 | 全部 |
| `aria-hidden` | 1.2.6 | MIT | 生产 | 全部 |
| `array-buffer-byte-length` | 1.0.2 | MIT | 开发 | 全部 |
| `array-includes` | 3.1.9 | MIT | 开发 | 全部 |
| `array.prototype.findlast` | 1.2.5 | MIT | 开发 | 全部 |
| `array.prototype.findlastindex` | 1.2.6 | MIT | 开发 | 全部 |
| `array.prototype.flat` | 1.3.3 | MIT | 开发 | 全部 |
| `array.prototype.flatmap` | 1.3.3 | MIT | 开发 | 全部 |
| `array.prototype.tosorted` | 1.1.4 | MIT | 开发 | 全部 |
| `arraybuffer.prototype.slice` | 1.0.4 | MIT | 开发 | 全部 |
| `assertion-error` | 2.0.1 | MIT | 开发 | 全部 |
| `ast-types-flow` | 0.0.8 | MIT | 开发 | 全部 |
| `async` | 3.2.6 | MIT | 生产 | 全部 |
| `async-function` | 1.0.0 | MIT | 开发 | 全部 |
| `autoprefixer` | 10.5.0 | MIT | 开发 | 全部 |
| `available-typed-arrays` | 1.0.7 | MIT | 开发 | 全部 |
| `balanced-match` | 1.0.2 | MIT | 生产 | 全部 |
| `balanced-match` | 4.0.4 | MIT | 开发 | 全部 |
| `base64-js` | 1.5.1 | MIT | 生产 | 全部 |
| `bcryptjs` | 2.4.3 | MIT | 生产 | 全部 |
| `bidi-js` | 1.0.3 | MIT | 开发 | 全部 |
| `binary` | 0.3.0 | MIT | 生产 | 全部 |
| `binary-extensions` | 2.3.0 | MIT | 生产 | 全部 |
| `bl` | 4.1.0 | MIT | 生产 | 全部 |
| `bluebird` | 3.4.7 | MIT | 生产 | 全部 |
| `bowser` | 2.14.1 | MIT | 生产 | 全部 |
| `brace-expansion` | 1.1.22 | MIT | 生产 | 全部 |
| `brace-expansion` | 2.1.8 | MIT | 生产 | 全部 |
| `brace-expansion` | 5.0.13 | MIT | 开发 | 全部 |
| `braces` | 3.0.3 | MIT | 生产 | 全部 |
| `browserslist` | 4.28.9 | MIT | 开发 | 全部 |
| `buffer` | 5.7.1 | MIT | 生产 | 全部 |
| `buffer-crc32` | 0.2.13 | MIT | 生产 | 全部 |
| `buffer-indexof-polyfill` | 1.0.2 | MIT | 生产 | 全部 |
| `call-bind` | 1.0.9 | MIT | 开发 | 全部 |
| `call-bind-apply-helpers` | 1.0.2 | MIT | 开发 | 全部 |
| `call-bound` | 1.0.4 | MIT | 开发 | 全部 |
| `callsites` | 3.1.0 | MIT | 开发 | 全部 |
| `camelcase-css` | 2.0.1 | MIT | 生产 | 全部 |
| `chai` | 6.3.0 | MIT | 开发 | 全部 |
| `chainsaw` | 0.1.0 | MIT/X11 | 生产 | 全部 |
| `chalk` | 4.1.2 | MIT | 开发 | 全部 |
| `china-division` | 2.7.0 | MIT | 生产 | 全部 |
| `chokidar` | 3.6.0 | MIT | 生产 | 全部 |
| `client-only` | 0.0.1 | MIT | 生产 | 全部 |
| `clsx` | 2.1.1 | MIT | 生产 | 全部 |
| `cmdk` | 1.1.1 | MIT | 生产 | 全部 |
| `color-convert` | 2.0.1 | MIT | 生产 | 全部 |
| `color-name` | 1.1.4 | MIT | 生产 | 全部 |
| `commander` | 4.1.1 | MIT | 生产 | 全部 |
| `compress-commons` | 4.1.2 | MIT | 生产 | 全部 |
| `concat-map` | 0.0.1 | MIT | 生产 | 全部 |
| `convert-source-map` | 2.0.0 | MIT | 开发 | 全部 |
| `cookie` | 0.7.2 | MIT | 生产 | 全部 |
| `core-util-is` | 1.0.3 | MIT | 生产 | 全部 |
| `crc32-stream` | 4.0.3 | MIT | 生产 | 全部 |
| `cross-spawn` | 7.0.6 | MIT | 生产 | 全部 |
| `css-tree` | 3.2.1 | MIT | 开发 | 全部 |
| `css.escape` | 1.5.1 | MIT | 开发 | 全部 |
| `csstype` | 3.2.3 | MIT | 生产 | 全部 |
| `data-urls` | 7.0.0 | MIT | 开发 | 全部 |
| `data-view-buffer` | 1.0.2 | MIT | 开发 | 全部 |
| `data-view-byte-length` | 1.0.2 | MIT | 开发 | 全部 |
| `data-view-byte-offset` | 1.0.1 | MIT | 开发 | 全部 |
| `date-fns` | 4.2.1 | MIT | 生产 | 全部 |
| `dayjs` | 1.11.20 | MIT | 生产 | 全部 |
| `debug` | 3.2.7 | MIT | 开发 | 全部 |
| `debug` | 4.4.3 | MIT | 开发 | 全部 |
| `decimal.js` | 10.6.0 | MIT | 开发 | 全部 |
| `decimal.js-light` | 2.5.1 | MIT | 生产 | 全部 |
| `deep-is` | 0.1.4 | MIT | 开发 | 全部 |
| `define-data-property` | 1.1.4 | MIT | 开发 | 全部 |
| `define-properties` | 1.2.1 | MIT | 开发 | 全部 |
| `dequal` | 2.0.3 | MIT | 开发 | 全部 |
| `detect-node-es` | 1.1.0 | MIT | 生产 | 全部 |
| `dlv` | 1.1.3 | MIT | 生产 | 全部 |
| `docx` | 9.6.1 | MIT | 生产 | 全部 |
| `docxtemplater` | 3.68.7 | MIT | 生产 | 全部 |
| `dom-accessibility-api` | 0.5.16 | MIT | 开发 | 全部 |
| `dom-accessibility-api` | 0.6.3 | MIT | 开发 | 全部 |
| `dom-helpers` | 5.2.1 | MIT | 生产 | 全部 |
| `dunder-proto` | 1.0.1 | MIT | 开发 | 全部 |
| `eastasianwidth` | 0.2.0 | MIT | 生产 | 全部 |
| `emoji-regex` | 8.0.0 | MIT | 生产 | 全部 |
| `emoji-regex` | 9.2.2 | MIT | 生产 | 全部 |
| `end-of-stream` | 1.4.5 | MIT | 生产 | 全部 |
| `enhanced-resolve` | 5.27.0 | MIT | 开发 | 全部 |
| `es-abstract` | 1.24.2 | MIT | 开发 | 全部 |
| `es-define-property` | 1.0.1 | MIT | 开发 | 全部 |
| `es-errors` | 1.3.0 | MIT | 生产 | 全部 |
| `es-iterator-helpers` | 1.3.2 | MIT | 开发 | 全部 |
| `es-module-lexer` | 2.1.0 | MIT | 开发 | 全部 |
| `es-object-atoms` | 1.1.1 | MIT | 开发 | 全部 |
| `es-set-tostringtag` | 2.1.0 | MIT | 开发 | 全部 |
| `es-shim-unscopables` | 1.1.0 | MIT | 开发 | 全部 |
| `es-to-primitive` | 1.3.0 | MIT | 开发 | 全部 |
| `esbuild` | 0.25.12 | MIT | 开发 | 全部 |
| `esbuild` | 0.28.1 | MIT | 生产 | 全部 |
| `escalade` | 3.2.0 | MIT | 开发 | 全部 |
| `escape-string-regexp` | 4.0.0 | MIT | 开发 | 全部 |
| `eslint` | 9.39.4 | MIT | 开发 | 全部 |
| `eslint-config-next` | 16.4.6 | MIT | 开发 | 全部 |
| `eslint-import-resolver-node` | 0.3.10 | MIT | 开发 | 全部 |
| `eslint-module-utils` | 2.12.1 | MIT | 开发 | 全部 |
| `eslint-plugin-import` | 2.32.0 | MIT | 开发 | 全部 |
| `eslint-plugin-jsx-a11y` | 6.10.2 | MIT | 开发 | 全部 |
| `eslint-plugin-react` | 7.37.5 | MIT | 开发 | 全部 |
| `eslint-plugin-react-hooks` | 7.1.1 | MIT | 开发 | 全部 |
| `estree-walker` | 3.0.3 | MIT | 开发 | 全部 |
| `eventemitter3` | 4.0.7 | MIT | 生产 | 全部 |
| `exceljs` | 4.4.0 | MIT | 生产 | 全部 |
| `fast-csv` | 4.3.6 | MIT | 生产 | 全部 |
| `fast-deep-equal` | 3.1.3 | MIT | 开发 | 全部 |
| `fast-equals` | 5.4.0 | MIT | 生产 | 全部 |
| `fast-glob` | 3.3.1 | MIT | 开发 | 全部 |
| `fast-glob` | 3.3.3 | MIT | 生产 | 全部 |
| `fast-json-stable-stringify` | 2.1.0 | MIT | 开发 | 全部 |
| `fast-levenshtein` | 2.0.6 | MIT | 开发 | 全部 |
| `fdir` | 6.5.0 | MIT | 开发 | 全部 |
| `file-entry-cache` | 8.0.0 | MIT | 开发 | 全部 |
| `fill-range` | 7.1.1 | MIT | 生产 | 全部 |
| `find-up` | 5.0.0 | MIT | 开发 | 全部 |
| `flat-cache` | 4.0.1 | MIT | 开发 | 全部 |
| `for-each` | 0.3.5 | MIT | 开发 | 全部 |
| `fraction.js` | 5.3.4 | MIT | 开发 | 全部 |
| `framer-motion` | 11.18.2 | MIT | 生产 | 全部 |
| `fs-constants` | 1.0.0 | MIT | 生产 | 全部 |
| `fsevents` | 2.3.3 | MIT | 生产 | 平台专用二进制 |
| `function-bind` | 1.1.2 | MIT | 生产 | 全部 |
| `function.prototype.name` | 1.1.8 | MIT | 开发 | 全部 |
| `functions-have-names` | 1.2.3 | MIT | 开发 | 全部 |
| `generator-function` | 2.0.1 | MIT | 开发 | 全部 |
| `gensync` | 1.0.0-beta.2 | MIT | 开发 | 全部 |
| `get-intrinsic` | 1.3.0 | MIT | 开发 | 全部 |
| `get-nonce` | 1.0.1 | MIT | 生产 | 全部 |
| `get-proto` | 1.0.1 | MIT | 开发 | 全部 |
| `get-symbol-description` | 1.1.0 | MIT | 开发 | 全部 |
| `get-tsconfig` | 4.14.0 | MIT | 开发 | 全部 |
| `globals` | 14.0.0 | MIT | 开发 | 全部 |
| `globals` | 16.4.0 | MIT | 开发 | 全部 |
| `globalthis` | 1.0.4 | MIT | 开发 | 全部 |
| `gopd` | 1.2.0 | MIT | 开发 | 全部 |
| `has-bigints` | 1.1.0 | MIT | 开发 | 全部 |
| `has-flag` | 4.0.0 | MIT | 开发 | 全部 |
| `has-property-descriptors` | 1.0.2 | MIT | 开发 | 全部 |
| `has-proto` | 1.2.0 | MIT | 开发 | 全部 |
| `has-symbols` | 1.1.0 | MIT | 开发 | 全部 |
| `has-tostringtag` | 1.0.2 | MIT | 开发 | 全部 |
| `hash.js` | 1.1.7 | MIT | 生产 | 全部 |
| `hasown` | 2.0.3 | MIT | 生产 | 全部 |
| `hermes-estree` | 0.25.1 | MIT | 开发 | 全部 |
| `hermes-parser` | 0.25.1 | MIT | 开发 | 全部 |
| `html-encoding-sniffer` | 6.0.0 | MIT | 开发 | 全部 |
| `ignore` | 5.3.2 | MIT | 开发 | 全部 |
| `ignore` | 7.0.16 | MIT | 开发 | 全部 |
| `immediate` | 3.0.6 | MIT | 生产 | 全部 |
| `import-fresh` | 3.3.1 | MIT | 开发 | 全部 |
| `imurmurhash` | 0.1.4 | MIT | 开发 | 全部 |
| `indent-string` | 4.0.0 | MIT | 开发 | 全部 |
| `internal-slot` | 1.1.0 | MIT | 开发 | 全部 |
| `is-array-buffer` | 3.0.5 | MIT | 开发 | 全部 |
| `is-async-function` | 2.1.1 | MIT | 开发 | 全部 |
| `is-bigint` | 1.1.0 | MIT | 开发 | 全部 |
| `is-binary-path` | 2.1.0 | MIT | 生产 | 全部 |
| `is-boolean-object` | 1.2.2 | MIT | 开发 | 全部 |
| `is-bun-module` | 1.3.0 | MIT | 开发 | 全部 |
| `is-callable` | 1.2.7 | MIT | 开发 | 全部 |
| `is-core-module` | 2.16.2 | MIT | 生产 | 全部 |
| `is-data-view` | 1.0.2 | MIT | 开发 | 全部 |
| `is-date-object` | 1.1.0 | MIT | 开发 | 全部 |
| `is-extglob` | 2.1.1 | MIT | 生产 | 全部 |
| `is-finalizationregistry` | 1.1.1 | MIT | 开发 | 全部 |
| `is-fullwidth-code-point` | 3.0.0 | MIT | 生产 | 全部 |
| `is-generator-function` | 1.1.2 | MIT | 开发 | 全部 |
| `is-glob` | 4.0.3 | MIT | 生产 | 全部 |
| `is-map` | 2.0.3 | MIT | 开发 | 全部 |
| `is-negative-zero` | 2.0.3 | MIT | 开发 | 全部 |
| `is-number` | 7.0.0 | MIT | 生产 | 全部 |
| `is-number-object` | 1.1.1 | MIT | 开发 | 全部 |
| `is-potential-custom-element-name` | 1.0.1 | MIT | 开发 | 全部 |
| `is-regex` | 1.2.1 | MIT | 开发 | 全部 |
| `is-set` | 2.0.3 | MIT | 开发 | 全部 |
| `is-shared-array-buffer` | 1.0.4 | MIT | 开发 | 全部 |
| `is-string` | 1.1.1 | MIT | 开发 | 全部 |
| `is-symbol` | 1.1.1 | MIT | 开发 | 全部 |
| `is-typed-array` | 1.1.15 | MIT | 开发 | 全部 |
| `is-weakmap` | 2.0.2 | MIT | 开发 | 全部 |
| `is-weakref` | 1.1.1 | MIT | 开发 | 全部 |
| `is-weakset` | 2.0.4 | MIT | 开发 | 全部 |
| `isarray` | 1.0.0 | MIT | 生产 | 全部 |
| `isarray` | 2.0.5 | MIT | 开发 | 全部 |
| `iterator.prototype` | 1.1.5 | MIT | 开发 | 全部 |
| `jiti` | 1.21.7 | MIT | 生产 | 全部 |
| `jose` | 4.15.9 | MIT | 生产 | 全部 |
| `js-tokens` | 4.0.0 | MIT | 生产 | 全部 |
| `js-yaml` | 4.3.2 | MIT | 开发 | 全部 |
| `jsdom` | 29.1.1 | MIT | 开发 | 全部 |
| `jsesc` | 3.1.0 | MIT | 开发 | 全部 |
| `json-buffer` | 3.0.1 | MIT | 开发 | 全部 |
| `json-schema-traverse` | 0.4.1 | MIT | 开发 | 全部 |
| `json-stable-stringify-without-jsonify` | 1.0.1 | MIT | 开发 | 全部 |
| `json5` | 1.0.2 | MIT | 开发 | 全部 |
| `json5` | 2.2.3 | MIT | 开发 | 全部 |
| `jsx-ast-utils` | 3.3.5 | MIT | 开发 | 全部 |
| `keyv` | 4.5.4 | MIT | 开发 | 全部 |
| `language-tags` | 1.0.9 | MIT | 开发 | 全部 |
| `lazystream` | 1.0.1 | MIT | 生产 | 全部 |
| `levn` | 0.4.1 | MIT | 开发 | 全部 |
| `lie` | 3.3.0 | MIT | 生产 | 全部 |
| `lilconfig` | 3.1.3 | MIT | 生产 | 全部 |
| `lines-and-columns` | 1.2.4 | MIT | 生产 | 全部 |
| `locate-path` | 6.0.0 | MIT | 开发 | 全部 |
| `lodash` | 4.18.1 | MIT | 生产 | 全部 |
| `lodash.defaults` | 4.2.0 | MIT | 生产 | 全部 |
| `lodash.difference` | 4.5.0 | MIT | 生产 | 全部 |
| `lodash.escaperegexp` | 4.1.2 | MIT | 生产 | 全部 |
| `lodash.flatten` | 4.4.0 | MIT | 生产 | 全部 |
| `lodash.groupby` | 4.6.0 | MIT | 生产 | 全部 |
| `lodash.isboolean` | 3.0.3 | MIT | 生产 | 全部 |
| `lodash.isequal` | 4.5.0 | MIT | 生产 | 全部 |
| `lodash.isfunction` | 3.0.9 | MIT | 生产 | 全部 |
| `lodash.isnil` | 4.0.0 | MIT | 生产 | 全部 |
| `lodash.isplainobject` | 4.0.6 | MIT | 生产 | 全部 |
| `lodash.isundefined` | 3.0.1 | MIT | 生产 | 全部 |
| `lodash.merge` | 4.6.2 | MIT | 开发 | 全部 |
| `lodash.union` | 4.6.0 | MIT | 生产 | 全部 |
| `lodash.uniq` | 4.5.0 | MIT | 生产 | 全部 |
| `loose-envify` | 1.4.0 | MIT | 生产 | 全部 |
| `lz-string` | 1.5.0 | MIT | 开发 | 全部 |
| `magic-string` | 0.30.21 | MIT | 开发 | 全部 |
| `math-intrinsics` | 1.1.0 | MIT | 开发 | 全部 |
| `merge2` | 1.4.1 | MIT | 生产 | 全部 |
| `micromatch` | 4.0.8 | MIT | 生产 | 全部 |
| `min-indent` | 1.0.1 | MIT | 开发 | 全部 |
| `minimist` | 1.2.8 | MIT | 生产 | 全部 |
| `mkdirp` | 0.5.6 | MIT | 生产 | 全部 |
| `motion-dom` | 11.18.1 | MIT | 生产 | 全部 |
| `motion-utils` | 11.18.1 | MIT | 生产 | 全部 |
| `ms` | 2.1.3 | MIT | 开发 | 全部 |
| `mz` | 2.7.0 | MIT | 生产 | 全部 |
| `nanoid` | 3.3.19 | MIT | 生产 | 全部 |
| `nanoid` | 5.1.16 | MIT | 生产 | 全部 |
| `natural-compare` | 1.4.0 | MIT | 开发 | 全部 |
| `next` | 16.4.6 | MIT | 生产 | 全部 |
| `next-themes` | 0.4.6 | MIT | 生产 | 全部 |
| `node-exports-info` | 1.6.0 | MIT | 开发 | 全部 |
| `node-releases` | 2.0.55 | MIT | 开发 | 全部 |
| `nodemailer` | 10.6.0 | MIT-0 | 生产 | 全部 |
| `normalize-path` | 3.0.0 | MIT | 生产 | 全部 |
| `oauth` | 0.9.15 | MIT | 生产 | 全部 |
| `object-assign` | 4.1.1 | MIT | 生产 | 全部 |
| `object-hash` | 2.2.0 | MIT | 生产 | 全部 |
| `object-hash` | 3.0.0 | MIT | 生产 | 全部 |
| `object-inspect` | 1.13.4 | MIT | 开发 | 全部 |
| `object-keys` | 1.1.1 | MIT | 开发 | 全部 |
| `object.assign` | 4.1.7 | MIT | 开发 | 全部 |
| `object.entries` | 1.1.9 | MIT | 开发 | 全部 |
| `object.fromentries` | 2.0.8 | MIT | 开发 | 全部 |
| `object.groupby` | 1.0.3 | MIT | 开发 | 全部 |
| `object.values` | 1.2.1 | MIT | 开发 | 全部 |
| `obug` | 2.1.1 | MIT | 开发 | 全部 |
| `oidc-token-hash` | 5.2.0 | MIT | 生产 | 全部 |
| `openid-client` | 5.7.1 | MIT | 生产 | 全部 |
| `optionator` | 0.9.4 | MIT | 开发 | 全部 |
| `own-keys` | 1.0.1 | MIT | 开发 | 全部 |
| `p-limit` | 3.1.0 | MIT | 开发 | 全部 |
| `p-locate` | 5.0.0 | MIT | 开发 | 全部 |
| `pako` | 1.0.11 | (MIT AND Zlib) | 生产 | 全部 |
| `pako` | 2.1.0 | (MIT AND Zlib) | 生产 | 全部 |
| `parent-module` | 1.0.1 | MIT | 开发 | 全部 |
| `parse5` | 8.0.1 | MIT | 开发 | 全部 |
| `path-exists` | 4.0.0 | MIT | 开发 | 全部 |
| `path-is-absolute` | 1.0.1 | MIT | 生产 | 全部 |
| `path-key` | 3.1.1 | MIT | 生产 | 全部 |
| `path-parse` | 1.0.7 | MIT | 生产 | 全部 |
| `pathe` | 2.0.3 | MIT | 开发 | 全部 |
| `pdf-lib` | 1.17.1 | MIT | 生产 | 全部 |
| `picomatch` | 2.3.2 | MIT | 生产 | 全部 |
| `picomatch` | 4.0.7 | MIT | 开发 | 全部 |
| `pify` | 2.3.0 | MIT | 生产 | 全部 |
| `pirates` | 4.0.7 | MIT | 生产 | 全部 |
| `possible-typed-array-names` | 1.1.0 | MIT | 开发 | 全部 |
| `postcss` | 8.5.28 | MIT | 生产 | 全部 |
| `postcss-import` | 15.1.0 | MIT | 生产 | 全部 |
| `postcss-js` | 4.1.0 | MIT | 生产 | 全部 |
| `postcss-load-config` | 6.0.1 | MIT | 生产 | 全部 |
| `postcss-nested` | 6.2.0 | MIT | 生产 | 全部 |
| `postcss-selector-parser` | 6.1.6 | MIT | 生产 | 全部 |
| `postcss-value-parser` | 4.2.0 | MIT | 生产 | 全部 |
| `preact` | 10.29.2 | MIT | 生产 | 全部 |
| `preact-render-to-string` | 5.2.6 | MIT | 生产 | 全部 |
| `prelude-ls` | 1.2.1 | MIT | 开发 | 全部 |
| `pretty-format` | 27.5.1 | MIT | 开发 | 全部 |
| `pretty-format` | 3.8.0 | MIT | 生产 | 全部 |
| `process-nextick-args` | 2.0.1 | MIT | 生产 | 全部 |
| `prop-types` | 15.8.1 | MIT | 生产 | 全部 |
| `punycode` | 2.3.1 | MIT | 开发 | 全部 |
| `queue-microtask` | 1.2.3 | MIT | 生产 | 全部 |
| `react` | 19.2.7 | MIT | 生产 | 全部 |
| `react-day-picker` | 10.0.1 | MIT | 生产 | 全部 |
| `react-dom` | 19.2.7 | MIT | 生产 | 全部 |
| `react-hook-form` | 7.76.0 | MIT | 生产 | 全部 |
| `react-is` | 16.13.1 | MIT | 生产 | 全部 |
| `react-is` | 17.0.2 | MIT | 开发 | 全部 |
| `react-is` | 18.3.1 | MIT | 生产 | 全部 |
| `react-remove-scroll` | 2.7.2 | MIT | 生产 | 全部 |
| `react-remove-scroll-bar` | 2.3.8 | MIT | 生产 | 全部 |
| `react-smooth` | 4.0.4 | MIT | 生产 | 全部 |
| `react-style-singleton` | 2.2.3 | MIT | 生产 | 全部 |
| `read-cache` | 1.0.0 | MIT | 生产 | 全部 |
| `readable-stream` | 2.3.8 | MIT | 生产 | 全部 |
| `readable-stream` | 3.6.2 | MIT | 生产 | 全部 |
| `readdirp` | 3.6.0 | MIT | 生产 | 全部 |
| `recharts` | 2.15.4 | MIT | 生产 | 全部 |
| `recharts-scale` | 0.4.5 | MIT | 生产 | 全部 |
| `redent` | 3.0.0 | MIT | 开发 | 全部 |
| `reflect.getprototypeof` | 1.0.10 | MIT | 开发 | 全部 |
| `regexp.prototype.flags` | 1.5.4 | MIT | 开发 | 全部 |
| `require-from-string` | 2.0.2 | MIT | 开发 | 全部 |
| `resolve` | 1.22.12 | MIT | 生产 | 全部 |
| `resolve` | 2.0.0-next.7 | MIT | 开发 | 全部 |
| `resolve-from` | 4.0.0 | MIT | 开发 | 全部 |
| `resolve-pkg-maps` | 1.0.0 | MIT | 开发 | 全部 |
| `reusify` | 1.1.0 | MIT | 生产 | 全部 |
| `rollup` | 4.68.7 | MIT | 开发 | 全部 |
| `run-parallel` | 1.2.0 | MIT | 生产 | 全部 |
| `safe-array-concat` | 1.1.4 | MIT | 开发 | 全部 |
| `safe-buffer` | 5.1.2 | MIT | 生产 | 全部 |
| `safe-push-apply` | 1.0.0 | MIT | 开发 | 全部 |
| `safe-regex-test` | 1.1.0 | MIT | 开发 | 全部 |
| `scheduler` | 0.27.0 | MIT | 生产 | 全部 |
| `set-function-length` | 1.2.2 | MIT | 开发 | 全部 |
| `set-function-name` | 2.0.2 | MIT | 开发 | 全部 |
| `set-proto` | 1.0.0 | MIT | 开发 | 全部 |
| `setimmediate` | 1.0.5 | MIT | 生产 | 全部 |
| `shebang-command` | 2.0.0 | MIT | 生产 | 全部 |
| `shebang-regex` | 3.0.0 | MIT | 生产 | 全部 |
| `side-channel` | 1.1.0 | MIT | 开发 | 全部 |
| `side-channel-list` | 1.0.1 | MIT | 开发 | 全部 |
| `side-channel-map` | 1.0.1 | MIT | 开发 | 全部 |
| `side-channel-weakmap` | 1.0.2 | MIT | 开发 | 全部 |
| `sonner` | 1.7.4 | MIT | 生产 | 全部 |
| `stable-hash` | 0.0.4 | MIT | 开发 | 全部 |
| `stackback` | 0.0.2 | MIT | 开发 | 全部 |
| `std-env` | 4.1.0 | MIT | 开发 | 全部 |
| `stop-iteration-iterator` | 1.1.0 | MIT | 开发 | 全部 |
| `string_decoder` | 1.1.1 | MIT | 生产 | 全部 |
| `string-width` | 4.2.3 | MIT | 生产 | 全部 |
| `string-width` | 5.1.2 | MIT | 生产 | 全部 |
| `string.prototype.includes` | 2.0.1 | MIT | 开发 | 全部 |
| `string.prototype.matchall` | 4.0.12 | MIT | 开发 | 全部 |
| `string.prototype.repeat` | 1.0.0 | MIT | 开发 | 全部 |
| `string.prototype.trim` | 1.2.10 | MIT | 开发 | 全部 |
| `string.prototype.trimend` | 1.0.9 | MIT | 开发 | 全部 |
| `string.prototype.trimstart` | 1.0.8 | MIT | 开发 | 全部 |
| `strip-ansi` | 6.0.1 | MIT | 生产 | 全部 |
| `strip-ansi` | 7.2.0 | MIT | 生产 | 全部 |
| `strip-bom` | 3.0.0 | MIT | 开发 | 全部 |
| `strip-indent` | 3.0.0 | MIT | 开发 | 全部 |
| `strip-json-comments` | 3.1.1 | MIT | 开发 | 全部 |
| `styled-jsx` | 5.1.6 | MIT | 生产 | 全部 |
| `sucrase` | 3.35.0 | MIT | 生产 | 全部 |
| `supports-color` | 7.2.0 | MIT | 开发 | 全部 |
| `supports-preserve-symlinks-flag` | 1.0.0 | MIT | 生产 | 全部 |
| `symbol-tree` | 3.2.4 | MIT | 开发 | 全部 |
| `tailwind-merge` | 2.6.1 | MIT | 生产 | 全部 |
| `tailwindcss` | 3.4.19 | MIT | 生产 | 全部 |
| `tailwindcss-animate` | 1.0.7 | MIT | 生产 | 全部 |
| `tapable` | 2.3.4 | MIT | 开发 | 全部 |
| `tar-stream` | 2.2.0 | MIT | 生产 | 全部 |
| `thenify` | 3.3.1 | MIT | 生产 | 全部 |
| `thenify-all` | 1.6.0 | MIT | 生产 | 全部 |
| `tiny-invariant` | 1.3.3 | MIT | 生产 | 全部 |
| `tinybench` | 2.9.0 | MIT | 开发 | 全部 |
| `tinyexec` | 1.2.2 | MIT | 开发 | 全部 |
| `tinyglobby` | 0.2.17 | MIT | 开发 | 全部 |
| `tinyrainbow` | 3.2.0 | MIT | 开发 | 全部 |
| `tldts` | 7.1.1 | MIT | 开发 | 全部 |
| `tldts-core` | 7.1.1 | MIT | 开发 | 全部 |
| `tmp` | 0.2.7 | MIT | 生产 | 全部 |
| `to-regex-range` | 5.0.1 | MIT | 生产 | 全部 |
| `tr46` | 6.0.0 | MIT | 开发 | 全部 |
| `traverse` | 0.3.9 | MIT/X11 | 生产 | 全部 |
| `ts-api-utils` | 2.5.0 | MIT | 开发 | 全部 |
| `tsconfig-paths` | 3.15.0 | MIT | 开发 | 全部 |
| `tsx` | 4.22.3 | MIT | 生产 | 全部 |
| `type-check` | 0.4.0 | MIT | 开发 | 全部 |
| `typed-array-buffer` | 1.0.3 | MIT | 开发 | 全部 |
| `typed-array-byte-length` | 1.0.3 | MIT | 开发 | 全部 |
| `typed-array-byte-offset` | 1.0.4 | MIT | 开发 | 全部 |
| `typed-array-length` | 1.0.7 | MIT | 开发 | 全部 |
| `typescript-eslint` | 8.73.0 | MIT | 开发 | 全部 |
| `unbox-primitive` | 1.1.0 | MIT | 开发 | 全部 |
| `underscore` | 1.13.8 | MIT | 生产 | 全部 |
| `undici` | 7.30.2 | MIT | 生产 | 全部 |
| `undici-types` | 6.21.0 | MIT | 开发 | 全部 |
| `undici-types` | 7.24.6 | MIT | 生产 | 全部 |
| `unpdf` | 1.6.2 | MIT | 生产 | 全部 |
| `unzipper` | 0.10.14 | MIT | 生产 | 全部 |
| `update-browserslist-db` | 1.3.3 | MIT | 开发 | 全部 |
| `use-callback-ref` | 1.3.3 | MIT | 生产 | 全部 |
| `use-sidecar` | 1.1.3 | MIT | 生产 | 全部 |
| `use-sync-external-store` | 1.6.0 | MIT | 生产 | 全部 |
| `util-deprecate` | 1.0.2 | MIT | 生产 | 全部 |
| `uuid` | 11.1.1 | MIT | 生产 | 全部 |
| `victory-vendor` | 36.9.2 | MIT AND ISC | 生产 | 全部 |
| `vite` | 6.2.7 | MIT | 开发 | 全部 |
| `vitest` | 4.1.12 | MIT | 开发 | 全部 |
| `w3c-xmlserializer` | 5.0.0 | MIT | 开发 | 全部 |
| `whatwg-mimetype` | 5.0.0 | MIT | 开发 | 全部 |
| `whatwg-url` | 16.0.1 | MIT | 开发 | 全部 |
| `which-boxed-primitive` | 1.1.1 | MIT | 开发 | 全部 |
| `which-builtin-type` | 1.2.1 | MIT | 开发 | 全部 |
| `which-collection` | 1.0.2 | MIT | 开发 | 全部 |
| `which-typed-array` | 1.1.20 | MIT | 开发 | 全部 |
| `why-is-node-running` | 2.3.0 | MIT | 开发 | 全部 |
| `word-wrap` | 1.2.5 | MIT | 开发 | 全部 |
| `wrap-ansi` | 7.0.0 | MIT | 生产 | 全部 |
| `wrap-ansi` | 8.1.0 | MIT | 生产 | 全部 |
| `xml` | 1.0.1 | MIT | 生产 | 全部 |
| `xml-js` | 1.6.11 | MIT | 生产 | 全部 |
| `xmlbuilder` | 10.1.1 | MIT | 生产 | 全部 |
| `xmlchars` | 2.2.0 | MIT | 生产 | 全部 |
| `yocto-queue` | 0.1.0 | MIT | 开发 | 全部 |
| `zip-stream` | 4.1.1 | MIT | 生产 | 全部 |
| `zod` | 3.25.76 | MIT | 生产 | 全部 |
| `zod-validation-error` | 4.0.2 | MIT | 开发 | 全部 |

### 4.2 Apache-2.0
共 **88** 个（生产 68 / 开发 20）。含专利授权与 NOTICE 义务；本项目未修改这些组件。

| 包名 | 版本 | 许可证（package.json 原值） | 依赖类型 | 平台限定 |
|---|---|---|---|---|
| `@aws-crypto/crc32` | 5.2.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-crypto/crc32c` | 5.2.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-crypto/sha1-browser` | 5.2.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-crypto/sha256-browser` | 5.2.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-crypto/sha256-js` | 5.2.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-crypto/supports-web-crypto` | 5.2.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-crypto/util` | 5.2.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/client-s3` | 3.1053.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/core` | 3.974.13 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/crc64-nvme` | 3.972.9 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/credential-provider-env` | 3.972.39 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/credential-provider-http` | 3.972.41 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/credential-provider-ini` | 3.972.43 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/credential-provider-login` | 3.972.43 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/credential-provider-node` | 3.972.44 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/credential-provider-process` | 3.972.39 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/credential-provider-sso` | 3.972.43 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/credential-provider-web-identity` | 3.972.43 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/middleware-bucket-endpoint` | 3.972.15 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/middleware-expect-continue` | 3.972.13 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/middleware-flexible-checksums` | 3.974.21 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/middleware-location-constraint` | 3.972.11 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/middleware-sdk-s3` | 3.972.42 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/middleware-ssec` | 3.972.11 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/nested-clients` | 3.997.11 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/signature-v4-multi-region` | 3.996.28 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/token-providers` | 3.1052.0 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/types` | 3.973.9 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/util-locate-window` | 3.965.5 | Apache-2.0 | 生产 | 全部 |
| `@aws-sdk/xml-builder` | 3.972.43 | Apache-2.0 | 生产 | 全部 |
| `@aws/lambda-invoke-store` | 0.2.4 | Apache-2.0 | 生产 | 全部 |
| `@eslint/config-array` | 0.21.2 | Apache-2.0 | 开发 | 全部 |
| `@eslint/config-helpers` | 0.4.2 | Apache-2.0 | 开发 | 全部 |
| `@eslint/core` | 0.17.0 | Apache-2.0 | 开发 | 全部 |
| `@eslint/object-schema` | 2.1.7 | Apache-2.0 | 开发 | 全部 |
| `@eslint/plugin-kit` | 0.4.1 | Apache-2.0 | 开发 | 全部 |
| `@humanfs/core` | 0.19.2 | Apache-2.0 | 开发 | 全部 |
| `@humanfs/node` | 0.16.8 | Apache-2.0 | 开发 | 全部 |
| `@humanfs/types` | 0.15.0 | Apache-2.0 | 开发 | 全部 |
| `@humanwhocodes/module-importer` | 1.0.1 | Apache-2.0 | 开发 | 全部 |
| `@humanwhocodes/retry` | 0.4.3 | Apache-2.0 | 开发 | 全部 |
| `@img/sharp-darwin-arm64` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-darwin-x64` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-freebsd-wasm32` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-linux-arm` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-linux-arm64` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-linux-ppc64` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-linux-riscv64` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-linux-s390x` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-linux-x64` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-linuxmusl-arm64` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-linuxmusl-x64` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@img/sharp-webcontainers-wasm32` | 0.35.5 | Apache-2.0 | 生产 | 平台专用二进制 |
| `@prisma/client` | 5.22.0 | Apache-2.0 | 生产 | 全部 |
| `@prisma/debug` | 5.22.0 | Apache-2.0 | 生产 | 全部 |
| `@prisma/engines` | 5.22.0 | Apache-2.0 | 生产 | 全部 |
| `@prisma/engines-version` | 5.22.0-44.605197351a3c8bdd595af2d2a9bc3025bca48ea2 | Apache-2.0 | 生产 | 全部 |
| `@prisma/fetch-engine` | 5.22.0 | Apache-2.0 | 生产 | 全部 |
| `@prisma/get-platform` | 5.22.0 | Apache-2.0 | 生产 | 全部 |
| `@smithy/core` | 3.24.4 | Apache-2.0 | 生产 | 全部 |
| `@smithy/credential-provider-imds` | 4.3.4 | Apache-2.0 | 生产 | 全部 |
| `@smithy/fetch-http-handler` | 5.4.4 | Apache-2.0 | 生产 | 全部 |
| `@smithy/is-array-buffer` | 2.2.0 | Apache-2.0 | 生产 | 全部 |
| `@smithy/node-http-handler` | 4.7.4 | Apache-2.0 | 生产 | 全部 |
| `@smithy/signature-v4` | 5.4.4 | Apache-2.0 | 生产 | 全部 |
| `@smithy/types` | 4.20.0 | Apache-2.0 | 生产 | 全部 |
| `@smithy/util-buffer-from` | 2.2.0 | Apache-2.0 | 生产 | 全部 |
| `@smithy/util-utf8` | 2.3.0 | Apache-2.0 | 生产 | 全部 |
| `@swc/helpers` | 0.5.23 | Apache-2.0 | 生产 | 全部 |
| `aria-query` | 5.3.0 | Apache-2.0 | 开发 | 全部 |
| `aria-query` | 5.3.2 | Apache-2.0 | 开发 | 全部 |
| `axobject-query` | 4.1.0 | Apache-2.0 | 开发 | 全部 |
| `baseline-browser-mapping` | 2.11.23 | Apache-2.0 | 生产 | 全部 |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | 生产 | 全部 |
| `crc-32` | 1.2.2 | Apache-2.0 | 生产 | 全部 |
| `detect-libc` | 2.1.2 | Apache-2.0 | 生产 | 全部 |
| `didyoumean` | 1.2.2 | Apache-2.0 | 生产 | 全部 |
| `doctrine` | 2.1.0 | Apache-2.0 | 开发 | 全部 |
| `eslint-visitor-keys` | 3.4.3 | Apache-2.0 | 开发 | 全部 |
| `eslint-visitor-keys` | 4.2.1 | Apache-2.0 | 开发 | 全部 |
| `eslint-visitor-keys` | 5.0.1 | Apache-2.0 | 开发 | 全部 |
| `expect-type` | 1.3.0 | Apache-2.0 | 开发 | 全部 |
| `prisma` | 5.22.0 | Apache-2.0 | 生产 | 全部 |
| `readdir-glob` | 1.1.3 | Apache-2.0 | 生产 | 全部 |
| `sharp` | 0.35.5 | Apache-2.0 | 生产 | 全部 |
| `ts-interface-checker` | 0.1.13 | Apache-2.0 | 生产 | 全部 |
| `typescript` | 5.9.3 | Apache-2.0 | 开发 | 全部 |
| `xml-name-validator` | 5.0.0 | Apache-2.0 | 开发 | 全部 |

### 4.3 ISC
共 **52** 个（生产 44 / 开发 8）。义务与 MIT 等价（保留版权与许可声明）。

| 包名 | 版本 | 许可证（package.json 原值） | 依赖类型 | 平台限定 |
|---|---|---|---|---|
| `@isaacs/cliui` | 8.0.2 | ISC | 生产 | 全部 |
| `anymatch` | 3.1.3 | ISC | 生产 | 全部 |
| `d3-array` | 3.2.4 | ISC | 生产 | 全部 |
| `d3-color` | 3.1.0 | ISC | 生产 | 全部 |
| `d3-format` | 3.1.2 | ISC | 生产 | 全部 |
| `d3-interpolate` | 3.0.1 | ISC | 生产 | 全部 |
| `d3-path` | 3.1.0 | ISC | 生产 | 全部 |
| `d3-scale` | 4.0.2 | ISC | 生产 | 全部 |
| `d3-shape` | 3.2.0 | ISC | 生产 | 全部 |
| `d3-time` | 3.1.0 | ISC | 生产 | 全部 |
| `d3-time-format` | 4.1.0 | ISC | 生产 | 全部 |
| `d3-timer` | 3.0.1 | ISC | 生产 | 全部 |
| `electron-to-chromium` | 1.5.427 | ISC | 开发 | 全部 |
| `eslint-import-resolver-typescript` | 3.7.0 | ISC | 开发 | 全部 |
| `fastq` | 1.20.1 | ISC | 生产 | 全部 |
| `flatted` | 3.4.2 | ISC | 开发 | 全部 |
| `foreground-child` | 3.3.1 | ISC | 生产 | 全部 |
| `fs.realpath` | 1.0.0 | ISC | 生产 | 全部 |
| `fstream` | 1.0.12 | ISC | 生产 | 全部 |
| `glob` | 10.5.0 | ISC | 生产 | 全部 |
| `glob` | 7.2.3 | ISC | 生产 | 全部 |
| `glob-parent` | 5.1.2 | ISC | 生产 | 全部 |
| `glob-parent` | 6.0.2 | ISC | 生产 | 全部 |
| `graceful-fs` | 4.2.11 | ISC | 生产 | 全部 |
| `inflight` | 1.0.6 | ISC | 生产 | 全部 |
| `inherits` | 2.0.4 | ISC | 生产 | 全部 |
| `internmap` | 2.0.3 | ISC | 生产 | 全部 |
| `isexe` | 2.0.0 | ISC | 生产 | 全部 |
| `listenercount` | 1.0.1 | ISC | 生产 | 全部 |
| `lru-cache` | 10.4.3 | ISC | 生产 | 全部 |
| `lru-cache` | 5.1.1 | ISC | 开发 | 全部 |
| `lru-cache` | 6.0.0 | ISC | 生产 | 全部 |
| `lucide-react` | 0.460.0 | ISC | 生产 | 全部 |
| `minimalistic-assert` | 1.0.1 | ISC | 生产 | 全部 |
| `minimatch` | 3.1.5 | ISC | 生产 | 全部 |
| `minimatch` | 5.1.9 | ISC | 生产 | 全部 |
| `minimatch` | 9.0.9 | ISC | 生产 | 全部 |
| `next-auth` | 4.24.15 | ISC | 生产 | 全部 |
| `node-cron` | 4.2.1 | ISC | 生产 | 全部 |
| `once` | 1.4.0 | ISC | 生产 | 全部 |
| `picocolors` | 1.1.1 | ISC | 生产 | 全部 |
| `rimraf` | 2.7.1 | ISC | 生产 | 全部 |
| `saxes` | 5.0.1 | ISC | 生产 | 全部 |
| `saxes` | 6.0.0 | ISC | 开发 | 全部 |
| `semver` | 6.3.1 | ISC | 开发 | 全部 |
| `semver` | 7.8.5 | ISC | 生产 | 全部 |
| `siginfo` | 2.0.0 | ISC | 开发 | 全部 |
| `signal-exit` | 4.1.0 | ISC | 生产 | 全部 |
| `which` | 2.0.2 | ISC | 生产 | 全部 |
| `wrappy` | 1.0.2 | ISC | 生产 | 全部 |
| `yallist` | 3.1.1 | ISC | 开发 | 全部 |
| `yallist` | 4.0.0 | ISC | 生产 | 全部 |

### 4.4 BSD（BSD-2-Clause / BSD-3-Clause / BSD）
共 **22** 个（生产 11 / 开发 11）。三条款版本含「不得用作者名义背书」条款。

| 包名 | 版本 | 许可证（package.json 原值） | 依赖类型 | 平台限定 |
|---|---|---|---|---|
| `d3-ease` | 3.0.1 | BSD-3-Clause | 生产 | 全部 |
| `damerau-levenshtein` | 1.0.8 | BSD-2-Clause | 开发 | 全部 |
| `dingbat-to-unicode` | 1.0.1 | BSD-2-Clause | 生产 | 全部 |
| `duck` | 0.1.12 | BSD | 生产 | 全部 |
| `duplexer2` | 0.1.4 | BSD-3-Clause | 生产 | 全部 |
| `entities` | 8.0.0 | BSD-2-Clause | 开发 | 全部 |
| `eslint-scope` | 8.4.0 | BSD-2-Clause | 开发 | 全部 |
| `espree` | 10.4.0 | BSD-2-Clause | 开发 | 全部 |
| `esquery` | 1.7.0 | BSD-3-Clause | 开发 | 全部 |
| `esrecurse` | 4.3.0 | BSD-2-Clause | 开发 | 全部 |
| `estraverse` | 5.3.0 | BSD-2-Clause | 开发 | 全部 |
| `esutils` | 2.0.3 | BSD-2-Clause | 开发 | 全部 |
| `ieee754` | 1.2.1 | BSD-3-Clause | 生产 | 全部 |
| `lop` | 0.4.2 | BSD-2-Clause | 生产 | 全部 |
| `mammoth` | 1.12.0 | BSD-2-Clause | 生产 | 全部 |
| `option` | 0.2.4 | BSD-2-Clause | 生产 | 全部 |
| `react-transition-group` | 4.4.5 | BSD-3-Clause | 生产 | 全部 |
| `source-map-js` | 1.2.2 | BSD-3-Clause | 生产 | 全部 |
| `sprintf-js` | 1.0.3 | BSD-3-Clause | 生产 | 全部 |
| `tough-cookie` | 6.0.1 | BSD-3-Clause | 开发 | 全部 |
| `uri-js` | 4.4.1 | BSD-2-Clause | 开发 | 全部 |
| `webidl-conversions` | 8.0.1 | BSD-2-Clause | 开发 | 全部 |

### 4.5 MPL-2.0
共 **1** 个（生产 0 / 开发 1）。文件级 copyleft：修改过的源文件须以 MPL 公开；未修改的使用不受影响。

| 包名 | 版本 | 许可证（package.json 原值） | 依赖类型 | 平台限定 |
|---|---|---|---|---|
| `axe-core` | 4.11.4 | MPL-2.0 | 开发 | 全部 |

### 4.6 LGPL-3.0-or-later
共 **14** 个（生产 14 / 开发 0）。弱 copyleft：动态链接使用须保证可替换/可重链接并提供许可副本。

| 包名 | 版本 | 许可证（package.json 原值） | 依赖类型 | 平台限定 |
|---|---|---|---|---|
| `@img/sharp-libvips-darwin-arm64` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-darwin-x64` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-linux-arm` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-linux-arm64` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-linux-ppc64` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-linux-riscv64` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-linux-s390x` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | 生产 | 全部 |
| `@img/sharp-win32-arm64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-win32-ia32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | 生产 | 平台专用二进制 |
| `@img/sharp-win32-x64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | 生产 | 平台专用二进制 |

### 4.7 其他许可证（0BSD / BlueOak-1.0.0 / CC0-1.0 / Unlicense / Python-2.0 / CC-BY-4.0 / 双许可 / 无声明）
共 **18** 个（生产 12 / 开发 6）。逐项影响见 §5。

| 包名 | 版本 | 许可证（package.json 原值） | 依赖类型 | 平台限定 |
|---|---|---|---|---|
| `@isaacs/nonrecursive-glob-match` | 1.1.0 | BlueOak-1.0.0 | 开发 | 全部 |
| `argparse` | 2.0.1 | Python-2.0 | 开发 | 全部 |
| `big-integer` | 1.6.52 | Unlicense | 生产 | 全部 |
| `buffers` | 0.1.1 | （无 license 字段） | 生产 | 全部 |
| `caniuse-lite` | 1.0.30001810 | CC-BY-4.0 | 生产 | 全部 |
| `jackspeak` | 3.4.3 | BlueOak-1.0.0 | 生产 | 全部 |
| `jszip` | 3.10.1 | (MIT OR GPL-3.0-or-later) | 生产 | 全部 |
| `language-subtag-registry` | 0.3.23 | CC0-1.0 | 开发 | 全部 |
| `lru-cache` | 11.5.0 | BlueOak-1.0.0 | 开发 | 全部 |
| `mdn-data` | 2.27.1 | CC0-1.0 | 开发 | 全部 |
| `minimatch` | 11.0.9 | BlueOak-1.0.0 | 开发 | 全部 |
| `minipass` | 7.1.3 | BlueOak-1.0.0 | 生产 | 全部 |
| `package-json-from-dist` | 1.0.1 | BlueOak-1.0.0 | 生产 | 全部 |
| `path-scurry` | 1.11.1 | BlueOak-1.0.0 | 生产 | 全部 |
| `pizzip` | 3.2.0 | (MIT OR GPL-3.0) | 生产 | 全部 |
| `sax` | 1.6.0 | BlueOak-1.0.0 | 生产 | 全部 |
| `tslib` | 1.14.1 | 0BSD | 生产 | 全部 |
| `tslib` | 2.8.1 | 0BSD | 生产 | 全部 |

---

## 5. 特别标注：非 MIT / Apache-2.0 / BSD / ISC 的组件逐个说明

> 以下为**全部**不属于四大宽松许可（MIT / Apache-2.0 / BSD / ISC）的组件。逐个给出许可性质、在本产品中的用法、以及对分发的影响与处置。

### 5.1 LGPL-3.0-or-later：`@img/sharp-libvips-*`（14 个，均为生产依赖链上的平台二进制）

| 组件 | 版本 | 平台 | 说明 |
|---|---|---|---|
| `@img/sharp-libvips-darwin-arm64` | 1.3.4 | darwin/arm64 | LGPL-3.0-or-later |
| `@img/sharp-libvips-darwin-x64` | 1.3.4 | darwin/x64 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-arm` | 1.3.4 | linux/arm | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-arm64` | 1.3.4 | linux/arm64 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-ppc64` | 1.3.4 | linux/ppc64 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-riscv64` | 1.3.4 | linux/riscv64 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-s390x` | 1.3.4 | linux/s390x | LGPL-3.0-or-later |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | linux/x64 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.4 | linux/arm64 | LGPL-3.0-or-later |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | linux/x64 | LGPL-3.0-or-later |
| `@img/sharp-wasm32` | 0.35.5 | 多平台/多平台 | Apache-2.0 AND LGPL-3.0-or-later AND MIT |
| `@img/sharp-win32-arm64` | 0.35.5 | win32/arm64 | Apache-2.0 AND LGPL-3.0-or-later |
| `@img/sharp-win32-ia32` | 0.35.5 | win32/ia32 | Apache-2.0 AND LGPL-3.0-or-later |
| `@img/sharp-win32-x64` | 0.35.5 | win32/x64 | Apache-2.0 AND LGPL-3.0-or-later |

**性质**：LGPL-3.0-or-later 是弱 copyleft。它不要求 LawLink 开源，但要求：① 随分发提供 LGPL-3.0 许可证副本；② 使接收方能够替换/重链接该库（动态链接方式通常即满足）；③ 若修改该库本身，须公开修改后的源代码。

**本产品的实际用法（实测）**：

- 调用主体是 `sharp@0.35.5`（`next@16.4.6` 的图像优化引擎 + LawLink 直接依赖），libvips 是 sharp 通过 N-API 加载的**独立共享库**，不是静态链接进 LawLink 产物。
- 部署镜像内实测路径与体积：`/app/node_modules/@img/sharp-libvips-linuxmusl-arm64/lib/libvips-cpp.so.8.18.7`（18,712,760 字节），以普通文件形式存在于镜像文件系统中，接收方可直接替换该 `.so` 文件。
- 本项目**未修改** libvips 的任何源码或二进制。

**影响判定**：属于 LGPL 允许的「动态链接 + 独立可替换库」使用形态，**不传染** LawLink 自身代码的 MIT 许可。

**处置（已识别，待法务确认口径）**：见 §7.2。

### 5.2 双许可（MIT OR GPL）：`jszip@3.10.1`、`pizzip@3.2.0`

| 组件 | 版本 | 声明 | 本项目选择 | 依赖链（`npm ls` 实测） |
|---|---|---|---|---|
| `jszip` | 3.10.1 | `(MIT OR GPL-3.0-or-later)` | **MIT** | `lawlink → docx@9.6.1 / exceljs@4.4.0 / mammoth@1.12.0 → jszip` |
| `pizzip` | 3.2.0 | `(MIT OR GPL-3.0)` | **MIT** | `lawlink → pizzip`（直接依赖，供 `docxtemplater` 使用） |

**依据**：两个包自带的 `LICENSE.markdown` 正文首段均明确写明「dual licensed. At your choice you may use it under the MIT license *or* the GPLv3 license」——双许可由被许可方择一，选择 MIT 后即按 MIT 使用与分发，**GPL 分支不产生任何义务**。

**处置**：在分发中按 MIT 声明。建议在发布说明中保留一句「JSZip / PizZip 采用 MIT 分支」，以免尽调方看到 `GPL` 字样反复追问。

### 5.3 MPL-2.0：`axe-core@4.11.4`（1 个，仅开发依赖）

- 声明：`MPL-2.0`；自带 `LICENSE` 与 `LICENSE-3RD-PARTY.txt`。
- 依赖链（`npm ls` 实测）：`lawlink → eslint-config-next@16.4.6 → eslint-plugin-jsx-a11y@6.10.2 → axe-core@4.11.4`。
- 用途：ESLint 可访问性规则（`jsx-a11y`）的静态分析数据表，**不进入运行时、不参与业务逻辑**。
- 影响：MPL-2.0 是**文件级** copyleft——只对「被修改过的 MPL 源文件」要求以 MPL 公开；未修改的使用、以及与其它代码的组合（Larger Work）不受影响。本项目未修改 axe-core，故无源码公开义务，只需保留其许可声明。
- **注意（实测发现）**：当前 `Dockerfile` 的 `deps` 阶段执行裸 `npm ci`（未设 `NODE_ENV=production`），`runner` 阶段又整体 `COPY --from=builder /app/node_modules`，因此**部署镜像内实际包含开发依赖**——实测镜像内 `axe-core` 4.11.4 与 `typescript` 5.9.3 均存在。这放大了「开发依赖也须随镜像合规」的范围，处置建议见 `LICENSE-AUDIT-20261119.md` §6。
- **关于 `lightningcss`**：任务书列出的 `lightningcss`（MPL-2.0）**在本项目依赖树中不存在**。`npm ls lightningcss` 输出为空；`package-lock.json` 中 2 处命中仅为 `next` 的可选 `peerDependenciesMeta` 声明（未安装）。因此 MPL 组件实际只有 `axe-core` 一个。

### 5.4 无许可证声明：`buffers@0.1.1`（1 个，生产依赖）

见 §7.1（单列处置）。

### 5.5 CC-BY-4.0：`caniuse-lite@1.0.30001810`（1 个，生产依赖）

- 依赖链（`npm ls` 实测）：`lawlink → next@16.4.6 → caniuse-lite`（另经开发依赖 `autoprefixer@10.5.0 → browserslist@4.28.9 → caniuse-lite`）。
- 用途：浏览器兼容性数据表（Next.js 构建期按 `browserslist` 选择编译目标）。
- 影响：CC-BY-4.0 允许商用与再分发，**条件是署名（attribution）**。本项目在此列表即构成署名，另建议在发布说明中写明「浏览器兼容性数据由 caniuse-lite 提供（CC-BY-4.0，https://github.com/browserslist/caniuse-lite）」。
- 附带：该包自带 `LICENSE` 文件随分发包保留。

### 5.6 其余非常规许可证（逐项）

| 许可证 | 组件 | 版本 | 依赖类型 | 商用影响 |
|---|---|---|---|---|
| BlueOak-1.0.0 | `@isaacs/nonrecursive-glob-match` | 1.1.0 | 开发 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| Python-2.0 | `argparse` | 2.0.1 | 开发 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| Unlicense | `big-integer` | 1.6.52 | 生产 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| BlueOak-1.0.0 | `jackspeak` | 3.4.3 | 生产 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| CC0-1.0 | `language-subtag-registry` | 0.3.23 | 开发 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| BlueOak-1.0.0 | `lru-cache` | 11.5.0 | 开发 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| CC0-1.0 | `mdn-data` | 2.27.1 | 开发 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| BlueOak-1.0.0 | `minimatch` | 11.0.9 | 开发 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| BlueOak-1.0.0 | `minipass` | 7.1.3 | 生产 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| BlueOak-1.0.0 | `package-json-from-dist` | 1.0.1 | 生产 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| BlueOak-1.0.0 | `path-scurry` | 1.11.1 | 生产 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| BlueOak-1.0.0 | `sax` | 1.6.0 | 生产 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| 0BSD | `tslib` | 1.14.1 | 生产 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |
| 0BSD | `tslib` | 2.8.1 | 生产 | 宽松许可，可商用；0BSD / Unlicense / CC0 甚至不要求署名，本项目仍统一保留声明 |

补充说明：

- **`BlueOak-1.0.0`**（8 个，其中 `jackspeak`、`minipass`、`path-scurry`、`package-json-from-dist`、`sax@1.6.0` 为生产依赖）：Blue Oak Council 的模型许可，条款为「无任何限制」式宽松许可 + 明示不授予商标权，商用无障碍。
- **`Python-2.0`**（`argparse@2.0.1`，仅开发依赖）：Python 2.0 许可，宽松、可商用，需保留声明。
- **`Unlicense`**（`big-integer@1.6.52`，生产依赖，经 `exceljs → unzipper`）：公共领域奉献，无义务。
- **`0BSD`**（`tslib@1.14.1`、`tslib@2.8.1`）：零条款 BSD，无义务。
- **`CC0-1.0`**（`language-subtag-registry`、`mdn-data`，均开发依赖）：公共领域奉献，无义务。

---

## 6. 未随包提供许可证文本文件的组件（需在分发时补齐）

实测：本机 784 个已安装组件中（另 1 个为其他平台专用、本机未安装），**47** 个包的目录内不含任何 `LICENSE`／`LICENCE`／`COPYING`／`NOTICE`／`UNLICENSE` 文件；其中 **32** 个是生产依赖。这些组件的许可证信息只存在于 `package.json` 的 `license` 字段（本清单已逐个记录），因此**本文件构成其许可声明的补充载体**。

| 包名 | 版本 | 许可证 | 依赖类型 | 补齐建议 |
|---|---|---|---|---|
| `@aws-sdk/credential-provider-http` | 3.972.41 | Apache-2.0 | 生产 | 引用本清单即可 |
| `@aws-sdk/credential-provider-login` | 3.972.43 | Apache-2.0 | 生产 | 引用本清单即可 |
| `@aws-sdk/nested-clients` | 3.997.11 | Apache-2.0 | 生产 | 引用本清单即可 |
| `@esbuild/darwin-arm64` | 0.28.1 | MIT | 生产 | 引用本清单即可 |
| `@img/sharp-libvips-darwin-arm64` | 1.3.4 | LGPL-3.0-or-later | 生产 | **须随分发附 LGPL-3.0 全文——见 §7.2** |
| `@napi-rs/canvas-darwin-arm64` | 0.1.100 | MIT | 生产 | 引用本清单即可 |
| `@next/env` | 16.4.6 | MIT | 生产 | 引用本清单即可 |
| `@next/swc-darwin-arm64` | 16.4.6 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/number` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-compose-refs` | 1.1.2 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-context` | 1.1.2 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-direction` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-id` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-use-callback-ref` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-use-layout-effect` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-use-previous` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-use-rect` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/react-use-size` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `@radix-ui/rect` | 1.1.1 | MIT | 生产 | 引用本清单即可 |
| `binary` | 0.3.0 | MIT | 生产 | 引用本清单即可 |
| `buffers` | 0.1.1 | （无 license 字段） | 生产 | **无任何许可声明——见 §7.1** |
| `chainsaw` | 0.1.0 | MIT/X11 | 生产 | 引用本清单即可 |
| `client-only` | 0.0.1 | MIT | 生产 | 引用本清单即可 |
| `dingbat-to-unicode` | 1.0.1 | BSD-2-Clause | 生产 | 引用本清单即可 |
| `dlv` | 1.1.3 | MIT | 生产 | 引用本清单即可 |
| `eastasianwidth` | 0.2.0 | MIT | 生产 | 引用本清单即可 |
| `hash.js` | 1.1.7 | MIT | 生产 | 引用本清单即可 |
| `isarray` | 1.0.0 | MIT | 生产 | 引用本清单即可 |
| `next-auth` | 4.24.15 | ISC | 生产 | 引用本清单即可 |
| `react-remove-scroll-bar` | 2.3.8 | MIT | 生产 | 引用本清单即可 |
| `saxes` | 5.0.1 | ISC | 生产 | 引用本清单即可 |
| `victory-vendor` | 36.9.2 | MIT AND ISC | 生产 | 附 MIT 与 ISC 两份文本 |

> 说明：上表按「本机（darwin/arm64）实际安装目录」检测。其他平台专用二进制（如 `@img/sharp-libvips-linux-x64`）本机未安装，但其包内同样不带许可文本文件（已由镜像内 `sharp-libvips-linuxmusl-arm64` 目录实测确认：仅有 `README.md`、`lib/`、`package.json`、`versions.json`）。

---

## 7. 已知风险项与处置状态

### 7.1 `buffers@0.1.1` —— 无许可证声明（**唯一实质风险项**）

| 项 | 实测结果 |
|---|---|
| 组件 | `buffers@0.1.1` |
| `package.json` `license` 字段 | **不存在**（字段缺失，非空字符串） |
| 包内许可文本文件 | **无**（目录仅：`README.markdown`、`index.js`、`package.json`、`examples/`、`test/`） |
| README 内许可声明 | **无**（已通读 `README.markdown` 全文，只有用法与 API 说明） |
| npm 注册表元数据 | `npm view buffers --json` 无 `license` 键；发布于 2011-10-12（0.1.1），维护者 `substack` |
| 上游仓库 | `http://github.com/substack/node-buffers` → **HTTP 404**（本次联网实测确认，非引用他人结论） |
| 依赖链 | `lawlink → exceljs@4.4.0 → unzipper@0.10.14 → binary@0.3.0 → buffers@0.1.1`（`npm ls buffers` 实测） |
| 是否进入部署镜像 | **是**（镜像内 `/app/node_modules/buffers` 实测存在） |
| 代码规模 | `index.js` 7,057 字节；唯一直接使用者是 `binary@0.3.0`（`binary` 自身声明 MIT） |

**风险描述**：无许可证声明的组件，在法律上属于「保留所有权利」（默认版权），严格解释下不构成分发授权。

**处置建议（优先级 P1）**：

1. **短期（随本次分发即可）**：在发布说明／SECURITY 或本文件内以显式段落记载该组件来源、链上位置与「无许可声明」事实，并保留其原始 `README.markdown` 与作者署名（James Halliday `mail@substack.net`）。这是**披露**而非取得授权。
2. **中期（建议纳入下一批次代码任务，本轮不执行）**：从依赖树中消除它——`unzipper` 仅在 `exceljs` 的流式解压路径使用，可选方案：① 升级 `exceljs`／用 `overrides` 把 `unzipper` 提到不再依赖 `binary → buffers` 的版本；② 若 `exceljs` 的 xlsx 读写改为 `jszip` 路径则可移除。**这需要改 `package.json`，超出本轮「只写文档」的授权范围，须由主控单独立项并跑全量测试。**
3. **法务口径**：请法务确认「在开源项目中分发一个 2011 年、无声明、作者仓库已消失的 30 行工具库」是否按「默示许可/低风险容忍」处理；若不接受，则按第 2 条消除依赖。

### 7.2 `@img/sharp-libvips-*` —— LGPL-3.0-or-later，动态链接

| 项 | 实测结果 |
|---|---|
| 组件 | `@img/sharp-libvips-{darwin-arm64,darwin-x64,linux-arm,linux-arm64,linux-ppc64,linux-riscv64,linux-s390x,linux-x64,linuxmusl-arm64,linuxmusl-x64}@1.3.4` |
| 声明 | 全部 `LGPL-3.0-or-later` |
| 镜像内实际安装的那一个 | `@img/sharp-libvips-linuxmusl-arm64@1.3.4`（因基础镜像 `node:22-alpine` 为 musl + 本机 arm64 构建） |
| 形态 | 独立共享库文件 `lib/libvips-cpp.so.8.18.7`，18,712,760 字节 |
| 加载方式 | 由 `sharp@0.35.5` 通过 N-API 在运行时加载（非静态链接、非编译进 LawLink 产物） |
| 是否修改 | 未修改 |
| 包内许可文本 | **无** `LICENSE` 文件（仅 `README.md`/`lib`/`package.json`/`versions.json`）→ 必须由本项目随分发补齐 LGPL-3.0 全文 |

**风险描述**：LGPL-3.0 的弱 copyleft 义务。当前形态（动态链接 + 可替换的独立 `.so` + 未修改）属于 LGPL 明确允许的用法，**不传染** MIT 代码。

**处置建议（优先级 P2，需法务确认文案）**：

1. 随产品分发提供 **LGPL-3.0 许可证全文**（上游包未自带，必须由本项目补齐；建议作为 `docs/licenses/LGPL-3.0.txt` 附于发行物——本轮未创建，因本文档授权范围仅两个文件）。
2. 在发布说明中提供「如何替换 libvips」的说明（镜像内替换 `/app/node_modules/@img/sharp-libvips-*/lib/libvips-cpp.so.*` 后重启即可），以满足 LGPL-3.0「可重链接」要求。
3. 保持 `sharp` 版本升级路径不变更（升级只换二进制，不引入源码修改）。
4. 如未来需要彻底规避 LGPL 讨论，可评估 `sharp` 的 `--libvips` 自制构建或改用其它图像库——属产品决策，不在本轮范围。

### 7.3 `axe-core@4.11.4` —— MPL-2.0（仅开发依赖）

- 未修改 → **无源码公开义务**；保留声明即可（本文件已列）。
- 附加发现：部署镜像内确实包含该包（`Dockerfile` 未裁剪 devDependencies）。这不构成 MPL 违规（未修改即无义务），但会让「镜像内含 MPL/GPL 字样的包」成为尽调问询点，处置见 §8 与审计报告 §6。

### 7.4 `jszip@3.10.1` / `pizzip@3.2.0` —— MIT OR GPL 双许可

- **已择 MIT**，依据为两包 `LICENSE.markdown` 正文明确的双许可声明（见 §5.2）。
- GPL 分支不产生义务，无 copyleft 传染。

### 7.5 风险项计数

| 等级 | 数量 | 明细 |
|---|---|---|
| P1（须处置/须法务定口径） | 1 | `buffers@0.1.1` 无许可声明 |
| P2（须补齐声明载体，不影响可用性） | 2 | `@img/sharp-libvips-*` 缺 LGPL 全文；`caniuse-lite` CC-BY-4.0 需署名 |
| P3（记录即可，已按宽松许可处理） | 3 | `axe-core`（MPL，未修改）、`jszip`／`pizzip`（择 MIT）、`argparse`／`victory-vendor`／`pako` 等组合式宽松许可 |
| **合计** | **6** | 其中**阻断分发**：0 |

---

## 8. 禁止商用 / 强 copyleft 许可证扫描结论

扫描范围：全部 901 个组件的 `license` 字段、`package-lock.json` 全文字符串、以及各包 `LICENSE` 文件（对重点包逐个通读）。

| 被扫描类别 | 结果 |
|---|---|
| AGPL-3.0 / AGPL-anywhere | **未发现** |
| SSPL（Server Side Public License） | **未发现** |
| BUSL / Business Source License | **未发现** |
| Commons Clause / 「非商用」附加条款 | **未发现** |
| CC-BY-NC / 任何 NC（NonCommercial）变体 | **未发现** |
| Elastic License / 其它「源码可见但限制商用」许可 | **未发现** |
| 纯 GPL-2.0 / GPL-3.0（非双许可、非 LGPL） | **未发现** |
| `UNLICENSED` / `SEE LICENSE IN` / 「Proprietary」 | **未发现** |

证据（可复现）：

```bash
# 1) 全 lockfile 关键字扫描（输出为空即未发现）
grep -o -i -E "AGPL|SSPL|BUSL|Commons Clause|CC-BY-NC|Elastic License|noncommercial|NonCommercial" package-lock.json | sort -u

# 2) 非宽松许可包清单（本次结果见 §3）
#    仅出现：LGPL-3.0-or-later(14) / MPL-2.0(1) / 双许可 MIT-OR-GPL(2) / 无声明(1) / 其它宽松(18)
```

**结论：本产品依赖树中不存在禁止商用或强 copyleft（AGPL/SSPL/GPL）许可的组件。**

---

## 9. 复核方法（可复现）

```bash
cd <LawLink 仓库根>

# ① 依赖清单基数（本次结果：901 个 name@version）
node -e 'const l=require("./package-lock.json");const s=new Set();
for(const [k,v] of Object.entries(l.packages)){if(k&&v.version)s.add((v.name||k.replace(/^.*node_modules\//,""))+"@"+v.version);}
console.log(s.size);'

# ② 许可证分布
node -e 'const l=require("./package-lock.json");const c={};
for(const [k,v] of Object.entries(l.packages)){if(!k)continue;const x=String(v.license);c[x]=(c[x]||0)+1;}
console.log(Object.entries(c).sort((a,b)=>b[1]-a[1]));'

# ③ 禁止商用许可扫描（应无输出）
grep -o -i -E "AGPL|SSPL|BUSL|CC-BY-NC|Elastic License" package-lock.json | sort -u

# ④ 项目自身许可
head -3 LICENSE   # 期望：MIT License / Copyright (c) 2026 叶森 (Sen Ye)

# ⑤ buffers 依赖链
npm ls buffers

# ⑥ 部署镜像内的实际依赖形态（需镜像 lawlink-app:latest）
docker run --rm --entrypoint sh lawlink-app:latest -c 'ls node_modules/@img; ls -l node_modules/@img/*/lib/*.so*;   node -p "require("/app/node_modules/axe-core/package.json").license"'
```

---

## 10. 附注

1. 本清单的「生产／开发」标记以 `package-lock.json` 的 `dev` 字段为准；**当前 `Dockerfile` 会在运行镜像中包含开发依赖**，故对分发而言两者都实际存在。是否裁剪由后续代码批次决定（见审计报告 §6）。
2. 平台专用二进制（`os`/`cpu` 约束）在一次构建中只会安装与本机平台匹配的那一个；本清单按「可能出现的全部变体」列出，便于任意目标平台分发时都能覆盖。
3. 本清单不构成法律意见。存在疑义时（尤其是 §7.1 `buffers` 与 §7.2 LGPL 文案），以法务/尽调结论为准。
4. 清单随依赖变更需重新生成；建议在发布检查单中加入「重跑 §9 命令并更新本文档」。

---

*文档结束。共 901 个第三方组件。*
