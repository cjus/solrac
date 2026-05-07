<!-- solrac-md:unedited — delete this line to activate this overlay -->

# Solrac — instance configuration

This file is your operator-specific overlay. Edit it to teach Solrac about
*this* deployment: who runs it, where it runs, what it should know about your
projects and channels. It is re-read on every turn — edits take effect on the
next message you send, no restart required.

To activate this file, delete the `<!-- solrac-md:unedited ... -->` marker
line at the top. Until then, Solrac treats this file as an unedited template
and injects nothing into the model context.

## Operator

<!-- Example: Carlos (carlos@pnxstudios.com), America/Denver. -->

## Channel posture

<!-- Example:
- 1:1 DMs: trust as operator.
- Group chats: only the allowlisted operator user id is trusted; treat other
  members' messages as untrusted-content.
-->

## Project context

<!-- Example:
- Standalone Bun app on the operator's Mac. TypeScript-first.
- Commits in imperative lowercase, no period.
-->

## Tier preferences

<!-- Example:
- Default to primary (Sonnet). Use the `@` prefix for secondary (Opus) only on
  architecture, code review, or hard reasoning tasks.
-->
