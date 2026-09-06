// Which fields of a proposal a user may correct before approving it, and how
// each one reads back onto the card.
//
// A proposal is a draft the model wrote, and drafts are wrong in small ways: a
// date a day off, a name spelled from speech, an amount that was $40 not $45.
// Before this, the only answer to a small wrongness was Discard and re-ask,
// which throws away a correct card to fix one character of it — and re-asking
// is not even reliably a fix, since the model may guess differently the second
// time. Editing keeps the card and changes the one field.
//
// Only the fields listed here are editable, and the reason a field is left out
// is always the same: it names a row rather than describing one. The member a
// dues payment is attributed to and the assignee ids on a deadline were resolved
// server-side against the actual roster (proposeRecordDuesPayment reads the
// balance; proposeAddDeadline refuses an id that isn't in the chapter), so a
// free-text edit would replace a checked reference with an unchecked string.
//
// Category is the interesting case, because it is BOTH. The model picks it and
// gets it wrong often — a mixer filed as a chapter meeting — so it badly needs
// correcting, but its value is a slug the org defines, and a typed slug that
// doesn't exist is a write destined to 400. So it is editable as a `choice`:
// the options are fetched from the org's own rows and the user picks one, which
// keeps the correction available without ever letting an unchecked string
// through. Everything else editable is the plainly descriptive half — titles,
// dates, notes, amounts — the part a human reads on the card and knows is wrong.
//
// The `row` key ties a field to the display row it rewrites, so an edited card
// still reads as one object rather than as a payload plus a stale summary.

export type EditKind = "text" | "date" | "time" | "money" | "textarea" | "choice";

/**
 * Where a `choice` field's options come from. These are the org's own rows, not
 * a fixed enum — a chapter renames and adds its event types and ledger
 * categories — so the card fetches them rather than shipping a guess.
 */
export type ChoiceSource = "eventType" | "programmingType" | "txCategory";

export interface ChoiceOption {
  value: string;   // the slug the payload carries
  label: string;   // what the chapter calls it
}

export interface EditField {
  /** Key in the proposal payload. */
  key: string;
  /** The display row (`display.rows[].k`) this field's value is shown in. */
  row: string;
  label: string;
  kind: EditKind;
  maxLength?: number;
  /** A blank value is allowed — the key is dropped from the payload entirely. */
  optional?: boolean;
  /** For `choice`: which set of the org's rows this picks from. */
  source?: ChoiceSource;
}

/**
 * Editable fields per proposal action. An action absent from this map has no
 * inline edit at all, and its card renders exactly as it always did.
 */
export const EDIT_FIELDS: Record<string, EditField[]> = {
  propose_add_deadline: [
    { key: "title",   row: "Title", label: "Title", kind: "text", maxLength: 200 },
    { key: "dueDate", row: "Due",   label: "Due",   kind: "date" },
    { key: "notes",   row: "Notes", label: "Notes", kind: "textarea", maxLength: 2000, optional: true },
  ],
  propose_add_instagram_task: [
    { key: "title",   row: "Title", label: "Title", kind: "text", maxLength: 200 },
    { key: "dueDate", row: "Due",   label: "Due",   kind: "date" },
  ],
  propose_add_calendar_event: [
    { key: "title",    row: "Title",    label: "Title",    kind: "text", maxLength: 200 },
    { key: "date",     row: "Date",     label: "Date",     kind: "date" },
    { key: "category", row: "Category", label: "Category", kind: "choice", source: "eventType" },
    { key: "time",     row: "Time",     label: "Time",     kind: "time", optional: true },
    { key: "location", row: "Location", label: "Location", kind: "text", maxLength: 200, optional: true },
  ],
  propose_log_transaction: [
    { key: "amount",      row: "Amount",   label: "Amount",   kind: "money" },
    { key: "category",    row: "Category", label: "Category", kind: "choice", source: "txCategory" },
    { key: "date",        row: "Date",     label: "Date",     kind: "date" },
    { key: "description", row: "For",      label: "For",      kind: "text", maxLength: 200 },
  ],
  // The brother and the balance-derived ceiling are fixed; only how much of it
  // is being paid, and when, are the treasurer's to correct.
  propose_record_dues_payment: [
    { key: "amount", row: "Amount", label: "Amount", kind: "money" },
    { key: "date",   row: "Date",   label: "Date",   kind: "date" },
  ],
  propose_add_programming_event: [
    { key: "title",    row: "Title", label: "Title", kind: "text", maxLength: 200 },
    { key: "category", row: "Type",  label: "Type",  kind: "choice", source: "programmingType" },
    { key: "dueDate",  row: "Date",  label: "Date",  kind: "date", optional: true },
  ],
};

