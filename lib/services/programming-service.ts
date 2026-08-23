import type { Prisma } from "@/app/generated/prisma/client";
import type { RequestContext } from "@/lib/context";
import { emit } from "@/lib/events";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { scrapeMetadata } from "@/lib/og-metadata";
import {
  canEnter,
  fromProgrammingInput,
  isProgrammingManagedType,
  makeLabelResolver,
  missingFor,
  needsConfirmFirst,
  resolveProgrammingDisplay,
  toCalendarFields,
  toProgrammingTask,
} from "@/lib/programming";
import { isProgrammingStage, STAGES, type ProgrammingStage } from "@/lib/state/programming-stage";
import {
  fieldsForEvent,
  mergeFieldValues,
  sanitizeDetached,
  sanitizeFieldValues,
  type EventFieldDef,
} from "@/lib/event-fields";
import { loadEventFieldDefs } from "@/lib/event-fields-db";
import { assertWithinActiveSemester } from "./semester-bounds";
import type {
  AttachProgrammingDocInput,
  CreateProgrammingTaskInput,
  SetStageInput,
  UpdateProgrammingTaskInput,
} from "@/lib/validation/programming";

/**
 * ProgrammingEvent is the owning record. A CalendarEvent — the chapter-visible
 * mirror — exists only for CONFIRMED and DONE, created on promotion into
 * Confirmed and deleted on demotion out of it.
 *
 * That boundary moved here from Planning. Planning used to publish, which made
 * Idea→Planning a drag with no consequence anywhere and put dateless, placeless
 * events on everyone's calendar. Planning is now a private lane and Confirmed is
 * the one that costs a date and a location.
 */
function stageIsPublished(stage: ProgrammingStage | string): boolean {
  return stage === "confirmed" || stage === "done";
}

/**
 * Lane order, for telling a forward move from a backward one. Only forward moves
 * are gated — parking something is never a mistake the product should argue with,
 * and a free demotion is the documented escape from the published-event freeze.
 */
const STAGE_ORDER = STAGES;

const ROW_SELECT = {
  id:              true,
  title:           true,
  date:            true,
  category:        true,
  location:        true,
  time:            true,
  description:     true,
  status:          true,
  stage:           true,
  mandatory:       true,
  collabOrg:       true,
  attachmentUrl:   true,
  attachmentDocId: true,
  spendingCents:   true,
  successRating:   true,
  wrapUpNotes:     true,
  calendarEventId: true,
  ownerBrotherId:  true,
  ownerRoleId:     true,
  ownerNote:       true,
  fieldValues:     true,
  detachedFields:  true,
  // Nested so ownerLabel resolves a role's current holders without an N+1. The
  // holder list is brotherIds only; their org-local display names come from the
  // one roster read in `nameResolver` (Membership.name, not Brother.name).
  ownerBrother:    { select: { id: true, name: true } },
  ownerRole:       { select: { id: true, name: true, brothers: { select: { brotherId: true } } } },
  _count:          { select: { docs: true } },
} as const satisfies Prisma.ProgrammingEventSelect;

type ProgrammingRow = Prisma.ProgrammingEventGetPayload<{ select: typeof ROW_SELECT }>;
type ProgrammingDocLinkWithDoc = Prisma.ProgrammingEventDocGetPayload<{ include: { doc: true } }>;

function isServiceCategory(category: string) {
  return category === "service";
}

/**
 * The org's programming-managed event types (see isProgrammingManagedType):
 * everything creatable except chapter — built-ins and customs alike. Fetched
 * once per service call; used for the board's category filter, input
 * validation, and slug→label resolution on the DTO.
 */
async function managedTypes(ctx: RequestContext) {
  const rows = await ctx.db.calendarEventType.findMany({
    select: { slug: true, label: true, creatable: true, hidden: true },
  }) as { slug: string; label: string; creatable: boolean; hidden: boolean }[];
  return rows.filter(isProgrammingManagedType);
}

/**
 * brotherId → the name THIS ORG uses for that person.
 *
 * Owner labels must never render Brother.name, which is the account-canonical
 * string no roster shows (AGENTS.md: everything an org assesses about a member
 * lives on the Membership, including the name). One roster read serves every row
 * in the response, so a board of forty events costs one query, not forty.
 */
