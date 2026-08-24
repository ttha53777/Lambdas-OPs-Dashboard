/**
 * Tests for the programming service. ProgrammingEvent is the owning record; a
 * CalendarEvent — the chapter-visible mirror — exists only once an event reaches
 * CONFIRMED. Planning is a private lane, which is the v3 change these tests pin.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testPrisma, resetDb } from "../setup/prisma";
import { createOrg, createBrother, createCalendarEvent, createEventType, createSemester } from "../setup/factories";
import { db } from "@/lib/db";
import {
  createProgrammingTask,
  deleteProgrammingTask,
  listProgrammingTasks,
  setStage,
  updateProgrammingTask,
} from "@/lib/services/programming-service";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { canEnter } from "@/lib/programming";
import { updateProgrammingTaskInput } from "@/lib/validation/programming";
import type { RequestContext } from "@/lib/context";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

function ctxFor(orgId: number, actorId: number): RequestContext {
  return {
    requestId:       randomUUID(),
    orgId,
    actorId,
    actorName:       "Tester",
    actorEmail:      null,
    authUserId:      "auth-test",
    membershipId:    null,
    permissions:     0,
    maxRank:         0,
    isOrgAdmin:      true,
    isPlatformAdmin: false,
    db:              db(orgId),
  };
}

async function seedOrg() {
  const org = await createOrg("Prog Org", "prog-org");
  const admin = await createBrother({ orgId: org.id, isOrgAdmin: true });
  // Dated items now require an active semester that contains their date; these
  // tests use dates across all of 2026, so seed a year-wide active semester.
  await createSemester({ orgId: org.id, startDate: "2026-01-01", endDate: "2026-12-31" });
  // program/social/fundy are org-owned CUSTOM types now (only chapter/party/
  // deadline/service are built-ins) — give this org the LPE-style vocabulary.
  await createEventType({ orgId: org.id, slug: "program", label: "Program" });
  await createEventType({ orgId: org.id, slug: "social",  label: "Social" });
  await createEventType({ orgId: org.id, slug: "fundy",   label: "Fundraiser" });
  return { org, admin };
}

/** A second roster member, for use as an event owner. */
async function seedOwner(orgId: number, name = "Maya Chen") {
  return createBrother({ orgId, name });
}

/**
 * Create + promote to confirmed (gives the event a CalendarEvent).
 *
 * Confirming needs an owner, a date AND a location now, so the helper supplies
 * an owner unless the caller names one — every caller here is testing the
 * calendar mirror, not the gate.
 */
async function createConfirmed(ctx: RequestContext, input: Parameters<typeof createProgrammingTask>[1]) {
  const owner = input.ownerBrotherId ?? (await seedOwner(ctx.orgId, `Owner ${Math.random().toString(36).slice(2, 7)}`)).id;
  const task = await createProgrammingTask(ctx, { ...input, ownerBrotherId: owner });
  return setStage(ctx, task.id, { stage: "confirmed" });
}

describe("createProgrammingTask", () => {
  it("starts in Idea with no CalendarEvent", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);

    const task = await createProgrammingTask(ctx, { title: "Speaker Series", category: "program" });

    expect(task.stage).toBe("idea");
    expect(task.type).toBe("Program");
    expect(task.dueDate).toBeNull();

    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: task.id } });
    expect(pe?.calendarEventId).toBeNull();
    expect(pe?.category).toBe("program");
    expect(await testPrisma.calendarEvent.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it("stores collab in collabOrg with a clean title", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);

    const task = await createProgrammingTask(ctx, { title: "Brotherhood Social", collab: "KDF", category: "social" });
    expect(task.title).toBe("Brotherhood Social");
    expect(task.collab).toBe("KDF");

    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: task.id } });
    expect(pe?.collabOrg).toBe("KDF");
  });
});

