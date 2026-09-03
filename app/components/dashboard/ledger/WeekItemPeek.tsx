"use client";

import React, { useEffect, useState } from "react";
import { Modal } from "../primitives";
import { orgFetch } from "../../../lib/api";
import { taskAssigneeLabel, type CalEventType, type CalendarEvent, type Task } from "../../../data";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW    = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

/** Parsed at noon so a DST shift can't roll the date onto its neighbour. */
function parseISO(iso: string): Date {
  return new Date(`${iso}T12:00:00`);
}

function fmtLongDate(iso: string): string {
  const d = parseISO(iso);
  return `${DOW[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Whole days from `today` to `iso`, both read as local calendar dates. */
function daysUntil(iso: string, today: string): number {
  return Math.round((parseISO(iso).getTime() - parseISO(today).getTime()) / 86_400_000);
}

/** The one line that answers "do I need to care right now?". */
function relWhen(iso: string, today: string): string {
  const diff = daysUntil(iso, today);
  if (diff === 0)  return "Today";
  if (diff === 1)  return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 0)    return `In ${diff} days`;
  return `${-diff} days ago`;
}

const FALLBACK_CAT_COLOR = "#8a8f98";

/** The dashboard renders the dusk (dark) theme, so `colorDark` is the visible one. */
function catColor(types: Map<string, CalEventType>, category: string): string {
  const t = types.get(category);
  return t ? (t.colorDark ?? t.color) : FALLBACK_CAT_COLOR;
}

type AttendanceDetail = {
  excused:   { brotherId: number; brotherName: string; reason: string }[];
  unexcused: { brotherId: number; brotherName: string }[];
  attended:  { brotherId: number; brotherName: string }[];
};

/**
 * What This Week hands back when a row is clicked. The two row kinds carry
 * different records, so the peek is told which one it has rather than trying to
 * re-derive it from a merged shape.
 */
export type WeekPeekTarget =
  | { kind: "event";    event: CalendarEvent }
  | { kind: "deadline"; task: Task };

/**
 * Detail sheet for one This Week row.
 *
 * Deliberately read-only apart from the single link out: the dashboard row is a
 * glance, and the peek answers the questions a glance raises — when exactly,
 * where, is it required, who is coming — without turning into a second copy of
 * the timeline's editor. Anything beyond that ("Open in timeline" / "Open task")
 * hands off to the page that already owns editing.
 */
export function WeekItemPeek({
  target,
  today,
  eventTypes,
  rosterSize,
  onClose,
  onOpenEvent,
  onOpenTask,
}: {
  target: WeekPeekTarget;
  today: string;
  eventTypes: Map<string, CalEventType>;
  /** Non-exempt roster count — the denominator for the attendance bar. */
  rosterSize: number;
  onClose: () => void;
  /** Jump to this event on the timeline. */
  onOpenEvent: (event: CalendarEvent) => void;
  /** Jump to this deadline on the tasks page. */
  onOpenTask: (task: Task) => void;
}) {
  const isEvent = target.kind === "event";
  const date    = isEvent ? target.event.date : (target.task.dueDate as string);
  const title   = isEvent ? target.event.title : target.task.title;
  const accent  = isEvent ? catColor(eventTypes, target.event.category) : "var(--gold, #d8a657)";
  const rel     = relWhen(date, today);
  const isToday = date === today;
  const isPast  = date < today;

  // Attendance is only meaningful for a mandatory event, and only worth fetching
  // for one — an optional coffee run has no roll to take.
  const wantsAttendance = isEvent && target.event.mandatory;
  const eventId = isEvent ? target.event.id : null;
  const [att, setAtt]         = useState<AttendanceDetail | null>(null);
  const [attLoading, setLoad] = useState(false);
  const [attFailed, setFail]  = useState(false);

  useEffect(() => {
    if (!wantsAttendance || eventId == null) return;
    const controller = new AbortController();
    setAtt(null);
    setFail(false);
    setLoad(true);
    orgFetch(`/api/attendance/${eventId}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: AttendanceDetail) => setAtt(data))
      .catch(err => { if (err.name !== "AbortError") setFail(true); })
      .finally(() => setLoad(false));
    return () => controller.abort();
  }, [wantsAttendance, eventId]);

  const attended  = att?.attended.length  ?? 0;
  const excused   = att?.excused.length   ?? 0;
  const absent    = att?.unexcused.length ?? 0;
  const logged    = attended + excused + absent;
  // Nobody has been marked either way yet: the remainder of the roster is
  // "not logged", which is a different fact from "absent" and must not be
  // coloured like one.
  const unlogged  = Math.max(0, rosterSize - logged);
  const barTotal  = Math.max(1, logged + unlogged);

  return (
    <Modal
      ariaLabel={title}
      onClose={onClose}
      tone="dusk"
      hideHeader
      maxWidthClass="max-w-md"
    >
      <div className="wpeek" style={{ ["--peek-accent" as string]: accent }}>
        {/* Hero: the date is the loudest thing here, because "when" is the
            question a week row most often leaves open. */}
        <div className="wpeek-hero">
          <div className="wpeek-tags">
            <span className="wpeek-cat">
              {isEvent
                ? (eventTypes.get(target.event.category)?.label ?? target.event.category)
                : "Deadline"}
            </span>
            {isEvent && target.event.mandatory && <span className="wpeek-req">Required</span>}
            {!isEvent && target.task.status === "done" && <span className="wpeek-done">Done</span>}
          </div>
          <h3 className="wpeek-title">{title}</h3>
          <p className="wpeek-when">
            <span className="d">{fmtLongDate(date)}</span>
            <span className={`rel${isToday ? " now" : isPast ? " past" : ""}`}>{rel}</span>
          </p>
        </div>

        {/* Facts. Each row is a question the dashboard row couldn't answer. */}
        <dl className="wpeek-facts">
          {isEvent && target.event.time && (
            <div className="wpeek-fact"><dt>Time</dt><dd>{target.event.time}</dd></div>
          )}
          {isEvent && target.event.location && (
            <div className="wpeek-fact"><dt>Where</dt><dd>{target.event.location}</dd></div>
          )}
          {!isEvent && (
            <div className="wpeek-fact"><dt>Owner</dt><dd>{taskAssigneeLabel(target.task, 4)}</dd></div>
          )}
          {isEvent && target.event.description && (
            <div className="wpeek-fact wide"><dd>{target.event.description}</dd></div>
          )}
          {!isEvent && target.task.notes && (
            <div className="wpeek-fact wide"><dd>{target.task.notes}</dd></div>
          )}
        </dl>

        {/* Attendance — a proportion bar, not a name dump. The dashboard peek
            answers "how's turnout", and the timeline owns the per-person roll. */}
        {wantsAttendance && (
          <div className="wpeek-att">
            <div className="wpeek-att-h">
              <span className="lab">Attendance</span>
              {logged > 0 && <span className="count">{attended}/{rosterSize}</span>}
            </div>
            {attLoading ? (
              <p className="wpeek-att-note">Loading…</p>
            ) : attFailed ? (
              <p className="wpeek-att-note">Couldn&apos;t load attendance.</p>
            ) : logged === 0 ? (
              <p className="wpeek-att-note">
                {isPast ? "No attendance recorded." : "Nothing logged yet."}
              </p>
            ) : (
              <>
                <div
                  className="wpeek-bar"
                  role="img"
                  aria-label={`${attended} attended, ${excused} excused, ${absent} absent, ${unlogged} not logged`}
                >
                  {attended > 0 && <i className="seg ok"      style={{ flexGrow: attended }} />}
                  {excused  > 0 && <i className="seg exc"     style={{ flexGrow: excused  }} />}
                  {absent   > 0 && <i className="seg abs"     style={{ flexGrow: absent   }} />}
                  {unlogged > 0 && <i className="seg unknown" style={{ flexGrow: unlogged }} />}
                </div>
                <ul className="wpeek-legend">
                  {attended > 0 && <li><i className="d ok" />{attended} here</li>}
                  {excused  > 0 && <li><i className="d exc" />{excused} excused</li>}
                  {absent   > 0 && <li><i className="d abs" />{absent} absent</li>}
                  {unlogged > 0 && <li><i className="d unknown" />{unlogged} not logged</li>}
                </ul>
                {/* Guard against a stale denominator reading as a lie: if more
                    people were logged than the roster has non-exempt members,
                    say nothing rather than render a bar that overflows. */}
                {barTotal < logged && <p className="wpeek-att-note">Roster changed since logging.</p>}
              </>
            )}
          </div>
        )}

        <div className="wpeek-actions">
          <button type="button" className="wpeek-ghost" onClick={onClose}>Close</button>
          <button
            type="button"
            className="wpeek-primary"
            onClick={() => (isEvent ? onOpenEvent(target.event) : onOpenTask(target.task))}
          >
            {isEvent ? "Open in timeline" : "Open task"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </Modal>
  );
}
