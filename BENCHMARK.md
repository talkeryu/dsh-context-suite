# 同题 A/B Benchmark：裸跑 DSH vs `dsh-context-suite` 0.1.5

2026-11-17，macOS 桌面版 DSH。两组跑**同一套 3 轮题面**、同一模型、同一温度、同一工作目录、同一 MCP 服务；唯一变量是 `dsh-context-suite` 是否启用。

## 测试环境

| 项 | 值 |
|---|---|
| DSH | 桌面版（2026-11-16 构建），1M token 窗口 |
| 模型 | `local-ubuntu` / `DeepSeek-V4.1-Flash-1017-Heretic-12d58ad0`，reasoning effort `max` |
| 温度 | 两组均 `0.5`（stock 用只 pin 温度的对照插件；suite 用自带 `sampling-default`） |
| MCP | REA，stdio，255 个 `mcp__rea__*` 工具 |
| 工作目录 | `~/Downloads/REA`（真实 TypeScript 仓库） |
| 对照组 | `bench-stock`：desktop 克隆，移除 `dsh-context-suite`，保留其余 bundle |
| 实验组 | `bench-suite`：desktop 克隆，启用 `dsh-context-suite@0.1.5` 的 6 个默认项 + `lazy-tools` 的 `rea` 组 |
| 会话 | stock `session-63e8492d…`，suite `session-c06b492d…`，日志在 `~/.dsh/sessions/<cwd-slug>/` |

两组都用 `dsh --profile <name> --port <port> --no-open` 启动 web UI，由同一个浏览器自动化脚本逐字发送题面。会话日志是 DSH 自己写的 `session.v4.jsonl.zstd`，下面的数字全部由 `bench/analyze-sessions.mjs` 从日志事件解析，不是估算。

## 固定题面

### Turn 1 — 首步 Schema + 大结果读取

```text
你是一个代码分析助手，工作目录是当前仓库。请严格按以下步骤执行，不要跳步。

步骤 1：用 read 工具完整读取以下 6 个文件，每个文件一次读完（不要分段；不要用 bash/grep/wc/sed 代替 read）：
1. src/python/PythonPycParser.ts
2. src/application/binary/BinarySession.ts
3. src/domain/javascript/javascriptSemanticRequireOrigin.ts
4. src/application/reverse/ReverseEngineeringService.ts
5. src/domain/webCaptureDiff.ts
6. src/application/Uninstall.ts

步骤 2：对每个文件，报告：
- 文件总行数（以 read 输出最后一行的行号为准）
- 第一个以 `export` 开头的顶层声明的名称（如果 read 输出里看不到，可以用一次 grep 确认，并注明）
- 最后一个以 `export` 开头的顶层声明的名称及其行号（同上）

步骤 3：输出一个 Markdown 表格，列为：文件 | 总行数 | 首个导出 | 末个导出 | 末个导出行号。

只报告实际读到的内容，不要猜测，不要修改文件。
```

### Turn 2 — 推过折叠线 + 折叠后 skill 目录

```text
继续同一任务。请对以下 3 个文件做分段扫描，建立完整的代码地图：

1. src/native/elf/ElfUnwindTables.ts
2. src/domain/native/nativeAotPe.ts
3. src/application/ClientConfigurationDocument.ts

对每个文件，用 bash 执行 `sed -n 'START,ENDp' 文件`，每次 200 行，从第 1 行开始，直到文件末尾。不要用 cat，不要合并多次输出；每次命令只输出一个 200 行区间。可以每 6 条命令并行执行。

扫描过程中，如果你看到 `<context_window_reminder>`，或者上下文已经很大，请调用 `compress` 工具折叠历史（把所有已完成的对话范围合并成一次调用；摘要中务必保留 Turn 1 的 6 个文件行数表）。折叠后继续扫描。

扫描完成后回答：
A. 对每个文件报告：总行数、包含 `export` 的行数、第一个 `export` 所在行号。
B. 请列出你当前上下文 `<available_skills>` 里实际可见的所有 skill 名称（只列你真正看到的，不要凭记忆或猜测编造；如果看不到，明确说“看不到”）。
C. 核对 Turn 1 的 6 个文件行数，逐行列出：文件名 | Turn 1 报告的行数 | 现在重新确认的行数 | 是否一致。
```

### Turn 3 — `lazy-tools` 按需解锁

```text
最后一步：测试工具组的按需加载。
1. 如果你当前能看到 `load_tools` 工具，调用 `load_tools({ group: "rea" })`，然后确认你现在能看到 `mcp__rea__*` 工具（列出前 3 个名称即可）。
2. 如果你看不到 `load_tools`，说明你的 `mcp__rea__*` 工具是否已经直接可见（列出前 3 个名称）。
3. 如果你刚才用 `load_tools` 解锁了，再调用 `load_tools({ group: "rea", hide: true })` 收起，并确认 `mcp__rea__*` 已不可见。
```

