import type {
  AddressBook,
  Contact,
  ContactAddress,
  ContactBanner,
  ContactOrganization,
  CustomField,
  LinkedContactFields,
  LinkedContactGroup,
} from "@mail/shared";
import {
  CONTACT_BANNER_SWATCHES,
  CONTACT_PHOTO_MIME_TYPES,
  contactDisplayName,
  contactOrganizationLine,
  customFieldTypeSchema,
  generateUlid,
  getContactCapabilityTable,
  linkedContactAddresses,
  unionLinkedContactFields,
} from "@mail/shared";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ContactPhotoTooLargeError,
  removeContactPhoto as removeContactPhotoBlob,
  UnsupportedContactPhotoTypeError,
  uploadContactPhoto,
} from "../api/contact-photos.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { announceUndoableAction } from "../mail/undo-toast.js";
import {
  deriveAddressBookScope,
  deriveMailAccountScope,
  useAccountScope,
} from "../mail/useAccountScope.js";
import { useAddressBooks } from "../store/address-books.js";
import {
  duplicateCandidatesInScope,
  linkContacts,
  newContactLinkId,
  setLinkedContactFront,
  unlinkContact,
  useContactLinks,
  useLinkedContactGroup,
} from "../store/contact-links.js";
import {
  copyContact,
  createContact,
  deleteContact,
  mergeContacts,
  moveContact,
  newContactId,
  recordContactPhoto,
  restoreContact,
  setContactBanner,
  trashContact,
  updateContact,
  useContact,
  useContacts,
} from "../store/contacts.js";
import { useConnectedAccounts, useMailAccounts } from "../store/index.js";
import { addressBookOriginLabel } from "./address-book-origin.js";
import { ContactCopyMoveDialog } from "./ContactCopyMoveDialog.js";
import {
  CONTACT_BANNER_SWATCH_LABELS,
  contactBannerStyle,
  contactBannerSwatchStyle,
} from "./contact-banner.js";
import "./contact-dialog.css";
import {
  buildContactWritableFields,
  type ContactFormState,
  type ContactFormVisibility,
  contactFormVisibility,
  contactToFormState,
  EMPTY_CONTACT_FORM_STATE,
  mergeContactFormVisibility,
} from "./contact-form.js";
import {
  checkContactPhotoFile,
  contactPhotoRejectionMessage,
  contactPhotoSrc,
} from "./contact-photo.js";
import { MailHistoryTab } from "./MailHistoryTab.js";
import { contactsToVCardFile, contactVCardFileName, downloadVCardFile } from "./vcard-export.js";

const CUSTOM_FIELD_TYPES = customFieldTypeSchema.options;

/** The photo `<input>`'s own `accept` (#213) — a hint for the OS picker, not a security boundary; `checkContactPhotoFile` is the real gate. */
const CONTACT_PHOTO_ACCEPT = CONTACT_PHOTO_MIME_TYPES.join(",");

/**
 * The Person Page (#212, spec's own §The Contacts App): a Dialog over the
 * grid, never an inline pane or a full-page navigation — `/contacts/:contactId`
 * (`ContactDialogRoute.tsx`) is exactly this dialog's open state, the same
 * discipline `NoteDialog.tsx` keeps for `/notes/:noteId`.
 *
 * An *existing* Contact opens into **Details** (view mode: the hero plus a
 * read-only rendering of every family it holds) and only enters **Edit**
 * mode on the User's own "Edit" — Save returns to Details without closing
 * the dialog, and Cancel discards the in-progress edit the same way. A
 * *brand-new* Contact (`contactId: null`) has no Details to show yet, so it
 * skips straight to the plain create form #210 already shipped — no hero,
 * no view/edit toggle, Save both creates and closes exactly as before
 * (cancelling leaves nothing behind, `store/contacts.ts#createContact`'s own
 * doc comment).
 *
 * Edit's own rows are drawn from `addressBook.capabilityTableId`'s
 * `ContactCapabilityTable` (`contactFormVisibility`) so a family the table
 * omits is absent from the form entirely, never merely disabled — this
 * ticket's own acceptance line, #210's own posture kept unchanged.
 *
 * `initialFields`/`addressBookOverride` (#218) only ever apply in Create
 * mode: the promotion dialog off "People you've mailed" pre-fills the
 * Correspondent's own name/address and lets the User re-target which
 * Address Book the save lands in, a one-time override over the fixed
 * `addressBook` prop — `/contacts/new` (`NewContactRoute.tsx`) passes
 * neither, so it keeps its plain blank-form, single-Address-Book shape.
 *
 * `footerExtra`/`onSaved` (#219) are the same "Create mode only" shape,
 * one step further: `PromoteCorrespondentDialog`'s own "Approve as well"
 * checkbox, when it's opened from mail, renders as `footerExtra` and reads
 * as though it belongs to this form, but this dialog never looks inside it
 * — `onSaved` is the one hook it fires, after `createContact` lands and
 * before `onClose`, so the checkbox's own state stays the caller's alone.
 */
