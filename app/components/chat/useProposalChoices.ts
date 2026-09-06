"use client";

// The option sets a writ card's `choice` fields pick from — the org's own event
// types and ledger categories, not a fixed enum, because a chapter renames and
// adds both. See proposal-edit.ts for why category is editable this way rather
// than as free text.
//
// Fetched once per widget and shared by every card, on two grounds: several
// proposals in one turn would otherwise each fetch the same two lists, and the
// lists must be in hand BEFORE a row is opened — a picker that populates a beat
// after you click it loses the click. Both reads are ungated (every member's
// ledger and calendar view already needs them), so a member who can't approve a
// card can still be handed them harmlessly; the permission gate on the card is
// what decides whether editing is offered at all.

import { useEffect, useState } from "react";

import { orgFetch } from "../../lib/api";
import { isProgrammingManagedType } from "@/lib/programming";
import type { ChoiceOption, ChoiceSource } from "./proposal-edit";

export type ChoiceSets = Partial<Record<ChoiceSource, ChoiceOption[]>>;

interface EventTypeRow { slug: string; label: string; creatable: boolean; hidden: boolean }
interface TxCategoryRow { slug: string; label: string; kind: string; hidden: boolean }

export function useProposalChoices(enabled: boolean): ChoiceSets {
  const [sets, setSets] = useState<ChoiceSets>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void (async () => {
      const [types, cats] = await Promise.all([
        orgFetch("/api/calendar/event-types").then(r => (r.ok ? r.json() : [])).catch(() => []),
        orgFetch("/api/treasury/categories").then(r => (r.ok ? r.json() : [])).catch(() => []),
      ]) as [EventTypeRow[], TxCategoryRow[]];
      if (cancelled) return;

      // Mirror what the proposal handlers themselves accept, so the picker can
      // never offer a value the endpoint would then reject: calendar events want
      // creatable, non-hidden types, and programming manages that same set minus
      // chapter (isProgrammingManagedType).
      const usable = Array.isArray(types) ? types.filter(t => t.creatable && !t.hidden) : [];
      const opt = (r: { slug: string; label: string }): ChoiceOption => ({ value: r.slug, label: r.label });

      setSets({
        eventType:       usable.map(opt),
        programmingType: usable.filter(isProgrammingManagedType).map(opt),
        txCategory:      (Array.isArray(cats) ? cats.filter(c => !c.hidden) : []).map(opt),
      });
    })();

    return () => { cancelled = true; };
  }, [enabled]);

  return sets;
}
