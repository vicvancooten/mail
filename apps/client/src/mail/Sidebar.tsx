import type { GmailLabel, Label } from "@mail/shared";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  Clock,
  FolderOpen,
  Inbox,
  Layers,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  Reply,
  ShieldCheck,
  Tag,
  Trash2,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "../components/ui/sidebar.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { useSidebarCollapsed } from "./device-preferences.js";
import { FOLDER_LABELS, FOLDER_ORDER, type FolderKey } from "./folders.js";

/**
 * The mail folder rail (#74, rebuilt against the comp in #86; onto shadcn's
 * `Sidebar` in #93): a Compose pill, then the fixed folder destinations in
 * `folders.ts#FOLDER_ORDER`, then the Mail Account's Labels — an
 * independently scrolling bounded pane (`mail.css`'s own `.side-nav` rule),
 * not the thread list's own scroll container.
 *
 * The comp's rail (`.side-nav` in
 * `docs/design/prototypes/the-instrument.html`) is a run of transparent
 * rounded rows on the page ground: no compartment head, no rules between
 * entries, no inverted selection — the current entry is an `--accent-soft`
 * tint with accent ink, and everything else is quiet until hovered. Each
 * entry leads with a stroke icon, because a rail of bare words gives the eye
 * nothing to aim at.
 *
 * Counts are a call to action, never decoration (the ticket's own
 * acceptance criterion): only the Screener's held count and Drafts' unsent
 * count ever render one, and only once there's something to act on — a
 * `0` renders no badge at all.
 *
 * The Stream entry (#105, CONTEXT.md): started life in #96 as an interim
 * Split/List toggle standing in for `mail/TopBar.tsx`'s old one; now a plain
 * navigation to Stream's own full-screen route (`router/routes.tsx#streamRoute`)
 * — entered deliberately, never switched into — so it deliberately isn't
 * styled as a permanent rail entry (no icon in `FOLDER_ICONS`, no count),
 * just a plain button beside Compose.
 *
 * Collapses to an icon-only rail on desktop (#93's own acceptance box; #99's
 * "This device" page toggle is the other place that flips it) —
 * `SidebarMenuButton`'s own `tooltip` prop names each entry while
 * collapsed, since the label itself is hidden. Collapse state is a Device
 * Preference (`device-preferences.ts#useSidebarCollapsed`), reactive across
 * every mounted rail — and `settings/ThisDeviceSection.tsx`'s own control —
 * the instant either writes, like Appearance (`theme/device-theme.ts`).
 *
 * On phone this isn't a permanent rail at all: it's a `Sheet` bottom sheet
 * (#93), opened from its own trigger — the header's hub mark stays the App
 * Switcher at every width, as the comp has it; this sheet is Mail's own
 * folder navigation, a different question.
 */

const FOLDER_ICONS: Record<FolderKey, LucideIcon> = {
  inbox: Inbox,
  screener: ShieldCheck,
  snoozed: Clock,
  pinned: Pin,
  drafts: Pencil,
  sent: Reply,
  archive: Archive,
  trash: Trash2,
};

interface SidebarProps {
  folder: FolderKey;
  onSelectFolder: (folder: FolderKey) => void;
  labels: Label[];
  labelFilter: string | null;
  onSelectLabel: (labelId: string) => void;
  /** A Gmail Mail Account's own Labels (#126, ADR-0020) — empty for every other account, which is what makes the section below hide itself the same way the Labels one already does. */
  gmailLabels: GmailLabel[];
  gmailLabelFilter: string | null;
  onSelectGmailLabel: (labelId: string) => void;
  onCompose: () => void;
  screenerCount: number;
  draftsCount: number;
  /** Stream's own entry point (#105) — a plain navigation, run through the Action registry's `open-stream` (`MailSection.tsx`'s own `onOpenStream`). */
  onOpenStream: () => void;
}

