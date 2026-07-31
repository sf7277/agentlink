# Third-Party Notices

AgentLink 0.1.21的production依赖来源于npm lockfile。发布目录保留各包自带的LICENSE文件，
并包含CycloneDX SBOM。本文是来源索引，不替代各依赖的原始许可证文本。

AgentLink项目自身采用`PolyForm-Noncommercial-1.0.0`，见根目录`LICENSE`；该许可证只适用于AgentLink贡献代码，不替代或改变第三方依赖的原始许可证。

## 直接依赖

| 组件 | 版本 | 许可证 | 来源 |
|---|---:|---|---|
| better-sqlite3 | 12.11.1 | MIT | `pkg:npm/better-sqlite3@12.11.1` |
| lossless-json | 4.3.0 | MIT | `pkg:npm/lossless-json@4.3.0` |
| zod | 4.4.3 | MIT | `pkg:npm/zod@4.4.3` |

## 间接production依赖

| 许可证 | 组件与版本 |
|---|---|
| Apache-2.0 | detect-libc@2.1.2；tunnel-agent@0.6.0 |
| BSD-3-Clause | ieee754@1.2.1 |
| ISC | chownr@1.1.4；inherits@2.0.4；ini@1.3.8；once@1.4.0；semver@7.8.5；wrappy@1.0.2 |
| MIT OR WTFPL | expand-template@2.0.3 |
| BSD-2-Clause OR MIT OR Apache-2.0 | rc@1.2.8 |
| MIT | base64-js@1.5.1；bindings@1.5.0；bl@4.1.0；buffer@5.7.1；decompress-response@6.0.0；deep-extend@0.6.0；end-of-stream@1.4.5；file-uri-to-path@1.0.0；fs-constants@1.0.0；github-from-package@0.0.0；mimic-response@3.1.0；minimist@1.2.8；mkdirp-classic@0.5.3；napi-build-utils@2.0.0；node-abi@3.94.0；prebuild-install@7.1.3；pump@3.0.4；readable-stream@3.6.2；safe-buffer@5.2.1；simple-concat@1.0.1；simple-get@4.0.1；string_decoder@1.3.0；strip-json-comments@2.0.1；tar-fs@2.1.5；tar-stream@2.2.0；util-deprecate@1.0.2 |

精确组件、hash和依赖关系以对应发布目录中的`sbom.cdx.json`为准。
