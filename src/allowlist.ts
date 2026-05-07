/**
 * @fileoverview Per-from.id allowlist with bootstrap-on-every-boot semantics.
 * @purpose Determine whether a Telegram user (`from.id`) is permitted to use
 *          Solrac. The list lives in SQLite (`allowlist` table) and is
 *          re-bootstrapped from `ALLOWLIST_BOOTSTRAP` env on every boot.
 *
 * Solrac's gate is on the USER, not the chat. In a group, `chat.id` is shared
 * across members; if we gated on `chat.id`, anyone who could find the chat
 * could prompt the bot. Gating on `from.id` (the actual sender) closes that.
 * See `policy.ts::extractFromId` for the full read order including
 * callback_query and edited_message variants.
 *
 * Bootstrap is additive: `INSERT OR IGNORE` so removing entries from
 * `ALLOWLIST_BOOTSTRAP` doesn't remove them from the DB. To revoke an
 * existing entry, edit the env AND `DELETE FROM allowlist WHERE user_id = ?`.
 * This is intentional — env-only revocation would mean a typo in production
 * env silently drops users.
 *
 * Position in the dependency graph:
 *   db + log → allowlist → consumed by main (gateAndAuditDenied)
 *
 * Exports:
 *   - `createAllowlist(db)` — factory; returns `Allowlist`.
 *   - `Allowlist` — interface with `isAllowed(userId)` and
 *     `bootstrap(userIds)`.
 *
 * Key invariants:
 *   - `isAllowed` is a single indexed lookup on the `allowlist` PK
 *     (`user_id`). O(log n) at sqlite scale, in practice O(1).
 *   - `bootstrap(userIds)` is idempotent (INSERT OR IGNORE). Safe to call on
 *     every boot.
 *   - The allowlist is a hot path: every Telegram update calls `isAllowed`.
 *     Don't add I/O here.
 *
 * Gotchas:
 *   - `bootstrap` LOGS only the count and added — does NOT log the actual
 *     IDs. `from.id` is sensitive (lets you contact the user via Telegram).
 *   - The store has no `revoke` method. To revoke, hit the DB directly. The
 *     omission is deliberate — make revocation visible in the audit trail.
 *
 * Cross-references:
 *   - docs/USAGE.md#fromid-vs-chatid — why we gate on user not chat
 *   - main.ts::gateAndAuditDenied — the call site
 */

import type { SolracDb } from "./db.ts";
import { log } from "./log.ts";

export interface Allowlist {
  isAllowed: (userId: number) => boolean;
  bootstrap: (userIds: readonly number[]) => void;
}

export function createAllowlist(db: SolracDb): Allowlist {
  const stIs = db.raw.prepare("SELECT 1 AS hit FROM allowlist WHERE user_id = ?");
  const stAdd = db.raw.prepare(
    "INSERT OR IGNORE INTO allowlist (user_id, added_at) VALUES (?, ?)",
  );

  return {
    isAllowed(userId) {
      return stIs.get(userId) !== null;
    },
    bootstrap(userIds) {
      const now = Date.now();
      let added = 0;
      for (const id of userIds) {
        const r = stAdd.run(id, now);
        if (r.changes > 0) added++;
      }
      log.info("allowlist.bootstrap", { count: userIds.length, added });
    },
  };
}
