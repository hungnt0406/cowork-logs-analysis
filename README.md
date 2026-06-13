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

```bash
# 1. Eyeball the classifier on one session (audit tool)
bun run src/classify.ts <sessionId|path>

# 2. List discovered real sessions
bun run src/discover.ts

# 3. Smoke (structure only, no LLM calls)
bun run pipeline.ts --project auto-skills --limit 3 --no-judge

# 3b. Validate the structure for $0 — counts vs baseline + hard invariants (PASS/FAIL)
#     Run after any --no-judge pass; exits non-zero if an invariant breaks.
bun run check                       # or: bun run check --db other.db

# 3c. Eyeball the render for $0 — see EXACTLY what the judge will read.
#     The render is never persisted, so this re-runs structure and prints it.
bun run dump-render --list                  # metadata table: chars/cap, elided?, subagents?
bun run dump-render --sample 3              # 3 representative episodes (longest, elided, subagents)
bun run dump-render <sessionId>#<idx>       # one specific episode, full body
bun run dump-render --session <id|prefix>   # every episode in a session

# 4. Smoke with the live judge, capped
#    --project matches a substring of the session's recorded cwd basename
#    (e.g. the usth project records as "tennis_tracking_system").
bun run pipeline.ts --project tennis --limit 5 --max-episodes 10 --yes

# 5. Full run (resumable; judge is cache-keyed — re-running skips judged episodes)
bun run pipeline.ts --mine          # --mine also runs mine + report at the end

# 6. Trust gate: stratified human spot-check + auto cross-check
bun run src/calibrate.ts            # interactive; --non-interactive to just sample
bun run src/calibrate.ts --non-interactive

# 7. (Re)generate the report any time
bun run src/mine.ts
bun run src/report.ts               # writes out/report.md + out/candidates.json
```

### pipeline.ts flags
`--project <substr>` · `--limit N` (sessions) · `--since <ISO>` · `--resume` ·
`--classify-llm` (LLM pass on ambiguous turn boundaries) · `--max-episodes N`
(cap judge calls) · `--max-cost <USD>` (hard spend ceiling) · `--yes` (skip the
est-cost confirmation) · `--no-judge` · `--db <path>` · `--mine` ·
`--runner ccs|claude` (LLM routing, default `ccs`) · `--ccs-profile <name>` (default `my-api`)

Cost safety: a fresh judge run above ~$5 estimated prompts for confirmation (fails
closed on non-TTY — pass `--yes` for automation). `--max-cost` caps cumulative spend,
and 5 consecutive judge failures trip a circuit breaker so a broken CLI can't burn the
whole budget. Numeric flags reject non-numeric values rather than silently unbounding.

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

```bash
# 1. Kiểm tra nhanh classifier trên một phiên (công cụ audit)
bun run src/classify.ts <sessionId|path>

# 2. Liệt kê các phiên thực tế đã phát hiện
bun run src/discover.ts

# 3. Smoke test (chỉ kiểm tra cấu trúc, không gọi LLM)
bun run pipeline.ts --project auto-skills --limit 3 --no-judge

# 3b. Xác thực cấu trúc với chi phí $0 — đếm số liệu so với baseline + bất biến cứng (PASS/FAIL)
#     Chạy sau mỗi lần --no-judge; thoát với mã khác 0 nếu một bất biến bị vi phạm.
bun run check                       # hoặc: bun run check --db other.db

# 3c. Xem render với chi phí $0 — thấy CHÍNH XÁC những gì trình chấm điểm sẽ đọc.
#     Render không bao giờ được lưu, nên lệnh này chạy lại cấu trúc và in ra.
bun run dump-render --list                  # bảng metadata: chars/cap, đã rút gọn?, subagents?
bun run dump-render --sample 3              # 3 episode tiêu biểu (dài nhất, đã rút gọn, có subagents)
bun run dump-render <sessionId>#<idx>       # một episode cụ thể, toàn bộ nội dung
bun run dump-render --session <id|prefix>   # mọi episode trong một phiên

# 4. Smoke test với trình chấm điểm thực, có giới hạn
#    --project khớp với một chuỗi con của basename cwd được ghi lại của phiên
#    (ví dụ: dự án usth được ghi là "tennis_tracking_system").
bun run pipeline.ts --project tennis --limit 5 --max-episodes 10 --yes

# 5. Chạy đầy đủ (có thể tiếp tục; judge dùng cache-key — chạy lại sẽ bỏ qua episode đã chấm)
bun run pipeline.ts --mine          # --mine cũng chạy mine + report ở cuối

# 6. Cổng tin cậy: kiểm tra thủ công phân tầng + tự đối chiếu
bun run src/calibrate.ts            # tương tác; --non-interactive để chỉ lấy mẫu
bun run src/calibrate.ts --non-interactive

# 7. (Tái) tạo báo cáo bất cứ lúc nào
bun run src/mine.ts
bun run src/report.ts               # ghi ra out/report.md + out/candidates.json
```

### Các cờ của pipeline.ts
`--project <substr>` · `--limit N` (số phiên) · `--since <ISO>` · `--resume` ·
`--classify-llm` (chạy LLM trên các ranh giới lượt mơ hồ) · `--max-episodes N`
(giới hạn số lần gọi judge) · `--max-cost <USD>` (trần chi tiêu cứng) · `--yes` (bỏ qua
xác nhận chi phí ước tính) · `--no-judge` · `--db <path>` · `--mine` ·
`--runner ccs|claude` (định tuyến LLM, mặc định `ccs`) · `--ccs-profile <name>` (mặc định `my-api`)

An toàn chi phí: một lần chạy judge mới với chi phí ước tính trên ~$5 sẽ hỏi xác nhận
(thất bại an toàn khi không có TTY — truyền `--yes` để tự động hóa). `--max-cost` giới hạn
tổng chi tiêu tích lũy, và 5 lần judge thất bại liên tiếp sẽ kích hoạt cầu dao ngắt mạch để
một CLI lỗi không thể đốt hết ngân sách. Các cờ dạng số sẽ từ chối giá trị không phải số
thay vì âm thầm bỏ giới hạn.

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
