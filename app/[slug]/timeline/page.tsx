"use client";

import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useContext } from "react";
import { Sidebar } from "../../components/Sidebar";
import { BrotherAvatar } from "../../components/BrotherAvatar";
import { CalendarEvent, CalEventType, CalLayer, Task, InstagramTask, fmtDate, fmtRange, isoWeekBounds, taskAssigneeLabel } from "../../data";
import { isEventTypeVisibleInPicker } from "../../../lib/event-types";
import { CalendarCategory } from "../../../lib/state/calendar-category";
import { useChapter } from "../../context/ChapterContext";
import { Modal, ConfirmDialog } from "../../components/dashboard/primitives";
import { inputCls } from "../../components/dashboard/styles";
import { requestJson, orgFetch, ApiError } from "../../lib/api";
import { pad, toDateStr, daysFromToday } from "../../lib/dates";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrgPath } from "../../hooks/useOrgPath";
import { CalendarEventForm, type CalendarDraft, type CategoryOption } from "../../components/timeline/CalendarEventForm";
import { useActiveSemester } from "../../hooks/useActiveSemester";
import { useSemesterErrorHandler } from "../../hooks/useSemesterErrorHandler";
import { isNavVisible } from "../../components/Sidebar";
import "../../components/dashboard/dashboard-ledger.css";
import "../../components/dashboard/timeline-ledger.css";

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const _now = new Date();
const TODAY = { year: _now.getFullYear(), month: _now.getMonth(), day: _now.getDate() };

// Live deadlines/parties/IG posts are folded into the calendar timeline with
// offset ids so they don't collide with real CalendarEvent ids. Subtract the base
// to get back to the source Deadline.id (used to mark a deadline complete from the
// rail). Parties use 20000; Instagram posts use 30000 and render as deadline rows.
const DEADLINE_ID_BASE = 10000;
const IG_ID_BASE = 30000;
/** The source Deadline.id behind a timeline event, or null if it isn't a live deadline row. */
function deadlineIdOf(event: CalendarEvent): number | null {
  if (event.category !== "deadline") return null;
  const id = event.id - DEADLINE_ID_BASE;
  return id > 0 && id < DEADLINE_ID_BASE ? id : null;
}

interface PendingExcuse {
  id:              number;
  brotherId:       number;
  brotherName:     string;
  calendarEventId: number;
  eventTitle:      string;
  eventDate:       string;
  reason:          string;
  status:          string;
  submittedAt:     string;
  isRetroactive:   boolean;
  rejectionNote:   string | null;
}

// Glance-strip measures — clicking one opens its breakdown in the rail.
type GlanceMetric = "week" | "required" | "deadlines" | "overdue";
const GLANCE_TITLE: Record<GlanceMetric, string> = {
  week:      "This week",
  required:  "Required this month",
  deadlines: "Upcoming deadlines",
  overdue:   "Overdue",
};

// Filter layers — mono segmented control. `mandatory` reads as "Required".
const LAYERS: { id: CalLayer; label: string }[] = [
  { id: "all",       label: "All" },
  { id: "mandatory", label: "Required" },
  { id: "deadlines", label: "Deadlines" },
  { id: "parties",   label: "Parties" },
  { id: "service",   label: "Service" },
];

// Event types (labels + colors) are per-org now, fetched from
// /api/calendar/event-types and shared to the sub-components via this context so
// each row/rail can resolve its category without prop-threading. The app renders
// the "dusk" (dark) theme, so the visible color is `colorDark` (falling back to
// `color`). Unknown slugs get a neutral grey — legacy/edge safety.
const EventTypesContext = React.createContext<Map<string, CalEventType>>(new Map());
function useEventTypes() { return useContext(EventTypesContext); }

const FALLBACK_CAT_COLOR = "#8a8f98";

function catColorOf(types: Map<string, CalEventType>, category: string): string {
  const t = types.get(category);
  return t ? (t.colorDark ?? t.color) : FALLBACK_CAT_COLOR;
}

/** Per-row color: drive the `--catc` custom property the spine/rail read. */
function catStyleOf(types: Map<string, CalEventType>, category: string): React.CSSProperties {
  return { ["--catc" as string]: catColorOf(types, category) } as React.CSSProperties;
}

function catLabelOf(types: Map<string, CalEventType>, category: string): string {
  return types.get(category)?.label ?? category;
}

// ─── Meeting notes ────────────────────────────────────────────────────────────
// A chapter meeting's `description` IS its minutes (that's the field the Chapter
// page's minutes textarea writes). Minutes run long, so when the user has asked
// the AI to summarize them we show the summary here instead — the rail is a
// glance surface, not a reading surface. No summary means the user never asked
// for one, and then the raw minutes are all there is to show.
//
// Branching on the `chapter` slug is safe: built-in slugs are immutable (see
// lib/state/calendar-category.ts). Custom types that reuse `description` as a
// blurb keep the plain one-line meta row.

/** A meeting's minutes are its description; only `chapter` events carry minutes. */
function isMeetingEvent(event: CalendarEvent): boolean {
  return event.category === CalendarCategory.Chapter;
}

/** True when the minutes were edited after the summary was generated. */
function isSummaryStale(event: CalendarEvent): boolean {
  const summaryAt = event.notesSummaryAt ? new Date(event.notesSummaryAt).getTime() : 0;
  const updatedAt = event.notesUpdatedAt ? new Date(event.notesUpdatedAt).getTime() : 0;
  // Same 2s grace as the Chapter page: summarizing bumps both stamps in one
  // request, so an exact-ish tie is not a real edit.
  return summaryAt > 0 && updatedAt > summaryAt + 2000;
}

// Tiny renderer for the summarizer's narrow dialect — `**bold**`, "- " bullets,
// bold-only lines as section headers. Mirrors the Chapter page's SummaryMarkdown,
// but styled with the ledger's CSS classes instead of that page's Tailwind/dusk
// literals so it themes with the rest of the timeline.
function renderSummaryInline(text: string, keyPrefix: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4
      ? <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
      : <span key={`${keyPrefix}-${i}`}>{part}</span>,
  );
}

function SummaryBody({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    const at = blocks.length;
    blocks.push(<ul key={`ul-${at}`}>{bullets.map((b, i) => <li key={i}>{renderSummaryInline(b, `b-${at}-${i}`)}</li>)}</ul>);
    bullets = [];
  };
  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); return; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) { bullets.push(bullet[1]); return; }
    flush();
    const header = line.match(/^\*\*([^*]+)\*\*:?\s*$/);
    if (header) { blocks.push(<p key={`h-${i}`} className="sec">{header[1]}</p>); return; }
    blocks.push(<p key={`p-${i}`}>{renderSummaryInline(line, `p-${i}`)}</p>);
  });
  flush();
  return <div className="ev-notes-body">{blocks}</div>;
}

