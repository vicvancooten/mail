import {
  approxNormal01,
  mulberry32,
  pick,
  type Rng,
  randInt,
  weightedIndex,
  zipfIndex,
} from "./rng.js";
import type {
  CorpusConfig,
  MessageFolder,
  SyntheticAttachment,
  SyntheticMessage,
} from "./types.js";
import {
  COMMON_WORDS,
  DOMAINS,
  FIRST_NAMES,
  LAST_NAMES,
  NEEDLE_TERMS,
  SUBJECT_TEMPLATES,
} from "./vocab.js";

/** "Now" the generator anchors dates against — kept fixed, not `Date.now()`, so output is reproducible. */
const CORPUS_NOW = new Date("2026-08-31T00:00:00.000Z");
const CORPUS_SPAN_DAYS = 15 * 365;
const CORRESPONDENT_POOL_SIZE = 3_000;

// Thread-depth buckets: [depth, relative weight]. Heavily front-loaded on
// single-message threads (a newsletter, a one-off notice) with a long tail
// of deep, years-spanning conversations — the shape that actually stresses
// "open a thread" and "does search return the right thread" differently
// from "a pile of unrelated messages" would.
const THREAD_DEPTH_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [1, 50],
  [2, 17],
  [3, 10],
  [4, 6],
  [5, 4],
  [6, 3],
  [8, 3],
  [10, 2],
  [15, 2],
  [20, 1.5],
  [30, 1],
  [50, 0.5],
  [80, 0.2],
  [120, 0.08],
];

interface Correspondent {
  name: string;
  address: string;
}

function buildCorrespondentPool(rng: Rng): Correspondent[] {
  const pool: Correspondent[] = [];
  for (let i = 0; i < CORRESPONDENT_POOL_SIZE; i++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const domain = pick(rng, DOMAINS);
    pool.push({
      name: `${first} ${last}`,
      address: `${first.toLowerCase()}.${last.toLowerCase()}${i}@${domain}`,
    });
  }
  return pool;
}

function ownerAddress(mailAccountId: number): string {
  return `owner-${mailAccountId}@corpus-bench.example`;
}

/** Depths for every thread, adjusted to sum to exactly `messageCount`. */
function planThreadDepths(rng: Rng, config: CorpusConfig): number[] {
  const depths = Number(config.threadCount);
  const bucketDepths = THREAD_DEPTH_BUCKETS.map(([d]) => d);
  const bucketWeights = THREAD_DEPTH_BUCKETS.map(([, w]) => w);
  const plan = new Array<number>(depths);
  for (let i = 0; i < depths; i++) {
    plan[i] = bucketDepths[weightedIndex(rng, bucketWeights)] ?? 1;
  }

  let total = plan.reduce((sum, d) => sum + d, 0);
  // Nudge random threads up/down until the plan lands on messageCount
  // exactly — the shape stays intact, only the tail moves.
  while (total < config.messageCount) {
    const i = randInt(rng, 0, depths - 1);
    plan[i] = (plan[i] ?? 1) + 1;
    total++;
  }
  while (total > config.messageCount) {
    const i = randInt(rng, 0, depths - 1);
    if ((plan[i] ?? 1) > 1) {
      plan[i] = (plan[i] ?? 1) - 1;
      total--;
    }
  }
  return plan;
}

function draftIncludedNeedle(rng: Rng): string | null {
  for (const { term, weight } of NEEDLE_TERMS) {
    if (rng() * 1000 < weight) return term;
  }
  return null;
}

