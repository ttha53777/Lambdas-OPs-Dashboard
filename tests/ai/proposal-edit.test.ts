/**
 * app/components/chat/proposal-edit.ts — inline correction of a writ card.
 *
 * A proposal is a draft, and drafts are wrong in small ways. These pin the
 * properties that make correcting one safe: the payload and the rows the user
 * reads move together (so the card can't post something other than what it
 * shows), blank optional fields drop rather than posting empty values, the
 * identity-bearing keys a handler resolved server-side are never touched, and
 * an invalid draft is caught before it can be saved.
 */

import { describe, it, expect } from "vitest";
import {
  EDIT_FIELDS,
  applyEdit,
  applyEditToRows,
  draftFromPayload,
  editProblems,
  fieldProblem,
  isDirty,
  isEditable,
  type EditField,
} from "@/app/components/chat/proposal-edit";

const DEADLINE = "propose_add_deadline";
const DUES = "propose_record_dues_payment";

describe("draftFromPayload", () => {
  it("seeds every editable field from the payload, blanking absent ones", () => {
    const draft = draftFromPayload(DEADLINE, { title: "Budget due", dueDate: "2026-10-01" });
    expect(draft).toEqual({ title: "Budget due", dueDate: "2026-10-01", notes: "" });
  });

  it("is empty for an action with no inline edit", () => {
    expect(draftFromPayload("propose_nothing", { a: 1 })).toEqual({});
    expect(isEditable("propose_nothing")).toBe(false);
  });
});

describe("applyEdit", () => {
  it("keeps payload keys the edit doesn't cover", () => {
    // The assignee ids were resolved against real rows server-side; a free-text
    // edit must never be able to replace a checked reference.
    const payload = { title: "Budget due", dueDate: "2026-10-01", assigneeBrotherIds: [7], assigneeRoleIds: [] };
    const next = applyEdit(DEADLINE, payload, { title: "Budget draft due", dueDate: "2026-10-02", notes: "" });
    expect(next.assigneeBrotherIds).toEqual([7]);
    expect(next.title).toBe("Budget draft due");
    expect(next.dueDate).toBe("2026-10-02");
  });

  it("drops a blank optional field's key rather than posting an empty value", () => {
    const next = applyEdit(DEADLINE, { title: "T", dueDate: "2026-10-01", notes: "old" }, {
      title: "T", dueDate: "2026-10-01", notes: "   ",
    });
    expect("notes" in next).toBe(false);
  });

  it("stores money as a number rounded to cents, not the raw string", () => {
    const next = applyEdit(DUES, { amount: 120, date: "2026-09-01", brotherId: 4 }, {
      amount: "45.999", date: "2026-09-02",
    });
    expect(next.amount).toBe(46);
    expect(next.brotherId).toBe(4); // attribution is not editable
  });
});

describe("applyEditToRows", () => {
  it("rewrites the displayed row for every edited field", () => {
    const rows = [{ k: "Title", v: "Budget due" }, { k: "Due", v: "2026-10-01", em: true }];
    const out = applyEditToRows(DEADLINE, rows, { title: "Budget draft due", dueDate: "2026-10-02", notes: "" });
    expect(out).toEqual([
      { k: "Title", v: "Budget draft due" },
      { k: "Due", v: "2026-10-02", em: true },
    ]);
  });

  it("appends a row for an optional field that had none, so it can't post invisibly", () => {
    const rows = [{ k: "Title", v: "Mixer" }, { k: "Date", v: "2026-10-01", em: true }];
    const out = applyEditToRows("propose_add_calendar_event", rows, {
      title: "Mixer", date: "2026-10-01", time: "", location: "The Quad",
    });
    expect(out).toContainEqual({ k: "Location", v: "The Quad" });
  });

  it("drops the row of an optional field the user cleared", () => {
    const rows = [{ k: "Title", v: "T" }, { k: "Due", v: "2026-10-01", em: true }, { k: "Notes", v: "old" }];
    const out = applyEditToRows(DEADLINE, rows, { title: "T", dueDate: "2026-10-01", notes: "" });
    expect(out.some(r => r.k === "Notes")).toBe(false);
  });

  it("formats an edited money row as currency, matching how the server drew it", () => {
    const rows = [{ k: "Amount", v: "$120.00", em: true }, { k: "Date", v: "2026-09-01" }];
    const out = applyEditToRows(DUES, rows, { amount: "46", date: "2026-09-01" });
    expect(out[0].v).toBe("$46.00");
  });

  it("leaves rows no editable field maps to exactly as the server wrote them", () => {
    const rows = [{ k: "Brother", v: "Rob Chen" }, { k: "Amount", v: "$120.00", em: true }, { k: "Date", v: "2026-09-01" }];
    const out = applyEditToRows(DUES, rows, { amount: "120", date: "2026-09-01" });
    expect(out[0]).toEqual({ k: "Brother", v: "Rob Chen" });
  });
});

