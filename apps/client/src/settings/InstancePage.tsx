import type { InstanceInfoResponse } from "@mail/shared";
import { useEffect, useState } from "react";
import { fetchInstanceInfo, generateVapidKeys } from "../api/instance.js";

/**
 * The Owner-only Instance page (#104): "running version and image tag; Web
 * Push configured yes/no with the exact generate command; System Mailer
 * configured yes/no; secure-context check on PUBLIC_URL" — exactly those
 * four facts, first cut. Reached only via `SettingsLayout`'s nav, which
 * hides this page's entry from a Member entirely; `settingsInstanceRoute`
 * (`router/routes.tsx`) redirects one away who reaches the URL directly,
 * and `GET /instance/health` itself 403s them too (`routes/instance.ts`) —
 * three layers because "a Member gets no such nav entry" is the one
 * acceptance line that must never regress.
 *
 * Per-Mail-Account sync status deliberately stays off this page (the
 * ticket's own decision, "privacy") — it already lives on each User's own
 * Mail Accounts page.
 */
export function InstancePage() {
  const [info, setInfo] = useState<InstanceInfoResponse | null>(null);
  const [failed, setFailed] = useState(false);
  // The Web Push keypair's own generate action (ADR-0015 as amended) — the
  // one thing this page *does* rather than states, so it carries its own
  // in-flight/failed state rather than reloading the whole page's facts.
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(false);
  const [replacedKeypair, setReplacedKeypair] = useState(false);

  function onGenerateVapidKeys() {
    setGenerating(true);
    setGenerateError(false);
    void generateVapidKeys()
      .then((result) => {
        setReplacedKeypair(result.replaced);
        // Restate the fact from the same source the page loaded it from,
        // rather than patching `configured` locally and trusting that the
        // write landed the way the Client assumed.
        return fetchInstanceInfo().then(setInfo);
      })
      .catch(() => setGenerateError(true))
      .finally(() => setGenerating(false));
  }

  useEffect(() => {
    let cancelled = false;
    void fetchInstanceInfo()
      .then((result) => {
        if (!cancelled) setInfo(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-page">
      <h2>Instance</h2>
      <p>Facts about this self-hosted instance — visible to the Owner only.</p>

      {failed && <p role="alert">Couldn't load instance info.</p>}

      {info && (
        <section>
          <div className="instance-fact">
            <span className="instance-fact-label">Version</span>
            <span>{info.version}</span>
          </div>

          <div className="instance-fact">
            <span className="instance-fact-label">Image tag</span>
            <span>{info.imageTag}</span>
          </div>

          <div className="instance-fact">
            <span className="instance-fact-label">Web Push</span>
            <span>
              {info.webPush.configured ? (
                <>
                  Configured
                  {replacedKeypair && (
                    <> — with a new keypair, so every device has to enable notifications again.</>
                  )}
                </>
              ) : info.webPush.canGenerate ? (
                // The instance owns the keypair, so the fix is a press, not a
                // shell (ADR-0015 as amended). Reachable at all only on an
                // instance whose stored keypair can't be opened — an ordinary
                // one mints it at first boot and never shows this.
                <>
                  Not configured
                  <button
                    type="button"
                    className="instance-fact-action"
                    onClick={onGenerateVapidKeys}
                    disabled={generating}
                  >
                    {generating ? "Generating…" : "Generate keys"}
                  </button>
                  {generateError && (
                    <span role="alert"> Couldn't generate a keypair — check the server logs.</span>
                  )}
                </>
              ) : (
                // Env-pinned: a button here would write a keypair the
                // environment overrides on the next boot, so the command
                // stays the honest answer.
                <>
                  Not configured — generate keys with <code>{info.webPush.generateCommand}</code>
                </>
              )}
            </span>
          </div>

          <div className="instance-fact">
            <span className="instance-fact-label">System Mailer</span>
            <span>{info.systemMailer.configured ? "Configured" : "Not configured"}</span>
          </div>

          <div className="instance-fact">
            <span className="instance-fact-label">Public URL</span>
            <span>
              {info.publicUrl.value}
              {!info.publicUrl.isSecureContext && (
                <> — not a secure context: push and passkeys will not work from other devices.</>
              )}
            </span>
          </div>
        </section>
      )}
    </section>
  );
}
