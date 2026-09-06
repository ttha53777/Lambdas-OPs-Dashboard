// Client-side shapes for the Ask Chapt Spotlight. These mirror the SSE
// protocol documented in app/api/ai/chat/route.ts — the server is the source
// of truth; everything here is defensive-parsed off the wire.

export type StepStatus = "pending" | "active" | "done";

export interface LedgerStep {
  id: string;
  verb: string;
  source?: string;
  status: StepStatus;
  finding?: string;
  /**
   * A guessed step shown while the model is still deciding — never persisted to
   * the trace, and dropped the moment the real batch is known. See intent.ts.
   */
  provisional?: boolean;
}

export type RefType = "member" | "event" | "task";

export interface EntityRef {
  type: RefType;
  id: number;
}

export type AnswerTier = "high" | "medium" | "later";

export interface AnswerRow {
  kind: "person" | "money" | "event" | "task" | "generic";
  title: string;
  subtitle?: string;
  value?: string;
  ask?: string;
  /** Server-attached record id — present when the row can open a peek. */
  ref?: EntityRef;
  /** Impact tier on an advisory row; fills the same slot as `value`. */
  tier?: AnswerTier;
  /** Server-resolved screen path, relative to the org (e.g. "/treasury/dues"). */
  screen?: { label: string; path: string };
}

/**
 * What tapping a row actually does. The single source of truth shared by the
 * row's affordance, its click handler and keyboard selection — so the three
 * can't drift into showing an affordance for an interaction that isn't there.
 * Precedence matters: a row the server could identify opens its record rather
 * than spending a model turn re-deriving it, and a row that names a screen
 * navigates rather than asking the model to describe that screen back.
 */
export type RowAction = "peek" | "nav" | "idea" | "ask";

/**
 * An advisory row that is a PROPOSED EVENT rather than a change to an existing
 * screen: "Weekly Brotherhood Dinner", "Intramural Sports Night". These rows
 * point at the Events screen the way every advisory row points somewhere, but
 * navigating there is the wrong ending — it lands the officer on an empty
 * calendar holding a remembered phrase, with the idea itself left behind in the
 * chat. They open the idea panel instead, which carries the suggestion into a
 * prefilled proposal.
 *
 * The test is deliberately narrow. `ref` still wins (a row the server matched to
 * an event that ALREADY EXISTS is a record to peek at, not an idea to schedule),
 * and only an events-screen row with no record behind it can be an idea, so an
 * ordinary "clean up the events page" advisory row still navigates.
 */
export function isEventIdea(row: AnswerRow): boolean {
  return !row.ref && row.screen?.label.toLowerCase() === "events" && !!row.tier;
}

export function rowAction(row: AnswerRow): RowAction | null {
  if (row.ref) return "peek";
  if (isEventIdea(row)) return "idea";
  if (row.screen) return "nav";
  if (row.ask) return "ask";
  return null;
}

/**
 * How a question's chips relate, and so what tapping one means. "one" (the
 * default when absent) — alternatives, so a tap sends that reply immediately,
 * exactly as a typed reply would. "many" — constraints that can all hold at
 * once, so taps stage a selection and the user sends them as one reply.
 */
export type AskBackSelect = "one" | "many";

export interface AskBackQuestion {
  question: string;
  chips: string[];
  select?: AskBackSelect;
}

export interface AskBack {
  lead?: string;
  questions: AskBackQuestion[];
}

/**
 * Next row the arrows should land on, skipping any the server could resolve to
 * neither a record nor a follow-up. Selection paints a row as actionable, so
 * parking it where Enter does nothing reads as a broken key rather than as an
 * inert row. Returns -1 when no row in the answer can be acted on at all.
 */
export function stepRow(rows: AnswerRow[], from: number, dir: 1 | -1): number {
  if (from < 0) return rows.findIndex(r => rowAction(r));
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
    if (rowAction(rows[i])) return i;
  }
  return from;
}

export interface AnswerData {
  verdict: string; // may contain one *emphasis* span — rendered, never injected
  rows: AnswerRow[];
  follows: Array<{ label: string; ask: string }>;
  sources: string[];
  /** Questions the answer asks back, each with tappable likely replies. */
  askback?: AskBack;
}

export interface ProposalPermInfo {
  name: string;
  label: string;
  canApprove: boolean;
  holders?: { roleTitles: string[]; memberName?: string };
}

export interface ProposalDisplayInfo {
  kind: string;
  title: string;
  rows: Array<{ k: string; v: string; em?: boolean }>;
}

export type WritState = "pending" | "confirming" | "approved" | "discarded" | "dismissed" | "error";

export interface ProposalCard {
  id: string;                      // local id for keying
  action: string;
  endpoint: string;
  method: "POST" | "PATCH";
  payload: Record<string, unknown>;
  summary: string;
  display: ProposalDisplayInfo;
  perm: ProposalPermInfo;
  sig: string | null;
  iat: number;
  state: WritState;
  resultMessage?: string;
  stamp?: string;                  // "6:12 PM · Marcus S." — set when settled
  /**
   * The user corrected a field before approving. The payload and display rows
   * are then the user's, not the ones the signature covers, so `sig` no longer
   * describes this card — the approval is recorded by reading the created row
   * back server-side instead. See proposal-edit.ts and recordEditedApproval.
   */
  edited?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Plain-prose fallback (refusals, how-to, fast-path) — the serif note style. */
  content: string;
  /** The reasoning ledger: live while streaming, then frozen as the trace. */
  steps?: LedgerStep[];
  /** Serif intent line for the live ledger, derived from the question client-side. */
  intent?: string;
  /** The model is writing the answer rather than calling tools (server-signalled). */
  composing?: boolean;
  /** Structured verdict+rows answer (compose_answer path). */
  answer?: AnswerData | null;
  proposals?: ProposalCard[];
  feedback?: "up" | "down";
  /** The user hit Stop mid-stream — render whatever arrived, no caret. */
  stopped?: boolean;
}

export function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** "Andre Whitfield" → "AW" for the person-row avatar. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase() || "·";
}

/** Local wall-clock stamp, e.g. "6:12 PM". */
export function timeStamp(d: Date = new Date()): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
