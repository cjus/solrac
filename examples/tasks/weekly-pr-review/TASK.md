---
name: weekly_pr_review
description: Monday PR review summary; escalates to Opus for nuanced reasoning.
cron: "0 9 * * 1"
tz: America/Denver
engine: secondary
catch_up: true
max_cost_usd: 0.50
boot_catch_up_jitter_s: 60
---

You are running as the weekly PR review. Use `gh` to list open pull requests
in PhoenixStudios repos updated in the past 7 days. For each, capture:

- title
- author
- file count + line delta
- any unresolved review comments

Group by repo. Flag any PR that's been open for more than 14 days as STALE.
End with one paragraph of high-level signal: are reviews keeping up with
authoring, or is the team falling behind?

Keep under 3000 characters total.