describe("listProgrammingTasks", () => {
  it("returns program, social, fundy, and service programming events", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);

    await createProgrammingTask(ctx, { title: "Program Night", category: "program" });
    await createProgrammingTask(ctx, { title: "Mixer", category: "social" });
    await createProgrammingTask(ctx, { title: "Philanthropy", category: "fundy" });
    await createProgrammingTask(ctx, { title: "Park Cleanup", category: "service" });
    // A non-programming calendar row should not surface as a task.
    await createCalendarEvent({ orgId: org.id, title: "Chapter Mtg", category: "chapter" });

    const tasks = await listProgrammingTasks(ctx);
    expect(tasks).toHaveLength(4);
    expect(tasks.map(t => t.title).sort()).toEqual(["Mixer", "Park Cleanup", "Philanthropy", "Program Night"]);
    expect(tasks.find(t => t.title === "Park Cleanup")?.type).toBe("Community Service");
  });
});

describe("setStage", () => {
  it("refuses Idea → Planning without an owner", async () => {
    // The rule that gives Idea→Planning a meaning. Before v3 this drag recorded
    // a decision with no consequence anywhere — Planning already published.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Unowned", category: "program" });

    await expect(setStage(ctx, task.id, { stage: "planning" })).rejects.toThrow(/owner/i);
  });

  it("accepts Idea → Planning with a person owner, and creates NO CalendarEvent", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const owner = await seedOwner(org.id);
    const task = await createProgrammingTask(ctx, {
      title: "Speaker Series", category: "program", ownerBrotherId: owner.id,
    });

    const planning = await setStage(ctx, task.id, { stage: "planning" });
    expect(planning.stage).toBe("planning");
    expect(planning.owner).toMatchObject({ kind: "brother", id: owner.id });

    // The v3 publish boundary: Planning is PRIVATE.
    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: task.id } });
    expect(pe?.calendarEventId).toBeNull();
    expect(await testPrisma.calendarEvent.count({ where: { organizationId: org.id } })).toBe(0);
  });

  it("accepts a ROLE owner, and resolves it to today's holders", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const role = await testPrisma.role.create({
      data: { organizationId: org.id, name: "Social Chair", rank: 1, permissions: 0 },
    });
    const holder = await seedOwner(org.id, "Maya Chen");
    await testPrisma.brotherRole.create({
      data: { organizationId: org.id, brotherId: holder.id, roleId: role.id },
    });

    const task = await createProgrammingTask(ctx, {
      title: "Mixer", category: "social", ownerRoleId: role.id,
    });
    const planning = await setStage(ctx, task.id, { stage: "planning" });

    expect(planning.stage).toBe("planning");
    expect(planning.owner).toMatchObject({ kind: "role", name: "Social Chair", holders: ["Maya Chen"] });
  });

  it("refuses Planning → Confirmed missing a date OR a location, naming what's missing", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const owner = await seedOwner(org.id);

    const noLocation = await createProgrammingTask(ctx, {
      title: "No place", category: "program", ownerBrotherId: owner.id, dueDate: "2026-09-15",
    });
    await expect(setStage(ctx, noLocation.id, { stage: "confirmed" })).rejects.toThrow(/location/i);

    const noDate = await createProgrammingTask(ctx, {
      title: "No date", category: "program", ownerBrotherId: owner.id, location: "EMU",
    });
    await expect(setStage(ctx, noDate.id, { stage: "confirmed" })).rejects.toThrow(/date/i);
  });

  it("publishes to the chapter at Confirmed by creating the CalendarEvent", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const owner = await seedOwner(org.id);
    const task = await createProgrammingTask(ctx, {
      title: "Speaker Series", dueDate: "2026-09-15", location: "EMU", time: "7:00 PM",
      category: "program", ownerBrotherId: owner.id,
    });

    const confirmed = await setStage(ctx, task.id, { stage: "confirmed" });
    expect(confirmed.stage).toBe("confirmed");

    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: task.id } });
    expect(pe?.calendarEventId).not.toBeNull();
    const ce = await testPrisma.calendarEvent.findUnique({ where: { id: pe!.calendarEventId! } });
    expect(ce?.title).toBe("Speaker Series");
    expect(ce?.date).toBe("2026-09-15");
    expect(ce?.category).toBe("program");
  });

  it("refuses Planning → Done even when every field is answered", async () => {
    // A complete Planning event satisfies every FIELD Confirmed needs. Without
    // this guard it would go straight to Done — published to the chapter with a
    // toast that only says "wrapped", so nobody is told the chapter can see it.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const owner = await seedOwner(org.id);
    const task = await createProgrammingTask(ctx, {
      title: "Complete", dueDate: "2026-09-15", location: "EMU", category: "program", ownerBrotherId: owner.id,
    });
    await setStage(ctx, task.id, { stage: "planning" });

    await expect(setStage(ctx, task.id, { stage: "done" })).rejects.toThrow(/confirm/i);
  });

  it("allows Confirmed → Done", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Wrapped", dueDate: "2026-09-15", location: "EMU", category: "program",
    });
    const done = await setStage(ctx, confirmed.id, { stage: "done" });
    expect(done.stage).toBe("done");
    // Done still publishes — the CalendarEvent stays.
    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } });
    expect(pe?.calendarEventId).not.toBeNull();
  });

  it("creates a ServiceEvent when a service event is confirmed", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);

    const promoted = await createConfirmed(ctx, {
      title: "Park Cleanup", dueDate: "2026-09-18", location: "City Park", category: "service",
    });
    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: promoted.id } });
    const svc = await testPrisma.serviceEvent.findUnique({ where: { calendarEventId: pe!.calendarEventId! } });
    expect(svc?.title).toBe("Park Cleanup");
    expect(svc?.location).toBe("City Park");
  });

  it("unpublishes on Confirmed → Planning, deleting the CalendarEvent but keeping the event", async () => {
    // Backward moves are always free — parking something is never a mistake the
    // product should argue with, and this is the documented escape from the
    // published-event freeze.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Park Cleanup", dueDate: "2026-09-18", location: "City Park", category: "service",
    });
    const calId = (await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } }))!.calendarEventId!;

    const demoted = await setStage(ctx, confirmed.id, { stage: "planning" });
    expect(demoted.stage).toBe("planning");

    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } });
    expect(pe).not.toBeNull();                 // event preserved
    expect(pe?.calendarEventId).toBeNull();    // no longer on the chapter's calendar
    expect(await testPrisma.calendarEvent.findUnique({ where: { id: calId } })).toBeNull();
    expect(await testPrisma.serviceEvent.findUnique({ where: { calendarEventId: calId } })).toBeNull();
  });

  it("a double-clicked Confirm publishes exactly one CalendarEvent", async () => {
    // The double-click. setStage decides `promoting` from a read taken before its
    // transaction opens, so two in-flight confirms both saw calendarEventId ==
    // null and both created a calendar row; the second UPDATE overwrote the link
    // and left the first row orphaned — on every member's Timeline, absent from
    // the Events board (which lists ProgrammingEvent), and editable from nowhere.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const owner = await seedOwner(org.id, "Race Owner");
    const task = await createProgrammingTask(ctx, {
      title: "Double Clicked", category: "social", dueDate: "2026-09-12",
      location: "House", ownerBrotherId: owner.id,
    });

    // Both settle: losing the race is not a user-visible error, the event IS
    // confirmed — just not by this request.
    const results = await Promise.allSettled([
      setStage(ctx, task.id, { stage: "confirmed" }),
      setStage(ctx, task.id, { stage: "confirmed" }),
    ]);
    expect(results.every(r => r.status === "fulfilled")).toBe(true);
    expect(results.every(r => (r as PromiseFulfilledResult<{ stage: string }>).value.stage === "confirmed")).toBe(true);

    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: task.id } });
    expect(pe?.calendarEventId).not.toBeNull();

    // The real assertion: no calendar row exists that no ProgrammingEvent owns.
    const calendarRows = await testPrisma.calendarEvent.findMany({ where: { organizationId: org.id } });
    expect(calendarRows).toHaveLength(1);
    expect(calendarRows[0].id).toBe(pe!.calendarEventId);
  });

  it("a double-clicked demote deletes the CalendarEvent exactly once", async () => {
    // Mirror image: both demotes read the same calendarEventId, and the loser
    // deleted a CalendarEvent (and ServiceEvent) that was already gone, throwing
    // a bogus "Not found" on a click whose work had in fact completed.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Park Cleanup", dueDate: "2026-09-19", location: "City Park", category: "service",
    });

    const results = await Promise.allSettled([
      setStage(ctx, confirmed.id, { stage: "planning" }),
      setStage(ctx, confirmed.id, { stage: "planning" }),
    ]);
    expect(results.every(r => r.status === "fulfilled")).toBe(true);

    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } });
    expect(pe?.calendarEventId).toBeNull();
    expect(await testPrisma.calendarEvent.findMany({ where: { organizationId: org.id } })).toHaveLength(0);
    expect(await testPrisma.serviceEvent.findMany({ where: { organizationId: org.id } })).toHaveLength(0);
  });

  it("re-confirming after demotion recreates a CalendarEvent", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Mixer", dueDate: "2026-09-01", location: "House", category: "social",
    });
    await setStage(ctx, confirmed.id, { stage: "idea" });

    const re = await setStage(ctx, confirmed.id, { stage: "confirmed" });
    expect(re.stage).toBe("confirmed");
    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } });
    expect(pe?.calendarEventId).not.toBeNull();
  });

  it("rejects an owner from another org", async () => {
    const { org, admin } = await seedOrg();
    const other = await createOrg("Other Org", "other-org");
    const stranger = await createBrother({ orgId: other.id, name: "Stranger" });
    const ctx = ctxFor(org.id, admin.id);

    // The FK alone would accept this — Brother is a cross-org table, and only the
    // org-scoped roster read catches it.
    await expect(
      createProgrammingTask(ctx, { title: "Mixer", category: "social", ownerBrotherId: stranger.id }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("updateProgrammingTask / deleteProgrammingTask", () => {
  it("rejects unknown programming events", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);

    await expect(updateProgrammingTask(ctx, 999999, { status: "Complete" })).rejects.toThrow(NotFoundError);
    await expect(deleteProgrammingTask(ctx, 999999)).rejects.toThrow(NotFoundError);
  });

  it("freezes the details of a PUBLISHED event, and names the way out", async () => {
    // Confirmed sits on everyone's Timeline, so silently moving the room or the
    // date rewrites a plan people already made around. The rule lives on the
    // server, not just in the panel — a stale tab is the same edit.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Tabling", dueDate: "2026-10-01", location: "Main Quad", category: "social",
    });

    await expect(updateProgrammingTask(ctx, confirmed.id, { location: "Parking Lot B" }))
      .rejects.toThrow(/back to Planning/i);
    await expect(updateProgrammingTask(ctx, confirmed.id, { dueDate: "2026-10-02" }))
      .rejects.toThrow(/back to Planning/i);

    // Wrap-up fields are deliberately NOT frozen — they are what a finished
    // event exists to collect.
    const rated = await updateProgrammingTask(ctx, confirmed.id, { successRating: 4, spendingCents: 900 });
    expect(rated.successRating).toBe(4);
    expect(rated.spendingCents).toBe(900);
  });

  // The wrap-up modal writes the rating BEFORE the stage move, so that a failed
  // move leaves the rating rather than losing it. That ordering is only legal
  // because the wrap-up fields are outside the frozen set — pin the whole
  // sequence, not just the freeze exemption.
  it("accepts the wrap-up patch then the move to Done, in that order", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Alumni Dinner", dueDate: "2026-10-04", location: "Chapter House", category: "social",
    });

    const rated = await updateProgrammingTask(ctx, confirmed.id, {
      successRating: 5, wrapUpNotes: "Book the caterer earlier next year.",
    });
    expect(rated.stage).toBe("confirmed");
    expect(rated.successRating).toBe(5);

    const done = await setStage(ctx, confirmed.id, { stage: "done" });
    expect(done.stage).toBe("done");
    // The record survives the move intact.
    expect(done.successRating).toBe(5);
    expect(done.wrapUpNotes).toBe("Book the caterer earlier next year.");
  });

  // The calendar's drop rule, pinned at the layer that matters: setting a date
  // must not publish. Auto-promoting here would put the event in front of the
  // whole chapter as a side effect of a drag aimed at a calendar square.
  it("setting a date on a Planning event does NOT create a CalendarEvent", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const owner = await seedOwner(org.id, "Maya Chen");
    const task = await createProgrammingTask(ctx, {
      title: "Retreat", category: "program", ownerBrotherId: owner.id, location: "Lodge",
    });
    await setStage(ctx, task.id, { stage: "planning" });

    const dated = await updateProgrammingTask(ctx, task.id, { dueDate: "2026-09-26" });
    expect(dated.stage).toBe("planning");
    expect(dated.dueDate).toBe("2026-09-26");
    // Complete enough to confirm — but still not confirmed, because nobody said so.
    expect(canEnter(dated, "confirmed")).toBe(true);
    expect(
      (await testPrisma.programmingEvent.findUnique({ where: { id: task.id } }))!.calendarEventId,
    ).toBeNull();
  });

  it("mirrors an edit to the CalendarEvent after demoting to Planning", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Tabling", dueDate: "2026-10-01", location: "Main Quad", category: "social",
    });

    await setStage(ctx, confirmed.id, { stage: "planning" });
    const updated = await updateProgrammingTask(ctx, confirmed.id, {
      category: "fundy", location: "Parking Lot B", time: "11:00 AM", collab: "DSP",
    });
    expect(updated.type).toBe("Fundraiser");
    expect(updated.location).toBe("Parking Lot B");
    expect(updated.collab).toBe("DSP");

    const reconfirmed = await setStage(ctx, confirmed.id, { stage: "confirmed" });
    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: reconfirmed.id } });
    const ce = await testPrisma.calendarEvent.findUnique({ where: { id: pe!.calendarEventId! } });
    expect(ce?.category).toBe("fundy");
    expect(ce?.location).toBe("Parking Lot B");
  });

  it("rejects clearing the date on a published event", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Mixer", dueDate: "2026-09-01", location: "House", category: "social",
    });

    await expect(updateProgrammingTask(ctx, confirmed.id, { dueDate: null })).rejects.toThrow(ValidationError);
  });

  it("allows clearing the date on an Idea event", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Idea", dueDate: "2026-09-01", category: "social" });

    const updated = await updateProgrammingTask(ctx, task.id, { dueDate: null });
    expect(updated.dueDate).toBeNull();
  });

  it("updates wrap-up fields", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Block Party", category: "social" });

    const updated = await updateProgrammingTask(ctx, task.id, {
      spendingCents: 12500, successRating: 4, wrapUpNotes: "Good turnout",
    });
    expect(updated.spendingCents).toBe(12500);
    expect(updated.successRating).toBe(4);
    expect(updated.wrapUpNotes).toBe("Good turnout");
  });

  it("swapping owner kinds clears the other FK", async () => {
    // An event is owned by a person OR a role. Leaving the old FK behind would
    // put two owners on the row for resolveOwner to pick between by declaration
    // order — which is not a decision anyone made.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const person = await seedOwner(org.id, "Maya Chen");
    const role = await testPrisma.role.create({
      data: { organizationId: org.id, name: "Social Chair", rank: 1, permissions: 0 },
    });

    const task = await createProgrammingTask(ctx, {
      title: "Mixer", category: "social", ownerBrotherId: person.id,
    });
    const swapped = await updateProgrammingTask(ctx, task.id, { ownerRoleId: role.id });
    expect(swapped.owner).toMatchObject({ kind: "role", id: role.id });

    const pe = await testPrisma.programmingEvent.findUnique({ where: { id: task.id } });
    expect(pe?.ownerBrotherId).toBeNull();
    expect(pe?.ownerRoleId).toBe(role.id);
  });

  // The picker's "Unassign" writes exactly this. Clearing has to actually
  // re-close the Planning gate, or the board would keep an event in a lane it no
  // longer qualifies for.
  it("clearing the owner drops the event back below the Planning gate", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const person = await seedOwner(org.id, "Maya Chen");

    const task = await createProgrammingTask(ctx, {
      title: "Mixer", category: "social", ownerBrotherId: person.id,
    });
    expect(canEnter(task, "planning")).toBe(true);

    const cleared = await updateProgrammingTask(ctx, task.id, { ownerBrotherId: null });
    expect(cleared.owner).toBeNull();
    expect(canEnter(cleared, "planning")).toBe(false);
  });

  // The picker emits ONE key precisely because both together is meaningless —
  // pinned at the schema so a future caller can't send both and get whichever
  // the service happens to write last.
  it("refuses a payload carrying BOTH owner kinds", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const person = await seedOwner(org.id, "Maya Chen");
    const role = await testPrisma.role.create({
      data: { organizationId: org.id, name: "Social Chair", rank: 1, permissions: 0 },
    });
    const task = await createProgrammingTask(ctx, { title: "Mixer", category: "social" });

    expect(() =>
      updateProgrammingTaskInput.parse({ ownerBrotherId: person.id, ownerRoleId: role.id }),
    ).toThrow();
    // And the create schema agrees, so neither door is open.
    expect(() =>
      updateProgrammingTaskInput.parse({ ownerBrotherId: person.id }),
    ).not.toThrow();
    expect(task.owner).toBeNull();
  });

  // Owner is deliberately OUTSIDE the frozen set: an officer handoff on a
  // published event must not require unpublishing it, which would drop it off
  // the chapter's timeline just to change who's accountable.
  it("reassigns the owner of a CONFIRMED event without unpublishing it", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Formal", dueDate: "2026-09-20", location: "Grand Ballroom", category: "social",
    });
    const calId = (await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } }))!.calendarEventId;
    const successor = await seedOwner(org.id, "Robin Vale");

    const handed = await updateProgrammingTask(ctx, confirmed.id, { ownerBrotherId: successor.id });
    expect(handed.owner).toMatchObject({ kind: "brother", id: successor.id });
    expect(handed.stage).toBe("confirmed");
    // Still on the timeline, same mirror row.
    expect(
      (await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } }))!.calendarEventId,
    ).toBe(calId);
  });

  it("removes the ServiceEvent when type changes away from community service", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Park Cleanup", dueDate: "2026-09-18", location: "City Park", category: "service",
    });
    const calId = (await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } }))!.calendarEventId!;

    // `category` is frozen while the event is published — the chapter has
    // already been told what this is. Retyping it goes through Planning, which
    // is the same route the panel offers, and demoting drops the mirror rows.
    await expect(updateProgrammingTask(ctx, confirmed.id, { category: "program" }))
      .rejects.toThrow(/back to Planning/i);

    await setStage(ctx, confirmed.id, { stage: "planning" });
    expect(await testPrisma.serviceEvent.findUnique({ where: { calendarEventId: calId } })).toBeNull();

    // Re-confirming under the new type mints a fresh CalendarEvent and, because
    // it is no longer community service, no ServiceEvent alongside it.
    await updateProgrammingTask(ctx, confirmed.id, { category: "program" });
    const reconfirmed = await setStage(ctx, confirmed.id, { stage: "confirmed" });
    expect(reconfirmed.category).toBe("program");
    const newCalId = (await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } }))!.calendarEventId!;
    expect(await testPrisma.serviceEvent.findUnique({ where: { calendarEventId: newCalId } })).toBeNull();
  });

  it("deletes the CalendarEvent + ServiceEvent when removing a promoted service event", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const confirmed = await createConfirmed(ctx, {
      title: "Park Cleanup", dueDate: "2026-09-18", location: "City Park", category: "service",
    });
    const calId = (await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } }))!.calendarEventId!;

    await deleteProgrammingTask(ctx, confirmed.id);

    expect(await testPrisma.programmingEvent.findUnique({ where: { id: confirmed.id } })).toBeNull();
    expect(await testPrisma.calendarEvent.findUnique({ where: { id: calId } })).toBeNull();
    expect(await testPrisma.serviceEvent.findUnique({ where: { calendarEventId: calId } })).toBeNull();
  });
});

