"use client";

/**
 * Step 3 — YOUR ROLES. Stacked role cards: renameable titles, workflow-gated
 * ability pills (whole-area grants), an Advanced disclosure of the individual
 * MANAGE_* flags, a hover peek of the concrete grants, a per-card delete, and
 * "+ Add a seat" pulling from the org type's seat pool.
 *
 * Every seat is deletable EXCEPT the full-authority founder one, which renders
 * a YOU badge where the others render their ×. That is the invariant this step
 * guards: an org must keep at least one role that can do everything, or the
 * workspace it provisions has no one who can administer it. The reducer
 * (removeSeat) refuses the same case, so a synthetic click can't route around
 * the missing button.
 *
 * Holder-name inputs were cut (no invite step — seats describe authority, not
 * people).
 */

import { useState } from "react";
import type { Draft } from "@/lib/onboarding/draft";
import { KIND_LABEL } from "@/lib/onboarding/kinds";
import {
  activeAreas,
  areaState,
  roleSummary,
  AREA_DESC,
  PERM_LABELS,
  type PermArea,
} from "@/lib/onboarding/perm-areas";
import { SEAT_POOL, roleToneIvory, type Seat } from "@/lib/onboarding/seats";
import { KIND_TO_TYPE } from "@/lib/onboarding/kinds";
import type { WorkflowId } from "@/lib/org-types";
import { monogram, wfSet, type FlowAction } from "./flow-state";
import { AreaIcon } from "./icons";

