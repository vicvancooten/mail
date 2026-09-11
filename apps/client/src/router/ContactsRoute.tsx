import { Outlet } from "@tanstack/react-router";
import { ContactsGrid } from "../contacts/ContactsGrid.js";

/**
 * `/contacts`'s layout route (#211) — `NotesRoute.tsx`'s own shape: the grid
 * is this route's own content, always mounted, and `<Outlet/>` is where a
 * deep link to `/contacts/:contactId` or `/contacts/new` (`routes.tsx`'s own
 * `contactsContactRoute`/`contactsNewRoute`) renders its dialog over it —
 * never a blank intermediate page.
 */
export function ContactsRoute() {
  return (
    <>
      <ContactsGrid />
      <Outlet />
    </>
  );
}
