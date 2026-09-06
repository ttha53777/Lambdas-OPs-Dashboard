"use client";

// The writ card — propose-then-commit, the human-in-the-loop moment. The
// permission model: the permission to do an action gates BOTH proposing and
// approving it. A holder self-approves (Approve / Discard); a non-holder's
// draft is BLOCKED, not routed — the gate names the required permission and
// who holds it, with only a Dismiss. Settling stamps the card (time · actor),
// the audit motif the Approvals record reuses.
//
// A card can also be CORRECTED before it is approved, by clicking the value you
// want to change. The model gets small things wrong — a date a day off, an
// amount that was $40 not $45, a mixer filed as a chapter meeting — and the only
// remedy used to be Discard and re-ask, which throws away an otherwise correct
// card to fix one field and may not even come back right.
//
// Editing is per-ROW, not per-card, and there is no Edit button. A card-wide
// edit mode makes correcting one field a three-step ceremony (enter, change,
// save) and re-renders every other row as an input the user never asked to
// touch, which reads as "check all of this again" rather than "this one word is
// wrong". Clicking the value directly is the smaller gesture and matches what
// the row already looks like — the value column is the only thing that changes,
// from text into a field, and only for the row you clicked. Enter or blur
// commits; Escape reverts that row. The card's own foot never moves, so Approve
// stays exactly where it was.
//
// Which fields are editable, and why the identity-bearing ones aren't, lives in
// proposal-edit.ts. An edited card can no longer echo its signature, so its
// approval is recorded by reading the created row back server-side instead.

import { useEffect, useMemo, useRef, useState } from "react";

import { IcLock, IcTick } from "./icons";
import {
  EDIT_FIELDS,
  applyEdit,
  applyEditToRows,
  draftFromPayload,
  fieldProblem,
  type EditField,
} from "./proposal-edit";
import type { ChoiceSets } from "./useProposalChoices";
import type { ProposalCard } from "./types";

function GateNote({ card }: { card: ProposalCard }) {
  const { label, holders } = card.perm;
  const role = holders?.roleTitles?.[0];
  const member = holders?.memberName;
  return (
    <div className="gate">
      <span className="lk"><IcLock /></span>
      <span className="gt">
        This needs the <b>{label}</b> permission{role ? <> — held by the <b>{role}</b></> : null}, which you don&apos;t have, so it can&apos;t post.
        {member ? <> Ask <b>{member}</b> to record it.</> : null}
      </span>
    </div>
  );
}

function SettledBar({ card }: { card: ProposalCard }) {
  const approved = card.state === "approved";
  return (
    <div className={`settled${approved ? "" : " declined"}`}>
      <span className="tk">{approved ? <IcTick /> : <>—</>}</span>
      <span className="txt">{card.resultMessage}</span>
      {card.stamp && <span className="stamp">{card.stamp}</span>}
    </div>
  );
}

/**
 * The value column of one row, while it is being edited. Mounts focused — the
 * click that opened it was the user already reaching for the field, so making
 * them click again would be a second gesture for one intent.
 */
function RowEditor({ field, options, value, onCommit, onCancel }: {
  field: EditField;
  options: Array<{ value: string; label: string }>;
  value: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);
  const problem = fieldProblem(field, v);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement && field.kind === "text") el.select();
  }, [field.kind]);

  // Enter commits, Escape reverts. Shift+Enter stays a newline in a textarea,
  // which is the only place a newline means anything.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
    if (e.key === "Enter" && !(field.kind === "textarea" && e.shiftKey)) {
      e.preventDefault();
      if (!problem) onCommit(v);
    }
  };
  // Blur commits too — clicking away from a field you just corrected should keep
  // the correction, not silently drop it. An invalid value reverts instead of
  // being committed, and the inline note below said why while it was open.
  const onBlur = () => { if (problem) onCancel(); else onCommit(v); };

  const shared = {
    ref: ref as never,
    className: "einput",
    value: v,
    onKeyDown,
    onBlur,
    maxLength: field.maxLength,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV(e.target.value),
  };

  return (
    <span className="wv editing">
      {field.kind === "choice" ? (
        // Picking from a select IS the decision — there is nothing left to type,
        // so the change commits on the spot rather than waiting for a blur the
        // user has no reason to perform.
        <select
          {...shared}
          className="einput choice"
          onChange={e => { setV(e.target.value); onCommit(e.target.value); }}
          onBlur={undefined}
        >
          {/* A slug the org no longer offers would otherwise vanish from its own
              row the moment the picker opened. Keep it until it's replaced. */}
          {!options.some(o => o.value === v) && v && <option value={v}>{v}</option>}
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : field.kind === "textarea" ? (
        <textarea {...shared} rows={2} placeholder={field.optional ? "Optional" : undefined} />
      ) : field.kind === "money" ? (
        <input {...shared} className="einput money" type="number" min="0" step="0.01" inputMode="decimal" />
      ) : (
        <input
          {...shared}
          type={field.kind === "date" ? "date" : field.kind === "time" ? "time" : "text"}
          placeholder={field.optional ? "Optional" : undefined}
        />
      )}
      {problem && <span className="wproblem">{problem}</span>}
    </span>
  );
}