describe("fieldValues", () => {
  it("stores answers to the org's optional fields, coerced by kind", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Mixer", category: "social" });

    const updated = await updateProgrammingTask(ctx, task.id, {
      // "40" arrives as a string from a number input; headcount is kind "num".
      fieldValues: { headcount: "40", budget: 250.5 },
    });
    expect(updated.fieldValues.headcount).toBe(40);
    expect(updated.fieldValues.budget).toBe(250.5);
  });

  it("merges a partial answer set instead of replacing it", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Mixer", category: "social" });
    await updateProgrammingTask(ctx, task.id, { fieldValues: { headcount: 40, budget: 100 } });

    const patched = await updateProgrammingTask(ctx, task.id, { fieldValues: { budget: 200 } });
    expect(patched.fieldValues.headcount).toBe(40);   // untouched
    expect(patched.fieldValues.budget).toBe(200);
  });

  it("clears an answer on an explicit empty", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Mixer", category: "social" });
    await updateProgrammingTask(ctx, task.id, { fieldValues: { headcount: 40 } });

    const cleared = await updateProgrammingTask(ctx, task.id, { fieldValues: { headcount: null } });
    expect(cleared.fieldValues.headcount).toBeUndefined();
  });

  it("drops a slug this org never defined", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Mixer", category: "social" });

    const updated = await updateProgrammingTask(ctx, task.id, {
      fieldValues: { headcount: 12, notARealField: "nope" },
    });
    expect(updated.fieldValues.headcount).toBe(12);
    expect(updated.fieldValues.notARealField).toBeUndefined();
  });

  it("hides a DISABLED field's answers without destroying them", async () => {
    // OFF is not DELETE. Sanitizing on read is what gives this for free: the row
    // stays on disk and comes straight back when the field is re-enabled.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Mixer", category: "social" });
    await updateProgrammingTask(ctx, task.id, { fieldValues: { headcount: 40 } });

    await testPrisma.eventFieldDefinition.updateMany({
      where: { organizationId: org.id, slug: "headcount" }, data: { enabled: false },
    });
    const hidden = (await listProgrammingTasks(ctx)).find(t => t.id === task.id)!;
    expect(hidden.fieldValues.headcount).toBeUndefined();

    // Still on disk.
    const row = await testPrisma.programmingEvent.findUnique({ where: { id: task.id } });
    expect((row!.fieldValues as Record<string, unknown>).headcount).toBe(40);

    await testPrisma.eventFieldDefinition.updateMany({
      where: { organizationId: org.id, slug: "headcount" }, data: { enabled: true },
    });
    const back = (await listProgrammingTasks(ctx)).find(t => t.id === task.id)!;
    expect(back.fieldValues.headcount).toBe(40);
  });

  it("never writes a column-backed builtin into the JSON", async () => {
    // description / attachment / cohost read and write real columns. A copy in
    // fieldValues would be a second, drifting source of truth.
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Mixer", category: "social" });

    await updateProgrammingTask(ctx, task.id, { fieldValues: { description: "should not land here" } });
    const row = await testPrisma.programmingEvent.findUnique({ where: { id: task.id } });
    expect((row!.fieldValues as Record<string, unknown>).description).toBeUndefined();
  });
});

