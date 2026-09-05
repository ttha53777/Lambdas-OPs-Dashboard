/**
 * The Ask Chapt approval record.
 *
 * Proposals are ephemeral (validate-only in lib/ai-tools.ts; the client POSTs
 * the payload to the real route on confirm). What persists is the APPROVAL:
 * after the underlying write succeeds, the client echoes back the proposal
 * blob the server HMAC-signed at draft time, and recordChatApproval writes the
 * durable audit row from it. The signature — not the client — attests the
 * card's contents; a tampered blob writes nothing.
 *
 * Trust model on record:
 *   1. sig verifies over {blob, perm, orgId, actorId, iat} rebuilt from server
 *      state — so the approver must be the same member, in the same org, the
 *      proposal was drafted for (the permission model: proposer == approver).
 *   2. The actor must (still) hold the required permission — defense in depth;
 *      the underlying POST already enforced it.
 */

import type { RequestContext } from "@/lib/context";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { verifyProposalBlob } from "@/lib/ai-approval-sig";
import { PROPOSAL_META } from "@/lib/ai-tools";
import { hasPermission } from "@/lib/permissions";
import { fmtUsd } from "@/lib/money";
import { emit } from "@/lib/events";
import type { RecordApprovalInput } from "@/lib/validation/ai";

// Where each proposal's approved POST lands — the audit row's subject link.
const SUBJECT_BY_ACTION: Record<string, string> = {
  propose_add_deadline:          "Task",
  propose_add_instagram_task:    "InstagramTask",
  propose_add_calendar_event:    "CalendarEvent",
  propose_log_transaction:       "Transaction",
  propose_record_dues_payment:   "Transaction",
  propose_add_programming_event: "ProgrammingEvent",
};

interface ApprovalRow {
  id: number;
  kind: string;
  title: string;
  summary: string;
  rows: unknown;
  permLabel: string;
  approvedByName: string;
  approvedByRole: string;
  approvedAt: Date;
}

function shape(r: ApprovalRow) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    rows: r.rows,
    permLabel: r.permLabel,
    approvedByName: r.approvedByName,
    approvedByRole: r.approvedByRole,
    approvedAt: r.approvedAt.toISOString(),
  };
}

/**
 * The actor's office title at approval time — snapshot for the record.
 * Same precedence as roleTitle() in app/data.ts: relational roles are the
 * source of truth; the free-text Brother.role covers members who hold no
 * relational role (plain members, imported rosters, committee labels).
 */
async function actorRoleTitle(ctx: RequestContext): Promise<string> {
  try {
    const roles = await ctx.db.role.findMany({
      where: { brothers: { some: { brotherId: ctx.actorId } } },
      orderBy: { rank: "desc" },
      select: { name: true },
    });
    if (roles.length > 0) return roles[0].name;
    const m = await ctx.db.member.findByBrotherId(ctx.actorId);
    return m?.role?.trim() || "Member";
  } catch {
    return "Member";
  }
}

/** List-row label: the writ title + the row that names what it acted on. */
function deriveSummary(display: RecordApprovalInput["display"]): string {
  const rows = display.rows;
  const named = rows.find(r => r.k === "Title")?.v
    ?? rows.find(r => r.k === "Brother")?.v
    ?? rows.find(r => r.em)?.v;
  return named ? `${display.title} · ${named}` : display.title;
}

