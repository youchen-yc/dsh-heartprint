# 发布流程（含「旧版本不安全」提示规则）

## 这条规则是什么

在**接下来 3 个新版本**的发布说明里，必须保留加粗的旧版本安全提示：

> **⚠️ 安全提示：1.1.0 之前的版本（1.0.0 / 1.0.1 / 1.0.2）没有经过安全加固，存在已知的加固缺失（设置接口无默认拒绝与限流、名字未做文件名净化、交付路径未校验）。请不要下载或使用这些旧版本，请使用 1.1.0 及以上版本。**

这条提示同时出现在两处：

1. **README 顶部**（npm 包页面与 GitHub 仓库都会显示；npm 每个新版本的说明就是从 README 渲染的）
2. **GitHub Release 说明**（发布 workflow 自动创建 Release 时写入）

## 怎么保证「连续 3 次」不靠记忆

`release-policy.json`：

```json
{ "legacyWarning": { "sinceVersion": "1.1.0", "remainingReleases": 3, "bold": true, "text": "…" } }
```

- `npm publish` 会触发 `prepublishOnly` → `node scripts/release-check.mjs`
- 只要 `remainingReleases > 0` 且 README 里没有这条提示原文，**发布直接失败**
- 每发布一个版本后执行一次：`node scripts/release-check.mjs --decrement`（把剩余次数减 1）
- 减到 0 后，脚本不再强制；此时可以决定是否把提示从 README 移除

这样即使换了会话、换了人，也不可能「忘了加提示就发出去」。

## 一次完整发布

```bash
# 1. 改完代码，跑全部检查（测试 + 秘密扫描 + SBOM 一致性）
npm run verify

# 2. 升版本号（修 bug 升 PATCH，加功能升 MINOR）
#    改 package.json 的 version

# 3. 重新生成 SBOM（版本号变了，哈希也变了）
npm run sbom

# 4. 提交并推两边
git add -A
git commit -m "feat: …"
git push origin master
git push github master

# 5. 发布（prepublishOnly 会自动检查旧版本提示是否还在）
npm publish --access public

# 6. 把提示剩余次数减 1
node scripts/release-check.mjs --decrement
git add release-policy.json
git commit -m "chore: 旧版本安全提示剩余次数 -1"
git push origin master && git push github master
```

## 发布后核对

```bash
npm view dsh-heartprint version                                   # latest 是否是新版本
npm view dsh-heartprint dist-tags
npm view dsh-heartprint readme | head -20                         # README 顶部提示是否在
```

## 安全评审（改代码后必须重跑）

改过代码后，之前的代码安全评审会失效。发布前重新提交：

1. `npm run verify` 全绿
2. `security_judge` → `action=submit`，证据沿用 `docs/security/compliance.md`
3. 拿到 `verdict=pass` 后再发布

## 旧版本处理

- 1.0.0 / 1.0.1 / 1.0.2 仍在 npm 上，**不能**用 bypass-2FA token 下架（npm 403）
- 要删需要账号配好真 2FA（Windows Hello / 安全密钥），然后 `npm unpublish dsh-heartprint@1.0.x --force`
- 在删掉之前，靠发布说明里的加粗提示 + 默认安装最新版来降低误用