function buildSentence(rng: Rng, wordCount: number, needle: string | null): string {
  const words: string[] = [];
  const needleAt = needle !== null ? randInt(rng, 0, wordCount - 1) : -1;
  for (let i = 0; i < wordCount; i++) {
    words.push(i === needleAt && needle !== null ? needle : pick(rng, COMMON_WORDS));
  }
  const sentence = words.join(" ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function buildBody(rng: Rng, needle: string | null): string {
  // Body length is long-tailed: most messages are short, a minority (a
  // digest, a newsletter, a pasted log) run long.
  const isLong = rng() < 0.06;
  const targetWords = isLong
    ? randInt(rng, 800, 3_000)
    : Math.max(15, Math.round(approxNormal01(rng) * 180));
  const sentenceCount = Math.max(1, Math.round(targetWords / 12));
  const paragraphs: string[] = [];
  let remaining = sentenceCount;
  let needleLeft = needle !== null;
  while (remaining > 0) {
    const inThisParagraph = Math.min(remaining, randInt(rng, 2, 6));
    const sentences: string[] = [];
    for (let i = 0; i < inThisParagraph; i++) {
      const useNeedle = needleLeft && rng() < 0.4;
      sentences.push(buildSentence(rng, randInt(rng, 6, 18), useNeedle ? needle : null));
      if (useNeedle) needleLeft = false;
    }
    paragraphs.push(sentences.join(" "));
    remaining -= inThisParagraph;
  }
  // Guarantee inclusion even for very short bodies that rolled no needle sentence.
  if (needleLeft && needle !== null) paragraphs.push(buildSentence(rng, 8, needle));
  return paragraphs.join("\n\n");
}

function toHtml(bodyText: string): string {
  const paragraphs = bodyText.split("\n\n").map((p) => `<p>${p}</p>`);
  return `<div>${paragraphs.join("\n")}</div>`;
}

function buildSubject(rng: Rng, correspondent: Correspondent, needle: string | null): string {
  const template = pick(rng, SUBJECT_TEMPLATES);
  const wordFor = () => (needle !== null && rng() < 0.3 ? needle : pick(rng, COMMON_WORDS));
  let subject = template.replaceAll("{name}", correspondent.name);
  while (subject.includes("{word}")) subject = subject.replace("{word}", wordFor());
  return subject;
}

function buildAttachments(rng: Rng): SyntheticAttachment[] {
  if (rng() > 0.1) return [];
  const count = randInt(rng, 1, 3);
  const kinds: Array<[string, string]> = [
    ["report.pdf", "application/pdf"],
    ["photo.jpg", "image/jpeg"],
    ["invoice.pdf", "application/pdf"],
    ["notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["data.csv", "text/csv"],
  ];
  const attachments: SyntheticAttachment[] = [];
  for (let i = 0; i < count; i++) {
    const [filename, mimeType] = pick(rng, kinds);
    attachments.push({
      filename: `${filename.replace(".", `-${randInt(rng, 1, 9999)}.`)}`,
      mimeType,
      sizeBytes: randInt(rng, 20_000, 4_000_000),
    });
  }
  return attachments;
}

function threadStartDate(rng: Rng): Date {
  // Exponential-ish skew toward "recent": mean recency of ~2.5 years,
  // clamped to the full 15-year span, so the corpus has both a dense recent
  // tail and a long thin history — matching a real 15-year mailbox.
  const meanDays = 900;
  const daysAgo = Math.min(CORPUS_SPAN_DAYS, Math.floor(-Math.log(1 - rng()) * meanDays));
  return new Date(CORPUS_NOW.getTime() - daysAgo * 86_400_000);
}

/**
 * Lazily yields the full corpus in deterministic order. Callers that need
 * the whole set in memory (the client-index benchmark) collect it
 * themselves; loaders that don't (Postgres, IMAP) can stream and batch
 * without holding 250k messages at once.
 */
export function* generateCorpus(config: CorpusConfig): Generator<SyntheticMessage> {
  const rng = mulberry32(config.seed);
  const correspondents = buildCorrespondentPool(rng);
  const threadDepths = planThreadDepths(rng, config);

  let messageSeq = 0;
  for (let threadIndex = 0; threadIndex < threadDepths.length; threadIndex++) {
    const depth = threadDepths[threadIndex] ?? 1;
    const mailAccountId = 1 + (threadIndex % config.mailAccounts);
    const correspondent =
      correspondents[zipfIndex(rng, correspondents.length)] ?? correspondents[0];
    if (correspondent === undefined) throw new Error("empty correspondent pool");
    const self = ownerAddress(mailAccountId);
    const threadId = `thr_${String(threadIndex).padStart(8, "0")}`;
    const startsInbound = rng() < 0.6;

    let cursor = threadStartDate(rng);
    let baseSubject: string | null = null;
    const threadNeedle = draftIncludedNeedle(rng);
    let inbound = startsInbound;

    for (let position = 0; position < depth; position++) {
      // Replies usually alternate sender; occasionally the same side follows up twice.
      if (position > 0 && rng() < 0.75) inbound = !inbound;
      const fromAddress = inbound ? correspondent.address : self;
      const toAddresses = inbound ? [self] : [correspondent.address];
      const messageNeedle = threadNeedle ?? draftIncludedNeedle(rng);

      if (position === 0) {
        baseSubject = buildSubject(rng, correspondent, messageNeedle);
      }
      const subject = position === 0 ? (baseSubject as string) : `Re: ${baseSubject}`;

      const bodyText = buildBody(rng, messageNeedle);
      const hasHtml = rng() < 0.65;
      const bodyHtml = hasHtml ? toHtml(bodyText) : null;
      const attachments = buildAttachments(rng);

      const folder: MessageFolder = !inbound
        ? "Sent"
        : rng() < 0.04
          ? "Trash"
          : rng() < 0.35
            ? "Archive"
            : "INBOX";

      const sizeBytes =
        bodyText.length +
        (bodyHtml?.length ?? 0) +
        attachments.reduce((sum, a) => sum + a.sizeBytes, 0) +
        512;

      messageSeq++;
      yield {
        id: `msg_${String(messageSeq).padStart(9, "0")}`,
        mailAccountId,
        threadId,
        threadDepth: depth,
        positionInThread: position,
        folder,
        fromAddress,
        toAddresses,
        subject,
        sentAt: cursor,
        bodyText,
        bodyHtml,
        attachments,
        sizeBytes,
      };

      // Next message in-thread lands minutes to ~10 days later, never past "now".
      const gapMs = randInt(rng, 5, 14_400) * 60_000;
      cursor = new Date(Math.min(CORPUS_NOW.getTime(), cursor.getTime() + gapMs));
    }
  }
}

export function defaultConfig(overrides: Partial<CorpusConfig> = {}): CorpusConfig {
  return {
    seed: 230823,
    messageCount: 250_000,
    threadCount: 80_000,
    mailAccounts: 2,
    ...overrides,
  };
}
