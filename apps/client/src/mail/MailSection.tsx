import { useMailAccounts } from "../store/index.js";
import { useLocalCacheSync } from "../sync/use-local-cache-sync.js";
import { ThreadList } from "./ThreadList.js";

/**
 * The minimal proof of the read path (#38): a raw Thread list rendered
 * straight out of the Local Cache, with the sync loop filling that cache
 * behind it. The real list — virtualization, time-grouping headers, Split /
 * List / Stream, the account switcher — is #40.
 *
 * Which Mail Account is shown is the first one by `createdAt` rather than a
 * remembered choice: last-active account and view are Device Preferences,
 * and those land with #54.
 */
export function MailSection() {
  useLocalCacheSync();
  const mailAccounts = useMailAccounts();

  if (!mailAccounts || mailAccounts.length === 0) return null;
  const [account] = mailAccounts;
  if (!account) return null;

  return (
    <section>
      <h2>Mail</h2>
      <p>{account.emailAddress}</p>
      <ThreadList mailAccountId={account.id} />
    </section>
  );
}
