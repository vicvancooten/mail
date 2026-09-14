import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ActionsProvider } from "../mail/actions/ActionsProvider.js";
import { noopActionContext } from "../mail/actions/types.js";
import { Screener } from "../mail/screener/Screener.js";
import { deriveMailAccountScope, useAccountScope } from "../mail/useAccountScope.js";
import { useConnectedAccounts, useMailAccounts } from "../store/index.js";
import { screenerRoute } from "./routes.js";

/**
 * `/mail/screener`'s route component (`routes.tsx#screenerRoute`'s own doc
 * comment) — the same thin-glue shape `StreamRoute.tsx` gives Stream:
 * `onLeave` mirrors its `canGoBack()`/`history.back()` else `replace` to
 * `/mail`, and `Screener`'s existing `onClose` prop is exactly that.
 *
 * `MailSection` no longer mounts `<Screener>` at all — it's reached only by
 * navigating here (`onOpenScreener`, threaded from `MailRoute.tsx` through
 * `MailSection.tsx`'s own `ActionContext`, `GatekeeperBanner`'s `onOpen`,
 * and the Command Palette's `screener` command) — so unlike that component,
 * this one derives its own Account Scope directly
 * (`useAccountScope`/`deriveMailAccountScope`, `stream/StreamStack.tsx`'s
 * own precedent for a full-screen destination outside `MailSection`), and
 * builds its own `ActionContext` from `noopActionContext` so the row menu's
 * Approve/Deny/Block still works (`Screener.tsx`'s own `useActions()` /
 * `withScreenerSender`) — every other field goes unused here: the Screener
 * owns its own `j`/`k`/`a`/`d`/`b`/Escape keyboard scheme directly and never
 * calls `useActionKeyboard`, so the registry's global bindings stay fully
 * off while this route is showing, the same "the Screener is up with its
 * own modal scheme" posture `MailSection.tsx` used to express with a
 * `disabled` flag on its own listener.
 */
export function ScreenerRoute() {
  const navigate = screenerRoute.useNavigate();
  const search = screenerRoute.useSearch();
  const router = useRouter();
  const mailAccounts = useMailAccounts();
  const connectedAccounts = useConnectedAccounts();
  const { scope: connectedAccountScope, setScope: setConnectedAccountScope } =
    useAccountScope(connectedAccounts);
  const accountScope = deriveMailAccountScope(
    connectedAccounts,
    connectedAccountScope,
    mailAccounts ?? [],
  );

  // A cold-start Gatekeeper digest deep-link's own Mail Account
  // (`pwa/push-decisions.ts`'s `screener` target, `screenerRoute`'s own
  // `account` search param): widens a previously narrowed Account Scope on
  // a fresh mount, `MailSection.tsx`'s own `initialAccountId` handling for
  // `/mail` — simplified here, since a fresh mount of this route has no
  // reset-on-primary-change effect to race the way that one does; applying
  // the target at most once is the whole of it.
  const appliedAccountRef = useRef(false);
  useEffect(() => {
    if (appliedAccountRef.current) return;
    const target = search.account;
    if (!target || !mailAccounts) return;
    appliedAccountRef.current = true;
    if (accountScope.includes(target)) return;
    const connectedAccountId = mailAccounts.find(
      (account) => account.id === target,
    )?.connectedAccountId;
    if (connectedAccountId) setConnectedAccountScope([connectedAccountId]);
  }, [search.account, mailAccounts, accountScope, setConnectedAccountScope]);

  const onLeave = useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      void navigate({ to: "/mail", replace: true });
    }
  }, [navigate, router]);

  const actionContext = useMemo(
    () => noopActionContext({ onBackToList: onLeave, onOpenFolders: onLeave }),
    [onLeave],
  );

  if (accountScope.length === 0) return null;

  return (
    <ActionsProvider value={actionContext}>
      <Screener accountScope={accountScope} onClose={onLeave} />
    </ActionsProvider>
  );
}