async function nameResolver(ctx: RequestContext): Promise<(brotherId: number) => string | null> {
  const roster = await ctx.db.member.listRoster();
  const byId = new Map(roster.map(m => [m.id, m.name]));
  return brotherId => byId.get(brotherId) ?? null;
}

/**
 * Everything a response needs beyond the rows themselves: the type labels, the
 * org's live field definitions, and the roster name map. Fetched once per service
 * call and threaded through, so the DTO mapping stays pure.
 */
interface ResponseDeps {
  labelFor: (slug: string) => string;
  nameFor: (brotherId: number) => string | null;
  defs: EventFieldDef[];
}

async function responseDeps(ctx: RequestContext, types: ManagedType[]): Promise<ResponseDeps> {
  const [nameFor, defs] = await Promise.all([nameResolver(ctx), loadEventFieldDefs(ctx.db)]);
  return { labelFor: makeLabelResolver(types), nameFor, defs };
}

/**
 * Map a row to the DTO, sanitizing its answers against the fields THIS EVENT
 * collects on the way out.
 *
 * Sanitizing on READ is what makes a switched-off field disappear from every
 * response while its answers stay on disk — the "OFF ≠ DELETE" rule, with no
 * extra machinery. The event's own opt-outs narrow that set further, so a field
 * detached from this one event stops reaching its sheet without touching what
 * every other event collects.
 */
function mapRow(row: ProgrammingRow, deps: ResponseDeps) {
  const detached = sanitizeDetached(row.detachedFields, deps.defs);
  return toProgrammingTask(
    row,
    deps.labelFor,
    deps.nameFor,
    sanitizeFieldValues(row.fieldValues, fieldsForEvent(deps.defs, detached)),
    detached,
  );
}

/**
 * Resolve + validate an input category against the org's managed types.
 * `hidden` types are retired: their existing events keep working, but new
 * events (and recategorizations) can't target them.
 */
function requireManagedCategory(
  types: { slug: string; hidden: boolean }[],
  slug: string,
) {
  const type = types.find(t => t.slug === slug);
  if (!type) throw new ValidationError(`Unknown event type "${slug}"`);
  if (type.hidden) throw new ValidationError(`The "${slug}" event type isn't available for new events`);
}

async function syncServiceEvent(
  tx: Prisma.TransactionClient,
  orgId: number,
  calendarEventId: number,
  row: { title: string; collabOrg: string; date: string | null; location: string | null },
) {
  const { title } = resolveProgrammingDisplay({ title: row.title, collabOrg: row.collabOrg });
  await tx.serviceEvent.upsert({
    where:  { calendarEventId },
    create: {
      organizationId:  orgId,
      title,
      date:            row.date ?? "",
      location:        row.location ?? "",
      notes:           "",
      calendarEventId,
    },
    update: {
      title,
      date:     row.date ?? "",
      location: row.location ?? "",
    },
  });
}

async function removeServiceEvent(tx: Prisma.TransactionClient, calendarEventId: number) {
  // deleteMany, not findUnique-then-delete: two concurrent demotes of the same
  // event both find the row, and the loser's delete() then throws P2025 on a row
  // that is already gone — surfacing as a bogus "Not found" on a click whose work
  // actually completed. deleteMany treats "already deleted" as 0 rows, not an error.
  await tx.serviceEvent.deleteMany({ where: { calendarEventId } });
}

type ManagedType = { slug: string; label: string; creatable: boolean; hidden: boolean };

async function requireProgrammingEvent(
  ctx: RequestContext,
  id: number,
): Promise<{ row: ProgrammingRow; types: ManagedType[] }> {
  // The scoped findUnique wrapper isn't select-narrowed in its return type; the
  // runtime select matches ROW_SELECT, so cast to the known payload.
  const row = await ctx.db.programmingEvent.findUnique({ where: { id }, select: ROW_SELECT }) as ProgrammingRow | null;
  const types = await managedTypes(ctx);
  if (!row || !types.some(t => t.slug === row.category)) {
    throw new NotFoundError("Programming event");
  }
  return { row, types };
}

