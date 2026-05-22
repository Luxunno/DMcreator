# Codex Handoff: 6657 LoRA Training

## 当前目标

这个仓库已经准备好 6657 弹幕风格 LoRA 的第一版训练数据。下一台训练机器的目标是：下载仓库后，直接基于 `sft-messages.jsonl` 开始 Qwen 系列模型 LoRA/QLoRA 实验。

## 推荐训练入口

优先使用：

- `data/training/6657/2026-05-20.sft-messages.jsonl`

这是 chat messages 格式，字段形态为：

```json
{"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}],"weight":1,"source":"sb6657_meme","source_id":"19580"}
```

辅助数据：

- `data/training/6657/2026-05-20.core.jsonl`：清洗后的核心风格样本。
- `data/training/6657/2026-05-20.retrieval.jsonl`：运行时 RAG 检索库。
- `data/memes/sb6657-memes.jsonl`：sb6657 精品烂梗库，已重算权重。
- `data/training/6657/2026-05-20.rejected.jsonl`：被规则过滤的样本，只用于审查过滤策略，不用于训练。

不要使用：

- `data/raw/**`
- `data/clean/**`
- `data/weighted/**`

这些目录不会提交到 GitHub，避免把原始监听数据和中间产物带到训练仓库。

## 数据权重约定

`sb6657-memes.jsonl` 被视为精品来源，`copy_count` 不再作为质量门槛，只作为传播热度增强项。

当前权重逻辑：

```text
raw_weight=(0.55*curated_base+0.22*capped_log(copy_count)+0.15*heat_score+0.08*tag_score)*length_factor
final weight=max(0.35, 0.35+minmax(raw_weight)*0.65*cluster_multiplier)
```

训练时如果框架支持 sample weight，可以读取 `weight` 字段；如果不支持，先忽略 `weight`，直接训练 `messages`。

## 建议 LoRA 策略

4070 Ti 上先做小步实验，不要一上来多轮猛训。

推荐默认：

- 基座：Qwen 7B/8B 级 Instruct 模型。
- 训练方式：4bit QLoRA。
- LoRA rank：8 或 16。
- epoch：1。
- learning rate：`1e-4` 起步。
- max sequence length：1024 或 2048。
- 目标：学习 6657 的短句、emoji、标点、复读节奏，不要求模型单独理解直播场景。

第一轮验收重点：

- 输出是否明显短句化。
- 是否保留弹幕语气。
- 是否更会使用 6657 常见句式。
- 是否出现背诵训练集原句。
- 是否输出过长、过脏、过界内容。

## 推荐推理方式

不要只靠 LoRA 生成。最终运行时仍建议：

```text
实时弹幕窗口 + OCR 场景信号 + retrieval.jsonl 检索样例 + LoRA 模型 + 安全过滤
```

LoRA 负责学风格，RAG 负责给当前场景补梗。

## 本仓库常用命令

安装依赖：

```bash
npm install
```

重新抓取 sb6657 精品梗并重算权重：

```bash
npm run crawl:memes
```

重新生成训练数据：

```bash
npm run prepare:train -- --date 2026-05-20
```

校验 TypeScript：

```bash
npm run typecheck
```

