import { describe, expect, it } from "vitest";
import { defaultConfig, generateCorpus } from "./generate.js";
import { COMMON_WORDS, NEEDLE_TERMS } from "./vocab.js";

describe("vocabulary invariants", () => {
  it("never lets a needle term double as ordinary filler text", () => {
    // Otherwise the term's real selectivity is filler-frequency plus needle
    // frequency, not the controlled rate NEEDLE_TERMS documents — this
    // happened with "invoice" and "onboarding" and silently 60x'd their
    // match counts in the search benchmark.
    const commonWords = new Set<string>(COMMON_WORDS);
    for (const { term } of NEEDLE_TERMS) {
      expect(commonWords.has(term)).toBe(false);
    }
  });
});

describe("generateCorpus", () => {
  it("yields exactly messageCount messages across exactly threadCount threads", () => {
    const config = defaultConfig({
      seed: 1,
      messageCount: 2_000,
      threadCount: 700,
      mailAccounts: 2,
    });
    const threads = new Set<string>();
    let count = 0;
    for (const message of generateCorpus(config)) {
      count++;
      threads.add(message.threadId);
    }
    expect(count).toBe(2_000);
    expect(threads.size).toBe(700);
  });

  it("is deterministic for a fixed seed", () => {
    const config = defaultConfig({ seed: 42, messageCount: 500, threadCount: 200 });
    const first = [...generateCorpus(config)].map((m) => m.id + m.subject + m.sentAt.toISOString());
    const second = [...generateCorpus(config)].map(
      (m) => m.id + m.subject + m.sentAt.toISOString(),
    );
    expect(first).toEqual(second);
  });

  it("only assigns mailAccountId within [1, mailAccounts]", () => {
    const config = defaultConfig({
      seed: 7,
      messageCount: 1_000,
      threadCount: 300,
      mailAccounts: 2,
    });
    for (const message of generateCorpus(config)) {
      expect(message.mailAccountId).toBeGreaterThanOrEqual(1);
      expect(message.mailAccountId).toBeLessThanOrEqual(2);
    }
  });

  it("keeps every message within the 15-year window and never after 'now'", () => {
    const config = defaultConfig({ seed: 3, messageCount: 800, threadCount: 250 });
    const now = new Date("2026-08-31T00:00:00.000Z").getTime();
    const fifteenYearsMs = 15 * 365 * 86_400_000;
    for (const message of generateCorpus(config)) {
      expect(message.sentAt.getTime()).toBeLessThanOrEqual(now);
      expect(message.sentAt.getTime()).toBeGreaterThanOrEqual(now - fifteenYearsMs - 86_400_000);
    }
  });

  it("gives reply messages a 'Re: ' subject sharing the thread's base subject", () => {
    const config = defaultConfig({ seed: 9, messageCount: 3_000, threadCount: 500 });
    const byThread = new Map<string, string[]>();
    for (const message of generateCorpus(config)) {
      const list = byThread.get(message.threadId) ?? [];
      list.push(message.subject);
      byThread.set(message.threadId, list);
    }
    let checkedAMultiMessageThread = false;
    for (const subjects of byThread.values()) {
      if (subjects.length < 2) continue;
      checkedAMultiMessageThread = true;
      const base = subjects[0];
      for (const subject of subjects.slice(1)) {
        expect(subject).toBe(`Re: ${base}`);
      }
    }
    expect(checkedAMultiMessageThread).toBe(true);
  });
});