async function loadTask(ctx: RequestContext, id: number, deps?: ResponseDeps) {
  const row = await ctx.db.programmingEvent.findUnique({ where: { id }, select: ROW_SELECT }) as ProgrammingRow | null;
  // Reload after a committed mutation — the row normally exists, but guard the
  // race where it's deleted in between so we return a clean 404 instead of a
  // raw TypeError 500. Mirrors requireProgrammingEvent above.
  if (!row) throw new NotFoundError("Programming event");
  return mapRow(row, deps ?? await responseDeps(ctx, await managedTypes(ctx)));
}

export async function listProgrammingTasks(ctx: RequestContext) {
  const types = await managedTypes(ctx);
  const [rows, deps] = await Promise.all([
    ctx.db.programmingEvent.findMany({
      where:   { category: { in: types.map(t => t.slug) } },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      select:  ROW_SELECT,
    }) as unknown as Promise<ProgrammingRow[]>,
    responseDeps(ctx, types),
  ]);
  return rows.map(row => mapRow(row, deps));
}

/**
 * Confirm an owner id belongs to THIS org before it reaches the FK.
 *
 * The foreign key would catch a fabricated id, but as a 409 naming a constraint;
 * a 400 naming the field is the error an officer can act on. More importantly the
 * FK alone would accept a *real* id belonging to ANOTHER org — Brother and Role
 * are both cross-org tables, and only the roster/role read here is org-scoped.
 */
async function assertOwnerInOrg(
  ctx: RequestContext,
  ownerBrotherId?: number | null,
  ownerRoleId?: number | null,
) {
  if (ownerBrotherId != null) {
    const member = await ctx.db.member.findByBrotherId(ownerBrotherId);
    if (!member) throw new ValidationError("That owner isn't on this org's roster");
  }
  if (ownerRoleId != null) {
    const role = await ctx.db.role.findFirst({ where: { id: ownerRoleId }, select: { id: true } });
    if (!role) throw new ValidationError("That owner role doesn't exist in this org");
  }
}

export async function createProgrammingTask(ctx: RequestContext, input: CreateProgrammingTaskInput) {
  const types = await managedTypes(ctx);
  requireManagedCategory(types, input.category);
  await assertOwnerInOrg(ctx, input.ownerBrotherId, input.ownerRoleId);
  // Requires an active semester even for a dateless Idea; when a dueDate is set
  // it must fall within the semester (it lands on the calendar on promotion).
  await assertWithinActiveSemester(ctx, input.dueDate);
  // Always starts in Idea: a ProgrammingEvent with no CalendarEvent.
  const data = fromProgrammingInput(input);
  const created = await ctx.db.programmingEvent.create({
    data: data as Omit<Prisma.ProgrammingEventUncheckedCreateInput, "organizationId">,
    select: ROW_SELECT,
  }) as unknown as ProgrammingRow;
  await emit(ctx, "programming.created", { type: "ProgrammingEvent", id: created.id }, {
    title: created.title, stage: created.stage,
  });
  return mapRow(created, await responseDeps(ctx, types));
}

/**
 * Fields whose edit is refused on a PUBLISHED event (Confirmed / Done).
 *
 * Confirmed sits on everyone's Timeline, so silently moving the room or the date
 * changes a plan people have already made around. The rule belongs on the server,
 * not only in the panel — a stale tab or a direct PATCH is the same edit.
 *
 * The exit is demotion, which is free and which the error names: move it back to
 * Planning, change it, confirm it again. That sequence is visible (the event
 * leaves the Timeline and comes back), which is exactly the point.
 *
 * Wrap-up fields are deliberately NOT frozen — successRating, wrapUpNotes and
 * spendingCents are what a Done event exists to collect.
 */
const FROZEN_WHEN_PUBLISHED = ["title", "dueDate", "location", "time", "category", "mandatory", "collab"] as const;

