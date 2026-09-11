import { describe, expect, it } from "vitest";
import { deriveFallbackUid, mapMessageClassToKind, parseTnef } from "./tnef.js";

/**
 * Hand-encodes fixtures against the same MS-OXTNEF wire format `tnef.ts`
 * reads — there is no real captured `winmail.dat` sample in this
 * environment (`tnef.ts`'s own doc comment), so these fixtures are this
 * suite's only source of truth for the envelope shape, the same "the ingest
 * path is what is under test, so its fixtures must not come from the same
 * library it parses with" posture `test-support/mime.ts` documents for
 * `.greenmail.test.ts` — except here the "library" and the "fixture builder"
 * are necessarily the same hand, since nothing else in this repo speaks
 * TNEF. Round-trip / bounds coverage is what carries the weight, not
 * byte-for-byte fidelity against a real Outlook capture.
 */

const TNEF_SIGNATURE = 0x223e9f78;
const LVL_MESSAGE = 0x01;
const ATT_MESSAGE_CLASS = 0x00088008;
const ATT_MAPI_PROPS = 0x00069003;
const PT_STRING8 = 0x001e;

function attString(text: string): Buffer {
  const withNul = Buffer.from(`${text}\0`, "latin1");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(withNul.length, 0);
  return Buffer.concat([header, withNul]);
}

function attribute(level: number, tag: number, value: Buffer): Buffer {
  const head = Buffer.alloc(1 + 4 + 4);
  head.writeUInt8(level, 0);
  head.writeUInt32LE(tag, 1);
  head.writeUInt32LE(value.length, 5);
  const checksum = Buffer.alloc(2); // unverified by the reader — see tnef.ts's own doc comment
  return Buffer.concat([head, value, checksum]);
}

function mapiProperty(id: number, type: number, text: string): Buffer {
  const raw = Buffer.from(`${text}\0`, "latin1");
  const padded = raw.length % 4 === 0 ? 0 : 4 - (raw.length % 4);
  const lengthHeader = Buffer.alloc(4);
  lengthHeader.writeUInt32LE(raw.length, 0);
  const propTag = Buffer.alloc(4);
  propTag.writeUInt32LE(((id & 0xffff) << 16) | (type & 0xffff), 0);
  return Buffer.concat([propTag, lengthHeader, raw, Buffer.alloc(padded)]);
}

function mapiPropsValue(properties: Buffer[]): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(properties.length, 0);
  return Buffer.concat([count, ...properties]);
}

function tnefEnvelope(...attributes: Buffer[]): Buffer {
  const header = Buffer.alloc(4 + 2);
  header.writeUInt32LE(TNEF_SIGNATURE, 0);
  header.writeUInt16LE(1, 4);
  return Buffer.concat([header, ...attributes]);
}

describe("parseTnef", () => {
  it("reads the legacy attMessageClass attribute", () => {
    const buf = tnefEnvelope(
      attribute(LVL_MESSAGE, ATT_MESSAGE_CLASS, attString("IPM.Schedule.Meeting.Request")),
    );
    expect(parseTnef(buf)).toEqual({
      messageClass: "IPM.Schedule.Meeting.Request",
      subject: null,
    });
  });

  it("falls back to PidTagMessageClass inside the attMAPIProps stream", () => {
    const props = mapiPropsValue([
      mapiProperty(0x001a, PT_STRING8, "IPM.Schedule.Meeting.Resp.Pos"),
      mapiProperty(0x0037, PT_STRING8, "Re: Weekly sync"),
    ]);
    const buf = tnefEnvelope(attribute(LVL_MESSAGE, ATT_MAPI_PROPS, props));
    expect(parseTnef(buf)).toEqual({
      messageClass: "IPM.Schedule.Meeting.Resp.Pos",
      subject: "Re: Weekly sync",
    });
  });

  it("rejects a buffer with the wrong signature", () => {
    const bad = Buffer.alloc(16);
    bad.writeUInt32LE(0xdeadbeef, 0);
    expect(parseTnef(bad)).toBeNull();
  });

  it("fails closed on a truncated attribute rather than throwing", () => {
    const whole = tnefEnvelope(
      attribute(LVL_MESSAGE, ATT_MESSAGE_CLASS, attString("IPM.Schedule.Meeting.Request")),
    );
    const truncated = whole.subarray(0, whole.length - 5);
    expect(() => parseTnef(truncated)).not.toThrow();
    expect(parseTnef(truncated)).toBeNull();
  });

  it("fails closed on an attribute claiming more bytes than remain", () => {
    const head = Buffer.alloc(1 + 4 + 4);
    head.writeUInt8(LVL_MESSAGE, 0);
    head.writeUInt32LE(ATT_MESSAGE_CLASS, 1);
    head.writeUInt32LE(1_000_000, 5); // far larger than anything follows
    const buf = Buffer.concat([tnefEnvelope(), head]);
    expect(parseTnef(buf)).toBeNull();
  });

  it("rejects a buffer past the hard byte ceiling with no parse attempt", () => {
    const huge = Buffer.alloc(10_000_001);
    expect(parseTnef(huge)).toBeNull();
  });

  it("returns null for a non-meeting message class rather than fabricating one", () => {
    const buf = tnefEnvelope(attribute(LVL_MESSAGE, ATT_MESSAGE_CLASS, attString("IPM.Note")));
    const result = parseTnef(buf);
    expect(result?.messageClass).toBe("IPM.Note");
    expect(mapMessageClassToKind(result?.messageClass ?? "")).toBeNull();
  });
});

describe("mapMessageClassToKind", () => {
  it("maps the IPM.Schedule.Meeting.* family", () => {
    expect(mapMessageClassToKind("IPM.Schedule.Meeting.Request")).toBe("request");
    expect(mapMessageClassToKind("IPM.Schedule.Meeting.Resp.Pos")).toBe("answer");
    expect(mapMessageClassToKind("IPM.Schedule.Meeting.Resp.Neg")).toBe("answer");
    expect(mapMessageClassToKind("IPM.Schedule.Meeting.Canceled")).toBe("cancellation");
  });
});

describe("deriveFallbackUid", () => {
  it("is deterministic for the same bytes and distinct for different bytes", () => {
    const a = Buffer.from("one winmail.dat");
    const b = Buffer.from("another winmail.dat");
    expect(deriveFallbackUid(a)).toBe(deriveFallbackUid(a));
    expect(deriveFallbackUid(a)).not.toBe(deriveFallbackUid(b));
    expect(deriveFallbackUid(a)).toMatch(/^tnef:[0-9a-f]{32}$/);
  });
});