export function ContactDialog({
  addressBook,
  contactId,
  onClose,
  onOpenThread,
  initialFields,
  addressBookOverride,
  footerExtra,
  onSaved,
}: {
  addressBook: AddressBook;
  /** `null` opens the dialog in Create mode — a fresh id is minted once, on the first render, and only written on Save. */
  contactId: string | null;
  onClose: () => void;
  /** The Mail history tab's own row action (#217) — router-agnostic, same "the route is the one place that knows a screen lives at a route at all" split `router/ContactDialogRoute.tsx` already draws for `onClose`. Never called for a brand-new Contact, which has no Mail history tab to click a row in. */
  onOpenThread: (threadId: string) => void;
  /** Create-mode-only pre-fill, applied once on mount — never re-applied on a later prop change. */
  initialFields?: Partial<ContactFormState>;
  /** Create-mode-only one-time Address Book picker — omitted, the dialog shows no picker at all. `onChange` is the caller's own state setter: this dialog never tracks which Address Book it saves into beyond the fixed `addressBook` prop it was handed. */
  addressBookOverride?: { options: AddressBook[]; onChange: (addressBookId: string) => void };
  /** Create-mode-only extra control rendered in the footer, ahead of Save — #219's "Approve as well" checkbox, absent everywhere else. */
  footerExtra?: ReactNode;
  /** Create-mode-only: fires once `createContact` has written, ahead of `onClose` — #219's own hook for a side effect keyed to the same Save (writing a Gatekeeper Verdict), never called for an existing Contact's edit-mode Save. */
  onSaved?: () => void;
}) {
  const existing = useContact(contactId);
  const idRef = useRef(contactId ?? newContactId());
  const isNew = contactId === null;

  // One person, not one record (#222, ADR-0026): every record linked into
  // this Contact, front first, or just the Contact itself when it isn't
  // linked. `null` in Create mode — there is no person yet.
  const group = useLinkedContactGroup(contactId);
  const addressBooks = useAddressBooks() ?? [];
  const booksById = useMemo(
    () => new Map(addressBooks.map((book) => [book.id, book])),
    [addressBooks],
  );
  const members = group?.members ?? (existing ? [existing] : []);
  const isLinked = group?.link != null;
  const fields = useMemo(() => (group ? unionLinkedContactFields(group) : null), [group]);

  const [activeTab, setActiveTab] = useState<"details" | "history">("details");
  /**
   * Which record an in-progress edit targets (#222's own acceptance line:
   * "each field edits the record it came from") — `null` is Details view.
   * A single id rather than a `"view" | "edit"` flag because on a linked
   * card "Edit" is not one action: each record's own Edit opens against that
   * record's fields and that record's Origin's capability table.
   */
  const [editingContactId, setEditingContactId] = useState<string | null>(
    isNew ? idRef.current : null,
  );
  const editingContact = members.find((member) => member.id === editingContactId) ?? null;
  const editingBook =
    (editingContact ? booksById.get(editingContact.addressBookId) : undefined) ?? addressBook;
  const editing = isNew || editingContactId !== null;

  /** Edit mode's own rows: always exactly one record's Origin (`mergeContactFormVisibility`'s own doc comment on why the union never applies here). */
  const visibility = useMemo(
    () => contactFormVisibility(getContactCapabilityTable(editingBook.capabilityTableId)),
    [editingBook.capabilityTableId],
  );
  /** Details' own rows: every family any linked record can hold. */
  const detailsVisibility = useMemo(
    () =>
      mergeContactFormVisibility(
        members.map((member) =>
          contactFormVisibility(
            getContactCapabilityTable(
              booksById.get(member.addressBookId)?.capabilityTableId ??
                addressBook.capabilityTableId,
            ),
          ),
        ),
      ),
    [members, booksById, addressBook.capabilityTableId],
  );
  const [form, setForm] = useState<ContactFormState>(() =>
    isNew && initialFields
      ? { ...EMPTY_CONTACT_FORM_STATE, ...initialFields }
      : EMPTY_CONTACT_FORM_STATE,
  );

  // Account Scope (#217, `useAccountScope.ts`): the Mail history tab's own
  // read of it, the same `deriveMailAccountScope` narrowing `MailSection.tsx`
  // and `ContactsGrid.tsx` each already do independently — `ContactDialog`
  // has no other reason to know about Mail Accounts at all.
  const connectedAccounts = useConnectedAccounts();
  const mailAccounts = useMailAccounts() ?? [];
  const { scope: connectedAccountScope } = useAccountScope(connectedAccounts);
  const mailAccountScope = useMemo(
    () => deriveMailAccountScope(connectedAccounts, connectedAccountScope, mailAccounts),
    [connectedAccounts, connectedAccountScope, mailAccounts],
  );
  /** Opens Edit against one record — the form is loaded from *that* record, never from whichever one happens to front the card. */
  const startEdit = useCallback((contact: Contact) => {
    setForm(contactToFormState(contact));
    setEditingContactId(contact.id);
  }, []);

  const handleSave = useCallback(async () => {
    const writable = buildContactWritableFields(form);
    if (isNew) {
      await createContact(idRef.current, addressBook.id, writable);
      onSaved?.();
      onClose();
      return;
    }
    if (editingContactId === null) return;
    await updateContact(editingContactId, writable);
    setEditingContactId(null);
  }, [form, isNew, addressBook.id, editingContactId, onClose, onSaved]);

  const handleCancelEdit = useCallback(() => {
    setEditingContactId(null);
  }, []);

  /**
   * Deletes this Contact (#224) — an Optimistic Action with Restore as its
   * real inverse (ADR-0019), `notes/NoteDialog.tsx`'s own Delete shape:
   * `trashContact` fires and raises the Undo toast in the same breath. On a
   * linked card the Sync Backend cascades the same intent to every record
   * `id` is linked with (ADR-0026: "Delete on a linked card deletes every
   * linked record, one Undo restores all") — this dialog only ever names the
   * one record whose own Delete control was clicked, in the footer
   * (unlinked) or the Linked records section (linked), and closes either
   * way: the whole person the dialog was showing is gone either way, not
   * only the one record `id` names.
   */
  const handleDeleteRecord = useCallback(
    async (id: string) => {
      await trashContact(id);
      announceUndoableAction("contactDelete", () => void restoreContact(id));
      onClose();
    },
    [onClose],
  );

  // A delete arriving from elsewhere (another device, or the linked-card
  // cascade landing for a member that isn't the one this route opened on)
  // while this dialog is still open — `notes/NoteDialog.tsx`'s own
  // `deletedAt` effect, `noteExists`'s own reasoning applied to a Contact.
  useEffect(() => {
    if (existing?.deletedAt) onClose();
  }, [existing?.deletedAt, onClose]);

  // The banner and the photo are Wicket's own decoration on **a record**
  // (#212/#213), so both target the record being edited on a linked card —
  // never the front record, which may not be the one whose Edit is open.
  const decoratedId = editingContactId ?? idRef.current;

  const handleBannerChange = useCallback(
    (banner: ContactBanner | null) => {
      void setContactBanner(decoratedId, banner);
    },
    [decoratedId],
  );

  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);

  const handlePhotoSelected = useCallback(
    async (file: File) => {
      const rejection = checkContactPhotoFile(file);
      if (rejection) {
        setPhotoError(contactPhotoRejectionMessage(rejection));
        return;
      }
      setPhotoError(null);
      setPhotoUploading(true);
      try {
        const photo = await uploadContactPhoto(decoratedId, file);
        await recordContactPhoto(decoratedId, photo);
      } catch (err) {
        setPhotoError(
          err instanceof UnsupportedContactPhotoTypeError
            ? "Unsupported image type"
            : err instanceof ContactPhotoTooLargeError
              ? `Over the ${Math.round(err.maxBytes / (1024 * 1024))}MB photo limit`
              : "Upload failed",
        );
      } finally {
        setPhotoUploading(false);
      }
    },
    [decoratedId],
  );

  const handlePhotoRemove = useCallback(async () => {
    setPhotoError(null);
    try {
      await removeContactPhotoBlob(decoratedId);
      await recordContactPhoto(decoratedId, null);
    } catch {
      setPhotoError("Remove failed");
    }
  }, [decoratedId]);

  // Possible duplicates (#222) — recomputed from the Contacts this Client
  // holds in Account Scope, never a stored join
  // (`@mail/shared#contact-duplicates.ts`). Records already linked to this
  // person are filtered out by `duplicateCandidatesInScope`: a pair the User
  // has already answered is no longer a suggestion.
  const allContacts = useContacts() ?? [];
  const contactLinks = useContactLinks() ?? [];
  const addressBooksInScope = useMemo(
    () => deriveAddressBookScope(connectedAccounts, connectedAccountScope, addressBooks),
    [connectedAccounts, connectedAccountScope, addressBooks],
  );
  const duplicateCandidates = useMemo(() => {
    if (!group) return [];
    const inScopeIds = new Set(addressBooksInScope.map((book) => book.id));
    const inScope = allContacts.filter((contact) => inScopeIds.has(contact.addressBookId));
    const candidates = duplicateCandidatesInScope(inScope, contactLinks);
    const memberIds = new Set(members.map((member) => member.id));
    const ids = new Set(members.flatMap((member) => [...(candidates.get(member.id) ?? [])]));
    return [...ids]
      .filter((id) => !memberIds.has(id))
      .map((id) => inScope.find((contact) => contact.id === id))
      .filter((contact): contact is Contact => contact !== undefined);
  }, [group, members, allContacts, contactLinks, addressBooksInScope]);

  /** The link this person belongs to, `""` when they stand alone — read once so the JSX below never has to assert a non-null `group.link` it has already checked. */
  const linkId = group?.link?.id ?? "";

  const handleLink = useCallback(async (otherContactId: string) => {
    await linkContacts(newContactLinkId(), idRef.current, otherContactId);
  }, []);

  // Merge within one Address Book (#223, ADR-0026: "Merge is confirmed
  // before it acts") — the one duplicate-suggestion action a User can't take
  // back, so it always passes through this confirm step first, unlike
  // `handleLink` above (a merge across Origins isn't destructive at all) and
  // unlike `handleDeleteRecord` (today's plain, unconfirmed delete this
  // ticket's own acceptance line doesn't ask this to match — only its
  // undo-less shape, `store/contacts.ts#mergeContacts`'s own doc comment).
  const [mergeCandidate, setMergeCandidate] = useState<Contact | null>(null);
  const handleMergeConfirm = useCallback(async () => {
    if (!mergeCandidate) return;
    const result = await mergeContacts(idRef.current, mergeCandidate.id);
    setMergeCandidate(null);
    // The record the route is open on may have been the one deleted — the
    // same "closes only when the record deleted is the one the route is open
    // on" shape `handleDeleteRecord` already takes.
    if (result && result.loserId === contactId) onClose();
  }, [mergeCandidate, contactId, onClose]);

  // Copy to…/Move to… (#225) — `mergeCandidate`'s own shape: naming the
  // action opens a nested confirm `Dialog`
  // (`ContactCopyMoveDialog.tsx`), which is the one place the actual
  // `copyContact`/`moveContact` call happens, once the User picks a target
  // and sees what it will drop.
  const [copyMoveMode, setCopyMoveMode] = useState<"copy" | "move" | null>(null);
  const handleCopyMoveConfirm = useCallback(
    async (target: AddressBook) => {
      if (!existing) return;
      const table = getContactCapabilityTable(target.capabilityTableId);
      if (copyMoveMode === "move") {
        const result = await moveContact(existing, target.id, table);
        announceUndoableAction("contactMove", result.undo);
        setCopyMoveMode(null);
        onClose();
        return;
      }
      const newId = await copyContact(existing, target.id, table);
      announceUndoableAction("contactCopy", () => deleteContact(newId));
      setCopyMoveMode(null);
    },
    [existing, copyMoveMode, onClose],
  );

  const handleExport = useCallback(async () => {
    if (!existing) return;
    const vcard = await contactsToVCardFile([existing]);
    downloadVCardFile(contactVCardFileName(existing), vcard);
  }, [existing]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="contact-dialog">
        {isNew || !existing ? (
          <>
            <DialogTitle>New contact</DialogTitle>
            {isNew && addressBookOverride ? (
              <label className="contact-dialog-address-book-override">
                Save to
                <select
                  aria-label="Address Book"
                  value={addressBook.id}
                  onChange={(event) => addressBookOverride.onChange(event.target.value)}
                >
                  {addressBookOverride.options.map((book) => (
                    <option key={book.id} value={book.id}>
                      {book.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        ) : (
          <ContactHero
            // The hero shows the **person** (#222): the union's name,
            // organisation, photo and banner, whichever record each came
            // from, over the front record's own identity for everything
            // else (its id is what the fallback gradient keys off).
            contact={
              fields
                ? {
                    ...(group?.front ?? existing),
                    name: fields.name,
                    organizations: fields.organizations.map((entry) => entry.entry),
                    banner: fields.banner?.entry ?? null,
                  }
                : existing
            }
            photoContact={
              fields?.photo
                ? { id: fields.photo.sourceContactId, photo: fields.photo.entry }
                : undefined
            }
            editable={editing}
            onBannerChange={handleBannerChange}
            // #213 scoped this to a Local Contact ("the upload path is a
            // Local Contact's own slice") — #216 widens it to a Google
            // Contact too, now that a photo change on one write-backs
            // through `updateContactPhoto`, and #226 widens it once more to
            // CardDAV (its own vCard `PHOTO` re-embedded on the next write,
            // `contacts/carddav/write-back-loop.ts`'s own doc comment) —
            // `ContactDialog.tsx`'s own `handlePhotoSelected`/
            // `handlePhotoRemove` are unchanged either time: the
            // upload/remove round trip is identical, the write-back is
            // entirely the Sync Backend's own follow-up. Graph (`"microsoft"`)
            // stays excluded until #227's own adapter supports a photo
            // write-back too.
            photoEditable={
              editing &&
              (editingBook.capabilityTableId === "local" ||
                editingBook.capabilityTableId === "google" ||
                editingBook.capabilityTableId === "caldav_carddav")
            }
            photoUploading={photoUploading}
            photoError={photoError}
            onPhotoSelected={(file) => void handlePhotoSelected(file)}
            onPhotoRemove={() => void handlePhotoRemove()}
          />
        )}

        {!isNew && existing ? (
          <div className="contact-dialog-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "details"}
              className={`contact-dialog-tab${activeTab === "details" ? " active" : ""}`}
              onClick={() => setActiveTab("details")}
            >
              Details
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "history"}
              className={`contact-dialog-tab${activeTab === "history" ? " active" : ""}`}
              onClick={() => setActiveTab("history")}
            >
              Mail history
            </button>
          </div>
        ) : null}

        {activeTab === "history" && !isNew && existing ? (
          <MailHistoryTab
            // Every address on every linked record (#222's own acceptance
            // line) — #217 left this hook open for exactly this.
            addresses={group ? linkedContactAddresses(group) : []}
            accountScope={mailAccountScope}
            mailAccounts={mailAccounts}
            onOpenThread={onOpenThread}
          />
        ) : !isNew && existing && !editing && fields && group ? (
          <>
            <ContactDetailsView
              fields={fields}
              visibility={detailsVisibility}
              sourceLabel={
                isLinked
                  ? (sourceContactId) => recordLabel(sourceContactId, members, booksById)
                  : undefined
              }
            />
            {group.link ? (
              <LinkedRecordsSection
                group={group}
                link={group.link}
                booksById={booksById}
                onEdit={startEdit}
                onUnlink={(id) => void unlinkContact(id)}
                onFront={(id) => void setLinkedContactFront(linkId, id)}
                onDelete={(id) => void handleDeleteRecord(id)}
              />
            ) : null}
            <DuplicateSuggestions
              candidates={duplicateCandidates}
              booksById={booksById}
              ownAddressBookId={existing.addressBookId}
              onLink={(id) => void handleLink(id)}
              onMerge={setMergeCandidate}
            />
          </>
        ) : (
          <ContactEditForm form={form} visibility={visibility} onChange={setForm} />
        )}

        {mergeCandidate ? (
          <Dialog open onOpenChange={(open) => (open ? undefined : setMergeCandidate(null))}>
            <DialogContent className="contact-merge-confirm">
              <DialogTitle>Merge with {contactDisplayName(mergeCandidate)}?</DialogTitle>
              <p>
                The older record survives and takes the other&rsquo;s fields; the other record is
                deleted. This can&rsquo;t be undone.
              </p>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setMergeCandidate(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void handleMergeConfirm()}
                >
                  Merge
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}

        {copyMoveMode && existing ? (
          <ContactCopyMoveDialog
            mode={copyMoveMode}
            contact={existing}
            addressBooks={addressBooks}
            onConfirm={(target) => void handleCopyMoveConfirm(target)}
            onClose={() => setCopyMoveMode(null)}
          />
        ) : null}

        {activeTab === "history" || (!editing && isLinked) ? null : (
          <DialogFooter>
            {!isNew && existing && !editing ? (
              // A linked card's Delete and Edit are per record, in the
              // Linked records section (#222) — the footer carries them only
              // while this Contact stands alone, where there is exactly one
              // record either could mean. Copy/Move/Export (#225) share that
              // same scoping — a linked card's own Copy/Move is future work,
              // the same gap #224's own Delete note already leaves open.
              isLinked ? null : (
                <>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void handleDeleteRecord(existing.id)}
                  >
                    Delete
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void handleExport()}>
                    Export
                  </Button>
                  {addressBooks.length > 1 ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setCopyMoveMode("copy")}
                      >
                        Copy to…
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setCopyMoveMode("move")}
                      >
                        Move to…
                      </Button>
                    </>
                  ) : null}
                  <Button type="button" onClick={() => startEdit(existing)}>
                    Edit
                  </Button>
                </>
              )
            ) : (
              <>
                {!isNew ? (
                  <Button type="button" variant="outline" onClick={handleCancelEdit}>
                    Cancel
                  </Button>
                ) : null}
                {isNew ? footerExtra : null}
                <Button type="button" onClick={() => void handleSave()}>
                  Save
                </Button>
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The hero (spec's own §Banner): a banner strip behind an overlapping
 * avatar, `ContactCard.tsx`'s own treatment at Person Page scale.
 * "Change banner" — the fixed swatch set plus a raw image URL — only shows
 * in Edit mode (this ticket's own acceptance line: "Edit ... offers Change
 * banner ... over the hero"); Details view renders the same hero read-only.
 */
function ContactHero({
  contact,
  photoContact,
  editable,
  onBannerChange,
  photoEditable,
  photoUploading,
  photoError,
  onPhotoSelected,
  onPhotoRemove,
}: {
  contact: Contact;
  /** Which record's photo to render, when it isn't `contact`'s own (#222: a linked card shows the union's photo, whose bytes are addressed by the record that holds them). */
  photoContact?: Pick<Contact, "id" | "photo">;
  editable: boolean;
  onBannerChange: (banner: ContactBanner | null) => void;
  photoEditable: boolean;
  photoUploading: boolean;
  photoError: string | null;
  onPhotoSelected: (file: File) => void;
  onPhotoRemove: () => void;
}) {
  const name = contactDisplayName(contact);
  const organizationLine = contactOrganizationLine(contact);
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const photoSrc = contactPhotoSrc(photoContact ?? contact);
  const [pickerOpen, setPickerOpen] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="contact-hero">
      <div className="contact-hero-banner" style={{ background: contactBannerStyle(contact) }}>
        {editable ? (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="contact-hero-banner-button"
              >
                Change banner
              </Button>
            </PopoverTrigger>
            <PopoverContent className="contact-banner-picker">
              <BannerPicker
                banner={contact.banner}
                onChange={(banner) => {
                  onBannerChange(banner);
                  setPickerOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      <div className="contact-hero-avatar" aria-hidden="true">
        {photoSrc ? <img className="contact-hero-avatar-image" src={photoSrc} alt="" /> : initial}
      </div>
      {photoEditable ? (
        <div className="contact-hero-photo-controls">
          <input
            ref={photoInputRef}
            type="file"
            accept={CONTACT_PHOTO_ACCEPT}
            className="contact-hero-photo-input"
            aria-label="Choose photo"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onPhotoSelected(file);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={photoUploading}
            onClick={() => photoInputRef.current?.click()}
          >
            {photoUploading ? "Uploading…" : "Change photo"}
          </Button>
          {(photoContact ?? contact).photo ? (
            <Button type="button" variant="ghost" size="sm" onClick={onPhotoRemove}>
              Remove photo
            </Button>
          ) : null}
          {photoError ? <span className="contact-hero-photo-error">{photoError}</span> : null}
        </div>
      ) : null}
      <div className="contact-hero-body">
        <DialogTitle className="contact-hero-name">{name}</DialogTitle>
        {organizationLine ? <p className="contact-hero-organization">{organizationLine}</p> : null}
      </div>
    </div>
  );
}

/** The swatch grid plus raw-URL field the hero's "Change banner" popover opens (spec's own §Banner). A swatch pick or a submitted URL both close the popover (the caller's `onChange`); there is no separate Save step here — same instant-apply posture `AddFacetControl.tsx`'s own popover doors already take. */
function BannerPicker({
  banner,
  onChange,
}: {
  banner: ContactBanner | null;
  onChange: (banner: ContactBanner | null) => void;
}) {
  const [url, setUrl] = useState(banner?.kind === "image" ? banner.url : "");

  return (
    <div className="contact-banner-picker-body">
      <span className="contact-dialog-legend">Banner</span>
      <div className="contact-banner-swatches">
        {CONTACT_BANNER_SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="contact-banner-swatch"
            aria-label={CONTACT_BANNER_SWATCH_LABELS[swatch]}
            aria-pressed={banner?.kind === "swatch" && banner.swatch === swatch}
            style={{ background: contactBannerSwatchStyle(swatch) }}
            onClick={() => onChange({ kind: "swatch", swatch })}
          />
        ))}
      </div>
      <form
        className="contact-banner-url-row"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = url.trim();
          if (trimmed.length === 0) return;
          onChange({ kind: "image", url: trimmed });
        }}
      >
        <Input
          aria-label="Banner image URL"
          placeholder="Image URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button type="submit" variant="outline" size="sm">
          Use image
        </Button>
      </form>
      {banner !== null ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          Reset to default
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Details (view mode): a read-only rendering of every family this person's
 * Origin(s) can hold and actually has a value in — an empty family is simply
 * absent, the same "absent, not disabled" posture the edit form's own rows
 * take for a family an Origin can't hold at all.
 *
 * Draws the **union** (#222, ADR-0026: "the union of fields shows on one
 * Person Page") rather than one Contact: for an unlinked Contact the union
 * is just its own fields, so this one rendering serves both and there is no
 * second "linked" view to keep in step. `sourceLabel` is what makes the
 * union honest on a linked card — every row says which record it came from,
 * which is the same record that row's Edit will open
 * (`LinkedRecordsSection`) — and is omitted for an unlinked Contact, where
 * naming the one record it could possibly be would be noise.
 */
function ContactDetailsView({
  fields,
  visibility,
  sourceLabel,
}: {
  fields: LinkedContactFields;
  visibility: ContactFormVisibility;
  sourceLabel?: (sourceContactId: string) => string | null;
}) {
  const addressLines = fields.addresses.map((entry) => ({
    id: entry.entry.id,
    sourceContactId: entry.sourceContactId,
    type: entry.entry.type,
    line: [
      entry.entry.street,
      entry.entry.city,
      entry.entry.region,
      entry.entry.postalCode,
      entry.entry.country,
    ]
      .filter((part): part is string => Boolean(part && part.trim().length > 0))
      .join(", "),
  }));

  const anyDetails =
    fields.emails.length > 0 ||
    fields.phones.length > 0 ||
    fields.websites.length > 0 ||
    fields.addresses.length > 0 ||
    fields.organizations.length > 0 ||
    fields.birthday !== null ||
    fields.notes.length > 0 ||
    fields.customFields.length > 0 ||
    fields.categories.length > 0;

  const source = (sourceContactId: string) => sourceLabel?.(sourceContactId) ?? undefined;

  return (
    <div className="contact-dialog-details">
      {visibility.organizations && fields.organizations.length > 0 ? (
        <DetailSection legend="Organization">
          {fields.organizations.map((entry) => (
            <DetailRow
              key={entry.entry.id}
              label={entry.entry.title ?? undefined}
              value={entry.entry.name}
              source={source(entry.sourceContactId)}
            />
          ))}
        </DetailSection>
      ) : null}

      {visibility.emails && fields.emails.length > 0 ? (
        <DetailSection legend="Email">
          {fields.emails.map((entry) => (
            <DetailRow
              key={entry.entry.id}
              label={entry.entry.type}
              value={entry.entry.value}
              source={source(entry.sourceContactId)}
            />
          ))}
        </DetailSection>
      ) : null}

      {visibility.phones && fields.phones.length > 0 ? (
        <DetailSection legend="Phone">
          {fields.phones.map((entry) => (
            <DetailRow
              key={entry.entry.id}
              label={entry.entry.type}
              value={entry.entry.value}
              source={source(entry.sourceContactId)}
            />
          ))}
        </DetailSection>
      ) : null}

      {visibility.addresses && addressLines.length > 0 ? (
        <DetailSection legend="Address">
          {addressLines.map((entry) => (
            <DetailRow
              key={entry.id}
              label={entry.type}
              value={entry.line || "—"}
              source={source(entry.sourceContactId)}
            />
          ))}
        </DetailSection>
      ) : null}

      {visibility.websites && fields.websites.length > 0 ? (
        <DetailSection legend="Website">
          {fields.websites.map((entry) => (
            <DetailRow
              key={entry.entry.id}
              label={entry.entry.type}
              value={entry.entry.value}
              source={source(entry.sourceContactId)}
            />
          ))}
        </DetailSection>
      ) : null}

      {visibility.birthday && fields.birthday ? (
        <DetailSection legend="Birthday">
          <DetailRow
            value={`${String(fields.birthday.entry.month).padStart(2, "0")}/${String(
              fields.birthday.entry.day,
            ).padStart(
              2,
              "0",
            )}${fields.birthday.entry.year ? `/${fields.birthday.entry.year}` : ""}`}
            source={source(fields.birthday.sourceContactId)}
          />
        </DetailSection>
      ) : null}

      {fields.notes.length > 0 ? (
        <DetailSection legend="Notes">
          {fields.notes.map((entry) => (
            <div key={entry.sourceContactId} className="contact-dialog-note-block">
              {source(entry.sourceContactId) ? (
                <span className="contact-dialog-detail-source">
                  {source(entry.sourceContactId)}
                </span>
              ) : null}
              <p className="contact-dialog-notes">{entry.entry}</p>
            </div>
          ))}
        </DetailSection>
      ) : null}

      {visibility.customFields && fields.customFields.length > 0 ? (
        <DetailSection legend="Custom fields">
          {fields.customFields.map((entry) => (
            <DetailRow
              key={entry.entry.id}
              label={entry.entry.label}
              value={entry.entry.value}
              source={source(entry.sourceContactId)}
            />
          ))}
        </DetailSection>
      ) : null}

      {fields.categories.length > 0 ? (
        <DetailSection legend="Categories">
          <div className="contact-dialog-chips">
            {fields.categories.map((category) => (
              <span key={category} className="contact-dialog-chip">
                {category}
              </span>
            ))}
          </div>
        </DetailSection>
      ) : null}

      {!anyDetails ? (
        <p className="contact-dialog-empty">No details yet — Edit to add some.</p>
      ) : null}
    </div>
  );
}

/** How a linked card names one of its records: the Address Book's name, with its Origin badge behind it — "Google Contacts (Google)" reads apart from a second book of the same Origin, which #226/#227 make possible. */
function recordLabel(
  contactId: string,
  members: readonly Contact[],
  booksById: ReadonlyMap<string, AddressBook>,
): string | null {
  const member = members.find((entry) => entry.id === contactId);
  const book = member ? booksById.get(member.addressBookId) : undefined;
  if (!book) return null;
  return book.name;
}

/**
 * A linked card's own record list (#222) — where every per-record action
 * lives, because on a linked card there is no single record a footer button
 * could mean. Each row is one record: which Address Book and Origin it came
 * from, whether it currently fronts the card, and its own Edit, Front,
 * Unlink and Delete.
 *
 * "Front this record" is the User's own pick over the derived default
 * (ADR-0026: the record in the Default Address Book, else the most recently
 * edited) — the row already fronting the card offers "Fronting" as a
 * disabled marker rather than a no-op button, and "Use the default" clears
 * an explicit pick so the card follows the Default Address Book again.
 */
function LinkedRecordsSection({
  group,
  link,
  booksById,
  onEdit,
  onUnlink,
  onFront,
  onDelete,
}: {
  group: LinkedContactGroup;
  link: NonNullable<LinkedContactGroup["link"]>;
  booksById: ReadonlyMap<string, AddressBook>;
  onEdit: (contact: Contact) => void;
  onUnlink: (contactId: string) => void;
  onFront: (contactId: string | null) => void;
  onDelete: (contactId: string) => void;
}) {
  return (
    <section className="contact-dialog-section contact-dialog-linked">
      <span className="contact-dialog-legend">Linked records</span>
      {group.members.map((member) => {
        const book = booksById.get(member.addressBookId);
        const label = book?.name ?? "Unknown Address Book";
        const fronting = member.id === group.front.id;
        return (
          <div key={member.id} className="contact-dialog-linked-row">
            <span className="contact-dialog-linked-book">
              {label}
              {book ? (
                <span className="contact-dialog-linked-origin">
                  {addressBookOriginLabel(book.capabilityTableId)}
                </span>
              ) : null}
              {fronting ? <span className="contact-dialog-linked-front">Fronting</span> : null}
            </span>
            <span className="contact-dialog-linked-actions">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Edit ${label}`}
                onClick={() => onEdit(member)}
              >
                Edit
              </Button>
              {fronting ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Front ${label}`}
                  onClick={() => onFront(member.id)}
                >
                  Front this record
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Unlink ${label}`}
                onClick={() => onUnlink(member.id)}
              >
                Unlink
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                aria-label={`Delete ${label}`}
                onClick={() => onDelete(member.id)}
              >
                Delete
              </Button>
            </span>
          </div>
        );
      })}
      {link.frontContactId !== null ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onFront(null)}>
          Use the default Address Book's record
        </Button>
      ) : null}
    </section>
  );
}

/**
 * The possible-duplicate suggestions on a Person Page (#222, ADR-0026:
 * "Duplicate detection suggests, never acts") — a section in Details, never
 * a modal and never automatic. Renders nothing at all when there is nothing
 * to suggest, so an ordinary Contact's Person Page is unchanged.
 *
 * A pair in **another** Address Book offers **Link** (ADR-0026: "cross-Origin
 * pairs offer Link", generalized to any other book — what makes a merge
 * lossy is that the two records answer to different upstreams, which is true
 * of any two books, and two records in the same book are exactly the case a
 * real Merge loses nothing on). A pair in the **same** Address Book offers
 * **Merge** instead (#223) — `onMerge` only ever names the candidate; the
 * confirm step and the actual write live in `ContactDialog`'s own
 * `handleMergeConfirm`, the same "component wires the toast, the store stays
 * store" split this file's own doc comments already draw elsewhere.
 */
function DuplicateSuggestions({
  candidates,
  booksById,
  ownAddressBookId,
  onLink,
  onMerge,
}: {
  candidates: readonly Contact[];
  booksById: ReadonlyMap<string, AddressBook>;
  ownAddressBookId: string;
  onLink: (contactId: string) => void;
  onMerge: (candidate: Contact) => void;
}) {
  if (candidates.length === 0) return null;

  return (
    <section className="contact-dialog-section contact-dialog-duplicates">
      <span className="contact-dialog-legend">Possible duplicate</span>
      {candidates.map((candidate) => {
        const book = booksById.get(candidate.addressBookId);
        const sameBook = candidate.addressBookId === ownAddressBookId;
        const name = contactDisplayName(candidate);
        return (
          <div key={candidate.id} className="contact-dialog-duplicate-row">
            <span className="contact-dialog-duplicate-name">
              {name}
              {book ? (
                <span className="contact-dialog-linked-origin">
                  {addressBookOriginLabel(book.capabilityTableId)}
                </span>
              ) : null}
            </span>
            {sameBook ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Merge ${name}`}
                onClick={() => onMerge(candidate)}
              >
                Merge
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                aria-label={`Link ${name}`}
                onClick={() => onLink(candidate.id)}
              >
                Link
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function DetailSection({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <section className="contact-dialog-section">
      <span className="contact-dialog-legend">{legend}</span>
      {children}
    </section>
  );
}

function DetailRow({
  label,
  value,
  source,
}: {
  label?: string;
  value: string;
  /** Which record this row came from (#222) — absent for an unlinked Contact. */
  source?: string;
}) {
  return (
    <div className="contact-dialog-detail-row">
      {label ? <span className="contact-dialog-detail-label">{label}</span> : null}
      <span className="contact-dialog-detail-value">{value}</span>
      {source ? <span className="contact-dialog-detail-source">{source}</span> : null}
    </div>
  );
}

/** Edit mode's own rows — #210's original form body, unchanged, entered via "Edit" on an existing Contact or shown outright for a brand-new one. */
function ContactEditForm({
  form,
  visibility,
  onChange,
}: {
  form: ContactFormState;
  visibility: ContactFormVisibility;
  onChange: (form: ContactFormState) => void;
}) {
  return (
    <>
      <section className="contact-dialog-section">
        <Input
          aria-label="Given name"
          placeholder="Given name"
          value={form.name.given ?? ""}
          onChange={(event) =>
            onChange({ ...form, name: { ...form.name, given: event.target.value } })
          }
        />
        <Input
          aria-label="Family name"
          placeholder="Family name"
          value={form.name.family ?? ""}
          onChange={(event) =>
            onChange({ ...form, name: { ...form.name, family: event.target.value } })
          }
        />
      </section>

      {visibility.emails ? (
        <TypedFieldSection
          legend="Email"
          entries={form.emails}
          onChange={(emails) => onChange({ ...form, emails })}
        />
      ) : null}

      {visibility.phones ? (
        <TypedFieldSection
          legend="Phone"
          entries={form.phones}
          onChange={(phones) => onChange({ ...form, phones })}
        />
      ) : null}

      {visibility.websites ? (
        <TypedFieldSection
          legend="Website"
          entries={form.websites}
          onChange={(websites) => onChange({ ...form, websites })}
        />
      ) : null}

      {visibility.addresses ? (
        <AddressSection
          entries={form.addresses}
          onChange={(addresses) => onChange({ ...form, addresses })}
        />
      ) : null}

      {visibility.organizations ? (
        <OrganizationSection
          entries={form.organizations}
          limit={visibility.organizationsLimit}
          onChange={(organizations) => onChange({ ...form, organizations })}
        />
      ) : null}

      {visibility.birthday ? (
        <section className="contact-dialog-section">
          <span className="contact-dialog-legend">Birthday</span>
          <Input
            aria-label="Birthday month"
            type="number"
            min={1}
            max={12}
            placeholder="MM"
            value={form.birthday?.month ?? ""}
            onChange={(event) =>
              onChange({
                ...form,
                birthday: {
                  month: Number(event.target.value) || 1,
                  day: form.birthday?.day ?? 1,
                  year: form.birthday?.year ?? null,
                },
              })
            }
          />
          <Input
            aria-label="Birthday day"
            type="number"
            min={1}
            max={31}
            placeholder="DD"
            value={form.birthday?.day ?? ""}
            onChange={(event) =>
              onChange({
                ...form,
                birthday: {
                  month: form.birthday?.month ?? 1,
                  day: Number(event.target.value) || 1,
                  year: form.birthday?.year ?? null,
                },
              })
            }
          />
          <Input
            aria-label="Birthday year"
            type="number"
            placeholder="YYYY (optional)"
            value={form.birthday?.year ?? ""}
            onChange={(event) =>
              onChange({
                ...form,
                birthday: {
                  month: form.birthday?.month ?? 1,
                  day: form.birthday?.day ?? 1,
                  year: event.target.value === "" ? null : Number(event.target.value),
                },
              })
            }
          />
        </section>
      ) : null}

      <section className="contact-dialog-section">
        <Input
          aria-label="Notes"
          placeholder="Notes"
          value={form.notes}
          onChange={(event) => onChange({ ...form, notes: event.target.value })}
        />
      </section>

      {visibility.customFields ? (
        <CustomFieldSection
          entries={form.customFields}
          onChange={(customFields) => onChange({ ...form, customFields })}
        />
      ) : null}
    </>
  );
}

/** Shared row shape for the three single-value typed families (email/phone/website) — `type` is free text; `contactFormVisibility`/`splitTypedContactFields` decide standard vs Custom Field at Save. */
function TypedFieldSection({
  legend,
  entries,
  onChange,
}: {
  legend: string;
  entries: { id: string; type: string; value: string; primary: boolean }[];
  onChange: (entries: { id: string; type: string; value: string; primary: boolean }[]) => void;
}) {
  return (
    <section className="contact-dialog-section">
      <span className="contact-dialog-legend">{legend}</span>
      {entries.map((entry, index) => (
        <div className="contact-dialog-row" key={entry.id}>
          <Input
            aria-label={`${legend} type`}
            placeholder="Type (e.g. home, or a custom label)"
            value={entry.type}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, type: event.target.value } : e)),
              )
            }
          />
          <Input
            aria-label={`${legend} value`}
            value={entry.value}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, value: event.target.value } : e)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([
            ...entries,
            { id: generateUlid(), type: "", value: "", primary: entries.length === 0 },
          ])
        }
      >
        Add {legend.toLowerCase()}
      </Button>
    </section>
  );
}

function AddressSection({
  entries,
  onChange,
}: {
  entries: ContactAddress[];
  onChange: (entries: ContactAddress[]) => void;
}) {
  return (
    <section className="contact-dialog-section">
      <span className="contact-dialog-legend">Address</span>
      {entries.map((entry, index) => (
        <div className="contact-dialog-row" key={entry.id}>
          <Input
            aria-label="Address type"
            placeholder="Type (e.g. home, or a custom label)"
            value={entry.type}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, type: event.target.value } : e)),
              )
            }
          />
          <Input
            aria-label="Street"
            placeholder="Street"
            value={entry.street ?? ""}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, street: event.target.value } : e)),
              )
            }
          />
          <Input
            aria-label="City"
            placeholder="City"
            value={entry.city ?? ""}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, city: event.target.value } : e)),
              )
            }
          />
          <Input
            aria-label="Country"
            placeholder="Country"
            value={entry.country ?? ""}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, country: event.target.value } : e)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...entries, { id: generateUlid(), type: "", primary: entries.length === 0 }])
        }
      >
        Add address
      </Button>
    </section>
  );
}