export async function updateProgrammingTask(ctx: RequestContext, id: number, input: UpdateProgrammingTaskInput) {
  const { row: existing, types } = await requireProgrammingEvent(ctx, id);

  if (stageIsPublished(existing.stage)) {
    const frozen = FROZEN_WHEN_PUBLISHED.filter(f => input[f] !== undefined);
    if (frozen.length > 0) {
      throw new ValidationError(
        `This event is published to the chapter, so its ${frozen.join(", ")} can't be edited here. Move it back to Planning first, then confirm it again.`,
      );
    }
  }

  await assertOwnerInOrg(ctx, input.ownerBrotherId, input.ownerRoleId);

  const data: Prisma.ProgrammingEventUncheckedUpdateInput = {};
  const changedFields: string[] = [];

  if (input.title !== undefined)        { data.title = input.title.trim(); changedFields.push("title"); }
  if (input.collab !== undefined)       { data.collabOrg = input.collab?.trim() ?? ""; changedFields.push("collabOrg"); }
  if (input.dueDate !== undefined) {
    // A published event (Confirmed+) is on the calendar and must keep a date.
    if (input.dueDate == null && stageIsPublished(existing.stage)) {
      throw new ValidationError("A published event must keep its date. Move it back to Planning first to clear the date.");
    }
    // Setting a concrete date must stay within the active semester; clearing it
    // to null (Idea/Planning only, handled above) is exempt.
    if (input.dueDate != null) await assertWithinActiveSemester(ctx, input.dueDate);
    data.date = input.dueDate;
    changedFields.push("date");
  }
  if (input.location !== undefined)     { data.location = input.location?.trim() || null; changedFields.push("location"); }
  if (input.time !== undefined)         { data.time = input.time?.trim() || null; changedFields.push("time"); }
  // Setting one owner clears the other: an event is owned by a person OR a role,
  // and leaving the old FK behind would leave two owners on the row for
  // resolveOwner to pick between by declaration order.
  if (input.ownerBrotherId !== undefined) {
    data.ownerBrotherId = input.ownerBrotherId;
    if (input.ownerBrotherId != null) data.ownerRoleId = null;
    changedFields.push("owner");
  }
  if (input.ownerRoleId !== undefined) {
    data.ownerRoleId = input.ownerRoleId;
    if (input.ownerRoleId != null) data.ownerBrotherId = null;
    if (!changedFields.includes("owner")) changedFields.push("owner");
  }
  if (input.mandatory !== undefined)    { data.mandatory = input.mandatory; changedFields.push("mandatory"); }
  if (input.status !== undefined)       { data.status = input.status; changedFields.push("status"); }
  if (input.description !== undefined)  { data.description = input.description; changedFields.push("description"); }
  if (input.attachmentUrl !== undefined) { data.attachmentUrl = input.attachmentUrl; changedFields.push("attachmentUrl"); }
  if (input.attachmentDocId !== undefined) { data.attachmentDocId = input.attachmentDocId; changedFields.push("attachmentDocId"); }
  if (input.spendingCents !== undefined) { data.spendingCents = input.spendingCents; changedFields.push("spendingCents"); }
  if (input.successRating !== undefined) { data.successRating = input.successRating; changedFields.push("successRating"); }
  if (input.wrapUpNotes !== undefined)  { data.wrapUpNotes = input.wrapUpNotes; changedFields.push("wrapUpNotes"); }
  if (input.category !== undefined)     { requireManagedCategory(types, input.category); data.category = input.category; changedFields.push("category"); }

  const deps = await responseDeps(ctx, types);

  // Answers to the org's optional fields. Merged over what's stored (a PATCH
  // carries only the edited slugs) and sanitized against the LIVE definitions, so
  // an unknown slug is dropped, a value is coerced to its field's kind, and an
  // explicit empty clears the answer.
  // Which optional fields THIS event collects. Sent whole (the full opt-out set)
  // rather than as a delta, so the pill row is describing a state and two officers
  // racing can't interleave into a set neither of them chose.
  //
  // Detaching CLEARS that event's answer, which is the one place this model parts
  // company with the org-level switch: org-off hides and preserves, because it is
  // reversible bookkeeping about the whole chapter, whereas detaching is a claim
  // that this field was never part of THIS event. Leaving a hidden answer behind
  // would resurface it the moment someone reattached — and the UI warns before
  // doing it, so the loss is chosen rather than discovered.
  const nextDetached = input.detachedFields !== undefined
    ? sanitizeDetached(input.detachedFields, deps.defs)
    : sanitizeDetached(existing.detachedFields, deps.defs);

  if (input.detachedFields !== undefined) {
    data.detachedFields = nextDetached;
    changedFields.push("detachedFields");
  }

  const nowDetached = new Set(nextDetached);
  const wasDetached = new Set(sanitizeDetached(existing.detachedFields, deps.defs));
  const newlyDetached = [...nowDetached].filter(s => !wasDetached.has(s));

  if (input.fieldValues !== undefined || newlyDetached.length > 0) {
    const merged = mergeFieldValues(
      existing.fieldValues,
      input.fieldValues ?? {},
      // Merge against the org's set, not the event's: a slug being cleared for
      // detachment must still be recognised here, or sanitize would drop it as
      // unknown and the stored answer would survive the detach.
      deps.defs,
    );
    for (const slug of newlyDetached) delete merged[slug];
    data.fieldValues = merged;
    if (!changedFields.includes("fieldValues")) changedFields.push("fieldValues");
  }

  const nextCategory = (data.category as string | undefined) ?? existing.category;
  const wasService   = isServiceCategory(existing.category);
  const willService  = isServiceCategory(nextCategory);

  await ctx.db.$transaction(async (tx) => {
    const updated = await tx.programmingEvent.update({
      where: { id },
      data,
      select: ROW_SELECT,
    });

    // Mirror calendar-relevant fields onto the CalendarEvent if this event is
    // published (Confirmed+). Idea and Planning have no calendar row to mirror to.
    if (updated.calendarEventId != null) {
      await tx.calendarEvent.update({
        where: { id: updated.calendarEventId },
        data:  toCalendarFields(updated),
      });
      if (willService) {
        await syncServiceEvent(tx, ctx.orgId, updated.calendarEventId, updated);
      } else if (wasService) {
        await removeServiceEvent(tx, updated.calendarEventId);
      }
    }
  });

  const full = await loadTask(ctx, id, deps);
  // Emitted on EVERY edit, unlike the calendar.updated below it. Updates used to
  // ride on that event alone, so an Idea-stage edit emitted nothing at all —
  // and moving the publish boundary to Confirmed widened that silent window from
  // one lane to two.
  await emit(ctx, "programming.updated", { type: "ProgrammingEvent", id }, {
    title: full.title, stage: full.stage, changedFields,
  });
  if (existing.calendarEventId != null) {
    await emit(ctx, "calendar.updated", { type: "CalendarEvent", id: existing.calendarEventId }, {
      title: full.title, changedFields,
    });
  }
  return full;
}