describe("attachment", () => {
  it("stores and patches attachmentUrl", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Block Party", category: "social" });

    const updated = await updateProgrammingTask(ctx, task.id, {
      attachmentUrl: "https://docs.google.com/document/d/runofshow",
    });
    expect(updated.attachmentUrl).toBe("https://docs.google.com/document/d/runofshow");
    expect(updated.attachmentDocId).toBeNull();
  });

  it("stores and patches attachmentDocId", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const doc = await testPrisma.doc.create({
      data: { organizationId: org.id, title: "Bylaws", url: "https://example.com/bylaws" },
    });
    const task = await createProgrammingTask(ctx, { title: "Chapter Night", category: "program" });

    const updated = await updateProgrammingTask(ctx, task.id, { attachmentDocId: doc.id });
    expect(updated.attachmentDocId).toBe(doc.id);
    expect(updated.attachmentUrl).toBeNull();
  });

  it("clears attachment when both set to null", async () => {
    const { org, admin } = await seedOrg();
    const ctx = ctxFor(org.id, admin.id);
    const task = await createProgrammingTask(ctx, { title: "Mixer", category: "social" });
    await updateProgrammingTask(ctx, task.id, { attachmentUrl: "https://example.com/link" });

    const cleared = await updateProgrammingTask(ctx, task.id, { attachmentUrl: null });
    expect(cleared.attachmentUrl).toBeNull();
    expect(cleared.attachmentDocId).toBeNull();
  });

});
