# dsh-context-suite

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的上下文卫生插件，打包成一个 bundle：**6 个默认启用，2 个可选**。

DSH 在上下文变长时会把历史折叠成摘要。这个折叠是**静默**的；工具结果默认**从不剪枝**；一个大的 MCP 服务每次请求都要**全量发送工具 Schema**；折叠之后 skill 目录会从界面上**永久消失**。下面每个插件修一个这样的坑。它们互相独立：装整个 bundle，然后关掉你不想要的那一行就行。

## 实测效果

macOS、DSH 桌面版、1M token 本地路由（DeepSeek-V4.1-Flash）、255 个工具的 REA MCP 服务。数字来自那次会话自己的日志，不是合成基准。

| 插件 | 默认 | 修的是什么 | 实测 |
|---|---|---|---|
| `result-budget` | ✅ | DSH 自带工具结果剪枝器，但从不调用 | 单会话剪掉 19 条：**524,445 → 98,021 字符（−81.3%）**，131,270 token 不再进上下文 |
| `lazy-tools` | ✅ | 每个工具每次请求都带完整 JSON Schema | 255 个工具：**92,191 → 9,853 token/请求（−82,338，−89%）** |
| `context-reminder` | ✅ | 折叠是静默的，模型不知道自己在读摘要 | 单会话 4 次折叠前提醒 + 3 次折叠通知 |
| `skill-catalog-guard` | ✅ | 折叠后 skill 目录永久消失 | 历史会话 12 个全部恢复；**本次 A/B 未恢复**（见已知限制） |
| `session-digest` | ✅ | 新会话不知道上一个会话干了什么 | 每会话注入一次，≤1,600 字符 |
| `sampling-default` | ✅ | 本地引擎的温度不改代码就改不了 | 请求体 `temperature: 0.5` |
| `note-index` | ⬜ 可选 | 折叠后没人告诉模型有笔记 | 每轮列出 ≤3 篇笔记，**~430 字符（~200 token）** |
| `goal-audit` | ⬜ 可选 | goal 轮开局只有"继续"，没有上轮证据 | 实测 round 2 注入：`2 tool calls, 2 tool results, 0 errors` |

两个大头是 `result-budget` 和 `lazy-tools`：`lazy-tools` 每次请求省 **82,338 token**（工具 Schema），`result-budget` 在一次会话里累计挡掉 **131,270 token** 的历史工具结果。两者口径不同，别相加。其余几个都很小、有界，主要作用是"折叠时别丢信息"。

### 同题 A/B（2026-11-17）

3 轮、stock 18 步 / suite 23 步，同一模型、同一 `temperature: 0.5`、同一 REA MCP（255 工具）、同一工作目录与一字不差的题面；唯一变量是 suite。对照组用一个只 pin temperature 的小控制插件，避免把 suite 的 `sampling-default` 算成收益。完整题面、逐项质量核对与复现命令见 [BENCHMARK.md](BENCHMARK.md)。

| 指标 | 对照组 stock | 实验组 suite | 差异 |
|---|---|---|---|
| 首步工具数 | 296 | 42 | −85.8% |
| 首步 prompt token | 104,100 | 19,880 | **−80.9%** |
| Step 2 未缓存 / 缓存命中 | 2,029 / 102,400 | 1,777 / 18,432 | 未缓存 −12.4%，缓存 −82.0% |
| 平均每步 prompt | 158,531 | 52,339 | **−67.0%** |
| 累计总输入（input + cacheRead + cacheWrite） | 2,853,557 | 1,203,786 | **−57.8%** |
| 累计未缓存输入（真算力） | 416,437 | 339,530 | −18.5% |
| `compaction/prune` | 0 次 / 0 token | 12 次 / 109,817 token | — |
| 折叠次数 / 折叠通知 | 2 / 0 | 2 / 1 | — |
| 折叠后可见 skill | 0 | 0 | 两组都丢失 |
| 任务质量（Turn 1/2 精确数字） | 基准 | 逐项一致 | 无损 |

读法：−57.8% 是总输入负载，其中大部分是 `cacheRead`（更便宜但不是免费）；真正未缓存的算力只省 18.5%。首步 −80.9% 是工具 Schema 的差，最稳定。`skill-catalog-guard` 这次没有恢复目录，两组折叠后都报告看不到 skill——这是本次暴露的缺陷，不是 suite 的收益。

## 选哪几个

- **只想省 token**：`result-budget` + `lazy-tools`。这两个是唯一有数量级收益的。
- **上下文卫生**：再加 `context-reminder` + `skill-catalog-guard`。它们不省 token，但让模型知道自己读的是摘要、让 skill 目录折叠后还在。
- **跨会话记忆**：`session-digest`。每开一个新会话，注入一次上一个会话的摘要。
- **可选**：`note-index` 与 AGENTS.md 规则 7 部分重复，且每轮都花约 200 token；`goal-audit` 只在 goal 轮触发。需要时再开。

## 安装

