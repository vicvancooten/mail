/**
 * The Client's one phone breakpoint (#273). Before this ticket the app
 * carried two: a 700px JS/CSS mount split deciding the Mail list/Reader
 * split-vs-stacked shape and the Settings rail-vs-full-width shape
 * (`apps/client/src/hooks/use-phone-width.ts`), and a second, unrelated
 * 768px shadcn-derived breakpoint deciding only the Hub's phone chrome
 * (header vs bottom bar, `apps/client/src/hooks/use-mobile.ts`, since
 * deleted). A window between the two — 701-768px — got phone chrome
 * wrapped around a still-desktop Mail layout. #270 kept the phone-chrome
 * value: 768px is the one number every phone-detecting hook and CSS media
 * query in the Client now reads, from here.
 */
export const phoneBreakpoint = 768;

/**
 * The split minimum (#296): the one width below which Split view falls back
 * to list-then-Reader (the same single-pane shape List view already renders,
 * `apps/client/src/mail/ListView.tsx`) rather than showing both panes
 * squeezed past readability. Derived, not picked: `mail.css`'s own
 * `.split-list` floor (`splitListMinimumWidth`, 280px — the narrowest the
 * comp's row form still renders at) plus a Reader narrow enough to still
 * read comfortably but not so cramped prose folds badly
 * (`splitReaderReadableWidth`, 640px) — together the ~920px below which
 * neither pane has room to be itself.
 *
 * Used by both layers, never duplicated: `apps/client/src/hooks/
 * use-split-minimum-width.ts`'s `useIsBelowSplitMinimum` reads it for the
 * Mail App's own render seam (`mail/MailSection.tsx`), and `css.ts` declares
 * it as `--split-minimum` for CSS authors — same "can't feed a custom
 * property to a media query, so it's documentation, not a live value" stance
 * `phoneBreakpoint` above already takes; no media query in the Client
 * currently needs this number, since the fallback is a component swap, not a
 * layout change within Split's own CSS.
 *
 * The phone breakpoint above is unchanged and unrelated: it decides Split's
 * own list-or-pane phone shape (`mail.css`'s `≤767px` rule) once Split is
 * already showing; this token decides whether Split renders at all.
 */
export const splitListMinimumWidth = 280;
export const splitReaderReadableWidth = 640;
export const splitMinimum = splitListMinimumWidth + splitReaderReadableWidth;
