import { z } from "zod";
import { APPROVAL_KINDS } from "@/lib/state";
import { PEEK_TYPES } from "@/lib/services/peek-service";

// The writ card's key/value lines, echoed back from the signed proposal blob.
const displayRow = z.object({
  k: z.string().min(1).max(40),
  v: z.string().min(1).max(200),
  em: z.boolean().optional(),
});

/**
 * POST /api/ai/approvals — record an approved chat proposal. Everything except
 * subjectId is the proposal blob the server signed at draft time; the service
 * re-verifies the signature before trusting any of it, so this schema only
 * bounds shapes/sizes (integrity is the HMAC's job, not zod's).
 */
export const recordApprovalInput = z.object({
  action:   z.string().min(1).max(60),
  endpoint: z.string().min(1).max(120),
  method:   z.enum(["POST", "PATCH"]),
  payload:  z.record(z.string(), z.unknown()),
  display:  z.object({
    kind:  z.enum(APPROVAL_KINDS as readonly [string, ...string[]]),
    title: z.string().min(1).max(80),
    rows:  z.array(displayRow).min(1).max(12),
  }),
  iat: z.number().finite(),
  sig: z.string().min(16).max(200),
  // Best-effort link to the row the approved POST created.
  subjectId: z.number().int().positive().optional(),
});
export type RecordApprovalInput = z.infer<typeof recordApprovalInput>;

/**
 * POST /api/ai/approvals — the event-idea panel's variant.
 *
 * The panel's card is filled in by the user AFTER the server signed it, so the
 * confirmed values are not the signed ones and no blob could verify. It sends
 * the created row's id instead, and the service builds the audit line by reading
 * that row back through the org-scoped client — see recordEventIdeaApproval.
 */
export const recordEventIdeaApprovalInput = z.object({
  source:  z.literal("event_idea"),
  eventId: z.number().int().positive(),
});
export type RecordEventIdeaApprovalInput = z.infer<typeof recordEventIdeaApprovalInput>;

/**
 * POST /api/ai/approvals — the inline-edit variant.
 *
 * A card the user corrected before approving carries a payload the signature no
 * longer covers, so like the event-idea panel it sends the id of the row its
 * POST created and the service reads that row back org-scoped. No sig is
 * accepted here on purpose: one would only ever describe the pre-edit draft.
 */
export const recordEditedApprovalInput = z.object({
  source:    z.literal("edited"),
  action:    z.string().min(1).max(60),
  subjectId: z.number().int().positive(),
});
export type RecordEditedApprovalInput = z.infer<typeof recordEditedApprovalInput>;

/** GET /api/ai/approvals?kind= — filter the record by surface. */
export const listApprovalsQuery = z.object({
  kind: z.enum(APPROVAL_KINDS as readonly [string, ...string[]]).optional(),
});

/** GET /api/ai/peek?type=&id= — the detail behind a tapped answer row. */
export const peekQuery = z.object({
  type: z.enum(PEEK_TYPES as readonly [string, ...string[]]),
  id:   z.coerce.number().int().positive(),
});

/** POST /api/ai/feedback — Helpful? thumbs on an answer. Telemetry only. */
export const assistantFeedbackInput = z.object({
  helpful:    z.boolean(),
  question:   z.string().max(300).default(""),
  answerKind: z.enum(["structured", "text", "fastpath"]).default("text"),
});
export type AssistantFeedbackInput = z.infer<typeof assistantFeedbackInput>;

/**
 * POST /api/ai/event-idea — open a tapped event-idea row into a proposal.
 *
 * The body is the ROW THE USER TAPPED, nothing more: the panel never sends a
 * date, time, location or description, because the model is never allowed to
 * invent one (only the chapter knows its own calendar). Those fields start
 * blank on the card and are filled in by the user, so accepting them here would
 * be accepting a guess we deliberately don't make.
 */
export const eventIdeaInput = z.object({
  title:    z.string().trim().min(1).max(80),
  subtitle: z.string().trim().max(120).optional(),
  /** The question that produced the row — context for the explanation only. */
  question: z.string().trim().max(300).optional(),
});
export type EventIdeaInput = z.infer<typeof eventIdeaInput>;