## 原始统计对比

`node bench/analyze-sessions.mjs <stock.jsonl.zstd> <suite.jsonl.zstd>` 的输出：

| 指标 | Stock（裸跑） | Suite 0.1.5 | 节省 |
|---|---:|---:|---:|
| 首请求工具数 | 296 | 42 | **85.8%** |
| Step 1 Prompt Token | 104,100 | 19,880 | **80.9%** |
| Step 2 未缓存输入 | 2,029 | 1,777 | 12.4% |
| Step 2 缓存命中 | 102,400 | 18,432 | **82.0%** |
| Step 2 总 Prompt | 104,758 | 20,773 | **80.2%** |
| 步数 | 18 | 23 | — |
| 平均每步 Prompt | 158,531 | 52,339 | **67.0%** |
| 累计总输入负载（input + cacheRead + cacheWrite） | 2,853,557 | 1,203,786 | **57.8%** |
| 累计未缓存输入（真算力） | 416,437 | 339,530 | **18.5%** |
| 累计缓存命中 | 2,437,120 | 864,256 | **64.5%** |
| 累计输出 | 18,124 | 24,156 | — |
| `compaction/prune` 次数 | 0 | 12 | — |
| 剪除 Token 总量 | 0 | 109,817 | — |
| 折叠（`compress`）次数 | 2 | 2 | — |
| `<context_folded>` 通知 | 0 | 1 | — |
| 折叠后模型报出的可见 Skill 数 | 0 | 0 | — |

> “节省”= `(stock − suite) / stock`。缓存命中比未缓存输入便宜，但仍要付延迟和显存；所以 57.8% 是**总输入负载**的节省，18.5% 是**未缓存真算力**的节省，两个口径都列出来。

### 首步：工具 Schema 是最大的一笔

| | Stock | Suite |
|---|---:|---:|
| 工具数 | 296 | 42 |
| 首步 Prompt | 104,100 | 19,880 |
| 首步缓存 | 0 | 0 |

首步没有缓存可吃，296 个工具的 JSON Schema 全部按未缓存输入计价。`lazy-tools` 把 255 个 `mcp__rea__*` 收进一个 `load_tools`，首步直接少 84,220 token（−80.9%）。

### 第二步：Prefix Cache 的保护

| | Stock | Suite |
|---|---:|---:|
| 未缓存输入 | 2,029 | 1,777 |
| 缓存命中 | 102,400 | 18,432 |
| 总 Prompt | 104,758 | 20,773 |

两组第二步都只新增了少量未缓存输入（读文件的结果），差别主要在**缓存前缀**：stock 的稳定前缀是 102,400 token，suite 只有 18,432。工具集稳定 + 结果剪枝让 suite 的缓存前缀小了 82.0%。

### 折叠与剪枝

| | Stock | Suite |
|---|---:|---:|
| `compaction/prune` 事件 | 0 | 12 |
| 剪除 Token | 0 | 109,817 |
| `compress` 折叠 | 2 | 2 |
| `<context_folded>` 通知 | 0 | 1 |

两组都真实折叠了 2 次（题面明确要求模型在上下文大时调用 `compress`，两组同一句）。suite 的 `result-budget` 在 12 个事件里剪掉 109,817 token；stock 的 DSH 自带剪枝器没有被调用，所以是 0。suite 的 `context-reminder` 在折叠后注入了一次 `<context_folded>`；stock 没有这个通知。

## 任务质量核对

### Turn 1：6 个文件的行数与导出

| 文件 | 两组报告的行数 | 首个导出 | 末个导出（行号） |
|---|---:|---|---|
| `src/python/PythonPycParser.ts` | 1863 | `parsePythonPyc` | `parsePythonPyc` (209) |
| `src/application/binary/BinarySession.ts` | 1881 | `BinarySession` | `BinarySession` (189) |
| `src/domain/javascript/javascriptSemanticRequireOrigin.ts` | 1881 | `observePossibleCommonJsDelegateWrite` | `semanticMutableBuiltinOrigin` (1860) |
| `src/application/reverse/ReverseEngineeringService.ts` | 1623 | `ReverseEngineeringOperation` | `digestFile` (1442) |
| `src/domain/webCaptureDiff.ts` | 1699 | `compareWebCaptures` | `compareWebCaptures` (22) |
| `src/application/Uninstall.ts` | 1719 | `UninstallFileSystem` | `systemUninstallHost` (506) |

两组**逐项一致**。suite 的 `read` 结果被剪掉中段，模型用一次 `grep` 补确认了落在中段的导出；stock 读的是全文。最终答案没有差异。

### Turn 2：3 个文件的分段扫描

