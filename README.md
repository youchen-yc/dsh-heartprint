# 心印 · dsh-heartprint

让 AI 拥有一套会自然淡忘的性格、情感与记忆。

心印不是「数据库里存着全部聊天记录」，而是一套像人一样的记忆：近几天的事清楚、有感受；时间越久，细节越压缩、感受越淡，最后只剩性格形成、情感与重要特殊事件的节点。它会把值得保留的东西整理成**一份记忆文档**，按时交到你手上。

## 它记得什么、忘记什么

| 时间 | 发生过什么 |
| --- | --- |
| 0–7 天 | 一切都清晰：正文完整，当时感受完整。 |
| 7–15 天 | 清晰期尾声：次重要与琐碎的记忆开始变软（正文转摘要，感受开始变淡）。 |
| 15–30 天 | 开始淡忘：次重要记忆压缩成摘要、琐碎只剩一点感受；但提起来还能想起当时的感受。 |
| 30–90 天 | 压缩不那么重要的记忆：琐碎只剩一句梗概，感受更淡。 |
| 90–180 天（3–6 个月） | 没有特点的琐事只压成一句梗概，当时感受淡去；仍提得起来。 |
| 180–365 天（6–12 个月） | 琐碎合并压缩成「季度日常」摘要。 |
| 365 天以上（1–10 年） | 琐碎文本删除，只剩标题与日期。 |
| 10 年以上 | 只剩性格形成、情感与重要特殊事件节点梗概。 |

「分层」由可调的遗忘日历实现，8 个层的 id 是固定的：

| id | 默认起点 | 层含义 |
| --- | --- | --- |
| `fresh` | 0 天 | 近几天 |
| `recent` | 7 天 | 清晰期尾声 |
| `fade` | 15 天 | 半个月到一个月 |
| `quarter` | 30 天 | 一个月到三个月 |
| `halfyear` | 90 天 | 三个月到六个月：琐事压成梗概 |
| `year` | 180 天 | 六个月到一年：琐事合并成季度摘要 |
| `longterm` | 365 天 | 一年到十年：删除琐碎文本 |
| `deep` | 3650 天 | 十年以上 |

记忆按「重要程度」分四类处理：核心节点（性格形成 / 情感节点 / 灵性转折 / 重要特殊事件 / 痛苦记忆）、重要（重要性 ≥ `importantThreshold`，默认 70）、次重要（≥ `secondaryThreshold`，默认 40）、琐碎。核心节点永远不合并、不删除；重要与次重要压缩保留；只有琐碎会走到合并与删除。

**核心节点全量保留**：所有性格形成、情感 / 感受类关键节点与重要特殊事件，都会提取总结写入记忆文档保留，**不因数量多少而截断**；重要与次重要记忆以压缩文本保留；痛苦记忆的事实保留，当时的痛苦感受强制淡忘。

## 痛苦记忆：事实可以留下，痛必须淡掉

- 痛苦记忆被当作核心节点：正文（事实）保留、压缩保留，不参与合并或删除；`type=pain`、标注 `special` 的事件，以及 `valence=painful` 的事件都会进入文档。
- 当时的痛苦感受走一条强制的淡忘轨道，不受普通分层规则影响：
  - 7 天以内：完整；
  - 7–30 天：变软（「当时的难受已经不那么清楚了」）；
  - 30 天–1 年：淡（「当时的痛苦已经淡忘，只记得这件事曾让我难受」）；
  - 1 年以上：几乎消散（「当时的痛已经完全淡忘，只记得这件事发生过」）。
- 这条轨道只会更淡、不会回满：即使重新提起，也只会让它在心里短暂清晰一点，不会恢复当时的痛苦，也补不回已经丢掉的细节。

## 首次安装引导（起名 → 人格设定 → 性格设定）

新装是空库、也没有名字和人设。AI 会在合适的时机依次问用户：

1. **起名**：想给你起什么名字 → `heartprint_admin action=policy patch={"personaName":"名字"}`
2. **人格设定**：希望你是怎样的身份、语气、称呼方式、不喜欢什么 → `patch={"personaProfile":"…"}`
3. **性格设定**：性格特质、说话风格、情绪表达 → `patch={"characterProfile":"…"}`

