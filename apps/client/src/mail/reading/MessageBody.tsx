import type { Message } from "@mail/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { type CidBlob, findCidReferences, resolveCidBlobs, revokeCidBlobs } from "./cid.js";
import { type MailtoLink, parseMailtoHref } from "./mailto.js";
import { generateNonce } from "./nonce.js";
import { buildMessageDocument, hasProxiedImages } from "./sandbox-document.js";

/** Clamp posted heights to something sane — a hostile/misbehaving script inside the frame gets ignored, not trusted. */
const MIN_HEIGHT = 40;
const MAX_HEIGHT = 20_000;
const DEFAULT_HEIGHT = 120;

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/**
 * The reading pane's sandboxed message body (#41): re-sanitizes
 * (`sandbox-document.ts`) immediately before every `srcdoc` write, resolves
 * `cid:` references against fetched attachment bytes, sizes itself via
 * `ResizeObserver` + `postMessage`, and keeps remote images blocked until
 * the User opts in for this one message — unless the sender is an Approved
 * Sender, in which case they load straight away (#55, poc-scope.md: "the
 * Gatekeeper verdict *is* the image-loading permission"). The verdict
 * arrives per message on `remoteImagesAllowed`, resolved server-side on
 * every read (`routes/messages.ts`), so approving someone in the Screener
 * takes effect the next time their mail is opened.
 *
 * No sandbox token besides `allow-scripts` is ever granted — never
 * `allow-same-origin` together with it (that combination lets the framed
 * document remove its own sandbox), never `allow-forms`/`allow-popups`/
 * `allow-top-navigation`. The frame's origin stays opaque; the CSP nonce is
 * the only thing that can ever execute inside it.
 *
 * The caller must render this with `key={message.id}` (the same convention
 * `ThreadDetailPane` already uses for `key={thread.id}`): the "load images"
 * override and the measured height are this component's own local state,
 * and a fresh mount per Message is what resets both when the User moves to
 * a different one, rather than an effect keyed on `message.id` that lint
 * would (correctly) flag as depending on something its body never reads.
 *
 * The click bridge (ADR-0018, `sandbox-document.ts`'s `LINK_BRIDGE_SCRIPT`)
 * is the only way a link inside the sandboxed frame ever does anything: the
 * frame posts `{type:"mail-link-click",href}`, and this component decides —
 * `http(s)` opens a new tab with `noopener` (never `noreferrer`'s cousin
 * `opener`, matching the sanitizer's own `rel` at ingest), `mailto:` opens
 * the Composer prefilled (`onMailtoLink`), anything else is ignored. Never
 * `allow-popups`: handing the click to the browser would lose this seam
 * entirely (ADR-0018's considered-and-rejected options).
 *
 * `interactive` (#102, default `true`) is the ordinary reading pane's mode.
 * The Screener's View dialog passes `false` for a stranger's held mail the
 * User hasn't decided about yet: remote images stay blocked with no "Load
 * remote images" opt-in (there is no Verdict yet to have loaded them for),
 * and the click bridge is never wired at all, so a link does nothing rather
 * than opening — the sandbox's own default (ADR-0018), deliberately left in
 * place rather than crossed. The parent's own `mail-link-click` handler
 * checks it too, belt-and-braces: nothing sender-authored can ever reach it
 * with the bridge script absent (CSP strips anything unnonced), but the
 * check keeps the contract airtight rather than resting on that alone.
 */
export function MessageBody({
  message,
  onMailtoLink,
  interactive = true,
}: {
  message: Message;
  onMailtoLink?: (link: MailtoLink) => void;
  interactive?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [cidBlobs, setCidBlobs] = useState<CidBlob[]>([]);
  // Seeded from the sender's Verdict, then the User's own per-message
  // override on top. A fresh mount per Message (see `key={message.id}`
  // above) is what re-reads the seed when they move to another one.
  // Non-interactive never seeds true — see the doc comment above.
  const [imagesLoaded, setImagesLoaded] = useState(interactive && message.remoteImagesAllowed);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const darkMode = usePrefersDark();

  const bodyHtml = message.bodyHtml ?? "";

  useEffect(() => {
    let cancelled = false;
    const contentIds = findCidReferences(bodyHtml);
    if (contentIds.length === 0) {
      setCidBlobs((prev) => {
        revokeCidBlobs(prev);
        return [];
      });
      return;
    }
    resolveCidBlobs(message.id, contentIds, message.attachments).then((blobs) => {
      if (cancelled) {
        revokeCidBlobs(blobs);
        return;
      }
      setCidBlobs((prev) => {
        revokeCidBlobs(prev);
        return blobs;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [message.id, bodyHtml, message.attachments]);

  // Blob URLs are only ever read while this component is mounted; release them on unmount too.
  useEffect(() => () => revokeCidBlobs(cidBlobs), [cidBlobs]);

  const srcDoc = useMemo(() => {
    return buildMessageDocument({
      html: bodyHtml,
      cidBlobUrls: new Map(cidBlobs.map((blob) => [blob.contentId, blob.blobUrl])),
      imagesLoaded,
      darkMode,
      nonce: generateNonce(),
      origin: window.location.origin,
      linkBridge: interactive,
    });
  }, [bodyHtml, cidBlobs, imagesLoaded, darkMode, interactive]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as unknown;
      if (!data || typeof data !== "object") return;
      const type = (data as { type?: unknown }).type;

      if (
        type === "mail-body-resize" &&
        typeof (data as { height?: unknown }).height === "number" &&
        Number.isFinite((data as { height: number }).height)
      ) {
        const next = (data as { height: number }).height;
        setHeight(Math.min(Math.max(next, MIN_HEIGHT), MAX_HEIGHT));
        return;
      }

      if (
        interactive &&
        type === "mail-link-click" &&
        typeof (data as { href?: unknown }).href === "string"
      ) {
        const href = (data as { href: string }).href;
        const mailto = parseMailtoHref(href);
        if (mailto) {
          onMailtoLink?.(mailto);
          return;
        }
        if (/^https?:\/\//i.test(href)) {
          window.open(href, "_blank", "noopener");
        }
        // Anything else (relative paths, `tel:`, `javascript:` — the last
        // already stripped by both sanitize passes but never trusted on
        // that alone) is ignored: the click bridge only ever knows how to
        // open two kinds of link.
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onMailtoLink, interactive]);

  const showLoadImages = interactive && !imagesLoaded && hasProxiedImages(bodyHtml);
  const frameClassName = message.bodyIsPlainText
    ? "message-body-frame message-body-frame-plain"
    : "message-body-frame";

  return (
    <div className="message-body">
      {showLoadImages ? (
        <button
          type="button"
          className="message-body-load-images"
          onClick={() => setImagesLoaded(true)}
        >
          Load remote images
        </button>
      ) : null}
      <iframe
        ref={iframeRef}
        title={`Message body from ${message.from?.name ?? message.from?.address ?? "unknown sender"}`}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        // The Width decision (#98, grill Q10): HTML mail fills the pane —
        // the sender's own document decides its width, same as it would in
        // any other mail client — while a plain-text message (no native
        // HTML alternative, `plainTextToHtml` at ingest) reads as a
        // centered column instead, matching the Snippet and reading header.
        className={frameClassName}
        style={{ height }}
      />
    </div>
  );
}