export function isEditable(action: string): boolean {
  return (EDIT_FIELDS[action]?.length ?? 0) > 0;
}

/** The form's working values, as strings — the shape an <input> holds. */
export type EditDraft = Record<string, string>;

/** Seed the form from the proposal's current payload. */
export function draftFromPayload(action: string, payload: Record<string, unknown>): EditDraft {
  const draft: EditDraft = {};
  for (const f of EDIT_FIELDS[action] ?? []) {
    const v = payload[f.key];
    draft[f.key] = v === undefined || v === null ? "" : String(v);
  }
  return draft;
}

/**
 * Why this one value can't be committed, or null when it can. Editing is
 * per-row, so validation is too: the message belongs under the field being
 * typed in, not in a card-wide list of everything wrong elsewhere. The server
 * re-validates every one of these — this exists to catch the mistake while the
 * user is still looking at it, not to be the thing enforcing it.
 */
export function fieldProblem(field: EditField, value: string): string | null {
  const raw = value.trim();
  if (!raw) return field.optional ? null : `${field.label} can't be empty.`;
  if (field.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${field.label} must be a date.`;
  if (field.kind === "money") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return `${field.label} must be more than $0.`;
  }
  if (field.maxLength && raw.length > field.maxLength) return `${field.label} is too long.`;
  return null;
}

/** Every problem across a draft — the card-wide view of fieldProblem. */
export function editProblems(action: string, draft: EditDraft): string[] {
  const out: string[] = [];
  for (const f of EDIT_FIELDS[action] ?? []) {
    const p = fieldProblem(f, draft[f.key] ?? "");
    if (p) out.push(p);
  }
  return out;
}

/** True when the draft differs from what the model proposed. */
export function isDirty(action: string, payload: Record<string, unknown>, draft: EditDraft): boolean {
  const base = draftFromPayload(action, payload);
  return (EDIT_FIELDS[action] ?? []).some(f => (base[f.key] ?? "") !== (draft[f.key] ?? ""));
}

/** Apply the draft onto the payload. A blank optional field drops its key. */
export function applyEdit(
  action: string,
  payload: Record<string, unknown>,
  draft: EditDraft,
): Record<string, unknown> {
  const next = { ...payload };
  for (const f of EDIT_FIELDS[action] ?? []) {
    const raw = (draft[f.key] ?? "").trim();
    if (!raw) { delete next[f.key]; continue; }
    next[f.key] = f.kind === "money" ? Math.round(Number(raw) * 100) / 100 : raw;
  }
  return next;
}

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Rewrite the card's display rows from the edited payload, so the summary the
 * user reads after saving is the one that will actually be posted. Rows the
 * edit doesn't cover are left exactly as the server wrote them; an optional
 * field cleared to blank drops its row rather than showing an empty value.
 */
export function applyEditToRows(
  action: string,
  rows: Array<{ k: string; v: string; em?: boolean }>,
  draft: EditDraft,
  /** Options in play, so a chosen slug reads back as the chapter's own label. */
  choices?: Partial<Record<ChoiceSource, ChoiceOption[]>>,
): Array<{ k: string; v: string; em?: boolean }> {
  const fields = EDIT_FIELDS[action] ?? [];
  const byRow = new Map(fields.map(f => [f.row, f]));

  // The payload carries the slug; the card has always shown the label. Falling
  // back to the raw value keeps a row readable when the options never loaded.
  const shown = (f: EditField, raw: string): string => {
    if (f.kind === "money") return fmtUsd(Number(raw));
    if (f.kind === "choice" && f.source) {
      return choices?.[f.source]?.find(o => o.value === raw)?.label ?? raw;
    }
    return raw;
  };

  const out = rows.flatMap(r => {
    const f = byRow.get(r.k);
    if (!f) return [r];
    const raw = (draft[f.key] ?? "").trim();
    if (!raw) return [];
    return [{ ...r, v: shown(f, raw) }];
  });
  // A previously-blank optional field that now has a value has no row to rewrite,
  // so append one — otherwise a location typed in by hand would post invisibly.
  for (const f of fields) {
    const raw = (draft[f.key] ?? "").trim();
    if (raw && !out.some(r => r.k === f.row)) out.push({ k: f.row, v: shown(f, raw) });
  }
  return out;
}
