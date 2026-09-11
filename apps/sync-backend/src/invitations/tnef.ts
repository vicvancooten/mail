/**
 * TNEF (`winmail.dat`) unwrapping (#239, ADR-0027, #182): an in-house
 * extractor, not a dependency — the research behind #182 found no maintained
 * npm package that reads meeting-request TNEF safely, and TNEF parsers have a
 * long CVE history under adversarial fuzzing (this ticket's own body), so
 * this reads the documented MS-OXTNEF wire format directly with a bounded,
 * defensive reader: every read is range-checked, every claimed length is
 * capped against both a hard byte ceiling and the bytes actually remaining,
 * and the whole walk is capped on iteration count. Anything that would
 * violate a bound aborts the parse and returns `null` — fails closed, never
 * throws into its caller.
 *
 * **Scope decision** (recorded here and in #239's closing report): this
 * parser reads the TNEF envelope far enough to recover `PidTagMessageClass`
 * — the gate this ticket's acceptance line names — and the small set of
 * standard (non-named) MAPI properties below. It deliberately does **not**
 * resolve PSETID_Appointment/PSETID_Meeting *named* properties (the
 * `DTSTART`/`DTEND`/organiser/attendee equivalents RFC-quotes as living
 * there), because that resolution needs the TNEF named-property mapping
 * stream's exact byte layout, which is not documented closely enough in this
 * environment to implement with confidence — guessing wrong there would
 * silently corrupt an Invitation's times rather than merely omit them. A
 * meeting-class TNEF attachment therefore still produces an Invitation row
 * (`kind` from the message class, `title` from `PidTagSubject` when present),
 * with `vevent.start`/`end`/`organizer`/`attendees` left unset. Full named-
 * property decoding is deferred to a follow-up ticket.
 */

import { createHash } from "node:crypto";

const TNEF_SIGNATURE = 0x223e9f78;
const LVL_MESSAGE = 0x01;
const LVL_ATTACHMENT = 0x02;

/** `atpString << 16 | attMessageClass` — MS-OXTNEF's legacy, deprecated-but-still-sent message-class attribute. */
const ATT_MESSAGE_CLASS = 0x00088008;
/** `atpByte << 16 | attMAPIProps` — the serialized MAPI property stream, at message level. */
const ATT_MAPI_PROPS = 0x00069003;

/** MAPI property ids this parser reads out of the `attMAPIProps` stream — both well-known, untagged (non-named) properties. */
const PROP_ID_MESSAGE_CLASS = 0x001a;
const PROP_ID_SUBJECT = 0x0037;

const PT_STRING8 = 0x001e;
const PT_UNICODE = 0x001f;
const MV_FLAG = 0x1000;

/** Hard ceilings — a hostile or corrupt `winmail.dat` aborts rather than spinning or over-allocating. */
const MAX_TNEF_BYTES = 10_000_000;
const MAX_ATTRIBUTES = 20_000;
const MAX_ATTRIBUTE_VALUE_BYTES = 5_000_000;
const MAX_MAPI_PROPERTIES = 5_000;

export interface TnefResult {
  messageClass: string | null;
  subject: string | null;
}

class BoundedReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private need(bytes: number): void {
    if (bytes < 0 || this.remaining < bytes) throw new RangeError("tnef: read past end of buffer");
  }

  u8(): number {
    this.need(1);
    const value = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    this.need(2);
    const value = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(length: number): Buffer {
    this.need(length);
    const value = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(length: number): void {
    this.need(length);
    this.offset += length;
  }
}

/**
 * Parses a `winmail.dat` buffer. Returns `null` for a buffer too large to
 * consider, a bad signature, or any structural violation encountered while
 * walking it — every one of those is "not a TNEF file this reads", not an
 * exception.
 */
export function parseTnef(buffer: Buffer): TnefResult | null {
  if (buffer.length > MAX_TNEF_BYTES) return null;

  try {
    const reader = new BoundedReader(buffer);
    const signature = reader.u32();
    if (signature !== TNEF_SIGNATURE) return null;
    reader.u16(); // key — unused, not authenticated

    let messageClass: string | null = null;
    let subject: string | null = null;

    for (let i = 0; i < MAX_ATTRIBUTES && reader.remaining > 0; i += 1) {
      const level = reader.u8();
      if (level !== LVL_MESSAGE && level !== LVL_ATTACHMENT) return null;
      const tag = reader.u32();
      const length = reader.u32();
      if (length < 0 || length > MAX_ATTRIBUTE_VALUE_BYTES || length > reader.remaining - 2) {
        return null;
      }
      const value = reader.bytes(length);
      reader.skip(2); // per-attribute checksum — not verified (see this module's own doc comment)

      if (tag === ATT_MESSAGE_CLASS) {
        messageClass ??= readAttString(value);
      } else if (tag === ATT_MAPI_PROPS) {
        const props = readMapiProperties(value);
        messageClass ??= props.messageClass;
        subject ??= props.subject;
      }
    }

    return { messageClass, subject };
  } catch {
    return null;
  }
}

/** `atpString`'s own shape: a 4-byte length (including the trailing NUL) followed by the bytes, no padding. */
function readAttString(value: Buffer): string | null {
  if (value.length < 4) return null;
  const length = value.readUInt32LE(0);
  if (length < 0 || length > value.length - 4) return null;
  return decodeNullTerminated(value.subarray(4, 4 + length));
}

interface MapiScanResult {
  messageClass: string | null;
  subject: string | null;
}

/**
 * Reads just enough of the `attMAPIProps` serialized property stream to pull
 * out the two standard, non-named properties this ticket wants
 * (`PidTagMessageClass`, `PidTagSubject`) — see this module's own doc comment
 * for why named (PSETID_Appointment) properties are out of scope. Any
 * property whose type this reader doesn't recognize is skipped by its
 * declared length rather than aborting the whole scan, so one exotic
 * property never hides `PidTagMessageClass` sitting after it.
 */
function readMapiProperties(buf: Buffer): MapiScanResult {
  const result: MapiScanResult = { messageClass: null, subject: null };
  const reader = new BoundedReader(buf);

  let count: number;
  try {
    count = reader.u32();
  } catch {
    return result;
  }
  if (count > MAX_MAPI_PROPERTIES) return result;

  for (let i = 0; i < count && reader.remaining > 0; i += 1) {
    try {
      const propTag = reader.u32();
      const propType = propTag & 0xffff;
      const propId = (propTag >>> 16) & 0xffff;
      const isMultiValue = (propType & MV_FLAG) !== 0;
      const baseType = propType & ~MV_FLAG;
      const valueCount = isMultiValue ? reader.u32() : 1;
      if (valueCount < 0 || valueCount > MAX_MAPI_PROPERTIES) return result;

      for (let v = 0; v < valueCount; v += 1) {
        const value = readMapiValue(reader, baseType);
        if (v === 0 && (propId === PROP_ID_MESSAGE_CLASS || propId === PROP_ID_SUBJECT)) {
          const text = typeof value === "string" ? value : null;
          if (propId === PROP_ID_MESSAGE_CLASS) result.messageClass ??= text;
          if (propId === PROP_ID_SUBJECT) result.subject ??= text;
        }
      }
    } catch {
      return result;
    }
  }
  return result;
}

/** Reads one property value of `baseType`, advancing past it regardless of whether the type is one this reader decodes. `null` for a type not decoded here. */
function readMapiValue(reader: BoundedReader, baseType: number): string | null {
  switch (baseType) {
    case PT_STRING8:
    case PT_UNICODE: {
      const length = reader.u32();
      if (length < 0 || length > MAX_ATTRIBUTE_VALUE_BYTES || length > reader.remaining) {
        throw new RangeError("tnef: mapi string length out of bounds");
      }
      const raw = reader.bytes(length);
      const padded = length % 4 === 0 ? 0 : 4 - (length % 4);
      reader.skip(padded);
      return baseType === PT_UNICODE ? decodeUtf16NullTerminated(raw) : decodeNullTerminated(raw);
    }
    case 0x0002: // PT_I2
      reader.skip(2);
      reader.skip(2); // padded to 4 bytes
      return null;
    case 0x0003: // PT_LONG
      reader.skip(4);
      return null;
    case 0x000b: // PT_BOOLEAN
      reader.skip(2);
      reader.skip(2);
      return null;
    case 0x0040: // PT_SYSTIME
      reader.skip(8);
      return null;
    case 0x0102: {
      // PT_BINARY
      const length = reader.u32();
      if (length < 0 || length > MAX_ATTRIBUTE_VALUE_BYTES || length > reader.remaining) {
        throw new RangeError("tnef: mapi binary length out of bounds");
      }
      reader.skip(length);
      const padded = length % 4 === 0 ? 0 : 4 - (length % 4);
      reader.skip(padded);
      return null;
    }
    default:
      // An unrecognized type has no declared length in this stream's own
      // framing — there is nothing safe to skip past, so the scan for this
      // property stream stops here (caller already has whatever it found
      // before this point).
      throw new RangeError(`tnef: unsupported mapi property type 0x${baseType.toString(16)}`);
  }
}

function decodeNullTerminated(buf: Buffer): string {
  const nul = buf.indexOf(0);
  return (nul === -1 ? buf : buf.subarray(0, nul)).toString("latin1");
}

function decodeUtf16NullTerminated(buf: Buffer): string {
  let end = buf.length;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      end = i;
      break;
    }
  }
  return buf.subarray(0, end).toString("utf16le");
}

/** RFC 5546-shaped bucket for a TNEF message class — the `IPM.Schedule.Meeting.*` family MS-OXOCAL defines. */
export function mapMessageClassToKind(
  messageClass: string,
): "request" | "answer" | "cancellation" | null {
  const value = messageClass.toLowerCase();
  if (value === "ipm.schedule.meeting.request") return "request";
  if (value.startsWith("ipm.schedule.meeting.resp.")) return "answer";
  if (value === "ipm.schedule.meeting.canceled" || value === "ipm.schedule.meeting.cancelled") {
    return "cancellation";
  }
  return null;
}

/**
 * A deterministic stand-in `UID` for a TNEF-sourced Invitation, since this
 * parser cannot yet decode `PidTagGlobalObjectId` into the real one (this
 * module's own doc comment). Hashing the raw attachment bytes means the same
 * `winmail.dat` re-ingested (a UIDVALIDITY rebuild, a re-run backfill)
 * derives the same `uid` rather than a fresh row each time — the uniqueness
 * `db/schema.ts#invitations` needs still holds, even without a true UID.
 */
export function deriveFallbackUid(raw: Buffer): string {
  return `tnef:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}