// Thrown to unwind the setStage transaction when a concurrent request already
// claimed the same stage transition. A unique symbol, so it can never collide
// with a real error: the catch rethrows anything that isn't identity-equal to
// it, and this value never escapes the function.
const RACE_LOST = Symbol("programming.stage.race-lost");

/**
 * Promote/demote engine, and the one place the lane rules are enforced.
 *
 * Crossing into CONFIRMED creates the CalendarEvent (and a ServiceEvent for
 * service-category events) — that is what "published to the chapter" means.
 * Dropping back to Planning or Idea deletes it. Lateral moves between Idea and
 * Planning, or Confirmed and Done, only flip the stage column.
 *
 * Forward moves are gated by the event's own FIELDS (canEnter), and the error
 * NAMES what's missing rather than counting it. Backward moves are always free:
 * parking something is never a mistake the product should argue with, and
 * demotion is the documented escape from the published-event freeze.
 */
export async function setStage(ctx: RequestContext, id: number, input: SetStageInput) {
  const next = input.stage;
  if (!isProgrammingStage(next)) throw new ValidationError("Unknown stage");
  const { row: pe, types } = await requireProgrammingEvent(ctx, id);
  const deps = await responseDeps(ctx, types);
  if (pe.stage === next) return mapRow(pe, deps);

  const forward = STAGE_ORDER.indexOf(next) > STAGE_ORDER.indexOf(pe.stage as ProgrammingStage);

  if (forward) {
    // Done is the one gate that isn't about fields: a complete Planning event
    // already satisfies everything Confirmed needs, so without this the stage
    // control takes it straight to Done — publishing it to the chapter (Done
    // publishes too) with a toast that only says "wrapped". Nobody is ever told
    // the chapter can now see it.
    if (needsConfirmFirst(pe, next)) {
      throw new ValidationError(
        "Confirm this event before wrapping it. Done means it happened, and the chapter was never told it was on.",
      );
    }
    if (!canEnter(pe, next)) {
      const missing = missingFor(pe, next).map(f => f.label.toLowerCase());
      throw new ValidationError(
        `Needs ${missing.join(" + ")} before it can move to ${next}.`,
        { missing: missingFor(pe, next).map(f => f.key) },
      );
    }
  }

  const willPublish = stageIsPublished(next);
  const promoting = willPublish && pe.calendarEventId == null;
  const demoting  = !willPublish && pe.calendarEventId != null;

  // Promotion puts the event on the chapter's calendar — its date (set while in
  // Idea or Planning, where the bound isn't enforced) must fall in the active
  // semester. canEnter already guarantees a date exists by this point.
  if (promoting) await assertWithinActiveSemester(ctx, pe.date);

  let createdCalendarId: number | null = null;
  let deletedCalendarId: number | null = null;
  // Set when a concurrent request already performed this exact transition. Not an
  // error for the user — the event IS confirmed, just not by this request — so the
  // transaction unwinds and we fall through to returning the winner's state.
  let lostRace = false;

  try {
    await ctx.db.$transaction(async (tx) => {
      if (promoting) {
        const ce = await tx.calendarEvent.create({
          data: { organizationId: ctx.orgId, ...toCalendarFields(pe) },
        });
        // CLAIM the transition, don't assume it. `promoting` was decided from a
        // read taken before this transaction opened, so two confirms of the same
        // event both see calendarEventId == null and both reach this point. The
        // `calendarEventId: null` guard makes the link a one-shot claim: the
        // loser matches 0 rows and throws out, rolling back its CalendarEvent
        // rather than overwriting the link and orphaning the winner's row on the
        // Timeline with nothing able to edit or delete it.
        const claimed = await tx.programmingEvent.updateMany({
          where: { id, organizationId: ctx.orgId, calendarEventId: null },
          data:  { stage: next, calendarEventId: ce.id },
        });
        if (claimed.count === 0) { lostRace = true; throw RACE_LOST; }
        if (isServiceCategory(pe.category)) {
          await syncServiceEvent(tx, ctx.orgId, ce.id, pe);
        }
        createdCalendarId = ce.id;
      } else if (demoting) {
        const calId = pe.calendarEventId!;
        if (isServiceCategory(pe.category)) await removeServiceEvent(tx, calId);
        // Same one-shot claim on the way down: two concurrent demotes would both
        // try to delete the same CalendarEvent, and the loser would fail on a row
        // that no longer exists. Releasing the link is what earns the delete.
        const released = await tx.programmingEvent.updateMany({
          where: { id, organizationId: ctx.orgId, calendarEventId: calId },
          data:  { stage: next, calendarEventId: null },
        });
        if (released.count === 0) { lostRace = true; throw RACE_LOST; }
        await tx.calendarEvent.delete({ where: { id: calId } });
        deletedCalendarId = calId;
      } else {
        await tx.programmingEvent.update({ where: { id }, data: { stage: next } });
      }
    });
  } catch (e) {
    if (e !== RACE_LOST) throw e;
  }

  // The other request already did this, emitted the events, and its CalendarEvent
  // is the live one. Return the committed state instead of a spurious error.
  if (lostRace) return loadTask(ctx, id, deps);

  // `published` says whether this move changed what the CHAPTER can see, which is
  // the fact a notification handler would care about — a stage column moving is
  // not, on its own, news.
  await emit(ctx, "programming.stage_changed", { type: "ProgrammingEvent", id }, {
    title: pe.title, from: pe.stage, to: next, published: stageIsPublished(next),
  });
  if (createdCalendarId != null) {
    await emit(ctx, "calendar.created", { type: "CalendarEvent", id: createdCalendarId }, {
      title: pe.title, date: pe.date ?? "", category: pe.category,
    });
  }
  if (deletedCalendarId != null) {
    await emit(ctx, "calendar.deleted", { type: "CalendarEvent", id: deletedCalendarId }, { title: pe.title });
  }
  return loadTask(ctx, id, deps);
}

