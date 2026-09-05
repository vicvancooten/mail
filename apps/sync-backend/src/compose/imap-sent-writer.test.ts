import type { Db } from "../db/client.js";
import type { CompositionRow } from "../db/schema.js";
import type { MailAccountRow } from "../mail-accounts/store.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const append = vi.fn();
const release = vi.fn();
const getMailboxLock = vi.fn(async () => ({ release }));
const findFolderByRole = vi.fn();
const expungeDraftCopy = vi.fn(async () => undefined);
const deleteBlobsForComposition = vi.fn(async () => undefined);

vi.mock("../sync/imap-connection.js", () => ({
  withMailAccountConnection: vi.fn(async (_db, _account, _options, body) =>
    body({
      getMailboxLock,
      append,
    }),
  ),
}));

vi.mock("../sync/folders.js", () => ({
  findFolderByRole,
}));

vi.mock("../sync/draft-push.js", () => ({
  expungeDraftCopy,
}));

vi.mock("./blob-store.js", () => ({
  deleteBlobsForComposition,
}));

const { imapSentWriter } = await import("./send-sweeper.js");

describe("imapSentWriter", () => {
  beforeEach(() => {
    append.mockReset();
    release.mockReset();
    getMailboxLock.mockClear();
    findFolderByRole.mockReset();
    expungeDraftCopy.mockClear();
    deleteBlobsForComposition.mockClear();
    findFolderByRole.mockResolvedValue({ path: "Sent" });
  });

  it("APPENDs to Sent on a generic account, then expunges the draft copy and drops blobs", async () => {
    const writer = imapSentWriter({} as Db, Buffer.alloc(32));
    const mime = Buffer.from("mime");

    await writer({
      account: { id: "acct-1", serverKind: "generic" } as MailAccountRow,
      row: { id: "comp-1" } as CompositionRow,
      mime,
    });

    expect(findFolderByRole).toHaveBeenCalledWith(expect.anything(), "acct-1", "sent");
    expect(getMailboxLock).toHaveBeenCalledWith("Sent");
    expect(append).toHaveBeenCalledWith("Sent", mime, ["\\Seen"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(expungeDraftCopy).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      id: "comp-1",
    });
    expect(deleteBlobsForComposition).toHaveBeenCalledWith(expect.anything(), "comp-1");
  });

  it("skips the Sent APPEND on a Gmail account, but still expunges the draft copy and drops blobs", async () => {
    const writer = imapSentWriter({} as Db, Buffer.alloc(32));

    await writer({
      account: { id: "acct-1", serverKind: "gmail" } as MailAccountRow,
      row: { id: "comp-1" } as CompositionRow,
      mime: Buffer.from("mime"),
    });

    expect(findFolderByRole).not.toHaveBeenCalled();
    expect(getMailboxLock).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(expungeDraftCopy).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      id: "comp-1",
    });
    expect(deleteBlobsForComposition).toHaveBeenCalledWith(expect.anything(), "comp-1");
  });
});
