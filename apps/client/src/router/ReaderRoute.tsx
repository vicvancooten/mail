import type { MailAccount, Message } from "@mail/shared";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { buildReplyContent, type ReplyMode } from "../compose/reply.js";
import { type AddToTasksResult, AddToTasksSheet } from "../mail/AddToTasksSheet.js";
import { ActionsProvider, useActionKeyboard } from "../mail/actions/ActionsProvider.js";
import { currentReaderHandle } from "../mail/actions/surface-handles.js";
import { type ActionContext, noopActionContext } from "../mail/actions/types.js";
import { ShortcutSheet } from "../mail/command-palette/ShortcutSheet.js";
import type { MailtoLink } from "../mail/reading/mailto.js";
import { useThreadMessages } from "../mail/reading/useThreadMessages.js";
import { ThreadDetailPane } from "../mail/ThreadDetailPane.js";
import { threadLinkSnapshot } from "../mail/thread-link-snapshot.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import { useTriage } from "../mail/useTriage.js";
import {
  type CachedThread,
  createNoteFromThreadLink,
  createTaskFromThreadLink,
  deleteNote,
  deleteTask,
  EMPTY_COMPOSE_CONTENT,
  enqueueMutation,
  newCompositionId,
  saveComposition,
  useLabels,
  useMailAccounts,
  useTaskLists,
  useThread,
} from "../store/index.js";
import { mailReaderRoute } from "./routes.js";

const Composer = lazy(() =>
  import("../compose/Composer.js").then((m) => ({ default: m.Composer })),
);

/**
 * The standalone Reader (#292): `/mail/reader/$threadId`'s own route
 * component, opened by "Open in new window" (`mail/reader-window.ts`) in a
 * fresh browser window — no Hub, no list, just this one Thread
 * (`router/RootLayout.tsx`'s own bare-chrome carve-out for this path). Every
 * other host of `ThreadDetailPane` (`SplitView`, `ListView`, `StreamStack`)
 * wires its own compose/notes/tasks handlers rather than sharing one — this
 * follows the same posture: a fresh window is its own little world, with no
 * folder to triage into and nothing else mounted to hand work off to, so
 * "Add to Notes"/"Add to Tasks"/a Task chip/reply are all wired for real
 * right here, straight off this same route's own `useNavigate` where they
 * land somewhere (a Note, a Task) rather than a stub that would leave the
 * button silently doing nothing.
 *
 * `useTriage` is given a one-Thread window (`threads: [thread]`), the same
 * "no list mounted to ask" shape `useTriage.ts`'s own `flatNeighbor` already
 * falls back to for Stream — Auto-advance has nowhere to land here either
 * (`autoAdvanceEnabled: false`), so Done/Trash/Snooze act and the window
 * simply keeps showing the Thread they acted on, same as a Thread already
 * out of the current folder view still rendering unchanged in a reader pane
 * elsewhere in this app.
 *
 * No `onBack` handed to `ThreadDetailPane`: there is no list this window
 * could return to, so it renders no Back pill (its own doc comment: "onBack
 * is present only for hosts that have a list to return to"). `u`/Escape's
 * own registry entry still needs *some* answer, so `onBackToList` here
 * closes the window instead — the closest thing this Reader has to "done
 * looking at this."
 */
