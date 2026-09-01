import pdfMainUrl from "pdfjs-dist/build/pdf.min.mjs?url";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useMemo, useRef, useState } from "react";
import { generateNonce } from "./nonce.js";

/**
 * A pinned, scripting-disabled pdf.js instance rendering an attachment's
 * first page, in its own sandboxed iframe — never the browser's native PDF
 * viewer (`docs/research/0005` §7: pdf.js is Firefox's own viewer, past
 * [CVE-2024-4367](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq)
 * at the pinned version, with `isEvalSupported: false` set explicitly).
 *
 * The PDF's bytes are fetched *by the parent* (an authenticated same-origin
 * request, `api/messages.ts`) and handed in via `postMessage` with the
 * `ArrayBuffer` transferred, not copied — the sandboxed document itself
 * never makes a network request of its own (`connect-src`/`default-src` in
 * its CSP are both `'none'`). `worker-src`/`script-src` name the app's real
 * origin the same way the message body's `img-src` does: the frame's own
 * origin is opaque (no `allow-same-origin`), so `'self'` there would match
 * nothing.
 */
export function PdfAttachmentPreview({ src, filename }: { src: string; filename: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [size, setSize] = useState({ width: 240, height: 320 });
  const nonce = useMemo(() => generateNonce(), []);
  const doc = useMemo(
    () => buildPdfViewerDocument({ nonce, origin: window.location.origin }),
    [nonce],
  );

  useEffect(() => {
    let cancelled = false;
    let childReady = false;
    let pendingBytes: ArrayBuffer | null = null;
    let posted = false;

    function post() {
      if (posted || !pendingBytes || !childReady) return;
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow) return;
      posted = true;
      frameWindow.postMessage({ type: "render-pdf", bytes: pendingBytes }, "*", [pendingBytes]);
    }

    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; width?: unknown; height?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "pdf-ready") {
        childReady = true;
        post();
      } else if (data.type === "pdf-rendered") {
        if (cancelled) return;
        setStatus("ready");
        if (typeof data.width === "number" && typeof data.height === "number") {
          setSize({ width: data.width, height: data.height });
        }
      } else if (data.type === "pdf-error") {
        if (!cancelled) setStatus("error");
      }
    }

    const timeout = window.setTimeout(() => {
      if (!cancelled) setStatus((current) => (current === "loading" ? "error" : current));
    }, 10_000);

    window.addEventListener("message", onMessage);
    fetch(src, { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`http ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => {
        if (cancelled) return;
        pendingBytes = bytes;
        post();
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [src]);

  if (status === "error") {
    return (
      <a href={src} download={filename} className="attachment-pdf-fallback">
        Preview unavailable — download to view
      </a>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={`PDF preview: ${filename}`}
      sandbox="allow-scripts"
      srcDoc={doc}
      className="attachment-pdf-preview"
      style={{ width: size.width, height: size.height }}
    />
  );
}

/**
 * `script-src 'nonce-x' 'strict-dynamic'`: the entry module script carries
 * the nonce, and `strict-dynamic` is what lets *its own* static `import` of
 * pdf.js's main build execute without also needing pdf.js's URL listed as a
 * host-source — the standard nonce+`strict-dynamic` pairing CSP3 documents
 * for exactly this "a trusted script loads more scripts" shape.
 */
function buildPdfViewerDocument({ nonce, origin }: { nonce: string; origin: string }): string {
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `worker-src ${origin}`,
    "style-src 'unsafe-inline'",
  ].join("; ");

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;padding:0;background:#fff;}canvas{display:block;max-width:100%;}</style>
</head><body>
<canvas id="page"></canvas>
<script nonce="${nonce}" type="module">
import * as pdfjsLib from ${JSON.stringify(pdfMainUrl)};
pdfjsLib.GlobalWorkerOptions.workerSrc = ${JSON.stringify(pdfWorkerUrl)};
window.addEventListener("message", async (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== "render-pdf") return;
  try {
    const pdf = await pdfjsLib.getDocument({ data: data.bytes, isEvalSupported: false }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.getElementById("page");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    parent.postMessage({ type: "pdf-rendered", width: viewport.width, height: viewport.height }, "*");
  } catch (err) {
    parent.postMessage({ type: "pdf-error", message: String(err) }, "*");
  }
});
parent.postMessage({ type: "pdf-ready" }, "*");
</script>
</body></html>`;
}