/** Click-to-rename inline title (mock's .rc-title behavior). */
function RenameTitle({
  value,
  className,
  onRename,
  disabled,
}: {
  value: string;
  className: string;
  onRename: (title: string) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (disabled) return <span className={className}>{value}</span>;
  if (!editing) {
    return (
      <span className={className} title="Click to rename" onClick={() => setEditing(true)}>
        {value}
      </span>
    );
  }
  return (
    <span className={className}>
      <input
        defaultValue={value}
        autoFocus
        onFocus={e => e.target.select()}
        onBlur={e => {
          onRename(e.target.value);
          setEditing(false);
        }}
        onKeyDown={e => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        aria-label="Role name"
      />
    </span>
  );
}

/** The hover peek: exactly what this seat can do, grouped by area. */
function Peek({ seat, areas, enabled }: { seat: Seat; areas: PermArea[]; enabled: ReadonlySet<WorkflowId> }) {
  const groups = areas
    .map(area => {
      const perms = seat.all ? [...area.perms] : area.perms.filter(p => seat.permissions.includes(p));
      return perms.length ? { area, labels: perms.map(p => PERM_LABELS[p]) } : null;
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);
  return (
    <div className="rc-peek">
      <div className="rc-peek-head">
        <span className="rc-peek-title"><em>{seat.title}</em></span>
        <span className="rc-peek-who">{seat.all ? "YOU" : "Unassigned"}</span>
      </div>
      <div className="rc-peek-sum">{roleSummary(seat.permissions, enabled, seat.all)}</div>
      {groups.length ? (
        <>
          <div className="rc-peek-lab">Can do</div>
          <div className="rc-peek-areas">
            {groups.map(g => (
              <div key={g.area.id} className="rc-peek-area">
                <AreaIcon id={g.area.id} />
                <div className="txt">
                  <div className="an">{g.area.label}</div>
                  <div className="al">{g.labels.join(" · ")}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="rc-peek-none">
          No admin abilities yet — this seat can see the workspace but can&rsquo;t change it. Tap a pill to grant one.
        </div>
      )}
    </div>
  );
}

export function RolesStep({
  draft,
  dispatch,
  onContinue,
}: {
  draft: Draft;
  dispatch: React.Dispatch<FlowAction>;
  onContinue: () => void;
}) {
  const enabled = wfSet(draft);
  const areas = activeAreas(enabled);
  const orgType = KIND_TO_TYPE[draft.kind ?? "fraternity"];
  const pool = (SEAT_POOL[orgType] ?? []).filter(p => !draft.seats.some(s => s.title === p.title));
  const kindLabel = draft.kind ? KIND_LABEL[draft.kind].toLowerCase() : "your organization";

  return (
    <div className="bp roles">
      <div className="bp-head">
        <p className="kicker">Your roles — who can do what</p>
        <h1 className="q-serif">
          Who can do what at <em>{draft.name.trim() || "your organization"}</em>?
        </h1>
        <p className="bp-sub">
          I set these roles up for {kindLabel} — each already does its job. Tap a pill to add or
          remove an ability, or just leave them.
        </p>
      </div>
      <div className="roles-stack">
        {draft.seats.map((seat, i) => {
          const founder = !!seat.all;
          return (
            <div
              key={`${i}-${seat.title}`}
              className={`role-card${founder ? " founder" : ""}`}
              style={{
                ["--rc-dusk" as string]: seat.color,
                ["--rc-ivory" as string]: roleToneIvory(seat.color),
                animationDelay: `${i * 60}ms`,
              }}
            >
              <div className="rc-head">
                <span className="rc-avatar">{monogram(seat.title)}</span>
                <div className="rc-namecol">
                  <RenameTitle
                    value={seat.title}
                    className="rc-title"
                    disabled={founder}
                    onRename={title => dispatch({ type: "renameSeat", index: i, title })}
                  />
                  <span className="rc-summary">{roleSummary(seat.permissions, enabled, seat.all)}</span>
                </div>
                {founder ? (
                  <span className="rc-you">YOU</span>
                ) : (
                  <button
                    className="rc-x"
                    title={`Delete ${seat.title}`}
                    aria-label={`Delete ${seat.title}`}
                    onClick={() => dispatch({ type: "removeSeat", index: i })}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="pill-row">
                {areas.map(area => {
                  const st = founder ? "on" : areaState(seat.permissions, area);
                  return (
                    <button
                      key={area.id}
                      className={`pill ${st}`}
                      onClick={
                        founder
                          ? undefined
                          : () => dispatch({ type: "toggleSeatArea", index: i, areaId: area.id })
                      }
                      aria-pressed={st !== "off"}
                    >
                      <AreaIcon id={area.id} />
                      {area.label}
                      {st === "partial" && <span className="part-dot">•</span>}
                      <span className="pill-tip" role="tooltip">{AREA_DESC[area.id]}</span>
                    </button>
                  );
                })}
              </div>
              {founder ? (
                <p className="rc-founder-note">
                  The founder seat holds <b>full authority</b> and can delegate every role — you can
                  hand it off in Settings later.
                </p>
              ) : (
                <details className="rc-adv">
                  <summary>Advanced — fine-tune each ability</summary>
                  {areas.map(area => (
                    <div key={area.id} className="adv-area">
                      <h6>
                        <AreaIcon id={area.id} />
                        {area.label}
                      </h6>
                      <div className="adv-abils">
                        {area.perms.map(p => {
                          const on = seat.permissions.includes(p);
                          return (
                            <button
                              key={p}
                              className={`abil${on ? " on" : ""}`}
                              onClick={() => dispatch({ type: "toggleSeatPerm", index: i, perm: p })}
                              aria-pressed={on}
                            >
                              <span className="ac">{on ? "✓" : ""}</span>
                              {PERM_LABELS[p]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </details>
              )}
              <Peek seat={seat} areas={areas} enabled={enabled} />
            </div>
          );
        })}
      </div>
      {pool.length > 0 && (
        <button
          className="add-seat roles-add"
          onClick={() =>
            dispatch({
              type: "addSeat",
              seat: { title: pool[0]!.title, color: pool[0]!.color, permissions: [...pool[0]!.permissions] },
            })
          }
        >
          + Add a seat — <b>{pool.map(p => p.title).join(", ")}</b>
        </button>
      )}
      <div className="bp-cta-row">
        <button className="cta big" onClick={onContinue}>
          Looks right — review the blueprint<span>→</span>
        </button>
      </div>
      <p className="bp-foot">
        Every role and ability has a home in Settings later — this is a fast start, not a lock-in.
      </p>
    </div>
  );
}
