import type { Correspondent, Recipient } from "@mail/shared";
import { normalizeCorrespondentAddress } from "@mail/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchCorrespondents } from "../api/correspondents.js";
import { useCorrespondents } from "../store/index.js";
import {
  correspondentLabel,
  isSyntacticallyValidAddress,
  matchCorrespondents,
  parseRecipients,
  recipientLabel,
} from "./recipients.js";

/** compose-spec's own floor for the backend leg — below it, nothing is worth a round trip. */
const BACKEND_QUERY_MIN_LENGTH = 2;
/** Debounced so an ordinary typing burst fires one request, not one per keystroke. */
const BACKEND_QUERY_DEBOUNCE_MS = 200;
const MAX_SUGGESTIONS = 6;

/**
 * A `To`/`Cc`/`Bcc` chip field (compose-spec §Recipients), with recipient
 * autocomplete (#49): typing a separator (comma, semicolon, Enter) or
 * pasting a block of addresses both go through the same `parseRecipients`
 * split — a paste is just several separators arriving at once. Address
 * validation is syntactic only, flagging a chip that does not look like an
 * address rather than refusing it — compose-spec's blocking rule ("no
 * syntactically valid recipient") is send-time's to enforce, not this
 * field's.
 *
 * Suggestions come from two sources, queried in parallel per compose-spec:
 * the Mail Account's synced top ~500 Correspondents (`useCorrespondents`,
 * instant — the whole point of syncing them locally) and, once the query is
 * long enough to be worth a round trip, the Sync Backend's full history
 * (`searchCorrespondents`) for the long tail the local top ~500 misses.
 * Local matches always sort first: they are what the <50ms budget is about,
 * and a backend result arriving later must never displace them.
 */
export function RecipientField({
  label,
  mailAccountId,
  recipients,
  onChange,
}: {
  label: string;
  mailAccountId: string | null;
  recipients: Recipient[];
  onChange: (next: Recipient[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [remoteMatches, setRemoteMatches] = useState<Correspondent[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const correspondents = useCorrespondents(mailAccountId);

  const excludeAddresses = useMemo(
    () => new Set(recipients.map((recipient) => normalizeCorrespondentAddress(recipient.address))),
    [recipients],
  );

  const localMatches = useMemo(
    () => matchCorrespondents(correspondents ?? [], draft, { exclude: excludeAddresses }),
    [correspondents, draft, excludeAddresses],
  );

  const suggestions = useMemo(() => {
    const seen = new Set(localMatches.map((match) => normalizeCorrespondentAddress(match.address)));
    const extra = remoteMatches.filter(
      (match) => !seen.has(normalizeCorrespondentAddress(match.address)),
    );
    return [...localMatches, ...extra].slice(0, MAX_SUGGESTIONS);
  }, [localMatches, remoteMatches]);

  // The backend leg (compose-spec: "queries the backend in parallel for the
  // long tail"). Debounced, and cancelled on every fresh keystroke — an
  // in-flight response for a superseded draft is simply discarded, never
  // applied to what the User has since typed.
  useEffect(() => {
    const query = draft.trim();
    if (mailAccountId === null || query.length < BACKEND_QUERY_MIN_LENGTH) {
      setRemoteMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchCorrespondents(mailAccountId, query)
        .then((matches) => {
          if (!cancelled) setRemoteMatches(matches);
        })
        .catch(() => {
          // The local top ~500 already rendered — a failed long-tail query
          // degrades to "no extra suggestions", never an error the User has
          // to dismiss mid-compose.
          if (!cancelled) setRemoteMatches([]);
        });
    }, BACKEND_QUERY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mailAccountId, draft]);

  function commitDraft() {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    onChange([...recipients, ...parseRecipients(trimmed)]);
    setDraft("");
    setSuggestionsOpen(false);
  }

  function selectSuggestion(correspondent: Correspondent) {
    onChange([...recipients, { name: correspondent.name, address: correspondent.address }]);
    setDraft("");
    setSuggestionsOpen(false);
    inputRef.current?.focus();
  }

  function removeAt(index: number) {
    onChange(recipients.filter((_, i) => i !== index));
  }

  const showSuggestions = suggestionsOpen && suggestions.length > 0;

  return (
    <div className="recipient-field">
      <span className="recipient-field-label" id={`recipient-${label}`}>
        {label}
      </span>
      <ul className="recipient-chips" aria-labelledby={`recipient-${label}`}>
        {recipients.map((recipient, index) => (
          // The address, not the index: two chips can genuinely share one
          // (a not-yet-corrected typo re-added), and only the address
          // survives a reorder — the list itself is append/remove-only, so
          // this never needs to disambiguate a true duplicate pair.
          <li
            key={recipient.address}
            className={`recipient-chip${isSyntacticallyValidAddress(recipient.address) ? "" : " invalid"}`}
          >
            {recipientLabel(recipient)}
            <button
              type="button"
              aria-label={`Remove ${recipientLabel(recipient)}`}
              onClick={() => removeAt(index)}
            >
              ×
            </button>
          </li>
        ))}
        <li className="recipient-input">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={showSuggestions}
            aria-controls={`recipient-suggestions-${label}`}
            aria-autocomplete="list"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSuggestionsOpen(true);
              // A fresh keystroke re-filters the list; whatever was
              // highlighted before may no longer exist, so re-anchor to the
              // top match.
              setHighlighted(0);
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              if (/[,;\n]/.test(text)) {
                event.preventDefault();
                onChange([...recipients, ...parseRecipients(text)]);
              }
            }}
            onKeyDown={(event) => {
              if (showSuggestions && event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted((index) => (index + 1) % suggestions.length);
                return;
              }
              if (showSuggestions && event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted((index) => (index - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (showSuggestions && event.key === "Escape") {
                event.preventDefault();
                setSuggestionsOpen(false);
                return;
              }
              if (event.key === "Enter" || event.key === "," || event.key === ";") {
                event.preventDefault();
                const highlightedSuggestion = suggestions[highlighted];
                if (showSuggestions && event.key === "Enter" && highlightedSuggestion) {
                  selectSuggestion(highlightedSuggestion);
                } else {
                  commitDraft();
                }
                return;
              }
              if (event.key === "Backspace" && draft.length === 0 && recipients.length > 0) {
                removeAt(recipients.length - 1);
              }
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onBlur={() => {
              // Deferred so a suggestion's own `onClick` still fires — a
              // plain blur would close the list before the click lands.
              setTimeout(() => setSuggestionsOpen(false), 100);
              commitDraft();
            }}
            aria-label={`${label} recipients`}
          />
          {showSuggestions && (
            <div
              id={`recipient-suggestions-${label}`}
              className="recipient-suggestions"
              role="listbox"
            >
              {suggestions.map((correspondent, index) => (
                <button
                  key={correspondent.id}
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  className={index === highlighted ? "highlighted" : undefined}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => selectSuggestion(correspondent)}
                >
                  {correspondentLabel(correspondent)}
                </button>
              ))}
            </div>
          )}
        </li>
      </ul>
    </div>
  );
}
