# 6657 Bulletchat Collector

前期语料链路：监听斗鱼 6657 弹幕，脱敏写入 JSONL，实时清洗，并在停止后生成基础统计。

## Install

```bash
npm install
```

## Collect

推荐使用 CLI 管理后台监听：

```bash
npm run collector
```

或者直接使用命令：

```bash
npm run collector -- start
npm run collector -- status
npm run collector -- logs
npm run collector -- stop
```

默认房间是 `6657`。可指定房间和数据目录：

```bash
npm run collector -- start --room 6657 --data-dir data
```

如果 `6657` 页面被斗鱼切成专题/赛事页，可以用真实播放器房间号连接弹幕，但仍按 `6657` 存数据：

```bash
npm run collector -- start --room 6657 --login-room 6979222 --max-per-second 20
```

当前 CLI 已内置 `6657 -> 6979222` 的默认监听映射；直接 `npm run collector -- start` 也会使用该真实房间号。若斗鱼后续更换专题页播放器房间号，再显式传新的 `--login-room`。

弹幕量很大时可以限制写入压力：

```bash
npm run collector -- start --max-per-second 20
npm run collector -- start --sample-rate 5
npm run collector -- start --max-queue 5000
```

- `--max-per-second 20`：每秒最多保留 20 条弹幕。
- `--sample-rate 5`：每 5 条保留 1 条。
- `--max-queue 5000`：写入队列超过 5000 时丢弃新消息，保护内存。

如果已连接但没有写入弹幕，可以打开事件诊断：

```bash
npm run collector -- start --debug-events --max-per-second 20
```

诊断日志只打印事件类型、计数和字段名，不打印用户昵称或 ID。

CLI 会把后台进程状态写入 `.collector/6657.json`，日志写入：

- `logs/collector-6657.out.log`
- `logs/collector-6657.err.log`

也可以直接在前台运行采集脚本：

```bash
npm run collect:6657
```

启动后会持续监听，使用 `Ctrl+C` 停止。输出目录：

- `data/raw/6657/YYYY-MM-DD.jsonl`
- `data/clean/6657/YYYY-MM-DD.jsonl`
- `data/stats/6657/YYYY-MM-DD.json`

采集只保存弹幕文本和必要上下文，不保存昵称、用户 ID、等级、头像或粉丝牌。

## Rebuild Stats

```bash
npm run stats
```

可选参数：

```bash
npm run stats -- --room 6657 --date 2026-05-20
```

## Build Weighted Corpus

从 `raw` 生成保留 emoji 和标点的加权结构化语料：

```bash
npm run weight -- --room 6657 --date 2026-05-20
```

输出目录：

- `data/weighted/6657/YYYY-MM-DD.jsonl`
- `data/weighted/6657/YYYY-MM-DD.summary.json`

输出字段核心为：

- `文本`：保留原始弹幕的 emoji 和标点。
- `分类`：按爆发频率、总频率、长度、emoji 等规则粗分类。
- `权重`：`(0.7 * log1p(first_window_count) + 0.3 * log1p(total_count)) * length_factor * emoji_factor * burst_factor`

默认只保留出现至少 2 次的弹幕簇。可调参数：

```bash
npm run weight -- --first-window-seconds 60 --min-count 2 --max-output 5000
```

## Tests

```bash
npm test
npm run typecheck
```
