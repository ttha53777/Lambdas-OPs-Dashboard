/**
 * Integrity tests for KIND_VARIANTS — the modifiers that refine a kind's SHAPE
 * (seats, words, metric defaults) — and for how flowReducer applies them.
 *
 * A variant no longer decides pages. The interview's activity beats own the page
 * set ("in a normal month, which of these happen?" — unnamed = off), so these
 * tests now assert the inverse of what they once did: setVariant must leave
 * enabledWorkflows ALONE. See the workflow-authority model in lib/org-types.ts.
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_METRIC_DEFAULTS,
  KIND_IDS,
  KIND_TO_TYPE,
  KIND_VARIANTS,
} from "@/lib/onboarding/kinds";
import { draftToCreateOrgInput, emptyDraft, type Draft } from "@/lib/onboarding/draft";
import { flowReducer } from "@/app/create/_components/flow-state";
import { ALL_WORKFLOWS, ALWAYS_ON_WORKFLOWS, BASE_WORKFLOWS, BEAT_WORKFLOWS, getOrgType } from "@/lib/org-types";
import { PERMISSIONS } from "@/lib/permissions";

describe("workflow authority model", () => {
  it("BASE and BEAT partition ALL_WORKFLOWS, and always-on lives in BASE", () => {
    const base = new Set<string>(BASE_WORKFLOWS);
    const beat = new Set<string>(BEAT_WORKFLOWS);
    // Disjoint: a page is decided by exactly one authority.
    for (const w of base) expect(beat, `${w} is in both BASE and BEAT`).not.toContain(w);
    // Exhaustive: no page is left with no owner.
    expect([...base, ...beat].sort()).toEqual([...ALL_WORKFLOWS].sort());
    // Always-on can never be a beat's to remove.
    for (const w of ALWAYS_ON_WORKFLOWS) expect(base, `always-on ${w} must be BASE`).toContain(w);
  });

  it("setKind seeds ONLY the base pages — the kind never guesses an activity page", () => {
    for (const kind of KIND_IDS) {
      const draft = flowReducer(emptyDraft(), { type: "setKind", kind });
      for (const w of draft.enabledWorkflows) {
        expect(BASE_WORKFLOWS, `setKind(${kind}) seeded beat-owned page "${w}"`).toContain(w);
      }
      // A roster and a dashboard are table stakes — the sheet is never empty.
      expect(draft.enabledWorkflows).toContain("members");
      expect(draft.enabledWorkflows).toContain("operations");
    }
  });
});

describe("KIND_VARIANTS integrity", () => {
  it("every added seat carries only real permission names", () => {
    for (const [kind, variants] of Object.entries(KIND_VARIANTS)) {
      for (const v of variants ?? []) {
        for (const seat of v.seatAdd ?? []) {
          for (const p of seat.permissions) {
            expect(Object.keys(PERMISSIONS), `${kind}:${v.id} seat ${seat.title}`).toContain(p);
          }
        }
      }
    }
  });

  it("every seatRemove names a real seat in the kind's base template (and never the founder)", () => {
    for (const [kind, variants] of Object.entries(KIND_VARIANTS)) {
      const template = getOrgType(KIND_TO_TYPE[kind as keyof typeof KIND_TO_TYPE])!;
      const titles = new Set(template.roleSeeds.filter(r => !r.all).map(r => r.name));
      for (const v of variants ?? []) {
        for (const title of v.seatRemove ?? []) {
          expect(titles, `${kind}:${v.id} removes unknown seat "${title}"`).toContain(title);
        }
      }
    }
  });

  it("fraternity/arts keep a true no-delta default variant (the template shape)", () => {
    for (const kind of ["fraternity", "arts"] as const) {
      const first = KIND_VARIANTS[kind]![0]!;
      expect(first.seatRemove ?? []).toHaveLength(0);
      expect(first.seatAdd ?? []).toHaveLength(0);
    }
  });

  it("BUILTIN_METRIC_DEFAULTS covers every kind", () => {
    for (const kind of KIND_IDS) expect(BUILTIN_METRIC_DEFAULTS[kind]).toBeDefined();
  });
});

describe("flowReducer: setVariant", () => {
  function draftWithKind(kind: (typeof KIND_IDS)[number]): Draft {
    return flowReducer(emptyDraft(), { type: "setKind", kind });
  }

  it("applies the professional-fraternity modifier: seats and metrics", () => {
    const draft = flowReducer(draftWithKind("fraternity"), { type: "setVariant", variant: "professional" });
    expect(draft.variant).toBe("professional");
    const titles = draft.seats.map(s => s.title);
    expect(titles).not.toContain("Social");
    expect(titles).not.toContain("PR");
    expect(titles).toContain("VP Professional Development");
    expect(titles).toContain("VP Membership");
    // The founder seat survives every variant.
    expect(draft.seats.some(s => s.all)).toBe(true);
    expect(draft.metrics.serviceHours).toBe(false);
    expect(draft.metrics.gpa).toBe(true);
  });

  it("NEVER touches the page set — pages belong to the activity beats", () => {
    // The founder said they run socials and hand out tasks; a variant resolved
    // afterwards (the concierge can do this on a later turn) must not undo it.
    const base = draftWithKind("fraternity");
    const answered = flowReducer(base, {
      type: "applyAiPicks",
      picks: { addWorkflows: ["parties", "tasks"], removeWorkflows: [], vocab: {} },
    });
    const withVariant = flowReducer(answered, { type: "setVariant", variant: "professional" });
    expect(withVariant.enabledWorkflows).toEqual(answered.enabledWorkflows);
    expect(withVariant.enabledWorkflows).toContain("parties");
    expect(withVariant.enabledWorkflows).toContain("tasks");
  });

  it("is idempotent and switch-safe: re-applying or changing variants never stacks", () => {
    const base = draftWithKind("fraternity");
    const once = flowReducer(base, { type: "setVariant", variant: "professional" });
    const twice = flowReducer(once, { type: "setVariant", variant: "professional" });
    expect(twice.seats).toEqual(once.seats);
    // Switching to another variant, then back, lands on the same state.
    const detour = flowReducer(flowReducer(once, { type: "setVariant", variant: "service" }), {
      type: "setVariant",
      variant: "professional",
    });
    expect(detour.seats).toEqual(once.seats);
    expect(detour.metrics).toEqual(once.metrics);
  });

  it("the default variant equals the untouched template", () => {
    const base = draftWithKind("fraternity");
    const social = flowReducer(base, { type: "setVariant", variant: "social" });
    expect(social.enabledWorkflows).toEqual(base.enabledWorkflows);
    expect(social.seats).toEqual(base.seats);
  });

  it("preserves custom metrics across a variant switch", () => {
    let draft = draftWithKind("club");
    draft = flowReducer(draft, { type: "addCustomMetric", name: "Chapter Points", unit: "pts" });
    draft = flowReducer(draft, { type: "setVariant", variant: "cultural" });
    expect(draft.metrics.custom).toEqual([{ name: "Chapter Points", unit: "pts" }]);
    expect(draft.metrics.attendance).toBe(false); // cultural flips attendance off
  });

  it("setKind resets the variant and metric flags to the new kind's defaults", () => {
    let draft = flowReducer(draftWithKind("fraternity"), { type: "setVariant", variant: "professional" });
    draft = flowReducer(draft, { type: "setKind", kind: "team" });
    expect(draft.variant).toBeNull();
    expect(draft.metrics.gpa).toBe(false);
    expect(draft.metrics.attendance).toBe(true);
  });
});

describe("flowReducer: metrics + founder title", () => {
  it("applyAiPicks toggles workflows and vocab but never drops always-on", () => {
    const base = flowReducer(emptyDraft(), { type: "setKind", kind: "fraternity" });
    const next = flowReducer(base, {
      type: "applyAiPicks",
      picks: {
        addWorkflows: ["communications"],
        removeWorkflows: ["parties", "operations"],
        vocab: { Member: "Knight" },
      },
    });
    expect(next.enabledWorkflows).toContain("communications");
    expect(next.enabledWorkflows).not.toContain("parties");
    expect(next.enabledWorkflows).toContain("operations"); // always-on survives
    expect(next.vocab.Member).toBe("Knight");
  });

  it("addCustomMetric trims, caps at 5, and rejects empties", () => {
    let draft = flowReducer(emptyDraft(), { type: "setKind", kind: "club" });
    draft = flowReducer(draft, { type: "addCustomMetric", name: "  Points  ", unit: "  pts " });
    expect(draft.metrics.custom).toEqual([{ name: "Points", unit: "pts" }]);
    expect(flowReducer(draft, { type: "addCustomMetric", name: "   ", unit: null }).metrics.custom).toHaveLength(1);
    for (let i = 0; i < 6; i++) draft = flowReducer(draft, { type: "addCustomMetric", name: `M${i}`, unit: null });
    expect(draft.metrics.custom).toHaveLength(5);
  });
});

describe("flowReducer: removeSeat", () => {
  const seeded = (kind: "fraternity" | "club" = "fraternity") =>
    flowReducer(emptyDraft(), { type: "setKind", kind });

  it("deletes an ordinary seat by index", () => {
    const draft = seeded();
    const victim = draft.seats.findIndex(s => !s.all);
    expect(victim).toBeGreaterThan(-1);
    const title = draft.seats[victim]!.title;
    const next = flowReducer(draft, { type: "removeSeat", index: victim });
    expect(next.seats).toHaveLength(draft.seats.length - 1);
    expect(next.seats.some(s => s.title === title)).toBe(false);
  });

  it("refuses to delete the last full-authority seat", () => {
    const draft = seeded();
    const founder = draft.seats.findIndex(s => s.all);
    expect(founder).toBeGreaterThan(-1);
    const next = flowReducer(draft, { type: "removeSeat", index: founder });
    expect(next.seats).toEqual(draft.seats);
    expect(next.seats.filter(s => s.all)).toHaveLength(1);
  });

  it("keeps an all-permission seat no matter how many ordinary seats are deleted", () => {
    let draft = seeded();
    // Walk the list from the end so each delete's index stays valid, and aim
    // every action at the founder too — the guard, not the UI, is what holds.
    for (let i = draft.seats.length - 1; i >= 0; i--) {
      draft = flowReducer(draft, { type: "removeSeat", index: i });
    }
    expect(draft.seats).toHaveLength(1);
    expect(draft.seats[0]!.all).toBe(true);
  });

  it("ignores an out-of-range index", () => {
    const draft = seeded();
    expect(flowReducer(draft, { type: "removeSeat", index: 99 }).seats).toEqual(draft.seats);
    expect(flowReducer(draft, { type: "removeSeat", index: -1 }).seats).toEqual(draft.seats);
  });

  it("a seat deleted here never reaches the provisioning payload", () => {
    const draft = seeded();
    const victim = draft.seats.findIndex(s => !s.all);
    const title = draft.seats[victim]!.title;
    const next = flowReducer(draft, { type: "removeSeat", index: victim });
    const seeds = draftToCreateOrgInput({ ...next, name: "Test Org" }).blueprint!.roleSeeds!;
    expect(seeds.some(r => r.name === title)).toBe(false);
    expect(seeds.filter(r => r.all)).toHaveLength(1);
  });
});
