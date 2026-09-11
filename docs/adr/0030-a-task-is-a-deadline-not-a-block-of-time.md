# A Task is a deadline, not a block of time

A Task's Due (#253) is a day, plus an optional floating clock time — never a duration, and never a
place on the Calendar's timed grid. Everywhere a due Task is shown outside the Tasks App itself (the
Calendar's grid, #260; the Reader's own chip row, #259) it renders as a **chip naming when it's due**,
never as an Occurrence with a start and an end. Decided while resolving [Due Tasks on the Calendar's
grid](https://github.com/vicvancooten/mail/issues/260) on the [Hub Apps
map](https://github.com/vicvancooten/mail/issues/158), formalising the rule `store/db.ts`, `packages/shared/src/tasks.ts`
and `store/tasks.ts` already cited by this number from #251 onward.

## Considered options

- **Render a due Task on the timed grid**, at its due time, sized to some default duration (a Reminder's
  own 30/60-minute placeholder, say): rejected. A Task has no end; inventing one would let it collide
  and stack with real Events in the interval-graph layout (`DayTimeGrid.tsx#layoutTimedEvents`) as if it
  competed for the same block of time it never claimed, and would need its own fabricated duration
  edited nowhere a User could see it.
- **A synthetic all-day Event materialised from a Task**, joined server-side so the existing Event
  pipeline renders it unchanged: rejected. It would put a Task's row into the `Event` collection and the
  materialiser (`docs/agents/domain.md`'s own Event/Occurrence model), which #260's own acceptance line
  rules out directly — "the overlay issues no request of its own and adds nothing to the `Event`
  collection or the materialiser." A Task and an Event stay two separate collections with no
  server-side join between them.
- **A due time as a position** on the all-day row (a short block starting at that time) rather than a
  text prefix: rejected. The all-day row has no time axis to begin with — every other chip in it (a
  multi-day all-day Event) already reads left-to-right by day, not by hour, and a Task competing for
  pixel width there would misread as a duration the same way rendering it on the timed grid would.

## Consequences

- A due Task never appears in Year view — there is no "block of time" small enough to summarize into a
  dot the way an Event's `has-events` marker does, and the ticket's own acceptance line says so directly.
- An overdue Task stays rendered on the day it was due, styled overdue, rather than rolling forward onto
  today — a grid that moved it would be lying about when it was due (#260's own words); the Tasks App's
  own Today view is where "gather every overdue Task" is instead a real feature (#254).
- The Calendar's slide-over lists Tasks as one fixed-colour row, never a `TaskList` with its own colour
  picker (`packages/shared/src/tasks.ts#taskListSchema` carries no `color` field) — a Task List is not a
  Calendar, and nothing here gives it one just to put a swatch next to it.
- A Task chip's popover offers no body editing — checkbox, title, Due, Task List and Open in Tasks only;
  the Tasks App (`TaskEditor.tsx`) stays the one place a Task's body is actually edited.