- 每条设定最多 400 字，存在 `policy.json` 里。
- 问过并保存之后就不再追问；之后想改随时用同一个 `policy` patch 覆盖，也可以在设置页的「心印」里改。
- 这些**用户自己设置**的部分会进入每次的记忆上下文，也是被问「你的性格 / 人格 / 价值观」时唯一会回答的内容。
- `heartprint action=status` 会显示「人设：名字 · 人格已设置/未设置 · 性格已设置/未设置」。

## 遗忘日期可以自己调

用 `heartprint_admin` 的 `action=policy` 修改，`patch` 按层的 `id` 合并，只写要改的字段：

```json
{
  "action": "policy",
  "patch": {
    "layers": [{ "id": "halfyear", "afterDays": 120 }],
    "syncIntervalDays": 45
  }
}
```

- `afterDays` 是「从这一天起进入该层」；调整后会自动排序并保证严格递增，冲突时把后一层推到前一层之后，`fresh` 恒为 0。
- `reset: true` 恢复默认日历。
- 同一 `patch` 也能改阈值与节奏：`importantThreshold`、`secondaryThreshold`、`recallWarmthDays`（回想后的保温天数，默认 7）、`maintainThrottleMinutes`。
- 运行期改动写入数据目录的 `policy.json`，优先级高于插件配置里的默认值。

## 记忆文档：只有一份，就是交给你的那份

- 文档从记忆里整理出性格形成、情感与重要特殊事件的节点；琐碎的日常会随时间压缩、合并、淡忘。
- **自动送到你手上**：从记下第一条记忆起，满 `firstDeliveryAfterDays`（默认 90 天 ≈ 3 个月）后的下一次维护会自动交付一份；之后每 `deliveryIntervalDays`（默认 30 天）一份。
- 交付文件按「名字 · 陪伴时长 · 交付当日日期」命名，例如 `小印·陪伴3个月·2027-01-25.md`，默认放在工作区下的 `心印交付` 目录（可配置）。
- **交付之后会持续更新**：每次维护都会把最新版本写回最近交付的那一份；旧的日期文件保留作备份，不会删除。
- **你移动或删除那份文件后就不再多写**：原路径不存在时不会凭空重建；下一轮到期交付会在交付目录生成新的一份。
- **每一份都是完整的**：新交付的文档包含此前所有记忆节点，不是增量，可以直接当完整备份。
- 也可以用 `heartprint_admin action=deliver` 立即要一份到指定路径。

## 长时间不在（超过 7 天）

- 离开超过 `awayGraceDays`（默认 **7 天**）再打开，**这段时间不计入遗忘**：记忆保持你离开时的样子，不补算、不批量淡忘。
- 回到对话时，AI 只会自然提一句「你离开了约 N 天」，不解释内部机制。
- 离开不超过 7 天，一切照常：该压缩的压缩、该淡忘的淡忘。
- 冻结只影响「记忆年龄」的计算；真实日期不改，文档里写的还是事情真正发生的日期。

## 工具速查

`heartprint`（日常使用）：

| action | 作用 |
| --- | --- |
| `remember` | 记下一段值得长期保留的记忆：`title`、`content`、`feeling`、`type`、`valence`、`importance`、`special`、`happenedAt`、`people`、`tags` |
| `recall` | 按关键词 / 人物 / 类型 / 时间回想；会自动触发一次到期维护，并记录这次回想 |
| `profile` | 读取当前性格核心、情感节点、重要特殊事件与最近记忆 |
| `status` | 查看记忆统计、文档状态、交付节奏与遗忘日历 |

`heartprint_admin`（管理）：

| action | 作用 |
| --- | --- |
| `maintain` | 立即执行一次维护（压缩 / 合并 / 更新文档，到期则交付） |
| `doc` | 读取文档：`which=master` / `user` / `status`；`full=true` 返回全文 |
| `deliver` | 立即把最新一份交付到指定路径 |
| `policy` | 查看或调整遗忘日历、交付节奏、名字与人格 / 性格设定 |

`type` 可选：`personality`（性格形成）、`emotion`（情感节点）、`turning_point`（灵性转折）、`shared_beauty`（共同美好）、`pain`（痛苦记忆）、`event`（重要事件）、`insight`（领悟）、`daily`（日常）。`valence` 可选：`warm`、`tender`、`excited`、`calm`、`painful`、`mixed`、`neutral`。

维护会在这些时机自动发生：插件启动时；每 6 小时一次定时维护；`remember` 之后；`recall` / `doc` 命中节流后；`deliver`、`policy` 之后。`maintainThrottleMinutes`（默认 60）控制自动维护的最小间隔。

