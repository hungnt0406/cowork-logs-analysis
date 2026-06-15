# Cowork Workflow Miner

Labels good/bad workflows from your own real Claude Code sessions and produces a
ranked report of skill/script/SOP candidates. Local prototype of the mining
intelligence gate (Cổng Go/Kill 1) — stops **before** drafting skills.

See `implementation-plan.md` for the full design and `DATA_FORMAT.md` for the
verified transcript format.

## Pipeline

```
discover → classify (turn roles) → segment (episodes) → signals + subagents
   → render → judge (claude -p) → SQLite ─┬→ calibrate (trust gate)
                                          └→ mine (cluster + good/bad) → report.md + candidates.json
```

## Setup

```bash
bun install            # only dep: @types/bun (uses bun:sqlite)
```

Requires the `claude` CLI on PATH (used headless as the judge: `claude -p --output-format json`).
By default the LLM calls route through the **ccs `my-api` profile** — the pipeline injects
that profile's env (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from `ccs env my-api`) into
the `claude` subprocess. Pass `--runner claude` to use the plain `claude` login instead, or
`--ccs-profile <name>` to pick a different ccs profile. (`ccs` is only required for the default
`--runner ccs`; `--runner claude` has no such dependency.)

## Run

New here? Two things make this safe to poke at: the **`--no-judge` path costs $0**
(no LLM calls at all), and the full run is **resumable + cache-keyed** (re-running
never re-judges an episode unless its content or the rubric changed). So work up
from the free checks to one small live run before you do the full thing.

### Quick start — the recommended first run

```bash
bun install                                              # one-time

# 1. See which sessions the pipeline will pick up ($0, no LLM)
bun run discover

# 2. Build structure only — no judge calls, $0 — then validate it (PASS/FAIL)
bun run pipeline.ts --project tennis --limit 3 --no-judge
bun run check

# 3. Eyeball EXACTLY what the judge will read ($0; the render is never stored)
bun run dump-render --sample 3

# 4. First LIVE run, tightly capped so it costs cents not dollars
bun run pipeline.ts --project tennis --limit 5 --max-episodes 10 --yes

# 5. Full run + report (resumable; skips anything already judged)
bun run pipeline.ts --mine
```

Then read the two outputs: `out/report.md` (human) and `out/candidates.json` (machine handoff).

> `--project <substr>` matches a substring of the session's recorded cwd basename,
> e.g. `tennis` matches the project recorded as `tennis_tracking_system`.

### Command reference (every command + its flags)

Each stage is runnable on its own. Flags are shown inline with what they do.

#### `pipeline.ts` — the orchestrator (the command you'll use most)

```bash
bun run pipeline.ts [flags]
```

| Flag | What it does |
|---|---|
| `--project <substr>` | only sessions whose cwd basename contains `<substr>` |
| `--limit N` | at most N sessions (0 ⇒ none; rejects non-numeric) |
| `--since <ISO>` | only sessions modified on/after an ISO date, e.g. `2026-06-01` |
| `--no-judge` | **structure phase only — no LLM, $0.** Pair with `bun run check` |
| `--max-episodes N` | hard cap on judge calls this run (bound cost by count) |
| `--max-cost <USD>` | stop judging once estimated spend would exceed this ceiling |
| `--yes` / `-y` | skip the >\$5 confirmation prompt (required on non-TTY / automation) |
| `--mine` | after judging, also run mine + report (writes `out/`) |
| `--resume` | re-run safely; writes are idempotent and judged episodes are skipped |
| `--classify-llm` | use the LLM to resolve ambiguous turn boundaries (default: heuristics only) |
| `--db <path>` | use a non-default SQLite file (default `analysis.db`) |
| `--runner ccs\|claude` | how `claude -p` is authed: `ccs` (default) injects a ccs profile's env; `claude` uses your plain login (no ccs needed) |
| `--ccs-profile <name>` | which ccs profile to inject (default `my-api`; only used with `--runner ccs`) |

