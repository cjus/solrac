/**
 * @fileoverview Built-in `time` integration — current time + timestamp formatting.
 * @purpose Educational reference for operators learning to write integrations.
 *          Smallest non-trivial example, zero deps, multi-tool, demonstrates the
 *          full `IntegrationContext` surface (`ctx.z`, `ctx.tool`, `ctx.log`).
 *
 * Why ship this as blessed:
 *   - It's universally useful: "what time is it for the team in Tokyo?" is a
 *     real recurring question, and Claude doesn't have a built-in time tool.
 *   - It's the file operators are pointed at FIRST when learning the pattern
 *     (see `docs/USAGE.md#integrations`). Heavy JSDoc here pays back the most.
 *   - Zero deps means no `npm install`, no credential bootstrap. It Just Works
 *     on a fresh deployment with `SOLRAC_INTEGRATIONS_ENABLED=true`.
 *
 * Why TWO tools instead of one:
 *   - Demonstrates that an integration is a *module* (multiple related tools
 *     under one namespace), not a single function. Operators copying this
 *     pattern for `linear`, `gmail`, etc. need to see >1 tool registered to
 *     understand the multi-call shape.
 *   - `time_now` and `time_format` cover the two common time questions
 *     (point-in-time + format-this-timestamp).
 *
 * Both tools are `tier: "auto"` because they have NO side effects — pure
 * functions of their input + the wall clock. Cost cap and loop detector
 * still apply via `PreToolUse` (verified — see `solrac-dev/PLAN.md`
 * Phase 3).
 *
 * `alwaysLoad: true` per tool — for ≤ ~10 integration tools, the schema-
 * upfront cost (~50-100 tokens per tool) is cheaper than an extra
 * `ToolSearch` round-trip every time the model wonders if there's a time
 * tool available.
 *
 * Position in the dependency graph:
 *   src/integrations-builtin/time → consumed by `loadIntegrations` at boot
 *
 * Cross-references:
 *   - docs/USAGE.md#integrations — operator-facing intro
 *   - src/integrations.ts — loader + IntegrationContext type
 *   - examples/integrations/echo/ — even smaller (1 tool, no Intl) intro
 *   - examples/integrations/linear/ — real-pattern example with external SDK
 */

import type {
  IntegrationContext,
  IntegrationModule,
} from "../../integrations.ts";

// IANA timezone validation. We don't ship a list of valid timezones (that'd
// be ~600 entries and the runtime already knows them). Instead we ask
// `Intl.DateTimeFormat` to validate by trying to construct it; an invalid
// tz throws `RangeError`. Cached so repeated calls with the same tz are
// effectively free.
const TZ_VALID_CACHE = new Map<string, boolean>();

function isValidTimezone(tz: string): boolean {
  const cached = TZ_VALID_CACHE.get(tz);
  if (cached !== undefined) return cached;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    TZ_VALID_CACHE.set(tz, true);
    return true;
  } catch {
    TZ_VALID_CACHE.set(tz, false);
    return false;
  }
}

export default function setup(ctx: IntegrationContext): IntegrationModule {
  return {
    apiVersion: 1,
    tools: [
      // ---- time_now ----
      ctx.tool(
        "time_now",
        "Get the current time. Returns an ISO 8601 timestamp (UTC) plus a " +
          "human-readable rendering in the requested timezone. Use this to " +
          "answer 'what time is it (right now, in <city/timezone>)?' Do NOT " +
          "use this for formatting an arbitrary timestamp — use time_format " +
          "for that.",
        {
          timezone: ctx.z
            .string()
            .optional()
            .describe(
              'IANA timezone name, e.g. "America/New_York", "Asia/Tokyo", ' +
                '"Europe/London", "UTC". Defaults to UTC when omitted.',
            ),
        },
        async (args) => {
          const tz = args.timezone ?? "UTC";
          if (!isValidTimezone(tz)) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Invalid timezone: "${tz}". Use an IANA name like "America/New_York" or "UTC".`,
                  }),
                },
              ],
            };
          }
          const now = new Date();
          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            dateStyle: "full",
            timeStyle: "long",
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    iso_utc: now.toISOString(),
                    timezone: tz,
                    formatted: formatter.format(now),
                    epoch_ms: now.getTime(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        },
        { alwaysLoad: true },
      ),

      // ---- time_format ----
      ctx.tool(
        "time_format",
        "Format an existing ISO 8601 timestamp in a target timezone and " +
          "locale. Use this to render a stored timestamp ('this issue was " +
          "updated at 2026-04-12T18:30:00Z') in the user's local context. " +
          "Do NOT use this to get the current time — use time_now for that.",
        {
          iso: ctx.z
            .string()
            .describe(
              'ISO 8601 timestamp to format, e.g. "2026-04-12T18:30:00Z" ' +
                'or "2026-04-12T18:30:00-04:00".',
            ),
          timezone: ctx.z
            .string()
            .optional()
            .describe(
              'IANA timezone for the output rendering, e.g. "Asia/Tokyo". ' +
                "Defaults to UTC.",
            ),
          locale: ctx.z
            .string()
            .optional()
            .describe(
              'BCP 47 locale tag, e.g. "en-US", "en-GB", "ja-JP". ' +
                'Defaults to "en-US". Affects month/day spelling and order.',
            ),
        },
        async (args) => {
          const tz = args.timezone ?? "UTC";
          const locale = args.locale ?? "en-US";
          if (!isValidTimezone(tz)) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Invalid timezone: "${tz}".`,
                  }),
                },
              ],
            };
          }
          const parsed = new Date(args.iso);
          if (Number.isNaN(parsed.getTime())) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Invalid ISO 8601 timestamp: "${args.iso}".`,
                  }),
                },
              ],
            };
          }
          // `Intl.DateTimeFormat` throws on a bad locale; catch + report.
          // We use `dateStyle:"full" + timeStyle:"long"` for a verbose render
          // ("Saturday, May 8, 2026 at 7:34:21 PM Eastern Daylight Time")
          // because the model can summarize down but can't add precision back.
          let formatted: string;
          try {
            formatted = new Intl.DateTimeFormat(locale, {
              timeZone: tz,
              dateStyle: "full",
              timeStyle: "long",
            }).format(parsed);
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `Invalid locale "${locale}": ${(err as Error).message}`,
                  }),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    input_iso: args.iso,
                    iso_utc: parsed.toISOString(),
                    timezone: tz,
                    locale,
                    formatted,
                    epoch_ms: parsed.getTime(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        },
        { alwaysLoad: true },
      ),
    ],
    meta: {
      // Both tools are pure functions of their input. Auto-tier means no
      // Telegram-confirm prompt — the model can answer "what time is it"
      // without a tap. Cost cap and loop detector still apply.
      tier: "auto",
    },
  };
}
