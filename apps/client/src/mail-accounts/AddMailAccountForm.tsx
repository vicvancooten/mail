import { useState } from "react";
import { ImapMailAccountForm } from "./ImapMailAccountForm.js";
import { ProviderSignInChoice } from "./ProviderSignInChoice.js";

/**
 * Add-a-Mail-Account (poc-spec.md §Mail Accounts): a separate, repeatable
 * step from creating the User, run from `MailAccountsSection`.
 *
 * Since #116 it opens on the Provider choice (`ProviderSignInChoice`);
 * **Other** is what leads here, into `ImapMailAccountForm` (#299 extracted
 * that flow into its own component so the "Other IMAP" row's own add
 * control can open straight into it, skipping this choice entirely). That
 * flow is deliberately unchanged: the autodiscover chain first, manual entry
 * as a first-class fallback step pre-filled with privateemail's defaults
 * when the domain's MX warrants it (docs/research/0004 §4), never an
 * apologetic dead end. Google and Microsoft never reach it at all — they
 * leave the app entirely and come back with the account already created.
 */
export function AddMailAccountForm({
  onAdded,
  isOwner = false,
}: {
  onAdded: () => void;
  /** Chooses the wording for an unregistered Provider (ADR-0021). Defaults to the Member's, the safe assumption. */
  isOwner?: boolean;
}) {
  const [showImap, setShowImap] = useState(false);

  if (showImap) {
    return <ImapMailAccountForm onAdded={onAdded} onBack={() => setShowImap(false)} />;
  }

  return <ProviderSignInChoice isOwner={isOwner} onChooseOther={() => setShowImap(true)} />;
}