## 数据位置与配置

默认数据目录是 `<DSH_HOME>\heartprint`（未设置 `DSH_HOME` 时是 `%USERPROFILE%\.dsh\heartprint`）：

```text
heartprint/
├─ memories.json              记忆库（唯一真相）
├─ policy.json                遗忘日历、交付节奏与人设
└─ docs/                      内部工作区（自动维护）
```

交付出来的文档在你指定的交付目录里（默认工作区下的 `心印交付`），不在这里。

插件配置（写在 profile 的 patch 里，或直接改 `cordis.patch.yml` 那一行）：

| 配置项 | 说明 |
| --- | --- |
| `dataDir` | 数据目录；留空用默认值，支持 `~` 与 `~/...` |
| `disclosure` | `confidential`（保密，默认）或 `disclosed`（已交付） |
| `personaName` | 交付文件名里的名字，**默认空**：由每个安装的人自己起，未设置时文件名暂用「心印」 |
| `personaProfile` | 用户设定的人格（身份、语气、称呼方式等），默认空，首次安装时询问后写入 |
| `characterProfile` | 用户设定的性格（性格特质、说话风格等），默认空，首次安装时询问后写入 |
| `firstDeliveryAfterDays` | 第一次自动交付的天数，默认 90（约 3 个月） |
| `deliveryIntervalDays` | 之后每隔多少天自动交付一份，默认 30 |
| `deliveryDir` | 自动交付目录；留空用工作区下的 `心印交付`，支持 `~` 与绝对路径 |
| `syncIntervalDays` | 自动维护周期，默认 30 天 |
| `awayGraceDays` | 离开多少天以上冻结遗忘计时，默认 7 天 |

设置页也有同样的配置：**设置 → 心印**（侧栏列表里）。

## 安全

- 信任边界与威胁模型：[`docs/security/trust-boundary.md`](docs/security/trust-boundary.md)
- 六种安全架构的落实与复核命令：[`docs/security/architectures.md`](docs/security/architectures.md)
- 逐条规则对照（含未达成项的诚实记录）：[`docs/security/compliance.md`](docs/security/compliance.md)
- 合并前安全评审清单：[`docs/security/review-checklist.md`](docs/security/review-checklist.md)
- 安全策略与已知局限：[`SECURITY.md`](SECURITY.md)
- 发布附带 CycloneDX SBOM：`sbom.cdx.json`（`npm run sbom:check` 校验）
- 设置接口默认拒绝：来源必须本机同源，方法/Content-Type/体积/频率逐项校验；测试见 `test/security.test.mjs`
- 安全事件可审计：授权失败/限流/配置变更写入宿主日志，`status` 里可看计数
- 一条命令跑完全部检查：`npm run verify`

## 隐私边界（诚实版）

- 插件**不联网、不上传**；记忆只存在本机的数据目录里。
- 交付出来的文档由你自己保管；它会被持续更新，直到你把它移走。
- 记忆内容本身在磁盘上仍是可读的 JSON——换台机器或清空数据目录前请自行备份。

## 分发与安装（给别人用）

这是一个标准的 DSH bundle，每个安装者的记忆都只存在他自己的 `<DSH_HOME>\heartprint` 里。

```text
plugin_manager install_bundle   <插件文件夹绝对路径>
```

- **只分发代码文件**：`index.js`、`client.js`、`lib/*.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`LICENSE`（即 `package.json` 的 `files` 清单）。`test/` 属于开发资料，不需要带上。
- **不要连带别人的数据目录**：`memories.json`、`policy.json`、`docs/` 都在 `<DSH_HOME>\heartprint` 下，不在插件目录里，天然不会被打包。
- 每个新安装默认是**空库**：没有记忆、没有文档；第一次维护时自动创建。
- 名字与人设不预置：AI 会在合适的时候问用户。
- 安装后工具出现在该 profile 的所有会话里；数据目录可以用 `dataDir` 配置项改。
- 本包 `license` 为 MIT，见 `LICENSE`。

## 测试

```bash
node --test test/engine.test.mjs test/tool.test.mjs test/regression.test.mjs test/alignment.test.mjs
```

分别覆盖：衰减引擎与文档渲染的纯函数、工具层的完整流程与策略调整、保存失败 / 库损坏 / 分层动作链 / 痛苦感受 / 交付同步 / 自动交付等回归场景，以及注入顺序与回退行为。