export async function recordChatApproval(ctx: RequestContext, input: RecordApprovalInput) {
  const meta = PROPOSAL_META[input.action];
  if (!meta) throw new ValidationError("Unknown proposal action.");
  if (input.display.kind !== meta.kind) throw new ValidationError("Proposal kind mismatch.");

  // Rebuild the signed blob exactly as runProposal signed it. perm, orgId, and
  // actorId come from SERVER state, so a blob drafted for someone else — or
  // another org — cannot verify here.
  const blob = {
    action: input.action,
    endpoint: input.endpoint,
    method: input.method,
    payload: input.payload,
    display: input.display,
    perm: meta.perm,
    orgId: ctx.orgId,
    actorId: ctx.actorId,
    iat: input.iat,
  };
  if (!verifyProposalBlob(blob, input.sig)) {
    throw new ForbiddenError("Proposal could not be verified.");
  }
  if (!(ctx.isPlatformAdmin || ctx.isOrgAdmin || hasPermission(ctx.permissions, meta.perm))) {
    throw new ForbiddenError(`Recording this approval requires ${meta.label}.`);
  }

  const approvedByRole = await actorRoleTitle(ctx);
  const subjectType = SUBJECT_BY_ACTION[input.action] ?? null;
  const subjectId = input.subjectId ?? null;

  const row = await ctx.db.chatApproval.create({
    data: {
      kind: meta.kind,
      action: input.action,
      title: input.display.title,
      summary: deriveSummary(input.display),
      rows: input.display.rows,
      permission: meta.perm,
      permLabel: meta.label,
      approvedById: ctx.actorId,
      approvedByName: ctx.actorName,
      approvedByRole,
      subjectType,
      subjectId,
      requestId: ctx.requestId,
    },
  });

  // The underlying domain event (transaction.created, task.created, …) already
  // told the feed's story — this one is the audit mirror, feed-silent.
  await emit(ctx, "assistant.proposal_approved", { type: "ChatApproval", id: row.id }, {
    action: input.action,
    kind: meta.kind,
    permission: meta.perm,
    subjectType,
    subjectId,
  }, { activity: false });

  return shape(row);
}

/**
 * Record the approval of a proposal whose committed values are NOT the signed
 * ones — an event booked from the idea panel, or any card the user corrected
 * inline before approving it.
 *
 * Every other card is drafted complete and ratified as-is, so the client can
 * echo the signed blob back and recordChatApproval verifies it verbatim. These
 * two surfaces both break that assumption in the same way: the idea panel opens
 * with a blank date the user fills in, and an inline edit rewrites a field the
 * model got wrong. In both cases the signed payload and the payload that
 * actually got written necessarily differ — echoing the former would file an
 * audit row that misstates what happened, and echoing the latter would fail the
 * HMAC and file nothing.
 *
 * So this path doesn't trust a blob at all. The client sends only the action and
 * the id of the row its POST created; the audit line is then built by READING
 * THAT ROW BACK through ctx.db, which is org-scoped — a caller can only ever
 * record a row that exists, in their own org, and the recorded values are the
 * committed ones by construction rather than by attestation. That is strictly
 * stronger than a signature over client-held values, which is why no sig is
 * required here. The permission check is unchanged: the actor must still hold
 * the permission the action's meta names.
 */

type DisplayRow = { k: string; v: string; em?: boolean };

/**
 * Rebuild a card's display rows from the row the write actually created. Keyed
 * by action so each surface reads back its own committed columns; returns null
 * when the row is gone or the action reads back no subject (nothing to attest).
 */
async function readBackRows(
  ctx: RequestContext,
  action: string,
  subjectId: number,
): Promise<DisplayRow[] | null> {
  switch (action) {
    case "propose_add_calendar_event": {
      const e = await ctx.db.calendarEvent.findUnique({ where: { id: subjectId } });
      if (!e) return null;
      return [
        { k: "Title", v: e.title },
        { k: "Date", v: e.date, em: true },
        { k: "Category", v: e.category },
        ...(e.time ? [{ k: "Time", v: e.time }] : []),
        ...(e.location ? [{ k: "Location", v: e.location }] : []),
        ...(e.mandatory ? [{ k: "Mandatory", v: "Yes" }] : []),
      ];
    }
    case "propose_add_deadline": {
      const t = await ctx.db.task.findUnique({ where: { id: subjectId } });
      if (!t) return null;
      return [
        { k: "Title", v: t.title },
        ...(t.dueDate ? [{ k: "Due", v: t.dueDate, em: true }] : []),
        ...(t.notes ? [{ k: "Notes", v: t.notes.length > 80 ? `${t.notes.slice(0, 77)}…` : t.notes }] : []),
      ];
    }
    case "propose_add_instagram_task": {
      const i = await ctx.db.instagramTask.findUnique({ where: { id: subjectId } });
      if (!i) return null;
      return [
        { k: "Title", v: i.title },
        { k: "Type", v: i.type },
        { k: "Due", v: i.dueDate, em: true },
      ];
    }
    case "propose_add_programming_event": {
      const p = await ctx.db.programmingEvent.findUnique({ where: { id: subjectId } });
      if (!p) return null;
      return [
        { k: "Title", v: p.title },
        { k: "Type", v: p.category },
        ...(p.date ? [{ k: "Date", v: p.date, em: true }] : []),
      ];
    }
    // Both treasury actions post a Transaction; they differ only in whether the
    // row is attributed to a member, which is what makes it a dues payment.
    case "propose_log_transaction":
    case "propose_record_dues_payment": {
      const t = await ctx.db.transaction.findUnique({ where: { id: subjectId } });
      if (!t) return null;
      const who = t.brotherId
        ? (await ctx.db.member.findByBrotherId(t.brotherId))?.name ?? null
        : null;
      return [
        ...(who ? [{ k: "Brother", v: who }] : [{ k: "Type", v: t.type === "income" ? "Income" : "Expense" }]),
        { k: "Category", v: t.category },
        { k: "Amount", v: fmtUsd(t.amount), em: true },
        { k: "Date", v: t.date },
        ...(who ? [] : [{ k: "For", v: t.description.length > 60 ? `${t.description.slice(0, 57)}…` : t.description }]),
      ];
    }
    default:
      return null;
  }
}