```sh
# 从 GitHub 装
dsh plugin --profile <你的profile> add github:talkeryu/dsh-context-suite

# 或者从本地目录装
dsh plugin --profile <你的profile> add link:/path/to/dsh-context-suite
```

如果安装器没自动加，把 `dsh-context-suite` 加进 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles`。

然后**重启 DSH**。服务端插件不热重载。

## 每一行的配置

| id | 配置项 | 默认值 |
|---|---|---|
| `tool-result-pruner` | `thresholdChars`、`headChars`、`tailChars` | 8192 / 4096 / 1024 |
| `result-budget` | `pressureThreshold` | `0`（每步都剪） |
| `context-reminder` | `growthTokens`、`dropTokens`、`dir` | 35000 / 8000 / `~/.dsh/notes` |
| `skill-catalog-guard` | `maxDescriptionChars` | 200 |
| `session-digest` | `maxUserChars`、`maxUsers`、`maxInjectChars`、`dir` | 160 / 12 / 1600 / `~/.dsh/self-study/sessions` |
| `note-index` | `maxNotes`、`maxAgeHours`、`dir` | 3 / 24 / `~/.dsh/notes` |
| `goal-audit` | `maxPaths`、`debug`、`debugPath` | 8 / `false` / `$TMPDIR/goal-audit.log` |
| `lazy-tools` | `toolName`、`groups[]`（`id`、`prefix`、`description`） | `load_tools`、`[]` |
| `sampling-default` | `provider`、`temperature` | `local-ubuntu`、`0.5` |

`lazy-tools` 不配 group 就什么都不做。给一个 255 工具的服务配：

```yaml
- id: lazy-tools
  name: 'dsh-context-suite/lazy-tools'
  config:
    toolName: load_tools
    groups:
      - id: rea
        prefix: 'mcp__rea__'
        description: 'REA 逆向工程工具'
```

`groups` 可以配多个，每个前缀一组，互不影响。

`sampling-default` 只对你指定的那个 provider 生效，其他 provider 完全不受影响。

### `result-budget` 的取舍

默认 `pressureThreshold: 0`，也就是**每一步都剪**：任何超过 `thresholdChars`（8192 字符）的工具结果，中段会被换成标记，只留头 4096 + 尾 1024。被剪掉的部分仍可通过 `decompress` 取回，但模型当步看到的是缩短版。

上下文还很空的时候，这有点激进。想只在压力大时才剪，设一个 token 数：

```yaml
- id: result-budget
  config:
    pressureThreshold: 200000   # 低于 20 万 token 压力时不剪
```

代价是省下的 token 变少；收益是模型读大文件时能一次看到全文。

## 关掉某一行

在你自己的 profile 的 `cordis.patch.yml` 里：

```yaml
- id: note-index
  disabled: true
```

## 测试

```sh
npm test
# 或直接跑 Node 内置测试运行器
node --test
```

覆盖全部 8 个插件模块及 `cordis.patch.yml` 契约：包括 `lazy-tools` 的跨步持久化解锁、重复 `hide:true` 幂等、多组与多 agent 隔离；`context-reminder` 的剪枝压力抵消与伪折叠抑制；`session-digest` 的真实日志扫描与合成消息过滤；`skill-catalog-guard` 的 `modelInvocable` 过滤与首步防重；以及 `result-budget`、`note-index`、`sampling-default`、`goal-audit` 的完整行为测试。

## 兼容性

在 2026-11-16 的 DSH 桌面版上测过。这些插件用的是 DSH 内部服务（`tokenMeter`、`toolResultPruner`、`skills.snapshot`、`session.surface.nodes`、`agent.inject`、`agents.get`），不是稳定公开契约，DSH 升级可能弄断其中一个。`context-reminder` 判断折叠的方式假设代理是"按增长折叠"（billion-context 是；DSH 自带的 compaction 不是）。

## 已知限制

- 实测样本是 n=1：一台机器、一个模型、一个 MCP 服务、一次会话。数字可复现，但没有跨环境基准。
- 已完成单任务同题 A/B（2026-11-17，3 轮，stock 18 步 / suite 23 步）：首步 prompt −80.9%、平均每步 −67.0%、累计总输入 −57.8%，Turn 1/2 的精确行数与导出名两组逐项一致。但未缓存输入只省 18.5%，大部分节省来自 `cacheRead`（更便宜但不是免费），不要把 −57.8% 当成等比例的算力节省；两组步数也不同，累计值比单步值更公平。
- `skill-catalog-guard` 在本次 A/B 中没有恢复目录：`catalogVisible()` 扫描 `session.surface.nodes`，折叠后原始目录节点仍在（只是被 shadow），于是误判"还在"，不注入。两组折叠后都报告看不到 skill。历史会话的"12 个全部恢复"未在本次复现；修复方向是检查节点是否被 shadow，而不是只检查存在。
- `lazy-tools` 的 `prefix` 配错会把工具藏起来又不报错；配完先确认 `load_tools` 能列出来。

## 许可证

MIT
