import { describe, expect, it } from "vitest";
import { chooseReplyMode, otherParticipantCount } from "./reply-mode.js";

describe("chooseReplyMode (#289)", () => {
  it("picks Reply All with more than one other participant", () => {
    const thread = {
      participants: [
        { name: "Me", address: "me@example.test" },
        { name: "Ada", address: "ada@example.test" },
        { name: "Bea", address: "bea@example.test" },
      ],
    };
    expect(otherParticipantCount(thread, "me@example.test")).toBe(2);
    expect(chooseReplyMode(thread, "me@example.test")).toBe("replyAll");
  });

  it("picks Reply with exactly one other participant", () => {
    const thread = {
      participants: [
        { name: "Me", address: "me@example.test" },
        { name: "Ada", address: "ada@example.test" },
      ],
    };
    expect(otherParticipantCount(thread, "me@example.test")).toBe(1);
    expect(chooseReplyMode(thread, "me@example.test")).toBe("reply");
  });

  it("compares case- and whitespace-insensitively, same as reply-all's own recipient filtering", () => {
    const thread = {
      participants: [
        { name: "Me", address: " Me@Example.test " },
        { name: "Ada", address: "ada@example.test" },
      ],
    };
    expect(otherParticipantCount(thread, "me@example.test")).toBe(1);
  });

  it('counts every participant as "other" when the owning Mail Account hasn\'t resolved yet', () => {
    const thread = {
      participants: [
        { name: "Ada", address: "ada@example.test" },
        { name: "Bea", address: "bea@example.test" },
      ],
    };
    expect(otherParticipantCount(thread, null)).toBe(2);
    expect(chooseReplyMode(thread, null)).toBe("replyAll");
  });
});
