# 安全策略（心印 dsh-heartprint）

心印是本机 DSH 插件：不联网、不上传、无第三方依赖。安全边界、威胁模型与架构落实见：

- [`docs/security/trust-boundary.md`](docs/security/trust-boundary.md) — 信任边界、身份转换点、STRIDE
- [`docs/security/architectures.md`](docs/security/architectures.md) — SDL / ASVS L2 / SLSA / SBOM / 零信任 / Saltzer 八原则

## 报告安全问题

请通过 GitHub Security Advisory（仓库 Security → Report a vulnerability）私下报告，
或者开一个不含利用细节的 issue 说明类型。48 小时内回复。

请不要在公开 issue 里贴可直接利用的细节。

## 本项目的安全承诺

| 项 | 说明 |
|---|---|
| 网络 | 无出站连接；入站只有本机回环的同源设置接口 |
| 权限 | 以 DSH 用户身份运行，不申请管理员权限，不访问系统目录 |
| 数据 | 记忆与配置在本机数据目录；加密档案 AES-256-GCM，密钥文件 0600 |
| 输入 | 设置接口与工具参数都按不可信输入处理：白名单、净化、体积/频率限制、路径校验 |
| 供应链 | 无运行时依赖；每个发布附带 CycloneDX SBOM（`sbom.cdx.json` + `npm run sbom:check`）；CI 发布走 `npm publish --provenance` |

## 已知局限（诚实记录）

- 记忆库与交付文档是**明文**的：同一 Windows 账号下的攻击者可读；加密档案的密钥也存于同一账号下，
  防的是「随手翻看/误暴露」，防不住同账号的坚定攻击者。
- 设置接口跑在本机 HTTP（回环）上，没有 TLS；浏览器与 DSH 在同一台机器，风险面为本地进程。
- 早期版本由开发机本地发布，尚无 CI provenance；从 1.1.0 起的发布由 GitHub Actions 生成 provenance。