describe("choice fields", () => {
  const EVENT = "propose_add_calendar_event";
  const choices = {
    eventType: [{ value: "social", label: "Social" }, { value: "chapter", label: "Chapter" }],
  };

  it("puts the slug in the payload but the chapter's label on the card", () => {
    const payload = { title: "Mixer", date: "2026-10-01", category: "chapter", mandatory: true };
    const draft = { ...draftFromPayload(EVENT, payload), category: "social" };
    expect(applyEdit(EVENT, payload, draft).category).toBe("social");
    const rows = applyEditToRows(EVENT, [
      { k: "Title", v: "Mixer" }, { k: "Date", v: "2026-10-01", em: true }, { k: "Category", v: "Chapter" },
    ], draft, choices);
    expect(rows.find(r => r.k === "Category")?.v).toBe("Social");
  });

  it("falls back to the raw slug when the options never loaded", () => {
    const payload = { title: "Mixer", date: "2026-10-01", category: "social" };
    const rows = applyEditToRows(EVENT, [{ k: "Category", v: "Social" }], draftFromPayload(EVENT, payload));
    expect(rows.find(r => r.k === "Category")?.v).toBe("social");
  });

  it("seeds the draft from the payload slug, not the displayed label", () => {
    // The row shows "Chapter"; the picker must open on the slug it maps to, or
    // the current value would read as unselected.
    expect(draftFromPayload(EVENT, { category: "chapter" }).category).toBe("chapter");
  });
});

describe("fieldProblem", () => {
  const field = (over: Partial<EditField> = {}): EditField => ({
    key: "title", row: "Title", label: "Title", kind: "text", ...over,
  });

  it("is null for a value that can be committed", () => {
    expect(fieldProblem(field(), "Budget due")).toBeNull();
  });

  it("names the field it is about, since it renders beside that row", () => {
    expect(fieldProblem(field(), "  ")).toBe("Title can't be empty.");
  });

  it("allows an optional field to be emptied", () => {
    expect(fieldProblem(field({ optional: true }), "")).toBeNull();
  });

  it("rejects a malformed date, a non-positive amount and an over-long value", () => {
    expect(fieldProblem(field({ kind: "date", label: "Due" }), "10/01/2026")).toBe("Due must be a date.");
    expect(fieldProblem(field({ kind: "money", label: "Amount" }), "0")).toBe("Amount must be more than $0.");
    expect(fieldProblem(field({ maxLength: 5 }), "abcdef")).toBe("Title is too long.");
  });
});

describe("editProblems", () => {
  it("flags a required field emptied", () => {
    expect(editProblems(DEADLINE, { title: "  ", dueDate: "2026-10-01", notes: "" })).toContain("Title can't be empty.");
  });

  it("accepts an optional field emptied", () => {
    expect(editProblems(DEADLINE, { title: "T", dueDate: "2026-10-01", notes: "" })).toEqual([]);
  });

  it("rejects a malformed date and a non-positive amount", () => {
    expect(editProblems(DEADLINE, { title: "T", dueDate: "10/01/2026", notes: "" }).length).toBe(1);
    expect(editProblems(DUES, { amount: "0", date: "2026-09-01" }).length).toBe(1);
    expect(editProblems(DUES, { amount: "-5", date: "2026-09-01" }).length).toBe(1);
  });

  it("rejects an over-long value", () => {
    const long = "x".repeat(201);
    expect(editProblems(DEADLINE, { title: long, dueDate: "2026-10-01", notes: "" })).toContain("Title is too long.");
  });
});

describe("isDirty", () => {
  const payload = { title: "T", dueDate: "2026-10-01" };

  it("is false when the draft still matches what the model proposed", () => {
    expect(isDirty(DEADLINE, payload, draftFromPayload(DEADLINE, payload))).toBe(false);
  });

  it("is true once any editable field differs", () => {
    expect(isDirty(DEADLINE, payload, { title: "T", dueDate: "2026-10-02", notes: "" })).toBe(true);
  });
});

describe("EDIT_FIELDS", () => {
  it("never exposes a key that names a roster row as free text", () => {
    // A brother id was checked against the roster server-side; making it
    // editable would swap a verified reference for an unchecked string.
    const forbidden = ["brotherId", "assigneeBrotherIds", "assigneeRoleIds"];
    for (const [action, fields] of Object.entries(EDIT_FIELDS)) {
      for (const f of fields) {
        expect(forbidden, `${action}.${f.key}`).not.toContain(f.key);
      }
    }
  });

  it("only ever offers a category as a picker, never as typed text", () => {
    // Category is editable because the model gets it wrong often, but its value
    // is a slug the org defines — a typed one that doesn't exist is a write
    // destined to 400. So it must always carry a source to pick from.
    for (const [action, fields] of Object.entries(EDIT_FIELDS)) {
      for (const f of fields) {
        if (f.key !== "category") continue;
        expect(f.kind, `${action}.category`).toBe("choice");
        expect(f.source, `${action}.category`).toBeTruthy();
      }
    }
  });

  it("gives every choice field a source and every non-choice field none", () => {
    for (const fields of Object.values(EDIT_FIELDS)) {
      for (const f of fields) {
        if (f.kind === "choice") expect(f.source).toBeTruthy();
        else expect(f.source).toBeUndefined();
      }
    }
  });

  it("points every field at a row key, so a save can't leave a stale summary", () => {
    for (const fields of Object.values(EDIT_FIELDS)) {
      for (const f of fields) expect(f.row.length).toBeGreaterThan(0);
    }
  });
});