| 文件 | 总行数 | 含 `export` 行数 | 首个 `export` 行号 |
|---|---:|---:|---:|
| `src/native/elf/ElfUnwindTables.ts` | 2021 | 2 | 241 |
| `src/domain/native/nativeAotPe.ts` | 2056 | 16 | 26 |
| `src/application/ClientConfigurationDocument.ts` | 2188 | 27 | 39 |

两组**逐项一致**。Turn 1 的 6 个行数在折叠后复核也全部一致（1863 / 1881 / 1881 / 1623 / 1699 / 1719）。suite 的折叠摘要保留了 Turn 1 的行数表；stock 的摘要也保留了。

### Turn 3：`lazy-tools`

| | Stock | Suite |
|---|---|---|
| `load_tools` 可见 | 否 | 是 |
| 解锁结果 | 255 个 `mcp__rea__*` 一直可见 | `Revealed 255 tools`，下一步可见 |
| 收起结果 | — | `Hid 255 tools`，下一步不可见 |
| 前 3 个工具名 | `act_on_build_computer`、`address_name`、`address_to_file_offset` | 同左 |

两组的工具名一致；suite 的解锁/收起闭环真实生效，且都是“下一步生效”。

## 结论

1. **首步省得最多**：296 → 42 个工具，104,100 → 19,880 token（−80.9%）。这是 `lazy-tools` 的直接效果，也是唯一不依赖缓存口径的硬节省。
2. **每步 Prompt 降到约三分之一**：平均 158,531 → 52,339（−67.0%），累计总输入负载 2,853,557 → 1,203,786（−57.8%）。
3. **真算力节省是 18.5%**：未缓存输入 416,437 → 339,530。其余节省来自缓存前缀变小（−64.5%），缓存更便宜但不是免费。对外说“省 58%”时最好同时给出 18.5% 这个保守口径。
4. **剪枝真实发生**：suite 12 次 `compaction/prune`，剪掉 109,817 token；stock 0 次。
5. **折叠两组都发生了 2 次**，但 suite 有 `<context_folded>` 通知，stock 没有。
6. **Skill 目录两组都丢了**：折叠后模型都报告“看不到 `<available_skills>`”。suite 的 `skill-catalog-guard` 本次**没有**恢复目录——这是 v0.1.5 的一个真实缺陷，不是“实验组全量恢复”。原因见下。
7. **质量没有损失**：Turn 1 的 6 个行数/导出、Turn 2 的 3 个行数/导出计数、Turn 3 的工具名，两组逐项一致。

## 已知限制

- **n=1**：一台机器、一个模型、一个 MCP 服务、一套 3 轮题面。数字可复现，但不是跨环境基准。
- **步数不同**：stock 18 步，suite 23 步（折叠和 33 条 `sed` 命令让 suite 多走了几步）。逐 Step 对比不是严格同构，累计总量才是公平口径。
- **折叠是模型决定的**：题面明确要求两组在上下文大时调用 `compress`，所以“折叠 2 次”不是纯插件效果；没有这句话，两组都可能不折叠。
- **`skill-catalog-guard` 本次失效**：模型报告看不到目录，日志里也没有 `skill-catalog-guard` 注入的 `user/message`。guard 用 `session.surface.nodes` 判断目录是否可见；折叠后原始目录节点仍在 `surface.nodes` 里（只是被 shadow），`catalogVisible()` 因此误判为“还在”，没有注入。对照组同样丢失，所以这一项两组打平，不能算 suite 的收益。README 里“12 个 skill 全部恢复”是历史会话的结果，本次 A/B 没有复现。
- **缓存口径**：`cacheReadTokens` 比 `inputTokens` 便宜，但两者不是 1:1。报告同时给出总输入负载和未缓存输入两个口径，避免只挑好看的那个。
- **对照组的温度控制**：stock 用一个只 pin `temperature: 0.5` 的对照插件，suite 用自带 `sampling-default`。这是控制变量，不是 suite 的功能差异。

## 复现

```sh
# 1. 两个隔离 profile（测试后删除）
#    bench-stock: desktop 克隆，bundles 去掉 dsh-context-suite
#    bench-suite: desktop 克隆，保留 dsh-context-suite + lazy-tools 的 rea 组

# 2. 启动两个 web UI
dsh --profile bench-stock --port 61390 --no-open
dsh --profile bench-suite --port 61391 --no-open

# 3. 用同一份题面依次发送 Turn 1/2/3（见上）

# 4. 解析两份会话日志
node bench/analyze-sessions.mjs \
  ~/.dsh/sessions/<cwd-slug>/session-<stock>/session.v4.jsonl.zstd \
  ~/.dsh/sessions/<cwd-slug>/session-<suite>/session.v4.jsonl.zstd
```

脚本只用 Node 内置模块和系统 `zstd`；它读 `request/header`、`assistant/message` 的 `usage`、`compaction/prune`、`tool/call` 和注入的 `user/message`，不依赖任何私有 API。
