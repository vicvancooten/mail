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
