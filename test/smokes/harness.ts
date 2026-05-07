// Shared scaffolding for solrac integration smokes.
//
// Smokes live outside `bun test` (no `.test.ts` suffix) because they touch a
// real sqlite file and run as standalone scripts. The harness provides:
//   - openTestDb(name): fresh sqlite under data/test/<name>/, removed first
//   - mkUpdate(opts): minimal Telegram Update fixture (typed via grammyjs)
//   - reportAndExit(results): pretty-print + process.exit(1) on any fail

import { mkdir, rm } from "node:fs/promises";
import type { Update } from "@grammyjs/types";
import { openDb, type SolracDb } from "../../src/db.ts";

export interface Phase {
  name: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export async function openTestDb(name: string): Promise<{ db: SolracDb; dir: string }> {
  const dir = `./data/test/${name}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const db = await openDb(dir);
  return { db, dir };
}

export interface MkUpdateOpts {
  updateId: number;
  fromId?: number;
  chatId?: number;
  text?: string;
}

export function mkUpdate(opts: MkUpdateOpts): Update {
  const fromId = opts.fromId;
  const chatId = opts.chatId ?? (fromId !== undefined ? 7000 + fromId : 7000);
  const from =
    fromId === undefined ? undefined : { id: fromId, is_bot: false, first_name: "u" };
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.updateId,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "u" },
      from,
      text: opts.text ?? "spam",
    },
  } as unknown as Update;
}

export function reportAndExit(label: string, phases: readonly Phase[]): never {
  let allPass = true;
  for (const p of phases) {
    const tag = p.pass ? "PASS" : "FAIL";
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${p.name}`);
    // eslint-disable-next-line no-console
    console.log(`         expected: ${p.expected}`);
    // eslint-disable-next-line no-console
    console.log(`         actual:   ${p.actual}`);
    if (!p.pass) allPass = false;
  }
  // eslint-disable-next-line no-console
  console.log(allPass ? `\n${label} OK` : `\n${label} FAILED`);
  process.exit(allPass ? 0 : 1);
}