/** The minutes block for a meeting: the AI summary when there is one, else the raw minutes. */
function MeetingNotes({ event }: { event: CalendarEvent }) {
  const summary = (event.notesSummary ?? "").trim();
  const minutes = (event.description ?? "").trim();
  if (!summary && !minutes) return null;

  if (!summary) {
    return (
      <div className="ev-notes">
        <div className="ev-notes-head"><span className="lab">Minutes</span></div>
        <div className="ev-notes-body raw">{minutes}</div>
      </div>
    );
  }

  const stale = isSummaryStale(event);
  return (
    <div className={`ev-notes summary${stale ? " stale" : ""}`}>
      <div className="ev-notes-head">
        <span className="ai-badge">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
          </svg>
          AI Summary
        </span>
        {event.notesSummaryAt && (
          <span className="gen">
            Generated {new Date(event.notesSummaryAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        )}
      </div>
      {stale && <p className="ev-notes-stale">Notes have changed since this summary.</p>}
      <SummaryBody text={summary} />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function filterByLayer(events: CalendarEvent[], layer: CalLayer): CalendarEvent[] {
  switch (layer) {
    case "all":       return events;
    case "mandatory": return events.filter(e => e.mandatory);
    case "deadlines": return events.filter(e => e.category === "deadline");
    case "parties":   return events.filter(e => e.category === "party");
    case "service":   return events.filter(e => e.category === "service");
  }
}

function fmtDow(dateStr: string) {
  const d = new Date(dateStr + "T12:00:00");
  return DAY_NAMES[d.getDay()].toUpperCase();
}

/** Human relative day: Today / Tomorrow / Yesterday / In N days / N days ago. */
function relWhen(dateStr: string): string {
  const diff = daysFromToday(dateStr);
  if (diff === 0)  return "Today";
  if (diff === 1)  return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 0)    return `In ${diff} days`;
  return `${-diff} days ago`;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

interface MonthGroup {
  id: string;
  monthLabel: string;
  year: number;
  isCurrentMonth: boolean;
  events: CalendarEvent[];
}

function buildMonthGroups(events: CalendarEvent[]): MonthGroup[] {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));

  const map: Record<string, MonthGroup> = {};
  for (const e of sorted) {
    const [yr, mo] = e.date.split("-").map(Number);
    const key = `${yr}-${pad(mo)}`;
    if (!map[key]) {
      map[key] = {
        id: key,
        monthLabel: MONTH_NAMES[mo - 1],
        year: yr,
        isCurrentMonth: yr === TODAY.year && mo === TODAY.month + 1,
        events: [],
      };
    }
    map[key].events.push(e);
  }

  // Current month pinned to the top; every other month stacked most-recent
  // first below it (e.g. a Jan–May term, viewed in March, reads March, then
  // May → April, then Feb → Jan). Events inside each month stay chronological
  // so the today marker and first-future-row logic still line up.
  return Object.values(map).sort((a, b) => {
    if (a.isCurrentMonth !== b.isCurrentMonth) return a.isCurrentMonth ? -1 : 1;
    return b.id.localeCompare(a.id);
  });
}

// ─── TodayMarker ──────────────────────────────────────────────────────────────

function TodayMarker() {
  const todayStr = toDateStr(TODAY.year, TODAY.month, TODAY.day);
  return (
    <div className="today-marker">
      <span className="pill">Today · {fmtDow(todayStr)} {fmtDate(todayStr)}</span>
      <span className="line" />
    </div>
  );
}

// ─── TimelineRow ──────────────────────────────────────────────────────────────

function TimelineRow({
  event, isToday, isPast, selected, onSelect, rowRef,
}: {
  event: CalendarEvent;
  isToday: boolean;
  isPast: boolean;
  selected: boolean;
  onSelect: (e: CalendarEvent) => void;
  rowRef?: (el: HTMLDivElement | null) => void;
}) {
  const types = useEventTypes();
  const [, , d] = event.date.split("-").map(Number);
  const stateCls = isToday ? "today" : isPast ? "past" : "future";

  return (
    <div
      ref={rowRef}
      /* Scroll target for the ?event= deep link (see the effect in the page). */
      data-event-id={event.id}
      className={`tl-row ${stateCls}${selected ? " selected" : ""}`}
      style={catStyleOf(types, event.category)}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(event)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(event); } }}
    >
      <div className="tl-date">
        <div className="dow">{fmtDow(event.date)}</div>
        <div className="dnum">{d}</div>
      </div>
      <div className="tl-node"><span className="dot"><i /></span></div>
      <div className="tl-body">
        <div className="tl-card">
          <div className="grow">
            <div className="t">{event.title}</div>
            <div className="m">
              <span className="cat">{catLabelOf(types, event.category)}</span>
              {event.mandatory && <span className="req">Required</span>}
              {event.time && <span>{event.time}</span>}
              {event.location && <span>{event.location}</span>}
            </div>
          </div>
          <span className="when">{relWhen(event.date)}</span>
          <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
          </svg>
        </div>
      </div>
    </div>
  );
}

// ─── EventDetail (rail, when a row is selected) ───────────────────────────────

type AttendanceDetail = {
  excused:   { brotherId: number; brotherName: string; reason: string; isRetroactive: boolean }[];
  unexcused: { brotherId: number; brotherName: string }[];
  attended:  { brotherId: number; brotherName: string }[];
  // Brother ids exempt from attendance this semester — excluded from the log form.
  exempt:    number[];
};