```bash
# common combinations
bun run pipeline.ts --project tennis --limit 3 --no-judge      # $0 structure smoke
bun run pipeline.ts --project tennis --max-episodes 10 --yes   # cheap live smoke
bun run pipeline.ts --since 2026-06-01 --max-cost 5 --mine     # bounded full run + report
bun run pipeline.ts --runner claude --mine                     # use plain `claude` login, no ccs
```

#### `discover` — list the sessions the pipeline would analyze ($0)

```bash
bun run discover [--project <substr>] [--since <ISO>] [--limit N]
```

#### `classify` — audit the turn-role classifier on ONE session

```bash
bun run classify <sessionId|path>      # required positional; heuristics only, $0
bun run classify <sessionId|path> --classify-llm   # also LLM-resolve ambiguous turns
```

#### `check` — validate DB structure after a `--no-judge` pass ($0)

```bash
bun run check                  # PASS/FAIL invariants; exits non-zero on failure
bun run check --db other.db    # check a non-default DB
```

#### `dump-render` — print exactly what the judge reads ($0; never persisted)

```bash
bun run dump-render --list                    # metadata table only: chars/cap, elided?, subagents?
bun run dump-render --sample [N]              # N representative episodes (default 3): longest, an elided one, subagents
bun run dump-render --random N                # N random episodes
bun run dump-render <sessionId>#<idx>         # one specific episode, full body
bun run dump-render --session <id|prefix>     # every episode in one session
# corpus-mode filters (combine with --list / --sample / --random):
bun run dump-render --sample 3 --project tennis --limit 5
```

#### `mine` — re-cluster + rank from the labels already in the DB

```bash
bun run mine
```

No flags (reads the default `analysis.db`). Tunable via env vars:
`MINE_LLM_CLUSTERING=0` (skip the LLM grouping pass → fall back to string-normalization
clustering), `MINE_LLM_TIMEOUT_MS` (default `180000`), `MINE_LLM_MODEL` (default `claude-sonnet-4-6`).

#### `report` — (re)write `out/report.md` + `out/candidates.json` from the DB

```bash
bun run report
```

No flags (reads the default `analysis.db`).

#### `calibrate` — trust gate: human spot-check + auto cross-check

Manual, **not** part of the auto pipeline.

```bash
bun run calibrate                       # interactive spot-check
bun run calibrate --non-interactive     # sample + auto cross-check only, no prompts
bun run calibrate --sample N            # how many episodes to spot-check
bun run calibrate --self-consistency K  # re-judge K episodes to measure judge stability
```

### Cost safety (applies to any run that judges)

A fresh run estimated above ~\$5 prompts for confirmation and **fails closed on
non-TTY** — pass `--yes` for automation. `--max-cost` caps cumulative spend,
`--max-episodes` caps the call count, and 5 consecutive judge failures trip a
circuit breaker so a broken CLI can't burn the whole budget. Numeric flags reject
non-numeric values rather than silently unbounding.

## Cost / time note

The judge runs `claude -p` **serially**, ~one call per episode (corpus ≈ 329
episodes). Each call is a real metered request. Use `--max-episodes` /
`--project` / `--limit` to bound a run; the multi-part cache key
(content + prompt + schema + model + cli) makes the full run resumable — nothing
is re-judged unless its content or the rubric changes.

## Outputs

- `analysis.db` (gitignored) — sessions, turns, episodes, features, evidence, labels, calibration, clusters.
- `out/report.md` — per-cluster good-vs-bad workflow contrast + exemplar episodes.
- `out/candidates.json` — ranked candidates (machine-readable handoff for the skill-draft phase).

## Module map

