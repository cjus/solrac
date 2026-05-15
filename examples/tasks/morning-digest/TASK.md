---
name: morning_digest
description: Weekday morning Notion ticket digest (DMs operator).
cron: "0 9 * * 1-5"
tz: America/Denver
catch_up: true
enabled: true
boot_catch_up_jitter_s: 30
---

You are running as the morning digest. List any Notion tickets in the PNX
projects database whose status is "In progress" and whose last update was more
than 48 hours ago. Format the reply as a short bullet list: ticket id, title,
last-touched-by, days stale.

If there are no stale tickets, reply exactly: "All clear."

Keep the reply under 1500 characters. Don't ask follow-up questions.