function RailContents({
  folder,
  onSelectFolder,
  labels,
  labelFilter,
  onSelectLabel,
  gmailLabels,
  gmailLabelFilter,
  onSelectGmailLabel,
  onCompose,
  screenerCount,
  draftsCount,
  onOpenStream,
  collapsed,
}: SidebarProps & { collapsed: boolean }) {
  return (
    <>
      <button
        type="button"
        className="compose-btn"
        onClick={onCompose}
        aria-label="Compose"
        title="Compose"
      >
        <Plus size={14} />
        {collapsed ? null : "Compose"}
      </button>
      <button
        type="button"
        className="nav-item stream-toggle"
        onClick={onOpenStream}
        aria-label="Open Stream"
        title="Stream — process the Inbox one Thread at a time, full screen"
      >
        <Layers size={15} />
        {collapsed ? null : <span className="nav-label">Stream</span>}
      </button>
      <SidebarMenu className="nav-list">
        {FOLDER_ORDER.map((key) => {
          const count = key === "screener" ? screenerCount : key === "drafts" ? draftsCount : 0;
          const active = labelFilter === null && gmailLabelFilter === null && folder === key;
          const Icon = FOLDER_ICONS[key];
          return (
            <SidebarMenuItem key={key}>
              <SidebarMenuButton
                className={`nav-item${active ? " active" : ""}`}
                isActive={active}
                tooltip={FOLDER_LABELS[key]}
                onClick={() => onSelectFolder(key)}
              >
                <Icon size={15} />
                <span className="nav-label">{FOLDER_LABELS[key]}</span>
                {count > 0 ? <span className="nav-count tabular">{count}</span> : null}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
      {labels.length > 0 ? (
        <>
          <p className="nav-heading">Labels</p>
          <SidebarMenu className="nav-list">
            {labels.map((label) => (
              <SidebarMenuItem key={label.id}>
                <SidebarMenuButton
                  className={`nav-item${labelFilter === label.id ? " active" : ""}`}
                  isActive={labelFilter === label.id}
                  tooltip={label.name}
                  onClick={() => onSelectLabel(label.id)}
                >
                  <Tag size={15} />
                  <span className="nav-label">{label.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </>
      ) : null}
      {gmailLabels.length > 0 ? (
        <>
          <p className="nav-heading">Gmail labels</p>
          <SidebarMenu className="nav-list">
            {gmailLabels.map((label) => (
              <SidebarMenuItem key={label.id}>
                <SidebarMenuButton
                  className={`nav-item${gmailLabelFilter === label.id ? " active" : ""}`}
                  isActive={gmailLabelFilter === label.id}
                  tooltip={label.name}
                  onClick={() => onSelectGmailLabel(label.id)}
                >
                  <FolderOpen size={15} />
                  <span className="nav-label">{label.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </>
      ) : null}
    </>
  );
}

function DesktopRail(props: SidebarProps) {
  const { state, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <nav className="side-nav side-nav-desktop" aria-label="Folders" data-collapsed={collapsed}>
      <button
        type="button"
        className="side-nav-collapse-toggle"
        onClick={toggleSidebar}
        aria-label={collapsed ? "Expand folders" : "Collapse folders"}
        title={collapsed ? "Expand folders" : "Collapse folders"}
      >
        <PanelLeft size={15} />
      </button>
      <RailContents {...props} collapsed={collapsed} />
    </nav>
  );
}

function MobileSheet(props: SidebarProps) {
  const { openMobile, setOpenMobile } = useSidebar();

  function selectFolder(next: FolderKey) {
    props.onSelectFolder(next);
    setOpenMobile(false);
  }

  function selectLabel(labelId: string) {
    props.onSelectLabel(labelId);
    setOpenMobile(false);
  }

  function selectGmailLabel(labelId: string) {
    props.onSelectGmailLabel(labelId);
    setOpenMobile(false);
  }

  return (
    <>
      <button
        type="button"
        className="side-nav-toggle"
        onClick={() => setOpenMobile(true)}
        aria-label="Open folders"
        aria-expanded={openMobile}
      >
        <PanelLeft size={18} />
      </button>
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent side="bottom" className="side-nav-sheet">
          <SheetHeader className="sr-only">
            <SheetTitle>Folders</SheetTitle>
            <SheetDescription>Choose a folder or label to view.</SheetDescription>
          </SheetHeader>
          <nav className="side-nav" aria-label="Folders">
            <RailContents
              {...props}
              onSelectFolder={selectFolder}
              onSelectLabel={selectLabel}
              onSelectGmailLabel={selectGmailLabel}
              collapsed={false}
            />
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * Both render unconditionally — visibility between the desktop rail and the
 * phone bottom sheet is `mail.css`'s own narrow-viewport breakpoint
 * (`max-width: 700px`, matching every other Split/List layout switch in the
 * app), not `useIsMobile`'s generic 768px: a JS/CSS breakpoint mismatch
 * would leave a dead zone with no way to open either.
 */
function SidebarBody(props: SidebarProps) {
  return (
    <>
      <DesktopRail {...props} />
      <MobileSheet {...props} />
    </>
  );
}

export function Sidebar(props: SidebarProps) {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  return (
    // Self-contained rather than relying on `RootLayout`'s own
    // `TooltipProvider` — `SidebarMenuButton`'s `tooltip` prop renders a
    // `Tooltip` unconditionally (only its *content* stays hidden once
    // expanded), so the rail needs a provider in reach wherever it mounts,
    // including a test that renders `MailSection` on its own.
    <TooltipProvider>
      {/* `display: contents` is load-bearing. shadcn's `SidebarProvider`
          renders a wrapper carrying `flex min-h-svh w-full` — an *app-shell*
          box, meant to contain a rail and the page beside it. Here the
          provider is used for its context alone (collapse state, the phone
          sheet): the rail below is one flex item of `.mail-frame`, with
          `.mail-body` as its sibling. Left as a box, that wrapper claims the
          frame's entire width, `.mail-body` computes to `0px`, and every
          Mail view renders off the right edge of the card — the whole App
          reads as blank while this rail beside it looks perfect (#93's
          regression). An inline style rather than a class in `mail.css`
          deliberately: it beats Tailwind's own `flex`/`w-full` utilities
          without depending on cascade layers or bundle order, and it is the
          one form of this fix a jsdom test can actually assert, since jsdom
          computes no layout at all. */}
      <SidebarProvider
        style={{ display: "contents" }}
        open={!collapsed}
        onOpenChange={(open) => setCollapsed(!open)}
      >
        <SidebarBody {...props} />
      </SidebarProvider>
    </TooltipProvider>
  );
}
