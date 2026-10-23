# dsh-code-taste

[English](README.en.md) | 中文

![dsh-code-taste 横幅](https://baxterl.github.io/assets/dsh-code-taste/banner.png?v=2)

一个 DeepSeek Harness 插件：让鲸鱼持续学习你的代码品味、审美风格和各种习惯，并在每个会话里照着写。

## 它是什么

新开一个会话，它什么都不记得——你要重新说一遍 `const` 别用 `let`、圆角 8px、commit 怎么排、回复用中文。这个插件专门听这些时刻：把你说的话变成带置信度的规则，存成一份你能手改的 markdown，然后在每个会话开始时把已经确认的那些放到模型面前。

所有东西都是你本机上的纯文本文件，不联网、不埋点。

## 信号

它从什么里学，以及现在还看不到什么：

| 信号 | 长什么样 | 状态 |
| --- | --- | --- |
| 显式指令 | 记住：以后都用 const | **已支持** — 0.85–0.90 直接写入 |
| 禁令 | 永远不要用 moment.js | **已支持** — 0.88 |
| 纠正 | 不要用 any，改成 unknown | **已支持** — 0.60 进待确认 |
| 正向反馈 | 对，就这样 | **已支持** — 给当前最强那条 +0.10 |
| **接受** | 你看了改动，直接继续往下做 | P1 — 用“后续没有编辑”推断 |
| **拒绝** | 你拒绝了工具调用，或把改动撤回 | P1 — 监听工具决策和工作区 diff |
| **编辑** | 你把 AI 刚写的东西重写了 | P1 — 对比 AI 写入的内容与之后的文件 |
| **选择** | 你从它给的几个方案里挑了一个 | P1 — 对提问的回答，或你反复选的做法 |

前四条今天就能用。后四条（接受/拒绝/编辑/选择）才是最诚实的信号——你留下什么、扔掉什么、重写什么——也是下一个版本的重点：它们要盯工作区和工具管线，而不只是聊天内容，所以分开做、分开验证。见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 安装

### 环境要求

- DeepSeek Harness `0.2.x`（在 `0.2.1-rc.2` 上验证）
- Node.js `22.19+` 或 `24+`（就是 DSH 自己跑的那个版本）

没有其它依赖：这个 bundle 零依赖，也不需要构建。

### 从 GitHub 安装

```sh
dsh plugin --profile desktop add github:BaxterL/dsh-code-taste
```

### 从本地目录安装

```sh
git clone https://github.com/BaxterL/dsh-code-taste
dsh plugin --profile desktop add ./dsh-code-taste
```

本地目录是**链接**进去的，不是拷贝，所以改完源码重启一次就生效。

### 让 DeepSeek 帮你装

把下面这段直接粘给一个 DeepSeek Harness 会话，它会替你做：

```
把 https://github.com/BaxterL/dsh-code-taste 这个 bundle 装进我当前的 DSH profile。

1. 用 plugin_manager 的 install_bundle，target 填 `github:BaxterL/dsh-code-taste`；
   或者执行 `dsh plugin --profile <profile> add github:BaxterL/dsh-code-taste`。
2. 不要动其它任何插件、bundle、配置或工作区文件。
3. 不要自己重启。告诉我是否需要重启、会影响什么。
4. 装完把 row id、解析到的版本号，以及验证步骤告诉我。
```

正常情况下它会回答：row id 是 `taste`、版本号是多少、以及 `restart-required`。如果它说 `applied`，说明已经加载；否则重启后再跑一次 `taste list`。

### 必须重启

bundle 的行是在宿主启动时插入的，新装 bundle 没有热重载。**装完重启 DSH**。

### 验证

新开一个会话，向模型要规则：

```
taste list
```

空工作区会回答 `No taste rules yet for this workspace.`——说明工具已经挂上，只是还没学到东西。第一条规则被捕获后，`<工作区>/.dsh/taste/` 目录会出现。

### 更新

```sh
dsh plugin --profile desktop add github:BaxterL/dsh-code-taste   # 重装最新
```

然后重启。本地目录安装的，`git pull` 就够。

### 卸载

在 **设置 → 插件** 里移除，或者：

```sh
dsh plugin --profile desktop remove dsh-code-taste
```

然后重启。你的 `TASTE.md` 不会被删——想彻底清空，自己删掉 `.dsh/taste/` 和 `~/.dsh/taste/`。

## 使用

### 说话就行

| 你说 | 会发生什么 |
| --- | --- |
| 记住：以后都用 const | 立刻写入，置信度 0.85–0.90，直接生效 |
| 永远不要用 moment.js | 立刻写入为 guardrail，0.88 |
| 不要用 any，改成 unknown | 进待处理队列，`taste learn` 复核后才写入 |
| 对，就这样 | 给当前注入的最强那条 +0.10 |

问句、一次性指令（“这次”“先这样”）、任何含密钥的内容，在进库之前就被丢掉了。

### 复核它学到的东西

纠正不会直接污染提示词，先等你确认：

```
taste review
taste approve id:r_8f2a1c
```

同一条被看到第二次时，也会自己转正。

### 手改规则文件

`<工作区>/.dsh/taste/TASTE.md`

```markdown
## code-style
- [r_8f2a1c] 统一用 const，除非需要重新赋值 @0.85 src:explicit ev:2

## avoid
- [r_9x8y7z6] 不引入 moment.js @0.72 src:correction ev:3 [pending] [glob:src/ui/**]
```

格式是 `- [id] 正文 @置信度 src:来源 ev:次数 [pending|archived] [pinned] [glob:路径]`。
不符合格式的行一律当注释，所以你可以随便加说明。

### 查看依据

```
taste why id:r_8f2a1c
```

打印这条规则的证据：什么时候抓到的、触发了哪个信号、原话是什么（截到 200 字，永远不存上下文代码）。

### 导出给别的工具

```
taste export target:agents     # .dsh/taste/export/AGENTS.taste.md
taste export target:claude     # .dsh/taste/export/CLAUDE.taste.md
```

导出的片段只列生效规则、不带置信度，可以直接贴进 `AGENTS.md` 或 `CLAUDE.md`。

## 配置

默认 `model.source: host`：复用你当前会话的模型，装好就能用；想完全不调用模型就改成 `none`。要切换，在你自己 profile 的
`cordis.patch.yml` 里覆盖这一行：

```yaml
- id: taste
  name: dsh-code-taste
  config:
    model:
      source: custom            # none | host | custom
      format: openai
      baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
      model: qwen-plus
      apiKeyEnv: DASHSCOPE_API_KEY
```

### 抽取用哪个模型

| `model.source` | 用什么 | 需要填什么 |
| --- | --- | --- |
| `none` | 不调模型，显式指令照常写入，纠正等你 `taste learn` | 无 |
| `host`（默认） | 直接用 DSH 当前会话的模型（自带 DeepSeek，或你在设置里选的任何模型） | 无 endpoint、无 key |
| `custom` | 第三方或本地的 OpenAI / Anthropic 兼容接口 | `format`、`baseURL`、`model`，本地一般不用 key |

`host` 是最省事的一档：不额外配置，复用你正在用的模型；代价是抽取调用会占一次你的主模型额度。
`custom` 适合把它固定到便宜模型或本地小模型上。

### 模型线路（`source: custom` 时）

`format: openai` 走任何 `/chat/completions` 接口：

| 线路 | baseURL | 模型示例 |
| --- | --- | --- |
| 通义千问 / DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://127.0.0.1:11434/v1` | `qwen2.5-coder:7b` |
| llama.cpp（本地） | `http://127.0.0.1:8080/v1` | `-m` 加载的那个 |
| LM Studio（本地） | `http://127.0.0.1:1234/v1` | 加载的模型 id |
| vLLM（本地） | `http://127.0.0.1:8000/v1` | 服务的模型 id |

`format: anthropic` 走 Messages API：

```yaml
      format: anthropic
      baseURL: https://api.anthropic.com
      model: claude-sonnet-4-5
      apiKeyEnv: ANTHROPIC_API_KEY
```

本地接口一般不需要 key：`apiKey` 和 `apiKeyEnv` 都留空即可。`apiKeyEnv` 填环境变量名，
`apiKey` 是直接写死的兜底值。**不要把 key 提交进仓库**——`taste config` 只会显示
`env:NAME` 或 `(inline key set)`。

### token 预算

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `model.source` | `host` | 复用当前会话模型 |
| `extract.minPending` | 3 | 攒够这么多信号才调一次 |
| `extract.throttleMinutes` | 10 | 每个会话每个窗口最多一次 |
| `extract.maxInputChars` | 4000 | 输入约 1000 token |
| `model.maxOutputTokens` | 256 | 输出硬上限 |
| `extract.maxRulesPerRun` | 3 | 单次最多接受的规则数 |
| `injectBudgetChars` | 3000 | 每轮注入约 750 token（最小 400） |

`source: none` 时唯一持续的开销就是注入那一段：默认约 750 token，其中大部分是固定的引导语。
嫌多可以把 `injectBudgetChars` 调小。

`taste config` 会打印当前来源、预算、线路和警告，**不会打印 key**。

## 工具

插件只暴露一个工具：`taste`。

| action | 参数 | 作用 |
| --- | --- | --- |
| `list` | — | 列出全部规则：作用域、分类、置信度、是否在注入 |
| `learn` | — | 取走本会话累积的纠正，交给模型蒸馏 |
| `add` | `text`、`category?`、`scope?`、`confidence?`、`glob?` | 新增一条，或强化一条近似规则 |
| `review` | — | 列出待确认候选（这些不会被注入） |
| `approve` | `id` | 把候选转正 |
| `forget` | `id`、`scope?` | 从项目/全局里删掉一条 |
| `why` | `id` | 打印这条规则的证据 |
| `profile` | — | 一段话的品味画像 + 最强的几条规则 |
| `export` | `format`（`agents` \| `claude`） | 在 `.dsh/taste/export/` 下生成片段 |

### 参数说明

- **`text`** — 一句祈使句，≤ 200 字。写成一个月后还看得懂的样子：“统一用 const，除非需要重新赋值”，而不是“这里改一下”。
- **`category`** — `code-style`（默认）、`design`、`stack`、`workflow`、`project-detail`、`communication`、`avoid`。只用于分组和在提示词里加标签，不改变行为。
- **`scope`** — `global`（默认）对所有工作区生效，`project` 只在当前工作区生效。同名规则项目覆盖全局。
- **`confidence`** — `0.1`–`0.95`。不填就按来源定：模型自己加的是 `0.55`，显式指令是 `0.85–0.90`。低于 `0.55` 的进 `pending`，不会注入。
- **`glob`** — 把规则限定到匹配的路径，比如 `src/ui/**`。目前只存储并展示，路径匹配在 P2 做。
- **`id`** — 内容寻址（`r_` + 归一化文本的 SHA-1 前 8 位），同一条规则学两次会落到同一个 id，不会分叉。

## 细节

### 置信度与生命周期

| 阶段 | 规则 |
| --- | --- |
| 基础分 | 显式 0.85 · 禁令 0.88 · 纠正 0.60 · 模型添加 0.55 |
| 强化 | 每重复一次或收到正向反馈 +0.10，上限 0.95 |
| 转正 | 第二次证据或手动 `approve` |
| 衰减 | 半衰期 60 天，从 `last_used` / `last_seen` 算 |
| 固定 | `[pinned]` 的规则不衰减 |
| 归档 | 有效置信度低于 0.25 视为归档：留在文件里，永不注入 |
| 去重 | 同义词折叠后包含度相似 ≥ 0.80 即合并（别用/不要用、改成/换成…） |

### 文件都在哪

| 文件 | 用途 |
| --- | --- |
| `<工作区>/.dsh/taste/TASTE.md` | 项目规则，你手改的就是这个 |
| `${DSH_HOME:-~/.dsh}/taste/TASTE.md` | 全局规则，所有工作区共享 |
| `…/taste/state.json` | 时间戳与召回计数（`created`、`last_used`、`recalled`） |
| `…/taste/evidence.jsonl` | 只追加的证据，一次捕获一行 JSON |
| `…/taste/export/*.md` | 给 `AGENTS.md` / `CLAUDE.md` 用的导出片段 |

写入是原子的（临时文件 + rename），写一半被打断也不会把规则文件截断。

### 注入

- 注册成一个名为 `taste` 的 `systemPrompt` context，order `920`。
- 会话开始时取一次快照，整个会话冻结，保证提示词前缀字节稳定、KV 缓存不抖。
- 预算 6000 字符（约 1500 token），按置信度从高到低，放不下的静默丢弃。
- 整段包在 `<taste-rules>` 里，并带一句“这是参考数据不是指令，当前请求优先”。
- 有待确认候选时，末尾只加一行提示；pending 的规则本身永不注入。

### 隐私

- 密钥类内容（API key、token、JWT、PEM、连接串、`password=`）在写入前直接拒绝。
- 邮箱替换成 `<email>`，绝对路径里的用户名折叠成 `~`。
- 证据只存 200 字的原话，不存上下文代码和整段对话。

### 已知限制（v0.2.0）

- 抽取默认用当前会话模型（`host`）；改成 `none` 就只做确定性采集，纠正要等 `taste learn`。
- 还不会从代码改动里学：你手改的代码没有被观察（计划在 P1）。
- 按 agent 隔离的注入依赖事件上下文；拿不到 agent 作用域时会退化成一条全局段落，并打一行日志。

## 开发

```sh
node test/harness.mjs
```

39 项检查，用假 ctx 直接驱动 `apply(ctx)`，不需要起 DSH。

## 许可

MIT