export function WritCard({ card, onApprove, onDiscard, onEdit, choices }: {
  card: ProposalCard;
  onApprove: (card: ProposalCard) => void;
  onDiscard: (card: ProposalCard) => void;
  /** Commit an inline correction — the parent rewrites the card in place. */
  onEdit?: (card: ProposalCard, payload: Record<string, unknown>, rows: ProposalCard["display"]["rows"]) => void;
  choices?: ChoiceSets;
}) {
  const blocked = !card.perm.canApprove;
  const settled = card.state === "approved" || card.state === "discarded" || card.state === "dismissed" || card.state === "error";
  /** The payload key of the one row currently open, if any. */
  const [openKey, setOpenKey] = useState<string | null>(null);

  const fields = EDIT_FIELDS[card.action] ?? [];
  // Correcting a card you can't approve is busywork — you can't post it either.
  const canEdit = !!onEdit && !blocked && card.state === "pending";
  const byRow = useMemo(() => new Map(fields.map(f => [f.row, f])), [fields]);

  // A row that exists on the card but has no value yet (an optional field the
  // model left out) still needs somewhere to click, so it renders as a row with
  // a placeholder rather than being absent.
  const shownRows = useMemo(() => {
    const rows = [...card.display.rows];
    if (!canEdit) return rows;
    for (const f of fields) {
      if (!rows.some(r => r.k === f.row)) rows.push({ k: f.row, v: "" });
    }
    return rows;
  }, [card.display.rows, fields, canEdit]);

  function commit(field: EditField, raw: string) {
    setOpenKey(null);
    const before = draftFromPayload(card.action, card.payload);
    // Opening a row and closing it unchanged is not an edit — it must not stamp
    // the card as Edited, which would claim the officer changed something they
    // only looked at, and would push the approval onto the readback path for no
    // reason. Compare trimmed, since that is what applyEdit will store.
    if ((before[field.key] ?? "").trim() === raw.trim()) return;
    const draft = { ...before, [field.key]: raw };
    onEdit?.(
      card,
      applyEdit(card.action, card.payload, draft),
      applyEditToRows(card.action, card.display.rows, draft, choices),
    );
  }

  return (
    <div className="writ" data-writ={card.state === "pending" ? "" : undefined}>
      <div className="wh">
        <span className="chip-tag">Proposal</span>
        <span className="what">{card.display.title}</span>
        {/* Provenance: these values are the officer's, not the model's. */}
        {card.edited && <span className="wedited">Edited</span>}
      </div>
      <div className="wb">
        {shownRows.map(r => {
          const field = canEdit ? byRow.get(r.k) : undefined;
          const editing = !!field && openKey === field.key;
          const draft = field ? draftFromPayload(card.action, card.payload)[field.key] ?? "" : "";
          return (
            <div key={r.k} className={`wrow${field ? " editable" : ""}`}>
              <span className="wk">{r.k}</span>
              {editing && field ? (
                <RowEditor
                  field={field}
                  options={(field.source && choices?.[field.source]) || []}
                  value={draft}
                  onCommit={v => commit(field, v)}
                  onCancel={() => setOpenKey(null)}
                />
              ) : field ? (
                // A button, not a div with onClick: this is a real control, and
                // it must be reachable and operable from the keyboard too.
                <button
                  type="button"
                  className={`wv val${r.em ? " em" : ""}${r.v ? "" : " empty"}`}
                  onClick={() => setOpenKey(field.key)}
                  title={`Edit ${field.label.toLowerCase()}`}
                >
                  {r.v || (field.optional ? "Add" : "Set")}
                </button>
              ) : (
                <span className={`wv${r.em ? " em" : ""}`}>{r.v}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* The gate spells out the permission itself; caption it otherwise. */}
      {!blocked && !settled && (
        <div className="permline"><span className="lk"><IcLock size={11} /></span>Requires <b>{card.perm.label}</b></div>
      )}
      {blocked && !settled && <GateNote card={card} />}

      {card.state === "pending" && (
        <div className="wfoot">
          <button type="button" className="wbtn primary" disabled={blocked} data-w="ratify" onClick={() => onApprove(card)}>
            Approve
          </button>
          <button type="button" className="wbtn quiet" data-w="decline" onClick={() => onDiscard(card)}>
            {blocked ? "Dismiss" : "Discard"}
          </button>
        </div>
      )}
      {card.state === "confirming" && (
        <div className="wfoot"><span className="wbusy"><span className="arc sm" />Approving…</span></div>
      )}
      {settled && <SettledBar card={card} />}
    </div>
  );
}