function EventDetail({
  event,
  onClose,
  canEdit,
  canDelete,
  canLogAttendance,
  onEdit,
  onDelete,
  onOpenProgramming,
  linkedPosts,
  onOpenInstagram,
  brotherList,
  selfBrotherId,
  deadlineStatus,
  canCompleteDeadline,
  onToggleDeadline,
}: {
  event: CalendarEvent;
  onClose: () => void;
  canEdit: boolean;
  canDelete: boolean;
  canLogAttendance: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** Present only for programming-backed events — jumps to the Programming page. */
  onOpenProgramming?: () => void;
  /** Instagram posts that promote this event (reverse of InstagramTask.calendarEventId). */
  linkedPosts?: { id: number; title: string; type: string; dueDate: string }[];
  /** Jump to the Instagram page. */
  onOpenInstagram?: () => void;
  brotherList: { id: number; name: string }[];
  selfBrotherId: number | null;
  /** Status of the source Task, when this row is a live dated task; null otherwise. */
  deadlineStatus: "open" | "done" | null;
  canCompleteDeadline: boolean;
  onToggleDeadline: (complete: boolean) => void;
}) {
  const isDeadline = event.category === "deadline";
  const isMeeting  = isMeetingEvent(event);
  const isComplete = deadlineStatus === "done";
  const todayStr   = toDateStr(TODAY.year, TODAY.month, TODAY.day);
  const isPast     = event.date < todayStr;
  const [, mo, d]  = event.date.split("-").map(Number);
  const types      = useEventTypes();

  const [attDetail,     setAttDetail]     = useState<AttendanceDetail | null>(null);
  const [attLoading,    setAttLoading]    = useState(false);
  const [excuseOpen,    setExcuseOpen]    = useState(false);
  const [excuseBrother, setExcuseBrother] = useState("");
  const [excuseReason,  setExcuseReason]  = useState("");
  const [excuseSubmitting, setExcuseSubmitting] = useState(false);
  const [logAttOpen,    setLogAttOpen]    = useState(false);
  const [logAttended,   setLogAttended]   = useState<Set<number>>(new Set());
  const [logSubmitting, setLogSubmitting] = useState(false);
  const [logError,      setLogError]      = useState<string | null>(null);

  useEffect(() => {
    if (!event.mandatory) return;
    const controller = new AbortController();
    setAttDetail(null);
    setAttLoading(true);
    orgFetch(`/api/attendance/${event.id}`, { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: AttendanceDetail) => setAttDetail(data))
      .catch(err => { if (err.name !== "AbortError") console.error("Failed to load attendance", err); })
      .finally(() => setAttLoading(false));
    return () => controller.abort();
  }, [event.id, event.mandatory]);

  useEffect(() => {
    setExcuseOpen(false);
    setExcuseBrother("");
    setExcuseReason("");
    setLogAttOpen(false);
    setLogAttended(new Set());
    setLogError(null);
  }, [event.id]);

  async function submitExcuse(e: React.FormEvent) {
    e.preventDefault();
    if (!excuseReason.trim()) return;
    if (canLogAttendance && !excuseBrother) return;
    setExcuseSubmitting(true);
    try {
      const res = await fetch("/api/excuses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendarEventId: event.id,
          brotherId: canLogAttendance ? Number(excuseBrother) : selfBrotherId ?? undefined,
          reason: excuseReason.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Excuse submission failed", err);
        return;
      }
      const updated = await requestJson<AttendanceDetail>(`/api/attendance/${event.id}`);
      setAttDetail(updated);
      setExcuseOpen(false);
      setExcuseBrother("");
      setExcuseReason("");
    } catch (err) {
      console.error("Excuse submission error", err);
    } finally {
      setExcuseSubmitting(false);
    }
  }

  function openLogAtt() {
    const excusedIds = new Set((attDetail?.excused ?? []).map(e => e.brotherId));
    const exemptIds = new Set(attDetail?.exempt ?? []);
    const alreadyAttended = new Set((attDetail?.attended ?? []).map(e => e.brotherId));
    const eligible = brotherList.filter(b => !excusedIds.has(b.id) && !exemptIds.has(b.id));
    setLogAttended(alreadyAttended.size > 0 ? alreadyAttended : new Set(eligible.map(b => b.id)));
    setLogError(null);
    setLogAttOpen(true);
  }

  async function submitLogAtt(e: React.FormEvent) {
    e.preventDefault();
    if (logSubmitting) return;
    setLogSubmitting(true);
    setLogError(null);
    try {
      const res = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendarEventId: event.id, attendedIds: Array.from(logAttended) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setLogError(typeof err?.error === "string" ? err.error : "Failed to log attendance.");
        return;
      }
      const updated = await requestJson<AttendanceDetail>(`/api/attendance/${event.id}`);
      setAttDetail(updated);
      setLogAttOpen(false);
    } catch {
      setLogError("Failed to log attendance. Please try again.");
    } finally {
      setLogSubmitting(false);
    }
  }

  return (
    <div className="ev" style={catStyleOf(types, event.category)}>
      {/* Back + edit/delete */}
      <div className="ev-top">
        <button className="ev-back" onClick={onClose}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        {canEdit && (
          <div className="ev-icons">
            <button className="ev-icon" title="Edit event" onClick={onEdit}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            {canDelete && (
              <button className="ev-icon danger" title="Delete event" onClick={onDelete}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Hero */}
      <div className="ev-hero">
        <div className="tags">
          <span className="cat">{catLabelOf(types, event.category)}</span>
          {event.mandatory && <span className="req">Required</span>}
          {isComplete && <span className="done">Done</span>}
        </div>
        <h3>{event.title}</h3>
        <div className="date">
          <span className="d">{fmtDow(event.date)} {d} {MONTH_NAMES[mo - 1]}</span>
          <span className="rel">{relWhen(event.date)}</span>
        </div>
      </div>

      {/* Meta. A meeting's description is its minutes, which get their own block
          below (summarized when the user asked for a summary) rather than being
          crammed into a one-line meta row. */}
      {(event.time || event.location || (event.description && !isMeeting) || isDeadline) && (
        <div className="ev-meta">
          {event.time && <div className="ev-meta-row"><span className="lab">Time</span>{event.time}</div>}
          {event.location && <div className="ev-meta-row"><span className="lab">Where</span>{event.location}</div>}
          {event.description && !isMeeting && <div className="ev-meta-row">{event.description}</div>}
          {isDeadline && !isComplete && (
            <div className={`ev-meta-row ddl${isPast ? " over" : ""}`}>
              {isPast ? "Overdue — was due this date" : "Submit by this date"}
            </div>
          )}
        </div>
      )}

      {isMeeting && <MeetingNotes event={event} />}

      {/* Programming-backed events live in the Programming pipeline — jump there. */}
      {onOpenProgramming && (
        <button className="ev-prog-link" onClick={onOpenProgramming}>
          Open in Programming
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      )}

      {/* Instagram posts that promote this event (set from the Instagram page). */}
      {linkedPosts && linkedPosts.length > 0 && (
        <div className="ev-linked-ig">
          <span className="lab">On Instagram</span>
          {linkedPosts.map(p => (
            <button key={p.id} className="ev-ig-row" onClick={onOpenInstagram}>
              <span className="ig-type">{p.type}</span>
              <span className="ig-title">{p.title}</span>
              <span className="ig-due">{fmtDow(p.dueDate)} {Number(p.dueDate.split("-")[2])} {MONTH_NAMES[Number(p.dueDate.split("-")[1]) - 1]}</span>
            </button>
          ))}
        </div>
      )}

      {/* Deadline submission — mark a live deadline complete (or reopen it). */}
      {deadlineStatus !== null && (
        <div className={`ev-deadline${isComplete ? " done" : ""}`}>
          <div className="row">
            <span className="state">
              <span className="d" />
              {isComplete ? "Submitted · complete" : "Not yet submitted"}
            </span>
            {canCompleteDeadline && (
              isComplete ? (
                <button className="ev-btn-ghost" onClick={() => onToggleDeadline(false)}>Reopen</button>
              ) : (
                <button className="ev-btn-primary" onClick={() => onToggleDeadline(true)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Mark complete
                </button>
              )
            )}
          </div>
        </div>
      )}

      {/* Attendance — mandatory events only */}
      {event.mandatory && (
        <div className="ev-att">
          <div className="ev-att-h">
            <span className="lab">Attendance</span>
            {!logAttOpen && !excuseOpen && (
              <div className="acts">
                {canLogAttendance && (
                  <>
                    <button onClick={openLogAtt}>
                      {attDetail?.attended && attDetail.attended.length > 0 ? "Edit" : "Log"}
                    </button>
                    <span className="sep">·</span>
                  </>
                )}
                <button className="quiet" onClick={() => setExcuseOpen(true)}>Excuse</button>
              </div>
            )}
          </div>

          {/* Summary */}
          {!logAttOpen && !excuseOpen && (
            attLoading ? (
              <p className="ev-att-empty">Loading…</p>
            ) : !attDetail || (attDetail.excused.length === 0 && attDetail.unexcused.length === 0 && attDetail.attended.length === 0) ? (
              <p className="ev-att-empty">{isPast ? "No attendance recorded." : "No attendance logged yet."}</p>
            ) : (
              <div className="ev-att-body">
                {attDetail.attended.length > 0 && (
                  <div className="ev-att-group">
                    <div className="gh">
                      <span className="d" style={{ background: "var(--ok)" }} />
                      <span className="gl" style={{ color: "var(--ok)" }}>Attended</span>
                      <span className="gc">{attDetail.attended.length}</span>
                    </div>
                    {attDetail.attended.map(e => <p key={e.brotherId} className="nm">{e.brotherName}</p>)}
                  </div>
                )}
                {attDetail.excused.length > 0 && (
                  <div className="ev-att-group">
                    <div className="gh">
                      <span className="d" style={{ background: "var(--gold)" }} />
                      <span className="gl" style={{ color: "var(--gold)" }}>Excused</span>
                      <span className="gc">{attDetail.excused.length}</span>
                    </div>
                    {attDetail.excused.map(e => <p key={e.brotherId} className="nm" title={e.reason}>{e.brotherName}</p>)}
                  </div>
                )}
                {attDetail.unexcused.length > 0 && (
                  <div className="ev-att-group">
                    <div className="gh">
                      <span className="d" style={{ background: "var(--rose)" }} />
                      <span className="gl" style={{ color: "var(--rose)" }}>Absent</span>
                      <span className="gc">{attDetail.unexcused.length}</span>
                    </div>
                    {attDetail.unexcused.map(e => <p key={e.brotherId} className="nm">{e.brotherName}</p>)}
                  </div>
                )}
              </div>
            )
          )}

          {/* Log attendance form */}
          {logAttOpen && (() => {
            const excusedIds = new Set((attDetail?.excused ?? []).map(e => e.brotherId));
            const exemptIds  = new Set(attDetail?.exempt ?? []);
            const eligible   = brotherList.filter(b => !excusedIds.has(b.id) && !exemptIds.has(b.id));
            const excused    = brotherList.filter(b => excusedIds.has(b.id));
            return (
              <form onSubmit={submitLogAtt} className="ev-att-form">
                <p className="fl">Mark who attended</p>
                <div className="ev-checks">
                  {eligible.map(b => (
                    <label key={b.id} className="ev-check">
                      <input
                        type="checkbox"
                        checked={logAttended.has(b.id)}
                        onChange={() => setLogAttended(prev => { const n = new Set(prev); n.has(b.id) ? n.delete(b.id) : n.add(b.id); return n; })}
                      />
                      <span>{b.name}</span>
                    </label>
                  ))}
                  {excused.map(b => (
                    <div key={b.id} className="ev-check disabled">
                      <input type="checkbox" disabled />
                      <span>{b.name}</span>
                      <span className="excused-tag">excused</span>
                    </div>
                  ))}
                </div>
                <p className="ev-form-foot">
                  {logAttended.size} attending · {eligible.length - logAttended.size} absent
                  {excused.length > 0 && ` · ${excused.length} excused`}
                </p>
                {logError && <p className="ev-err">{logError}</p>}
                <div className="ev-form-actions">
                  <button type="submit" className="ev-btn-primary" disabled={logSubmitting}>{logSubmitting ? "Saving…" : "Save"}</button>
                  <button type="button" className="ev-btn-ghost" onClick={() => setLogAttOpen(false)}>Cancel</button>
                </div>
              </form>
            );
          })()}

          {/* Excuse form */}
          {excuseOpen && (
            <form onSubmit={submitExcuse} className="ev-att-form">
              <p className="fl">
                {canLogAttendance
                  ? (isPast && attDetail && attDetail.unexcused.length > 0 ? "Retroactive excuse" : "Submit excuse")
                  : "Submit excuse for yourself"}
              </p>
              {canLogAttendance ? (
                <select className={inputCls} value={excuseBrother} onChange={e => setExcuseBrother(e.target.value)} required>
                  <option value="">Select brother…</option>
                  {brotherList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              ) : (
                <p className="fl" style={{ textTransform: "none", letterSpacing: 0 }}>
                  {brotherList.find(b => b.id === selfBrotherId)?.name ?? "You"}
                </p>
              )}
              <input className={inputCls} value={excuseReason} onChange={e => setExcuseReason(e.target.value)} placeholder="Reason" required />
              <div className="ev-form-actions">
                <button type="submit" className="ev-btn-primary" disabled={excuseSubmitting}>{excuseSubmitting ? "Saving…" : "Submit"}</button>
                <button type="button" className="ev-btn-ghost" onClick={() => setExcuseOpen(false)}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}

      {!canEdit && <p className="ev-managed">Managed from its source list — edit there to update.</p>}
    </div>
  );
}

// ─── GlanceDetail (rail, when a glance measure is clicked) ───────────────────

function GlanceDetail({
  metric, events, weekStart, weekEnd, onClose, onSelectEvent,
}: {
  metric: GlanceMetric;
  events: CalendarEvent[];
  weekStart: string;
  weekEnd: string;
  onClose: () => void;
  onSelectEvent: (e: CalendarEvent) => void;
}) {
  const types = useEventTypes();
  const blurb: Record<GlanceMetric, string> = {
    week:      `Events scheduled for ${fmtRange(weekStart, weekEnd)}.`,
    required:  "Mandatory events this month — attendance is taken.",
    deadlines: "Deadlines still ahead, soonest first.",
    overdue:   "Incomplete deadlines past their due date.",
  };
  // Namespaced tone class — a bare "overdue" would collide with the global
  // .overdue badge pill rule and tint the whole hero rose.
  const tone = metric === "overdue" ? "gd-overdue" : metric === "required" ? "gd-required" : "";

  return (
    <div className="gd">
      <div className="ev-top">
        <button className="ev-back" onClick={onClose}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
      </div>

      <div className={`gd-hero ${tone}`}>
        <p className="k">{GLANCE_TITLE[metric]}</p>
        <p className="v">{events.length}</p>
        <p className="blurb">{blurb[metric]}</p>
      </div>

      {events.length === 0 ? (
        <p className="gd-empty">{metric === "overdue" ? "Nothing overdue — all clear." : "Nothing in this window."}</p>
      ) : (
        <div className="then-card">
          {events.map(ev => (
            <button key={ev.id} className="then-row" style={catStyleOf(types, ev.category)} onClick={() => onSelectEvent(ev)}>
              <span className="when">{fmtDow(ev.date)}<br />{fmtDate(ev.date)}</span>
              <div className="what">
                <p className="t">{ev.title}</p>
                <p className="s">{catLabelOf(types, ev.category)}{ev.mandatory ? " · Required" : ev.time ? ` · ${ev.time}` : ""}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TimelineTodo (rail, idle — "what needs me" action queue) ─────────────────

/**
 * The action surface at the top of the idle rail. Aggregates the timeline's own
 * needs-attention items from data the page already derives — overdue deadlines,
 * deadlines due this week, and (admin) pending excuses. Mirrors the dashboard's
 * NeedsAttention pattern but stays scoped to timeline concerns; it never touches
 * dues / reimbursements / member-risk. Every action routes to an existing handler.
 */
function TimelineTodo({
  overdue, dueThisWeek, pendingExcuseCount, isAdmin,
  onMarkDone, onOpenEvent, onReviewExcuses,
}: {
  overdue: CalendarEvent[];
  dueThisWeek: CalendarEvent[];
  pendingExcuseCount: number;
  isAdmin: boolean;
  onMarkDone: (deadlineId: number) => void;
  onOpenEvent: (event: CalendarEvent) => void;
  onReviewExcuses: () => void;
}) {
  const showExcuses = isAdmin && pendingExcuseCount > 0;
  const count = overdue.length + dueThisWeek.length + (showExcuses ? 1 : 0);

  return (
    <div>
      <p className="lbl">Needs attention{count > 0 ? ` · ${count}` : ""}</p>
      <div className="tl-todo">
        {count === 0 ? (
          <p className="tl-todo-empty">Nothing needs you right now — all clear.</p>
        ) : (
          <>
            {overdue.map(ev => {
              const late = -daysFromToday(ev.date);
              return (
                <div key={`o-${ev.id}`} className="tl-todo-row">
                  <span className="tag rose">Overdue</span>
                  <button type="button" className="body" onClick={() => onOpenEvent(ev)}>
                    <p className="t">{ev.title}</p>
                    <p className="m">{late} day{late === 1 ? "" : "s"} late · {fmtDate(ev.date)}</p>
                  </button>
                  <button type="button" className="act" onClick={() => { const id = deadlineIdOf(ev); if (id != null) onMarkDone(id); }}>Mark done</button>
                </div>
              );
            })}
            {showExcuses && (
              <div className="tl-todo-row">
                <span className="tag gold">Excuses</span>
                <button type="button" className="body" onClick={onReviewExcuses}>
                  <p className="t">{pendingExcuseCount} excuse{pendingExcuseCount === 1 ? "" : "s"} awaiting review</p>
                  <p className="m">Approve or reject below</p>
                </button>
                <button type="button" className="act" onClick={onReviewExcuses}>Review</button>
              </div>
            )}
            {dueThisWeek.map(ev => (
              <div key={`w-${ev.id}`} className="tl-todo-row">
                <span className="tag vio">Due</span>
                <button type="button" className="body" onClick={() => onOpenEvent(ev)}>
                  <p className="t">{ev.title}</p>
                  <p className="m">{relWhen(ev.date)} · {fmtDate(ev.date)}</p>
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TimelinePage() {
  const { currentUser, taskList, setTaskList, igTaskList, setIgTaskList, partyList, brotherList, setBrotherList, avatarRevision, can } = useChapter();
  const router  = useRouter();
  const searchParams = useSearchParams();
  const orgPath = useOrgPath();
  const activeSemester = useActiveSemester();
  const handleSemesterError = useSemesterErrorHandler();
  const selfId = currentUser?.id ?? null;
  const isAdmin = currentUser?.isAdmin ?? false;
  const canManageEvents = can("MANAGE_EVENTS");
  // The Instagram page is visible only when the org has the communications
  // workflow enabled — that gates the "log as post" option in Add Deadline.
  const igEnabled = isNavVisible("Instagram", currentUser?.org?.enabledWorkflows ?? []);

  const [sidebarOpen,     setSidebarOpen]     = useState(false);
  const [activeLayer,     setActiveLayer]     = useState<CalLayer>("all");
  const [selectedEvent,   setSelectedEvent]   = useState<CalendarEvent | null>(null);
  const [glanceFocus,     setGlanceFocus]     = useState<GlanceMetric | null>(null);
  const [apiEvents,       setApiEvents]       = useState<CalendarEvent[]>([]);
  const [eventTypes,      setEventTypes]      = useState<CalEventType[]>([]);
  const [collapsedMonths, setCollapsedMonths] = useState<Set<string>>(new Set());
  const [activeModal,     setActiveModal]     = useState<"create" | "edit" | null>(null);
  const [calendarLoading,      setCalendarLoading]      = useState(true);
  const [calendarError,        setCalendarError]        = useState<string | null>(null);
  const [confirmDeleteEvent,   setConfirmDeleteEvent]   = useState<CalendarEvent | null>(null);

  // Pending-excuse review queue (admin-only)
  const [pendingExcuses, setPendingExcuses] = useState<PendingExcuse[]>([]);
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectionNote, setRejectionNote] = useState("");
  const [excuseActionBusy, setExcuseActionBusy] = useState<number | null>(null);
  const [bulkApproving, setBulkApproving] = useState(false);

  const mainRef          = useRef<HTMLDivElement | null>(null);
  const todayRef         = useRef<HTMLDivElement | null>(null);
  const currentMonthRef  = useRef<HTMLDivElement | null>(null);
  const reviewRef        = useRef<HTMLDivElement | null>(null);

  // True when the today anchor is off-screen — drives whether "Jump to today"
  // shows, and which direction it points. Starts true so the button renders
  // until the observer reports otherwise.
  const [todayOffscreen, setTodayOffscreen] = useState(true);
  const [todayAbove,      setTodayAbove]     = useState(false);

  // Legend popover on the filter toolbar.
  const [legendOpen, setLegendOpen] = useState(false);

  useEffect(() => {
    requestJson<CalendarEvent[]>("/api/calendar")
      .then(data => { setApiEvents(data); setCalendarError(null); })
      .catch(error => {
        // A 401 here means the fetch raced the session cookie on a hard
        // navigation (see the same case in [slug]/page.tsx's loadCalendar).
        // ChapterContext's redirect handler covers the real unauth case, so
        // treating this as an error just spams the console with a false
        // "database" failure.
        if (error instanceof ApiError && error.status === 401) return;
        console.error(error);
        setCalendarError("Could not load calendar events from the database.");
      })
      .finally(() => setCalendarLoading(false));
  }, []);

  // Per-org event types drive the timeline's labels/colors/legend + the picker.
  useEffect(() => {
    requestJson<CalEventType[]>("/api/calendar/event-types")
      .then(setEventTypes)
      .catch(() => {});
  }, []);

  const enabledWorkflows = currentUser?.org?.enabledWorkflows ?? [];
  const typeMap = useMemo(() => new Map(eventTypes.map(t => [t.slug, t])), [eventTypes]);
  // Types shown in the legend: not hidden and (no workflow or its workflow is on).
  // Includes non-creatable types (party/deadline) since those still appear on the spine.
  const legendTypes = useMemo(
    () => eventTypes
      .filter(t => !t.hidden && (t.workflowId == null || enabledWorkflows.includes(t.workflowId)))
      .sort((a, b) => a.displayOrder - b.displayOrder),
    [eventTypes, enabledWorkflows],
  );
  // The add-event picker: only creatable, workflow-enabled, non-hidden types.
  const categoryOptions = useMemo<CategoryOption[]>(
    () => eventTypes
      .filter(t => isEventTypeVisibleInPicker(t, enabledWorkflows))
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map(t => ({ slug: t.slug, label: t.label, color: t.colorDark ?? t.color, mandatoryDefault: t.mandatoryDefault })),
    [eventTypes, enabledWorkflows],
  );
  // When editing, keep the event's own category selectable even if it's now
  // hidden or its workflow was turned off (so its chip still shows).
  const editCategoryOptions = useMemo<CategoryOption[]>(() => {
    if (!selectedEvent || categoryOptions.some(o => o.slug === selectedEvent.category)) return categoryOptions;
    const t = typeMap.get(selectedEvent.category);
    return t
      ? [...categoryOptions, { slug: t.slug, label: t.label, color: t.colorDark ?? t.color, mandatoryDefault: t.mandatoryDefault }]
      : categoryOptions;
  }, [categoryOptions, selectedEvent, typeMap]);

  // Admin-only: load pending excuses for the review banner.
  useEffect(() => {
    if (!isAdmin) { setPendingExcuses([]); return; }
    requestJson<PendingExcuse[]>("/api/excuses?status=pending")
      .then(setPendingExcuses)
      .catch(() => {});
  }, [isAdmin]);

  async function decideExcuse(excuseId: number, action: "approve" | "reject", note?: string) {
    setExcuseActionBusy(excuseId);
    const target = pendingExcuses.find(e => e.id === excuseId);
    try {
      const result = await requestJson<{ brotherId: number; attendance: number | null }>(`/api/excuses/${excuseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, rejectionNote: note }),
      });
      setPendingExcuses(prev => prev.filter(e => e.id !== excuseId));
      setRejectingId(null);
      setRejectionNote("");
      if (action === "approve" && target && result.attendance !== null) {
        setBrotherList(prev => prev.map(b => b.id === target.brotherId ? { ...b, attendance: result.attendance ?? b.attendance } : b));
      }
    } catch (err) {
      console.error("decideExcuse failed", err);
      setRejectingId(null);
      setRejectionNote("");
      requestJson<PendingExcuse[]>("/api/excuses?status=pending").then(setPendingExcuses).catch(() => {});
    } finally {
      setExcuseActionBusy(null);
    }
  }

  // Bulk-approve every currently pending excuse. decideExcuse is race-safe on the
  // server (updateMany on status=pending), so we fan out and only drop the rows
  // that actually resolved; failures stay in the queue. Rejections are never
  // bulked — each carries its own note.
  async function approveAll() {
    if (bulkApproving) return;
    const targets = [...pendingExcuses];
    if (targets.length === 0) return;
    setBulkApproving(true);
    try {
      const results = await Promise.allSettled(
        targets.map(t =>
          requestJson<{ brotherId: number; attendance: number | null }>(`/api/excuses/${t.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "approve" }),
          }).then(res => ({ id: t.id, ...res })),
        ),
      );
      const okIds = new Set<number>();
      const attendanceById: Record<number, number> = {};
      for (const r of results) {
        if (r.status === "fulfilled") {
          okIds.add(r.value.id);
          if (r.value.attendance !== null) attendanceById[r.value.brotherId] = r.value.attendance;
        }
      }
      setPendingExcuses(prev => prev.filter(e => !okIds.has(e.id)));
      if (Object.keys(attendanceById).length > 0) {
        setBrotherList(prev => prev.map(b => b.id in attendanceById ? { ...b, attendance: attendanceById[b.id] } : b));
      }
      const failed = targets.length - okIds.size;
      if (failed > 0) {
        // Resync the queue so any rows decided elsewhere clear too.
        requestJson<PendingExcuse[]>("/api/excuses?status=pending").then(setPendingExcuses).catch(() => {});
      }
    } finally {
      setBulkApproving(false);
    }
  }

  const apiEventIds = useMemo(() => new Set(apiEvents.map(e => e.id)), [apiEvents]);

  const allEvents = useMemo<CalendarEvent[]>(() => {
    const live: CalendarEvent[] = [
      // Only DATED tasks fold into the timeline — a dated task IS a deadline.
      // Undated to-dos live on the Tasks page. Tasks are never `mandatory`: a due
      // date isn't an event you take attendance for. Completion is tracked via the
      // task's own status, surfaced (and editable) in the rail.
      ...taskList
        .filter(d => d.dueDate != null)
        .map(d => ({
          id:          DEADLINE_ID_BASE + d.id,
          title:       d.title,
          date:        d.dueDate as string,
          category:    "deadline",
          mandatory:   false,
          description: `${taskAssigneeLabel(d)} · ${d.status === "done" ? "Done" : "Open"}`,
        })),
      ...partyList.map(p => ({
        id:          20000 + p.id,
        title:       p.name,
        date:        p.date,
        category:    "party",
        mandatory:   false,
        description: p.notes,
      })),
      // Instagram posts are dated tasks tracked on the Instagram page; fold them
      // into the timeline as deadline rows so they read as a due-by item here too.
      ...igTaskList.map(t => ({
        id:          IG_ID_BASE + t.id,
        title:       t.title,
        date:        t.dueDate,
        category:    "deadline",
        mandatory:   false,
        description: `Instagram ${t.type} · Status: ${t.status}`,
      })),
    ];

    const liveDeadlineTitles = new Set([...taskList.map(d => d.title), ...igTaskList.map(t => t.title)]);
    const livePartyTitles    = new Set(partyList.map(p => p.name));

    const deduped = apiEvents.filter(e => {
      if (e.category === "deadline") return !liveDeadlineTitles.has(e.title);
      if (e.category === "party")    return !livePartyTitles.has(e.title);
      return true;
    });

    return [...deduped, ...live];
  }, [apiEvents, taskList, partyList, igTaskList]);

  const filtered    = useMemo(() => filterByLayer(allEvents, activeLayer), [allEvents, activeLayer]);
  const monthGroups = useMemo(() => buildMonthGroups(filtered), [filtered]);
  const layerCounts = useMemo(
    () => Object.fromEntries(LAYERS.map(l => [l.id, filterByLayer(allEvents, l.id).length])),
    [allEvents],
  );
  const selectedEventCanEdit = selectedEvent ? apiEventIds.has(selectedEvent.id) : false;

  // The source Task behind the selected row, if it's a live dated task.
  const selectedDeadline = useMemo(() => {
    if (!selectedEvent) return null;
    const id = deadlineIdOf(selectedEvent);
    return id != null ? taskList.find(d => d.id === id) ?? null : null;
  }, [selectedEvent, taskList]);

  // Mark a task complete (or reopen it) from the rail. Optimistic, with the same
  // PATCH + revert pattern the dashboard uses.
  function setDeadlineComplete(deadlineId: number, complete: boolean) {
    const previous = taskList.find(d => d.id === deadlineId);
    if (!previous) return;
    const nextStatus: "open" | "done" = complete ? "done" : "open";
    if (previous.status === nextStatus) return;
    setTaskList(prev => prev.map(d => d.id === deadlineId ? { ...d, status: nextStatus } : d));
    requestJson<unknown>(`/api/tasks/${deadlineId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    }).catch(error => {
      console.error(error);
      setTaskList(prev => prev.map(d => d.id === deadlineId ? previous : d));
      setCalendarError("Task update failed. Local changes were reverted.");
    });
  }

  const todayStr = toDateStr(TODAY.year, TODAY.month, TODAY.day);
  const monthPrefix = todayStr.slice(0, 7);

  // The first event on or after today — the chronological "now" anchor.
  const todayAnchorId = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date));
    const upcoming = sorted.find(e => e.date >= todayStr);
    return upcoming ? upcoming.id : sorted.length > 0 ? sorted[sorted.length - 1].id : null;
  }, [filtered, todayStr]);

  // ── Rail + glance derivations (global — independent of the active filter) ──
  const { start: weekStart, end: weekEnd } = useMemo(() => isoWeekBounds(new Date()), []);
  const upcoming = useMemo(
    () => allEvents.filter(e => e.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date)),
    [allEvents, todayStr],
  );
  const upNext   = upcoming[0] ?? null;
  const thenList = upcoming.slice(1, 3);
  const lastEvent = useMemo(
    () => (allEvents.length ? [...allEvents].sort((a, b) => a.date.localeCompare(b.date))[allEvents.length - 1] : null),
    [allEvents],
  );

  // Per-metric event lists — counts are derived from .length so the glance
  // numbers and the rail breakdowns can never drift apart.
  const weekEvents = useMemo(
    () => allEvents.filter(e => e.date >= weekStart && e.date <= weekEnd).sort((a, b) => a.date.localeCompare(b.date)),
    [allEvents, weekStart, weekEnd],
  );
  const requiredEvents = useMemo(
    () => allEvents.filter(e => e.mandatory && e.date.startsWith(monthPrefix)).sort((a, b) => a.date.localeCompare(b.date)),
    [allEvents, monthPrefix],
  );
  const deadlineEvents = useMemo(
    () => allEvents.filter(e => e.category === "deadline" && e.date >= todayStr).sort((a, b) => a.date.localeCompare(b.date)),
    [allEvents, todayStr],
  );
  // Overdue: incomplete, strictly past-due deadlines (the deriveNeedsAttention
  // rule). Mapped to CalendarEvents the same way allEvents does so the rail can
  // open the same detail view as any other row.
  const overdueEvents = useMemo<CalendarEvent[]>(
    () => taskList
      .filter(d => d.status !== "done" && d.dueDate != null && d.dueDate < todayStr)
      .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string))
      .map(d => ({
        id:          DEADLINE_ID_BASE + d.id,
        title:       d.title,
        date:        d.dueDate as string,
        category:    "deadline",
        mandatory:   false,
        description: `${taskAssigneeLabel(d)} · Open`,
      })),
    [taskList, todayStr],
  );

  const thisWeekCount     = weekEvents.length;
  const requiredThisMonth = requiredEvents.length;
  const upcomingDeadlines = deadlineEvents.length;
  const deadlinesDueThisWeek = useMemo(() => deadlineEvents.filter(e => e.date <= weekEnd), [deadlineEvents, weekEnd]);
  const deadlinesThisWeek = deadlinesDueThisWeek.length;
  const overdueCount      = overdueEvents.length;

  // The events behind whichever glance measure is focused.
  const glanceEvents = useMemo<CalendarEvent[]>(() => {
    switch (glanceFocus) {
      case "week":      return weekEvents;
      case "required":  return requiredEvents;
      case "deadlines": return deadlineEvents;
      case "overdue":   return overdueEvents;
      default:          return [];
    }
  }, [glanceFocus, weekEvents, requiredEvents, deadlineEvents, overdueEvents]);

  const digest = useMemo(() => {
    if (allEvents.length === 0) return "No events scheduled yet.";
    const clauses: string[] = [];
    if (upNext) {
      const diff = daysFromToday(upNext.date);
      const t = upNext.time ? ` at ${upNext.time}` : "";
      if (diff === 0)       clauses.push(`${upNext.title} is today${t}`);
      else if (diff === 1)  clauses.push(`${upNext.title} is tomorrow${t}`);
      else                  clauses.push(`next up is ${upNext.title} on ${fmtDate(upNext.date)}`);
    }
    if (deadlinesThisWeek > 0) clauses.push(`${deadlinesThisWeek} deadline${deadlinesThisWeek === 1 ? "" : "s"} due this week`);
    if (overdueCount > 0)      clauses.push(`${overdueCount} ${overdueCount === 1 ? "is" : "are"} overdue`);
    else if (lastEvent)        clauses.push(`nothing's on the books past ${fmtDate(lastEvent.date)}`);
    const s = clauses.join(", ");
    return s ? s.charAt(0).toUpperCase() + s.slice(1) + "." : "";
  }, [allEvents.length, upNext, deadlinesThisWeek, overdueCount, lastEvent]);

  // Open the admin excuse-review panel and scroll it into view (it lives above
  // the spine/rail layout). Triggered from the rail's "Needs attention" block.
  function openReviewPanel() {
    setReviewPanelOpen(true);
    requestAnimationFrame(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // Scroll-spy: show "Jump to today" only when the today anchor is off-screen,
  // and point the arrow toward it. Re-attaches whenever the anchor row remounts
  // (filter change, month collapse) — todayRef is set imperatively in the row.
  useEffect(() => {
    const main = mainRef.current;
    const target = todayRef.current;
    if (!main || !target) { setTodayOffscreen(true); return; }
    const obs = new IntersectionObserver(
      ([entry]) => {
        setTodayOffscreen(!entry.isIntersecting);
        // boundingClientRect.top < root top ⇒ anchor sits above the viewport.
        const rootTop = entry.rootBounds?.top ?? 0;
        setTodayAbove(entry.boundingClientRect.top < rootTop);
      },
      { root: main, threshold: 0 },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, [todayAnchorId, monthGroups, collapsedMonths]);

  // Jump-to-today helper for the rail button. No auto-scroll on load — the
  // timeline opens at the top of the page (briefing first).
  function scrollToToday(smooth = false) {
    const main = mainRef.current;
    const target = todayRef.current ?? currentMonthRef.current;
    if (!main || !target) return;
    const delta = target.getBoundingClientRect().top - main.getBoundingClientRect().top;
    const top = main.scrollTop + delta - 96; // breathing room so "Today" sits just below the toolbar
    if (smooth) main.scrollTo({ top, behavior: "smooth" });
    else main.scrollTop = top;
  }

  // ── Deep link: /timeline?event=<id> opens straight onto that row ──────────
  // The dashboard's This Week peek hands off here, so the row it named has to be
  // selected AND visible. Runs once per id: after that the rail is the user's to
  // steer, and re-selecting on every render would fight their next click.
  const deepLinkedId = searchParams.get("event");
  const didDeepLink  = useRef<string | null>(null);
  useEffect(() => {
    if (!deepLinkedId || didDeepLink.current === deepLinkedId) return;
    if (calendarLoading || allEvents.length === 0) return;
    const match = allEvents.find(e => String(e.id) === deepLinkedId);
    didDeepLink.current = deepLinkedId;
    if (!match) return;
    setSelectedEvent(match);
    // The initial collapse hides every month but the current one, and a week can
    // straddle a month boundary — so open the target's month before scrolling.
    const groupId = match.date.slice(0, 7);
    setCollapsedMonths(prev => {
      if (!prev.has(groupId)) return prev;
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });
    // Two frames: one for the month to expand, one for the row to lay out.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector(`[data-event-id="${match.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }, [deepLinkedId, calendarLoading, allEvents]);

  // ── Collapse every month except the current one, once after events load ──
  const didInitCollapse = useRef(false);
  useLayoutEffect(() => {
    if (didInitCollapse.current || calendarLoading || monthGroups.length === 0) return;
    didInitCollapse.current = true;
    setCollapsedMonths(new Set(monthGroups.filter(g => !g.isCurrentMonth).map(g => g.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarLoading, monthGroups]);

  function toggleMonth(id: string) {
    setCollapsedMonths(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCreateEvent(draft: CalendarDraft) {
    const tempId = -Date.now();
    const optimistic: CalendarEvent = { id: tempId, ...draft };
    setApiEvents(prev => [...prev, optimistic]);
    setSelectedEvent(optimistic);
    setActiveModal(null);
    setCalendarError(null);

    const isService = draft.category === "service";
    const promise = isService
      ? requestJson<{ calendarEvent: CalendarEvent }>("/api/service-events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        }).then(res => res.calendarEvent)
      : requestJson<CalendarEvent>("/api/calendar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });

    promise
      .then(saved => { setApiEvents(prev => prev.map(e => e.id === tempId ? saved : e)); setSelectedEvent(saved); })
      .catch(error => {
        console.error(error);
        setApiEvents(prev => prev.filter(e => e.id !== tempId));
        setSelectedEvent(null);
        handleSemesterError(error, setCalendarError, "Calendar event could not be saved. Local changes were reverted.");
      });
  }

  function handleUpdateEvent(draft: CalendarDraft) {
    if (!selectedEvent || !selectedEventCanEdit) return;
    const previous = apiEvents.find(e => e.id === selectedEvent.id);
    if (!previous) return;
    const optimistic: CalendarEvent = { ...previous, ...draft };
    setApiEvents(prev => prev.map(e => e.id === previous.id ? optimistic : e));
    setSelectedEvent(optimistic);
    setActiveModal(null);
    setCalendarError(null);
    requestJson<CalendarEvent>(`/api/calendar/${previous.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    })
      .then(saved => { setApiEvents(prev => prev.map(e => e.id === previous.id ? saved : e)); setSelectedEvent(saved); })
      .catch(error => {
        console.error(error);
        setApiEvents(prev => prev.map(e => e.id === previous.id ? previous : e));
        setSelectedEvent(previous);
        handleSemesterError(error, setCalendarError, "Calendar event update failed. Local changes were reverted.");
      });
  }

  function handleDeleteEvent() {
    if (!selectedEvent || !selectedEventCanEdit) return;
    setConfirmDeleteEvent(selectedEvent);
  }

  function executeDeleteEvent(event: CalendarEvent) {
    const previous = apiEvents.find(e => e.id === event.id);
    if (!previous) return;
    setApiEvents(prev => prev.filter(e => e.id !== previous.id));
    setSelectedEvent(null);
    setCalendarError(null);
    requestJson<void>(`/api/calendar/${previous.id}`, { method: "DELETE" })
      .catch(error => {
        console.error(error);
        setApiEvents(prev => [...prev, previous].sort((a, b) => a.id - b.id));
        setSelectedEvent(previous);
        setCalendarError("Calendar event delete failed. Local changes were reverted.");
      });
  }

  const brotherNames = useMemo(() => brotherList.map(b => b.name), [brotherList]);

  const dateLabel = _now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const dateShort = _now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <EventTypesContext.Provider value={typeMap}>
    <div className="flex h-screen overflow-hidden bg-[#07090f]">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} activeSection="Timeline" onNavClick={() => {}} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">

        {/* ── Toolbar (mobile/tablet only — hidden at lg+ where the sidebar is
            static and "Add Event" lives in the briefing below). ──────────────── */}
        <header className="toolbar-frosted dash-toolbar relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-white/[0.05] px-3 sm:gap-3 sm:px-5 lg:hidden">
          <button onClick={() => setSidebarOpen(true)} className="tb-icon-btn flex h-8 w-8 items-center justify-center rounded-lg text-[#958d7c] hover:bg-white/[0.07] lg:hidden">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <p className="tb-title text-[14px] font-semibold leading-tight text-[#ece7dd]">Timeline</p>
            <p className="tb-org hidden text-[11px] leading-tight text-[#958d7c] sm:block">{currentUser?.org?.name ?? "ChaptOS"}</p>
          </div>

          <p className="tb-date hidden text-[11px] text-[#958d7c] xl:block shrink-0">{dateShort}</p>

          <button
            onClick={() => router.push(orgPath("/tasks?new=1"))}
            className="tb-btn inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(236,231,221,0.12)] bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-[#c9c2b4] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-150 hover:border-[#a78bfa]/40 hover:bg-[#a78bfa]/10 hover:text-[#ece7dd] focus:outline-none"
          >
            <svg className="h-3.5 w-3.5 text-[#958d7c]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            <span className="hidden sm:inline">Add Deadline</span>
          </button>

          <button
            onClick={() => setActiveModal("create")}
            className="tb-btn inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(236,231,221,0.12)] bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-[#c9c2b4] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-all duration-150 hover:border-[#a78bfa]/40 hover:bg-[#a78bfa]/10 hover:text-[#ece7dd] focus:outline-none"
          >
            <svg className="h-3.5 w-3.5 text-[#958d7c]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            <span className="hidden sm:inline">Add Event</span>
          </button>
        </header>

        {/* ── Scrollable body ──────────────────────────────────────────────── */}
        <main ref={mainRef} className="page-ambient flex-1 overflow-y-auto">
          <div className="dash dash-timeline" data-dashboard-theme="dusk">

            {/* Loading / error banner */}
            {(calendarLoading || calendarError) && (
              <div style={{
                marginBottom: 14, border: "1px solid var(--line)", borderRadius: 10,
                background: "var(--card)", padding: "10px 14px", fontSize: 12,
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                color: calendarError ? "var(--rose)" : "var(--muted)",
              }}>
                <span>{calendarError ?? "Loading calendar events…"}</span>
                {calendarError && (
                  <button onClick={() => setCalendarError(null)} className="card-act">Dismiss</button>
                )}
              </div>
            )}

            {/* ── Briefing ─────────────────────────────────────────────────── */}
            <section className="briefing" aria-label="Timeline briefing">
              <div>
                <p className="kicker">
                  <span className="today">{dateLabel}</span>
                  &ensp;·&ensp;Week of {fmtRange(weekStart, weekEnd)}
                </p>
                <h1 className="greeting">The weeks <em>ahead</em>.</h1>
                {digest && (
                  <div className="digest">
                    <span className="ai-chip">AI</span>
                    <p>{digest}</p>
                  </div>
                )}
              </div>
              {/* Desktop add actions (the topbar that used to carry them is hidden at lg+). */}
              <div className="tl-add-actions">
                <button className="tl-add-btn ghost" onClick={() => router.push(orgPath("/tasks?new=1"))}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth={2.4} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  Add Deadline
                </button>
                <button className="tl-add-btn" onClick={() => setActiveModal("create")}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth={2.4} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  Add Event
                </button>
              </div>
            </section>

            {/* ── Glance strip — each measure opens its breakdown in the rail ── */}
            <section className="ledger" aria-label="Timeline measures">
              <button
                type="button"
                className={`measure${glanceFocus === "week" ? " on" : ""}`}
                aria-pressed={glanceFocus === "week"}
                onClick={() => { setSelectedEvent(null); setGlanceFocus(f => f === "week" ? null : "week"); }}
              >
                <p className="k">This week</p>
                <p className="v">{thisWeekCount}</p>
                <p className="note">{fmtRange(weekStart, weekEnd)}</p>
              </button>
              <button
                type="button"
                className={`measure${glanceFocus === "required" ? " on" : ""}`}
                aria-pressed={glanceFocus === "required"}
                onClick={() => { setSelectedEvent(null); setGlanceFocus(f => f === "required" ? null : "required"); }}
              >
                <p className="k">Required</p>
                <p className="v">{requiredThisMonth}</p>
                <p className="note">this month</p>
              </button>
              <button
                type="button"
                className={`measure${glanceFocus === "deadlines" ? " on" : ""}`}
                aria-pressed={glanceFocus === "deadlines"}
                onClick={() => { setSelectedEvent(null); setGlanceFocus(f => f === "deadlines" ? null : "deadlines"); }}
              >
                <p className="k">Deadlines</p>
                <p className="v">{upcomingDeadlines}</p>
                <p className={deadlinesThisWeek > 0 ? "note warn" : "note"}>
                  {deadlinesThisWeek > 0 ? `${deadlinesThisWeek} due this week` : "upcoming"}
                </p>
              </button>
              <button
                type="button"
                className={`measure${overdueCount > 0 ? " flag" : ""}${glanceFocus === "overdue" ? " on" : ""}`}
                aria-pressed={glanceFocus === "overdue"}
                onClick={() => { setSelectedEvent(null); setGlanceFocus(f => f === "overdue" ? null : "overdue"); }}
              >
                <p className="k">Overdue</p>
                <p className="v">{overdueCount}</p>
                <p className={overdueCount > 0 ? "note bad" : "note"}>
                  {overdueCount > 0 ? "need follow-up" : "all clear"}
                </p>
              </button>
            </section>

            {/* ── Filter ───────────────────────────────────────────────────── */}
            <div className="tl-toolbar">
              <div className="seg" role="tablist" aria-label="Filter events">
                {LAYERS.map(layer => {
                  const active = activeLayer === layer.id;
                  const count  = layerCounts[layer.id] ?? 0;
                  return (
                    <button key={layer.id} className={active ? "on" : ""} aria-selected={active} onClick={() => setActiveLayer(layer.id)}>
                      {layer.label} <span className="ct">{count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="tl-legend-wrap">
                <button
                  type="button"
                  className={`tl-legend-btn${legendOpen ? " on" : ""}`}
                  aria-expanded={legendOpen}
                  aria-label="Category legend"
                  onClick={() => setLegendOpen(o => !o)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="9" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v5m0-8h.01" />
                  </svg>
                  Legend
                </button>
                {legendOpen && (
                  <>
                    <button type="button" className="tl-legend-scrim" aria-hidden tabIndex={-1} onClick={() => setLegendOpen(false)} />
                    <div className="tl-legend-pop" role="dialog" aria-label="Category legend">
                      <div className="grid2">
                        {legendTypes.map(t => (
                          <div key={t.slug} className="li">
                            <span className="d" style={{ background: t.colorDark ?? t.color }} />
                            <span>{t.label}</span>
                          </div>
                        ))}
                        <div className="li"><span className="req-key">REQ</span><span>Attendance taken</span></div>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <span className="tl-scope">{filtered.length} event{filtered.length === 1 ? "" : "s"}</span>
            </div>

            {/* ── Admin: pending-excuse review ─────────────────────────────── */}
            {isAdmin && pendingExcuses.length > 0 && (
              <div className="tl-review" style={{ marginTop: 18 }} ref={reviewRef}>
                <button className="tl-review-h" onClick={() => setReviewPanelOpen(o => !o)}>
                  <span className="lead">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z" />
                    </svg>
                    {pendingExcuses.length} excuse{pendingExcuses.length === 1 ? "" : "s"} awaiting review
                  </span>
                  <span className="chev">{reviewPanelOpen ? "Hide" : "Review"}</span>
                </button>
                {reviewPanelOpen && (
                  <div className="tl-review-body">
                    {pendingExcuses.length > 1 && (
                      <div className="tl-review-bulk">
                        <span>Reviewed each one?</span>
                        <button type="button" onClick={approveAll} disabled={bulkApproving}>
                          {bulkApproving ? "Approving…" : `Approve all ${pendingExcuses.length}`}
                        </button>
                      </div>
                    )}
                    {pendingExcuses.map(ex => {
                      const isRejecting = rejectingId === ex.id;
                      const busy = excuseActionBusy === ex.id;
                      const brother = brotherList.find(b => b.id === ex.brotherId);
                      return (
                        <div key={ex.id} className="tl-excuse">
                          <div className="top">
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                {brother && (
                                  <BrotherAvatar brother={brother} selfId={selfId} selfAvatarUrl={currentUser?.avatarUrl} avatarRevision={avatarRevision} size="xs" />
                                )}
                                <p className="who">{ex.brotherName}</p>
                              </div>
                              <p className="ctx">
                                {ex.eventTitle} · {ex.eventDate}
                                {ex.isRetroactive && <span className="retro" title="Submitted after the event already took place"> · retroactive</span>}
                              </p>
                              <p className="reason">{ex.reason}</p>
                            </div>
                            <div className="acts">
                              <button className="ok" onClick={() => decideExcuse(ex.id, "approve")} disabled={busy}>Approve</button>
                              <button className="no" onClick={() => { setRejectingId(isRejecting ? null : ex.id); setRejectionNote(""); }} disabled={busy}>
                                {isRejecting ? "Cancel" : "Reject"}
                              </button>
                            </div>
                          </div>
                          {isRejecting && (
                            <div className="rej">
                              <input className={inputCls} type="text" value={rejectionNote} onChange={e => setRejectionNote(e.target.value)} placeholder="Optional note for the brother…" />
                              <button className="no" onClick={() => decideExcuse(ex.id, "reject", rejectionNote.trim() || undefined)} disabled={busy}>Confirm</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── Layout: spine + rail ─────────────────────────────────────── */}
            <div className="tl-layout">

              {/* Spine */}
              <div>
                {calendarLoading && monthGroups.length === 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {[...Array(5)].map((_, i) => (
                      <div key={i} style={{ height: 56, borderRadius: 10, border: "1px solid var(--line-soft)", background: "var(--card)", opacity: 0.5 }} />
                    ))}
                  </div>
                ) : monthGroups.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "72px 0", color: "var(--faint)" }}>
                    <p style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 16, color: "var(--muted)" }}>No events on this filter.</p>
                    {activeLayer !== "all" && (
                      <button onClick={() => setActiveLayer("all")} className="jump" style={{ display: "inline-flex", marginTop: 14 }}>Show all events</button>
                    )}
                  </div>
                ) : (
                  <>
                  {/* Future tail — months are newest-first, so the "nothing past X"
                      note sits at the top, with the most-recent events. */}
                  {lastEvent && (
                    <div className="tl-end tl-end--top">
                      <span className="e-dot" />
                      <p>Nothing scheduled past {fmtDate(lastEvent.date)}.</p>
                      <button onClick={() => setActiveModal("create")}>Add event →</button>
                    </div>
                  )}
                  {monthGroups.map(group => {
                    const isCollapsed = collapsedMonths.has(group.id);

                    if (isCollapsed) {
                      return (
                        <button key={group.id} className="past-bar" onClick={() => toggleMonth(group.id)}>
                          <span className="pm">{group.monthLabel} {group.year}</span>
                          <span className="pc">{group.events.length} event{group.events.length === 1 ? "" : "s"} hidden</span>
                          <span className="show">Show ▾</span>
                        </button>
                      );
                    }

                    // Today marker placement inside the current month.
                    let todayMarkerIndex = -1;
                    if (group.isCurrentMonth) {
                      const firstFutureIdx = group.events.findIndex(e => e.date >= todayStr);
                      if (firstFutureIdx > 0) todayMarkerIndex = firstFutureIdx;
                    }
                    const noFutureInMonth = group.isCurrentMonth && !group.events.some(e => e.date >= todayStr);

                    return (
                      <div key={group.id} ref={group.isCurrentMonth ? (el => { currentMonthRef.current = el; }) : undefined}>
                        <button className={`tl-month${group.isCurrentMonth ? " now" : ""}`} onClick={() => toggleMonth(group.id)}>
                          <h2>{group.monthLabel}<span className="yr">{group.year}</span></h2>
                          <span className="rule" />
                          <span className="cnt">
                            {group.events.length} event{group.events.length === 1 ? "" : "s"}
                            {group.isCurrentMonth && requiredThisMonth > 0 ? ` · ${requiredThisMonth} required` : ""}
                          </span>
                          <span className="chev">▾</span>
                        </button>

                        <div className="spine">
                          {noFutureInMonth && <TodayMarker />}
                          {group.events.map((e, i) => {
                            const isPast  = e.date < todayStr;
                            const isToday = e.date === todayStr;
                            return (
                              <React.Fragment key={e.id}>
                                {i === todayMarkerIndex && <TodayMarker />}
                                <TimelineRow
                                  event={e}
                                  isToday={isToday}
                                  isPast={isPast}
                                  selected={selectedEvent?.id === e.id}
                                  onSelect={setSelectedEvent}
                                  rowRef={e.id === todayAnchorId ? (el => { todayRef.current = el; }) : undefined}
                                />
                              </React.Fragment>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  </>
                )}
              </div>

              {/* Rail */}
              <aside className="tl-rail">
                {selectedEvent ? (
                  <EventDetail
                    event={selectedEvent}
                    onClose={() => setSelectedEvent(null)}
                    canEdit={selectedEventCanEdit}
                    canDelete={selectedEventCanEdit && isAdmin}
                    canLogAttendance={isAdmin}
                    onEdit={() => setActiveModal("edit")}
                    onDelete={handleDeleteEvent}
                    onOpenProgramming={
                      selectedEvent.programmingEventId != null
                        ? () => router.push(orgPath(`/events?open=${selectedEvent.programmingEventId}`))
                        : undefined
                    }
                    linkedPosts={
                      // Only real calendar events (not folded-in deadline/IG rows) can be
                      // promoted by a post — the FK references the true CalendarEvent id.
                      apiEventIds.has(selectedEvent.id)
                        ? igTaskList
                            .filter(t => t.calendarEventId === selectedEvent.id)
                            .map(t => ({ id: t.id, title: t.title, type: t.type, dueDate: t.dueDate }))
                        : []
                    }
                    onOpenInstagram={() => router.push(orgPath("/instagram"))}
                    brotherList={brotherList}
                    selfBrotherId={selfId}
                    deadlineStatus={selectedDeadline?.status ?? null}
                    canCompleteDeadline={canManageEvents && selectedDeadline != null}
                    onToggleDeadline={(complete) => { if (selectedDeadline) setDeadlineComplete(selectedDeadline.id, complete); }}
                  />
                ) : glanceFocus ? (
                  <GlanceDetail
                    metric={glanceFocus}
                    events={glanceEvents}
                    weekStart={weekStart}
                    weekEnd={weekEnd}
                    onClose={() => setGlanceFocus(null)}
                    onSelectEvent={setSelectedEvent}
                  />
                ) : (
                  <>
                    <TimelineTodo
                      overdue={overdueEvents}
                      dueThisWeek={deadlinesDueThisWeek}
                      pendingExcuseCount={pendingExcuses.length}
                      isAdmin={isAdmin}
                      onMarkDone={(id) => setDeadlineComplete(id, true)}
                      onOpenEvent={setSelectedEvent}
                      onReviewExcuses={openReviewPanel}
                    />

                    {upNext && (
                      <div>
                        <p className="lbl">Up next</p>
                        <div className="upnext" style={catStyleOf(typeMap, upNext.category)} onClick={() => setSelectedEvent(upNext)} role="button" tabIndex={0}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedEvent(upNext); } }}>
                          <div className="row1">
                            <span className="cat">{catLabelOf(typeMap, upNext.category)}</span>
                            <span className="soon">{relWhen(upNext.date)}</span>
                          </div>
                          <h3>{upNext.title}</h3>
                          <p className="meta">{fmtDate(upNext.date)}{upNext.time ? ` · ${upNext.time}` : ""}</p>
                          {(upNext.description || upNext.location) && (
                            <p className="desc">{upNext.description || upNext.location}</p>
                          )}
                        </div>
                      </div>
                    )}

                    {thenList.length > 0 && (
                      <div>
                        <p className="lbl">Then</p>
                        <div className="then-card">
                          {thenList.map(ev => (
                            <button key={ev.id} className="then-row" style={catStyleOf(typeMap, ev.category)} onClick={() => setSelectedEvent(ev)}>
                              <span className="when">{fmtDow(ev.date)}<br />{fmtDate(ev.date)}</span>
                              <div className="what">
                                <p className="t">{ev.title}</p>
                                <p className="s">{catLabelOf(typeMap, ev.category)}{ev.mandatory ? " · Required" : ev.time ? ` · ${ev.time}` : ""}</p>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {todayOffscreen && (
                      <button className="jump" onClick={() => scrollToToday(true)}>
                        {todayAbove ? "↑" : "↓"} Jump to today
                      </button>
                    )}
                  </>
                )}
              </aside>
            </div>
          </div>
        </main>
      </div>

      {activeModal === "create" && (
        <Modal title="Add Calendar Event" tone="dusk" onClose={() => setActiveModal(null)}>
          <CalendarEventForm submitLabel="Add Event" onSubmit={handleCreateEvent} categoryOptions={categoryOptions} minDate={activeSemester?.startDate} maxDate={activeSemester?.endDate} />
        </Modal>
      )}
      {activeModal === "edit" && selectedEvent && selectedEventCanEdit && (
        <Modal title="Edit Calendar Event" tone="dusk" onClose={() => setActiveModal(null)}>
          <CalendarEventForm initialEvent={selectedEvent} submitLabel="Save Event" onSubmit={handleUpdateEvent} categoryOptions={editCategoryOptions} minDate={activeSemester?.startDate} maxDate={activeSemester?.endDate} />
        </Modal>
      )}
      {confirmDeleteEvent && (
        <ConfirmDialog
          tone="dusk"
          title="Delete Event"
          message={<>Delete <span className="font-semibold text-[#ece7dd]">{confirmDeleteEvent.title}</span>? This cannot be undone.</>}
          onCancel={() => setConfirmDeleteEvent(null)}
          onConfirm={() => { executeDeleteEvent(confirmDeleteEvent); setConfirmDeleteEvent(null); }}
        />
      )}
    </div>
    </EventTypesContext.Provider>
  );
}