export async function deleteProgrammingTask(ctx: RequestContext, id: number) {
  const { row: target } = await requireProgrammingEvent(ctx, id);

  await ctx.db.$transaction(async (tx) => {
    if (target.calendarEventId != null) {
      if (isServiceCategory(target.category)) await removeServiceEvent(tx, target.calendarEventId);
      // Deleting the PE first would SET NULL then orphan the CalendarEvent; null
      // the link, delete the calendar row, then delete the PE (docs cascade).
      //
      // The stage is demoted in the SAME statement, not left alone: the publish
      // CHECK says a confirmed/done row must have a CalendarEvent, so nulling the
      // link on a published event is a violation even though the row is about to
      // disappear. Postgres checks per-statement, not at commit.
      await tx.programmingEvent.update({ where: { id }, data: { calendarEventId: null, stage: "idea" } });
      await tx.calendarEvent.delete({ where: { id: target.calendarEventId } });
    }
    await tx.programmingEvent.delete({ where: { id } });
  });

  await emit(ctx, "programming.deleted", { type: "ProgrammingEvent", id }, { title: target.title });
  if (target.calendarEventId != null) {
    await emit(ctx, "calendar.deleted", { type: "CalendarEvent", id: target.calendarEventId }, { title: target.title });
  }
}

/* ---------------------------------------------------------------- */
/* Docs                                                              */
/* ---------------------------------------------------------------- */

