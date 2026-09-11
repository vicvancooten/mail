import { useMemo, useState } from "react";
import { Button } from "../components/ui/button.js";
import { useContacts } from "../store/contacts.js";
import { useCorrespondentsAcrossAccounts } from "../store/reads.js";
import { PromoteCorrespondentDialog } from "./PromoteCorrespondentDialog.js";
import type { MailedPersonRow } from "./people-youve-mailed.js";
import { peopleYouveMailed } from "./people-youve-mailed.js";

/**
 * The "People you've mailed" tab (#218, `docs/contacts-spec.md`
 * §Correspondents, compose and the Gatekeeper): the one door from
 * Correspondents into Contacts, a tab on the Contacts App's one list rather
 * than a second screen (`ContactsGrid.tsx`'s own doc comment on the sibling
 * tab). Each row offers Save, opening `PromoteCorrespondentDialog`; a row
 * saved elsewhere (another tab, another device) leaves this list the instant
 * `useContacts()`'s live query re-runs — no local "just saved" bookkeeping.
 */
export function PeopleYouveMailedList({
  mailAccountIdsInScope,
}: {
  mailAccountIdsInScope: readonly string[];
}) {
  const correspondents = useCorrespondentsAcrossAccounts(mailAccountIdsInScope);
  const contacts = useContacts();
  const [promoting, setPromoting] = useState<MailedPersonRow | null>(null);

  const rows = useMemo(() => {
    if (!correspondents || !contacts) return undefined;
    return peopleYouveMailed(correspondents, contacts);
  }, [correspondents, contacts]);

  return (
    <>
      {rows === undefined ? null : rows.length === 0 ? (
        <p className="contacts-grid-empty">No one new to save yet.</p>
      ) : (
        <ul className="mailed-people-list">
          {rows.map((row) => (
            <li key={row.address} className="mailed-person-row">
              <div className="mailed-person-identity">
                <span className="mailed-person-name">{row.name ?? row.address}</span>
                {row.name ? <span className="mailed-person-address">{row.address}</span> : null}
              </div>
              <Button type="button" size="sm" onClick={() => setPromoting(row)}>
                Save
              </Button>
            </li>
          ))}
        </ul>
      )}
      {promoting ? (
        <PromoteCorrespondentDialog person={promoting} onClose={() => setPromoting(null)} />
      ) : null}
    </>
  );
}