| File | Stage |
|---|---|
| `src/discover.ts` | enumerate real sessions (excludes forks, agent-mode, the analyzer's own project) |
| `src/classify.ts` + `prompts/classify.md` | turn-role classifier (P0) |
| `src/segment.ts` | group turns into episodes (P0) |
| `src/signals.ts` | evidence signals + numeric features |
| `src/subagents.ts` | compact subagent summaries → parent episode |
| `src/render.ts` | compact episode view for the judge (≤12k chars) |
| `src/judge.ts` + `prompts/judge.md` | bias-anchored LLM judge + cache key (P0) |
| `src/calibrate.ts` | stratified calibration + self-consistency (P0 trust gate) |
| `src/mine.ts` | cluster + good/bad contrast + component ranking |
| `src/report.ts` | exemplar-driven report + candidates.json |
| `src/db.ts` + `src/schema.sql` | SQLite persistence |
| `src/types.ts` / `src/util.ts` | shared contract + helpers |
| `pipeline.ts` | orchestrator (resumable) |

---

# Cowork Workflow Miner (Tiếng Việt)

Gán nhãn workflow tốt/xấu từ chính các phiên Claude Code thực tế của bạn và tạo ra
báo cáo xếp hạng các ứng viên skill/script/SOP. Đây là bản prototype chạy cục bộ của
cổng kiểm soát trí tuệ khai thác (Cổng Go/Kill 1) — dừng lại **trước khi** soạn skill.

Xem `implementation-plan.md` để biết thiết kế đầy đủ và `DATA_FORMAT.md` để biết
định dạng transcript đã được xác minh.

## Pipeline

```
discover → classify (vai trò lượt) → segment (episode) → signals + subagents
   → render → judge (claude -p) → SQLite ─┬→ calibrate (cổng tin cậy)
                                          └→ mine (cluster + tốt/xấu) → report.md + candidates.json
```

## Cài đặt

```bash
bun install            # phụ thuộc duy nhất: @types/bun (dùng bun:sqlite)
```

Yêu cầu có `claude` CLI trong PATH (dùng ở chế độ headless làm trình chấm điểm:
`claude -p --output-format json`). Mặc định, các lệnh gọi LLM đi qua **profile ccs `my-api`** —
pipeline sẽ tiêm env của profile đó (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` từ
`ccs env my-api`) vào subprocess `claude`. Dùng `--runner claude` để chuyển sang đăng nhập
`claude` thông thường, hoặc `--ccs-profile <name>` để chọn profile ccs khác. (`ccs` chỉ bắt buộc
với runner mặc định `--runner ccs`; `--runner claude` không cần phụ thuộc này.)

## Chạy

Người mới? Hai điều khiến project này an toàn để thử nghiệm: đường chạy **`--no-judge`
tốn $0** (hoàn toàn không gọi LLM), và lần chạy đầy đủ **có thể tiếp tục + dùng cache-key**
(chạy lại không bao giờ chấm lại một episode trừ khi nội dung hoặc rubric của nó thay đổi).
Vì vậy hãy đi từ các bước miễn phí lên một lần chạy thực nhỏ trước khi chạy đầy đủ.

### Bắt đầu nhanh — lần chạy đầu tiên được khuyến nghị

```bash
bun install                                              # chạy một lần

# 1. Xem những phiên nào pipeline sẽ lấy ($0, không gọi LLM)
bun run discover

# 2. Chỉ dựng cấu trúc — không gọi judge, $0 — rồi xác thực (PASS/FAIL)
bun run pipeline.ts --project tennis --limit 3 --no-judge
bun run check

# 3. Xem CHÍNH XÁC những gì judge sẽ đọc ($0; render không bao giờ được lưu)
bun run dump-render --sample 3

# 4. Lần chạy THỰC đầu tiên, giới hạn chặt để chỉ tốn vài xu thay vì vài đô
bun run pipeline.ts --project tennis --limit 5 --max-episodes 10 --yes

# 5. Chạy đầy đủ + báo cáo (có thể tiếp tục; bỏ qua mọi episode đã chấm)
bun run pipeline.ts --mine
```

Sau đó đọc hai kết quả: `out/report.md` (cho người) và `out/candidates.json` (bàn giao cho máy).

> `--project <substr>` khớp với một chuỗi con của basename cwd được ghi lại của phiên,
> ví dụ `tennis` khớp với dự án được ghi là `tennis_tracking_system`.

### Tham chiếu lệnh (mỗi lệnh + các cờ của nó)

Mỗi giai đoạn có thể chạy độc lập. Các cờ được chú thích trực tiếp kèm chức năng.

#### `pipeline.ts` — trình điều phối (lệnh bạn dùng nhiều nhất)

```bash
bun run pipeline.ts [các cờ]
```

| Cờ | Chức năng |
|---|---|
| `--project <substr>` | chỉ các phiên có basename cwd chứa `<substr>` |
| `--limit N` | tối đa N phiên (0 ⇒ không phiên nào; từ chối giá trị không phải số) |
| `--since <ISO>` | chỉ các phiên sửa đổi từ một ngày ISO trở đi, ví dụ `2026-06-01` |
| `--no-judge` | **chỉ giai đoạn cấu trúc — không LLM, $0.** Dùng cùng `bun run check` |
| `--max-episodes N` | trần cứng số lần gọi judge trong lần chạy này (giới hạn chi phí theo số lượng) |
| `--max-cost <USD>` | dừng chấm khi chi phí ước tính vượt trần này |
| `--yes` / `-y` | bỏ qua xác nhận khi >\$5 (bắt buộc khi không có TTY / tự động hóa) |
| `--mine` | sau khi chấm, chạy luôn mine + report (ghi `out/`) |
| `--resume` | chạy lại an toàn; mọi ghi đều idempotent và episode đã chấm sẽ bị bỏ qua |
| `--classify-llm` | dùng LLM để xử lý ranh giới lượt mơ hồ (mặc định: chỉ heuristic) |
| `--db <path>` | dùng file SQLite khác mặc định (mặc định `analysis.db`) |
| `--runner ccs\|claude` | cách `claude -p` xác thực: `ccs` (mặc định) tiêm env của profile ccs; `claude` dùng đăng nhập thường (không cần ccs) |
| `--ccs-profile <name>` | profile ccs cần tiêm (mặc định `my-api`; chỉ dùng với `--runner ccs`) |

```bash
# các tổ hợp thường dùng
bun run pipeline.ts --project tennis --limit 3 --no-judge      # smoke cấu trúc $0
bun run pipeline.ts --project tennis --max-episodes 10 --yes   # smoke thực, rẻ
bun run pipeline.ts --since 2026-06-01 --max-cost 5 --mine     # chạy đầy đủ có giới hạn + report
bun run pipeline.ts --runner claude --mine                     # dùng đăng nhập `claude` thường, không ccs
```

#### `discover` — liệt kê các phiên pipeline sẽ phân tích ($0)

```bash
bun run discover [--project <substr>] [--since <ISO>] [--limit N]
```

#### `classify` — kiểm tra trình phân loại vai trò lượt trên MỘT phiên

```bash
bun run classify <sessionId|path>      # positional bắt buộc; chỉ heuristic, $0
bun run classify <sessionId|path> --classify-llm   # dùng thêm LLM cho lượt mơ hồ
```

#### `check` — xác thực cấu trúc DB sau một lần chạy `--no-judge` ($0)

```bash
bun run check                  # bất biến PASS/FAIL; thoát mã khác 0 khi lỗi
bun run check --db other.db    # kiểm tra một DB khác mặc định
```

#### `dump-render` — in chính xác những gì judge đọc ($0; không bao giờ lưu)

```bash
bun run dump-render --list                    # chỉ bảng metadata: chars/cap, đã rút gọn?, subagents?
bun run dump-render --sample [N]              # N episode tiêu biểu (mặc định 3): dài nhất, một cái bị rút gọn, có subagents
bun run dump-render --random N                # N episode ngẫu nhiên
bun run dump-render <sessionId>#<idx>         # một episode cụ thể, toàn bộ nội dung
bun run dump-render --session <id|prefix>     # mọi episode trong một phiên
# bộ lọc chế độ corpus (kết hợp với --list / --sample / --random):
bun run dump-render --sample 3 --project tennis --limit 5
```

#### `mine` — gom cụm + xếp hạng lại từ các nhãn đã có trong DB

```bash
bun run mine
```

Không có cờ (đọc `analysis.db` mặc định). Tinh chỉnh qua biến môi trường:
`MINE_LLM_CLUSTERING=0` (bỏ qua bước gom cụm bằng LLM → quay về gom cụm bằng chuẩn hóa
chuỗi), `MINE_LLM_TIMEOUT_MS` (mặc định `180000`), `MINE_LLM_MODEL` (mặc định `claude-sonnet-4-6`).

#### `report` — (tái) ghi `out/report.md` + `out/candidates.json` từ DB

```bash
bun run report
```

Không có cờ (đọc `analysis.db` mặc định).

#### `calibrate` — cổng tin cậy: kiểm tra thủ công + tự đối chiếu

Thủ công, **không** nằm trong pipeline tự động.

```bash
bun run calibrate                       # kiểm tra thủ công tương tác
bun run calibrate --non-interactive     # chỉ lấy mẫu + tự đối chiếu, không hỏi
bun run calibrate --sample N            # số episode cần kiểm tra
bun run calibrate --self-consistency K  # chấm lại K episode để đo độ ổn định của judge
```

### An toàn chi phí (áp dụng cho mọi lần chạy có chấm điểm)

Một lần chạy mới với chi phí ước tính trên ~\$5 sẽ hỏi xác nhận và **thất bại an toàn khi
không có TTY** — truyền `--yes` để tự động hóa. `--max-cost` giới hạn tổng chi tiêu tích lũy,
`--max-episodes` giới hạn số lần gọi, và 5 lần judge thất bại liên tiếp sẽ kích hoạt cầu dao
ngắt mạch để một CLI lỗi không thể đốt hết ngân sách. Các cờ dạng số sẽ từ chối giá trị không
phải số thay vì âm thầm bỏ giới hạn.

## Lưu ý chi phí / thời gian

Trình chấm điểm chạy `claude -p` **tuần tự**, ~một lần gọi cho mỗi episode (corpus ≈ 329
episode). Mỗi lần gọi là một request thực có tính phí. Dùng `--max-episodes` /
`--project` / `--limit` để giới hạn một lần chạy; cache-key đa thành phần
(nội dung + prompt + schema + model + cli) khiến lần chạy đầy đủ có thể tiếp tục — không có gì
bị chấm lại trừ khi nội dung hoặc rubric của nó thay đổi.

## Kết quả đầu ra

- `analysis.db` (gitignored) — sessions, turns, episodes, features, evidence, labels, calibration, clusters.
- `out/report.md` — đối chiếu workflow tốt-và-xấu theo từng cluster + các episode tiêu biểu.
- `out/candidates.json` — các ứng viên đã xếp hạng (bàn giao dạng máy đọc được cho giai đoạn soạn skill).

## Bản đồ module

| File | Giai đoạn |
|---|---|
| `src/discover.ts` | liệt kê các phiên thực (loại trừ fork, chế độ agent, chính dự án của analyzer) |
| `src/classify.ts` + `prompts/classify.md` | trình phân loại vai trò lượt (P0) |
| `src/segment.ts` | gom các lượt thành episode (P0) |
| `src/signals.ts` | tín hiệu bằng chứng + đặc trưng số |
| `src/subagents.ts` | tóm tắt subagent gọn → episode cha |
| `src/render.ts` | góc nhìn episode gọn cho trình chấm điểm (≤12k ký tự) |
| `src/judge.ts` + `prompts/judge.md` | trình chấm điểm LLM neo theo bias + cache-key (P0) |
| `src/calibrate.ts` | hiệu chỉnh phân tầng + tự nhất quán (cổng tin cậy P0) |
| `src/mine.ts` | cluster + đối chiếu tốt/xấu + xếp hạng thành phần |
| `src/report.ts` | báo cáo dựa trên episode tiêu biểu + candidates.json |
| `src/db.ts` + `src/schema.sql` | lưu trữ SQLite |
| `src/types.ts` / `src/util.ts` | hợp đồng chung + tiện ích |
| `pipeline.ts` | trình điều phối (có thể tiếp tục) |
