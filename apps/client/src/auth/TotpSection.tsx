import type { TotpEnrollResponse } from "@mail/shared";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError } from "../api/auth.js";
import { confirmTotp, disableTotp, enrollTotp, fetchTotpStatus } from "../api/totp.js";

type Status =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "enrolling"; enrollment: TotpEnrollResponse }
  | { kind: "enabled" };

/**
 * TOTP enroll → confirm → disable (#32), the minimal management surface the
 * ticket asks for — a full settings screen is the Preferences ticket.
 */
export function TotpSection() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTotpStatus()
      .then((result) => {
        if (!cancelled) setStatus({ kind: result.enabled ? "enabled" : "disabled" });
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load two-factor status.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleEnroll() {
    setError(null);
    setSubmitting(true);
    try {
      const enrollment = await enrollTotp();
      setStatus({ kind: "enrolling", enrollment });
    } catch {
      setError("Couldn't start enrollment.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirm(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await confirmTotp({ code });
      setStatus({ kind: "enabled" });
      setCode("");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_code"
          ? "That code didn't match — try the current one."
          : "Couldn't confirm enrollment.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisable(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await disableTotp({ code });
      setStatus({ kind: "disabled" });
      setCode("");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "invalid_code"
          ? "That code didn't match."
          : "Couldn't disable two-factor authentication.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h3>Authenticator app (TOTP)</h3>
      {error && <p role="alert">{error}</p>}

      {status.kind === "loading" && <p>Loading…</p>}

      {status.kind === "disabled" && (
        <button type="button" onClick={handleEnroll} disabled={submitting}>
          Enable two-factor authentication
        </button>
      )}

      {status.kind === "enrolling" && (
        <form onSubmit={handleConfirm}>
          <p>Scan or enter this key in your authenticator app, then confirm with a code:</p>
          <p>
            <code>{status.enrollment.secret}</code>
          </p>
          <p>
            <a href={status.enrollment.otpauthUrl}>{status.enrollment.otpauthUrl}</a>
          </p>
          <label htmlFor="totp-confirm-code">6-digit code</label>
          <input
            id="totp-confirm-code"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <button type="submit" disabled={submitting}>
            Confirm
          </button>
        </form>
      )}

      {status.kind === "enabled" && (
        <form onSubmit={handleDisable}>
          <p>Two-factor authentication is enabled.</p>
          <label htmlFor="totp-disable-code">Current code, to disable</label>
          <input
            id="totp-disable-code"
            inputMode="numeric"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <button type="submit" disabled={submitting}>
            Disable
          </button>
        </form>
      )}
    </section>
  );
}