export async function listProgrammingEventDocs(ctx: RequestContext, eventId: number) {
  await requireProgrammingEvent(ctx, eventId);
  const links = await ctx.db.programmingEventDoc.findMany({
    where:   { programmingEventId: eventId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: { doc: true },
  }) as ProgrammingDocLinkWithDoc[];
  return links.map(link => link.doc);
}

export async function attachProgrammingDoc(ctx: RequestContext, eventId: number, input: AttachProgrammingDocInput) {
  await requireProgrammingEvent(ctx, eventId);
  const meta = await scrapeMetadata(input.url).catch(() => null);
  const { doc } = await ctx.db.$transaction(async (tx) => {
    const doc = await tx.doc.create({
      data: {
        organizationId: ctx.orgId,
        title:          input.title,
        url:            input.url,
        description:    input.description ?? null,
        ogImage:        meta?.ogImage    ?? null,
        ogTitle:        meta?.ogTitle    ?? null,
        faviconUrl:     meta?.faviconUrl ?? null,
        embedOk:        meta?.embedOk    ?? null,
        createdById:    ctx.actorId,
      },
    });
    const link = await tx.programmingEventDoc.create({
      data: { organizationId: ctx.orgId, programmingEventId: eventId, docId: doc.id },
    });
    return { doc, link };
  });
  await emit(ctx, "doc.created", { type: "Doc", id: doc.id }, { title: doc.title, url: doc.url });
  return doc;
}

export async function detachProgrammingDoc(ctx: RequestContext, eventId: number, docId: number) {
  await requireProgrammingEvent(ctx, eventId);
  const link = await ctx.db.programmingEventDoc.findFirst({
    where: { docId, programmingEventId: eventId },
    include: { doc: true },
  }) as ProgrammingDocLinkWithDoc | null;
  if (!link) throw new NotFoundError("Doc");
  await ctx.db.$transaction(async (tx) => {
    await tx.programmingEventDoc.delete({ where: { id: link.id } });
    await tx.doc.delete({ where: { id: docId } });
  });
  await emit(ctx, "doc.deleted", { type: "Doc", id: docId }, { title: link.doc.title });
}