export function ReaderRoute() {
  const { threadId } = mailReaderRoute.useParams();
  const navigate = mailReaderRoute.useNavigate();
  const thread = useThread(threadId);
  const mailAccounts = useMailAccounts();
  const labels = useLabels() ?? [];

  const threads = useMemo(() => (thread ? [thread] : []), [thread]);
  const ids = useMemo(() => (thread ? [thread.id] : []), [thread]);
  const triage = useTriage({
    mailAccountId: thread?.mailAccountId ?? null,
    threads,
    ids,
    selectedThreadId: thread?.id ?? null,
    onSelect: () => {},
    direction: "older",
    autoAdvanceEnabled: false,
  });

  const { messages } = useThreadMessages(thread?.id ?? "");

  const [composeId, setComposeId] = useState<string | null>(null);
  const [composeFromChoices, setComposeFromChoices] = useState<MailAccount[] | null>(null);
  const closeCompose = useCallback(() => setComposeId(null), []);

  // Reply/reply-all/forward (#47, same account-resolution rule
  // `MailSection.tsx#openReply` and `StreamStack.tsx#openReply` already
  // give: always the arriving Message's own account, never a choice).
  const openReply = useCallback(
    (message: Message, mode: ReplyMode) => {
      if (composeId !== null || !mailAccounts) return;
      const account = mailAccounts.find((candidate) => candidate.id === message.mailAccountId);
      if (!account) return;
      const id = newCompositionId();
      setComposeFromChoices(null);
      void saveComposition(id, account.id, buildReplyContent(mode, message, account), {
        force: true,
      }).then(() => setComposeId(id));
    },
    [composeId, mailAccounts],
  );

  // A `mailto:` link clicked inside a Message body (ADR-0018) — this
  // window's own Thread names the sending account, the same "no Account
  // Scope to widen" reasoning that makes `openReply` above need no picker
  // either.
  const openMailtoLink = useCallback(
    (link: MailtoLink) => {
      if (composeId !== null || !mailAccounts || !thread?.mailAccountId) return;
      setComposeFromChoices(null);
      const id = newCompositionId();
      void saveComposition(
        id,
        thread.mailAccountId,
        { ...EMPTY_COMPOSE_CONTENT, to: link.to, subject: link.subject ?? "" },
        { force: true },
      ).then(() => setComposeId(id));
    },
    [composeId, mailAccounts, thread?.mailAccountId],
  );

  // "Add to Notes" (#195) — lands in this same window, `MailRoute.tsx#onNoteCreated`'s
  // own navigation (there is nothing else here for it to hand off to).
  const onAddToNotes = useCallback(
    (target: CachedThread) => {
      const subject = target.subject || "(no subject)";
      const participants =
        target.participants.map((p) => p.name ?? p.address).join(", ") || "(no sender)";
      const date = target.lastMessageAt ?? new Date().toISOString();
      void (async () => {
        const noteId = await createNoteFromThreadLink({
          threadId: target.id,
          subject,
          participants,
          date,
        });
        announceUndoableAction("addToNotes", () => void deleteNote(noteId));
        void navigate({ to: "/notes/$noteId", params: { noteId } });
      })();
    },
    [navigate],
  );

  // "Add to Tasks" (#258) — same sheet, same shape, as `MailSection.tsx`/
  // `StreamStack.tsx`.
  const [addToTasksThread, setAddToTasksThread] = useState<CachedThread | null>(null);
  const taskLists = useTaskLists();
  const defaultTaskListId = (taskLists ?? []).find((list) => list.isDefault)?.id ?? null;
  const onOpenAddToTasksSheet = useCallback((target: CachedThread) => {
    setAddToTasksThread(target);
  }, []);
  const onAddToTasksConfirm = useCallback(
    (result: AddToTasksResult) => {
      const target = addToTasksThread;
      if (!target) return;
      void (async () => {
        const taskId = await createTaskFromThreadLink(
          result.taskListId,
          result.title,
          threadLinkSnapshot(target),
          result.dueDate,
        );
        announceUndoableAction("addToTask", () => void deleteTask(taskId));
      })();
    },
    [addToTasksThread],
  );

  // "Add and mark Done" (#258) — the Task and archiving the Thread as one
  // action under one toast, same combined-Undo shape `MailSection.tsx`'s own
  // handler already gives it.
  const onAddToTasksConfirmAndDone = useCallback(
    (result: AddToTasksResult) => {
      const target = addToTasksThread;
      if (!target?.mailAccountId) return;
      const accountId = target.mailAccountId;
      void (async () => {
        const taskId = await createTaskFromThreadLink(
          result.taskListId,
          result.title,
          threadLinkSnapshot(target),
          result.dueDate,
        );
        void enqueueMutation({ type: "archive", threadId: target.id }, accountId);
        announceUndoableAction("addToTaskAndDone", () => {
          void deleteTask(taskId);
          void enqueueMutation({ type: "restoreToInbox", threadId: target.id }, accountId);
        });
      })();
    },
    [addToTasksThread],
  );

  // A Task chip's title (#259) — same navigation `MailRoute.tsx`/`StreamRoute.tsx`
  // already give it.
  const onOpenTask = useCallback(
    (taskId: string) => {
      void navigate({ to: "/tasks/$taskId", params: { taskId } });
    },
    [navigate],
  );

  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);

  const actionContext = useMemo<ActionContext>(
    () =>
      noopActionContext({
        thread: thread ?? null,
        triage,
        latestMessage: messages?.at(-1) ?? null,
        labels,
        onReply: openReply,
        // "Back to list" has no list here — closing the window is the one
        // honest answer `u`/Escape's own registry entry can get.
        onBackToList: () => window.close(),
        onOpenShortcutSheet: () => setShortcutSheetOpen(true),
        onAddToNotes,
        onAddToTasks: onOpenAddToTasksSheet,
        threadCount: thread ? 1 : 0,
        openPicker: thread ? (which) => currentReaderHandle()?.openPicker(which) : null,
      }),
    [thread, triage, messages, labels, openReply, onAddToNotes, onOpenAddToTasksSheet],
  );

  useActionKeyboard(
    actionContext,
    composeId !== null || shortcutSheetOpen || addToTasksThread !== null,
  );

  if (thread === undefined) return null; // still loading (`useThread`'s own doc comment)

  return (
    <ActionsProvider value={actionContext}>
      <div className="reader-standalone">
        {thread ? (
          <ThreadDetailPane
            key={thread.id}
            thread={thread}
            triage={triage}
            onReply={openReply}
            onMailtoLink={openMailtoLink}
            onOpenTask={onOpenTask}
          />
        ) : (
          // Deleted, or never synced to this device — nothing this window
          // can do but say so; there is no list to fall back to.
          <div className="reader-standalone-empty">
            <p>This Thread isn&apos;t available.</p>
          </div>
        )}
      </div>
      <ShortcutSheet open={shortcutSheetOpen} onClose={() => setShortcutSheetOpen(false)} />
      <AddToTasksSheet
        open={addToTasksThread !== null}
        thread={addToTasksThread}
        defaultTaskListId={defaultTaskListId}
        onOpenChange={(open) => {
          if (!open) setAddToTasksThread(null);
        }}
        onAdd={onAddToTasksConfirm}
        onAddAndMarkDone={onAddToTasksConfirmAndDone}
      />
      {composeId && thread?.mailAccountId && mailAccounts && (
        <Suspense fallback={null}>
          <Composer
            key={composeId}
            compositionId={composeId}
            mailAccounts={mailAccounts}
            defaultMailAccountId={thread.mailAccountId}
            fromChoices={composeFromChoices}
            onClose={closeCompose}
          />
        </Suspense>
      )}
    </ActionsProvider>
  );
}