export async function recordEditedApproval(ctx: RequestContext, action: string, subjectId: number) {
  const meta = PROPOSAL_META[action];
  if (!meta) throw new ValidationError("Unknown proposal action.");
  if (!(ctx.isPlatformAdmin || ctx.isOrgAdmin || hasPermission(ctx.permissions, meta.perm))) {
    throw new ForbiddenError(`Recording this approval requires ${meta.label}.`);
  }

  const rows = await readBackRows(ctx, action, subjectId);
  if (!rows) throw new ValidationError("No such record.");

  const display = { kind: meta.kind, title: meta.title, rows };
  const approvedByRole = await actorRoleTitle(ctx);
  const subjectType = SUBJECT_BY_ACTION[action] ?? null;

  const row = await ctx.db.chatApproval.create({
    data: {
      kind: meta.kind,
      action,
      title: meta.title,
      summary: deriveSummary(display),
      rows,
      permission: meta.perm,
      permLabel: meta.label,
      approvedById: ctx.actorId,
      approvedByName: ctx.actorName,
      approvedByRole,
      subjectType,
      subjectId,
      requestId: ctx.requestId,
    },
  });

  await emit(ctx, "assistant.proposal_approved", { type: "ChatApproval", id: row.id }, {
    action,
    kind: meta.kind,
    permission: meta.perm,
    subjectType,
    subjectId,
  }, { activity: false });

  return shape(row);
}

/**
 * Record the approval of an event booked from the event-idea panel.
 *
 * The panel is the one proposal surface where the CONFIRMED values are not the
 * signed ones. Every other card is drafted complete and ratified as-is, so the
 * client can echo the signed blob back and recordChatApproval verifies it
 * verbatim. Here the whole point is that the card opens with a blank date the
 * user fills in, so the signed payload (drafted against a placeholder) and the
 * payload that actually got booked necessarily differ — echoing the former would
 * file an audit row that misstates what happened, and echoing the latter would
 * fail the HMAC and file nothing.
 *
 * So this path doesn't trust a blob at all. The client sends only the id of the
 * row its POST created; the audit line is then built by READING THAT ROW BACK
 * through ctx.db, which is org-scoped — a caller can only ever record an event
 * that exists, in their own org, and the recorded values are the committed ones
 * by construction rather than by attestation. That is strictly stronger than a
 * signature over client-held values, which is why no sig is required here.
 */
/**
 * The event-idea panel's entry point. Its card is completed by the user after
 * signing, which is the same situation an inline edit creates, so it is the
 * same readback — kept as a named export because the panel's request shape
 * (`{ source: "event_idea", eventId }`) predates the general one.
 */
export async function recordEventIdeaApproval(ctx: RequestContext, eventId: number) {
  return recordEditedApproval(ctx, "propose_add_calendar_event", eventId);
}

export async function listChatApprovals(ctx: RequestContext, opts: { kind?: string } = {}) {
  const rows = await ctx.db.chatApproval.findMany({
    where: opts.kind ? { kind: opts.kind } : {},
    orderBy: { approvedAt: "desc" },
    take: 100,
  });
  return { approvals: rows.map(shape) };
}