/** `limit` (#227): Graph's own `organization: 1` — undefined for every Origin that leaves it unbounded. "Add organization" simply disappears past the cap (this ticket's own acceptance line: "no second organisation — absent, not disabled"), the same posture `visibility` already gives a whole family this Origin can't hold at all. */
function OrganizationSection({
  entries,
  limit,
  onChange,
}: {
  entries: ContactOrganization[];
  limit: number | undefined;
  onChange: (entries: ContactOrganization[]) => void;
}) {
  const atLimit = limit !== undefined && entries.length >= limit;
  return (
    <section className="contact-dialog-section">
      <span className="contact-dialog-legend">Organization</span>
      {entries.map((entry, index) => (
        <div className="contact-dialog-row" key={entry.id}>
          <Input
            aria-label="Organization name"
            placeholder="Organization"
            value={entry.name}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, name: event.target.value } : e)),
              )
            }
          />
          <Input
            aria-label="Title"
            placeholder="Title"
            value={entry.title ?? ""}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, title: event.target.value } : e)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      {atLimit ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...entries, { id: generateUlid(), name: "" }])}
        >
          Add organization
        </Button>
      )}
    </section>
  );
}

function CustomFieldSection({
  entries,
  onChange,
}: {
  entries: CustomField[];
  onChange: (entries: CustomField[]) => void;
}) {
  return (
    <section className="contact-dialog-section">
      <span className="contact-dialog-legend">Custom fields</span>
      {entries.map((entry, index) => (
        <div className="contact-dialog-row" key={entry.id}>
          <Input
            aria-label="Custom field label"
            placeholder="Label"
            value={entry.label}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, label: event.target.value } : e)),
              )
            }
          />
          <select
            aria-label="Custom field type"
            value={entry.type}
            onChange={(event) =>
              onChange(
                entries.map((e, i) =>
                  i === index ? { ...e, type: event.target.value as CustomField["type"] } : e,
                ),
              )
            }
          >
            {CUSTOM_FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <Input
            aria-label="Custom field value"
            value={entry.value}
            onChange={(event) =>
              onChange(
                entries.map((e, i) => (i === index ? { ...e, value: event.target.value } : e)),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([...entries, { id: generateUlid(), label: "", type: "text", value: "" }])
        }
      >
        Add custom field
      </Button>
    </section>
  );
}
