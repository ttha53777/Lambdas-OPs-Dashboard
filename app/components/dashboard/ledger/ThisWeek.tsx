import React from "react";
import { fmtRange, taskAssigneeLabel, type CalendarEvent, type Task } from "../../../data";
import { SectionError } from "./SectionError";
import type { WeekPeekTarget } from "./WeekItemPeek";

const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
function weekday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function dayNum(iso: string): number {
  return Number(iso.split("-")[2]);
}

type WeekItem = {
  date: string;
  title: string;
  meta: string;
  kind: "event" | "deadline";
  today: boolean;
  /** The record behind the row, handed straight to the peek sheet. Kept on the
   *  item rather than re-looked-up by id: the two kinds live in different lists,
   *  and an id alone would need a lookup that can miss. */
  target: WeekPeekTarget;
};

/**
 * "This week" agenda — every calendar event plus deadlines due in the current
 * ISO week (already filtered by the page's weeklyDigest), merged and
 * date-sorted. Mandatory events are tagged as such in the meta line rather than
 * being the only ones shown.
 * Read-only; the header All link to the existing deadline drawer so
 * deadline management stays reachable. Carries `id="sec-deadlines"`.
 */
export function ThisWeek({
  events,
  deadlines,
  weekStart,
  weekEnd,
  today,
  onAll,
  onSelect,
  calendarEmpty = false,
  onAddEvent,
  loading = false,
  error = false,
  onRetry,
}: {
  events: CalendarEvent[];
  deadlines: Task[];
  weekStart: string;
  weekEnd: string;
  today: string;
  onAll?: () => void;
  /** Opens the detail sheet for one row. A row click is a different intent from
   *  the card click (which opens the deadlines drawer), so it stops propagation;
   *  without this handler the rows stay inert text as before. */
  onSelect?: (target: WeekPeekTarget) => void;
  /** True when the calendar has no events at all, not merely none this week.
   *  "Nothing on the agenda this week" is the right answer for a quiet week and
   *  the wrong one for a calendar nobody has opened yet. */
  calendarEmpty?: boolean;
  /** Adds the first event. Undefined without MANAGE_EVENTS (or when the org
   *  doesn't run the events workflow) — the copy stands, the button doesn't. */
  onAddEvent?: () => void;
  /** The week is assembled from two sections (calendar + deadlines); true until
   *  BOTH land. An empty agenda is a real answer here, so it must not be given
   *  while either half is still in flight. */
  loading?: boolean;
  /** Either half failed. Takes precedence over `loading`, which stays true for a
   *  failed section (it never joins `loadedSections`). */
  error?: boolean;
  onRetry?: () => void;
}) {
  const items: WeekItem[] = [
    ...events.map((e): WeekItem => ({
      date: e.date,
      title: e.title,
      meta: [e.time, e.location, e.mandatory ? "mandatory" : null].filter(Boolean).join(" · "),
      kind: "event",
      today: e.date === today,
      target: { kind: "event", event: e },
    })),
    ...deadlines
      .filter(d => d.dueDate != null)
      .map((d): WeekItem => ({
        date: d.dueDate as string,
        title: d.title,
        meta: taskAssigneeLabel(d),
        kind: "deadline",
        today: d.dueDate === today,
        target: { kind: "deadline", task: d },
      })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <section
      id="sec-deadlines"
      className={`card${onAll && !loading && !error ? " cursor-pointer" : ""}`}
      aria-label="This week"
      onClick={loading || error ? undefined : onAll}
    >
      <div className="card-h">
        <h2>This week</h2>
        <div className="right">
          {/* The week range is computed from the clock, not fetched — it is
              already true, so it stays put while the agenda loads. */}
          <span className="sub">{fmtRange(weekStart, weekEnd)}</span>
        </div>
      </div>
      {error ? (
        <SectionError what="this week's agenda" onRetry={onRetry} />
      ) : loading ? (
        <div className="rail-skel rows" aria-busy="true" aria-label="Loading this week">
          {[0, 1, 2].map(i => (
            <div key={i} className="skel-row">
              <i className="skel day" />
              <i className="skel line" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rail-empty">
          {calendarEmpty ? "No events on the calendar yet." : "Nothing on the agenda this week."}
          {calendarEmpty && onAddEvent && (
            <button
              type="button"
              className="a"
              onClick={(e) => { e.stopPropagation(); onAddEvent(); }}
            >
              Add your first event →
            </button>
          )}
        </div>
      ) : (
        items.map((it, i) => {
          const body = (
            <>
              <div className="day">{weekday(it.date)}<b>{dayNum(it.date)}</b></div>
              <div className="what">
                <p className="t">
                  {it.title}
                  {it.kind === "deadline" && <span className="ddl-pill">DEADLINE</span>}
                  {it.today && <span className="today-pill">TODAY</span>}
                </p>
                {it.meta && <p className="m">{it.meta}</p>}
              </div>
            </>
          );
          const cls = it.today ? "week-item today" : "week-item";
          // A real <button> rather than a click handler on the div: these rows are
          // now the entry point to an event, so they have to be reachable and
          // operable from the keyboard like any other control.
          return onSelect ? (
            <button
              key={`${it.kind}-${i}`}
              type="button"
              className={cls}
              onClick={(e) => { e.stopPropagation(); onSelect(it.target); }}
            >
              {body}
            </button>
          ) : (
            <div key={`${it.kind}-${i}`} className={cls}>{body}</div>
          );
        })
      )}
    </section>
  );
}
