"use client";

import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";

const DrawerTrendChart = dynamic(() => import("../components/dashboard/DrawerTrendChart"), {
  ssr: false,
  loading: () => <div className="h-[110px] w-full rounded-lg bg-white/[0.04] animate-pulse" />,
});
import {
  Brother, CalendarEvent, CalEventType, InstagramType, ActivityEntry, PartyEvent, Task, InstagramTask, Transaction, Poll,
  taskAssigneeLabel,
  getBrotherStatus, roleTitle, calcHealthScore, deriveNeedsAttention, avg, fmt$, fmtDate, fmtRange, isoWeekBounds,
} from "../data";
import { useRouter } from "next/navigation";
import { useOrgPath } from "../hooks/useOrgPath";
import { useActiveSemester } from "../hooks/useActiveSemester";
import { useSemesterErrorHandler } from "../hooks/useSemesterErrorHandler";
import { useThresholds } from "../hooks/useThresholds";
import { useVocab } from "../hooks/useVocab";
import { useFeature } from "../hooks/useFeature";
import { useTrackedMetrics } from "../hooks/useTrackedMetrics";
import type { TrackedMetrics } from "@/lib/tracked-metrics";
import { useRollingToday } from "../hooks/useRollingToday";
import { trackedCount } from "@/lib/tracked-metrics";
import type { BuiltinMetricId } from "@/lib/onboarding/kinds";
import { WORKFLOW_FEATURES, type DisabledFeatures } from "@/lib/workflow-features";
import { isAttendanceExempt } from "@/lib/thresholds";
import { taskUrgency, type TaskUrgency } from "@/lib/tasks/urgency";
import { Sidebar, SvgIcon, NAV_ICONS, isNavVisible } from "../components/Sidebar";
import { BrotherAvatar } from "../components/BrotherAvatar";
import { useChapter } from "../context/ChapterContext";
import { useToast } from "../components/dashboard/Toast";
import { AddIGTaskForm, AddRevenueForm, LogAttendanceForm, ExcuseForm } from "../components/dashboard/forms";
import { TaskForm, type RoleOption, type TaskFormValue } from "../components/dashboard/TaskForm";
import type { QuickActionKey } from "../components/dashboard/QuickActionsMenu";
import { TxForm } from "../components/treasury/TxForm";
import { CalendarEventForm, type CalendarDraft, type CategoryOption } from "../components/timeline/CalendarEventForm";
import { isEventTypeVisibleInPicker } from "../../lib/event-types";
import { BrotherDrawer } from "../components/dashboard/drawers/BrotherDrawer";
import { Card, Modal, ConfirmDialog, FieldLabel } from "../components/dashboard/primitives";
import { KPI_ICONS, SECTION_IDS, inputDuskCls, btnDuskGhostCls, btnDuskActionCls } from "../components/dashboard/styles";
import { type Announcement } from "../components/dashboard/AnnouncementCard";
import { AnnouncementEditor } from "../components/dashboard/AnnouncementEditor";
import "../components/dashboard/dashboard-ledger.css";
import "../components/dashboard/drawer-ledger.css";
import { BriefingHeader } from "../components/dashboard/ledger/BriefingHeader";
import { BriefingActions } from "../components/dashboard/ledger/BriefingActions";
import { HealthDial } from "../components/dashboard/ledger/HealthDial";
import { PinnedAnnouncement } from "../components/dashboard/ledger/PinnedAnnouncement";
import { LedgerStrip, Measure } from "../components/dashboard/ledger/LedgerStrip";
import { NeedsAttention } from "../components/dashboard/ledger/NeedsAttention";
import { RosterTable } from "../components/dashboard/ledger/RosterTable";
import { ThisWeek } from "../components/dashboard/ledger/ThisWeek";
import { WeekItemPeek, type WeekPeekTarget } from "../components/dashboard/ledger/WeekItemPeek";
import { BallotCard } from "../components/dashboard/ledger/BallotCard";
import { TreasuryRail } from "../components/dashboard/ledger/TreasuryRail";
import { ActivityRail } from "../components/dashboard/ledger/ActivityRail";
import { DashHideButton } from "../components/dashboard/ledger/DashHideButton";
import { BillingAlert } from "../components/dashboard/BillingAlert";
import { apiErrorMessage, orgFetch, requestJson } from "../lib/api";
import { todayStr } from "../lib/dates";
import type { MetricSnapshot } from "@/lib/metrics";

// ─── Activity ID counter (module-level, reset-safe) ───────────────────────────

let _nextId = Date.now();

// Minimal service-event shape for the Brother-drawer "Log service hours" picker.
// Mirrors the fields the service page selects from /api/service-events.
type DashServiceEvent = { id: number; title: string; date: string };

/** The two fields of GET /api/invites the founder-only roster state needs.
 *  Declared structurally rather than importing InviteDto, which lives in a
 *  service module that pulls Prisma into the client bundle. */
type InviteSummary = { token: string; status: string };

// ─── KPI Drawer ───────────────────────────────────────────────────────────────

type KPIDrawerKey = "attendance" | "dues" | "gpa" | "service" | "treasury" | "door";

// `tone` selects the warm dusk accent (info/gold/vio/ok) used for the header icon
// tile and headline stat — mirroring the dashboard's category palette.
const DRAWER_CONFIGS: Record<KPIDrawerKey, { title: string; tone: string; iconKey: string }> = {
  attendance: { title: "Avg Attendance",   tone: "info", iconKey: "attendance" },
  dues:       { title: "Dues",             tone: "gold", iconKey: "dues"       },
  gpa:        { title: "Chapter GPA",      tone: "vio",  iconKey: "gpa"        },
  service:    { title: "Service Hours",    tone: "ok",   iconKey: "service"    },
  treasury:   { title: "Treasury Balance", tone: "vio",  iconKey: "treasury"   },
  door:       { title: "Door Revenue",     tone: "rose", iconKey: "door"       },
};

function KPIDetailDrawer({
  activeKey, onClose,
  brotherList, partyList,
  openPayDues, addServiceHour,
  avgAttendance, outstandingDues, chapterGPA,
  totalServiceHrs, onTrackSvc,
  totalDoorRev, maxRevenue, bestEvent,
  liveBalance, liveProjected, liveTrend,
  onOpenModal, onOpenAttendance,
  isAdmin = true,
  canTreasury = false,
  hasDuesData = true,
}: {
  activeKey: KPIDrawerKey | null;
  onClose: () => void;
  brotherList: Brother[];
  partyList: PartyEvent[];
  openPayDues: (b: Brother) => void;
  addServiceHour: (b: Brother) => void;
  avgAttendance: number;
  outstandingDues: number;
  chapterGPA: number;
  totalServiceHrs: number;
  onTrackSvc: number;
  totalDoorRev: number;
  maxRevenue: number;
  bestEvent: PartyEvent | null;
  liveBalance: number | null;
  liveProjected: number | null;
  liveTrend: { month: string; balance: number }[];
  onOpenModal: (key: "deadline" | "revenue" | "ig") => void;
  onOpenAttendance: () => void;
  isAdmin?: boolean;
  canTreasury?: boolean;
  /** False when no member carries a balance and the books are empty — i.e. dues
   *  were never assigned, so there is nothing to be "paid up" on. */
  hasDuesData?: boolean;
}) {
  const THRESHOLDS = useThresholds();
  const v = useVocab();
  const isOpen = activeKey !== null;
  const cfg = activeKey ? DRAWER_CONFIGS[activeKey] : null;
  // DRAWER_CONFIGS is a module const built before vocab exists; resolve the
  // org-specific titles here at render time. Keys without an override fall back
  // to the static cfg.title.
  const titleOverride: Partial<Record<KPIDrawerKey, string>> = {
    dues: v("Dues"),
    gpa:  `${v("Meetings")} GPA`,
  };
  const drawerTitle = activeKey ? (titleOverride[activeKey] ?? cfg?.title) : cfg?.title;

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  function renderContent() {
    if (!activeKey) return null;

    switch (activeKey) {
      case "attendance": {
        // Exempt members carry the -1 sentinel, not a real percentage — they
        // must not count as "below 80%" or sort to the top of the list.
        const attendees = brotherList.filter(b => !isAttendanceExempt(b.attendance));
        const sorted = [...attendees].sort((a, b) => a.attendance - b.attendance);
        const belowWatch = attendees.filter(b => b.attendance < THRESHOLDS.attendanceWatch);
        const atRisk = attendees.filter(b => b.attendance < THRESHOLDS.attendanceAtRisk);
        return (
          <>
            <div className="dd-stats c3">
              <div className="dd-stat"><p className="n info">{avgAttendance.toFixed(1)}%</p><p className="l">{v("Meetings")} avg</p></div>
              <div className="dd-stat"><p className="n gold">{belowWatch.length}</p><p className="l">Below 80%</p></div>
              <div className="dd-stat"><p className="n rose">{atRisk.length}</p><p className="l">At risk</p></div>
            </div>
            <div>
              <p className="dd-label">All {v("Member", true)} — Lowest First</p>
              <div className="dd-rows">
                {sorted.map(b => {
                  const tone = b.attendance >= THRESHOLDS.attendanceWatch ? "" : b.attendance >= THRESHOLDS.attendanceAtRisk ? "gold" : "rose";
                  return (
                    <div key={b.id} className="dd-bar-row">
                      <span className="nm">{b.name.split(" ")[0]}</span>
                      <div className="dd-track"><i className={tone} style={{ width: `${b.attendance}%` }} /></div>
                      <span className={`val ${tone}`}>{b.attendance}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="dd-note">
              {atRisk.length > 0
                ? <><b>{atRisk.length} brother{atRisk.length > 1 ? "s" : ""} need{atRisk.length === 1 ? "s" : ""} immediate follow-up.</b>{" "}Attendance goal is 80%+.</>
                : "No brothers are at attendance risk. Chapter goal is 80%+."
              }
            </div>
            <button onClick={() => { onOpenAttendance(); onClose(); }} className="dd-btn-primary">
              Log Attendance
            </button>
          </>
        );
      }

      case "dues": {
        const oweList = brotherList.filter(b => b.duesOwed > 0);
        const paidList = brotherList.filter(b => b.duesOwed === 0);
        // An org that has never assigned dues also has $0 outstanding, and used
        // to be congratulated for it. "Paid up" is a claim about dues that
        // exist; without any it's the drawer's version of the fabricated zero.
        if (!hasDuesData) {
          return (
            <div className="dd-empty">
              No {v("Dues").toLowerCase()} set yet — assign an amount on the {v("Treasury").toLowerCase()} page and balances appear here.
            </div>
          );
        }
        return (
          <>
            <div className="dd-stats c3">
              <div className="dd-stat"><p className="n gold">{fmt$(outstandingDues)}</p><p className="l">Total owed</p></div>
              <div className="dd-stat"><p className="n rose">{oweList.length}</p><p className="l">{v("Member", true)} owe</p></div>
              <div className="dd-stat"><p className="n ok">{paidList.length}</p><p className="l">Paid up</p></div>
            </div>
            {oweList.length > 0 && (
              <div>
                <p className="dd-label">Outstanding Balances</p>
                <div className="dd-feed">
                  {oweList.map(b => (
                    <div key={b.id} className="dd-item gold">
                      <div className="who">
                        <p className="t">{b.name}</p>
                        <p className="s">{b.role.split(" · ")[0]}</p>
                      </div>
                      <div className="amt">
                        <span className="m">{fmt$(b.duesOwed)}</span>
                        {canTreasury && (
                          <button onClick={() => openPayDues(b)} className="dd-row-act ok">Pay</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {paidList.length > 0 && (
              <div>
                <p className="dd-label">Paid Up <span className="ct">({paidList.length})</span></p>
                <div className="dd-rows">
                  {paidList.map(b => (
                    <div key={b.id} className="dd-line">
                      <p className="nm">{b.name}</p>
                      <span className="ok">✓ Clear</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {outstandingDues === 0 && (
              <div className="dd-note ok center">All {v("Member", true).toLowerCase()} are paid up.</div>
            )}
          </>
        );
      }

      case "gpa": {
        const sorted = [...brotherList].sort((a, b) => a.gpa - b.gpa);
        const belowWatch = brotherList.filter(b => b.gpa < THRESHOLDS.gpaWatch);
        const atRisk = brotherList.filter(b => b.gpa < THRESHOLDS.gpaAtRisk);
        return (
          <>
            <div className="dd-stats c3">
              <div className="dd-stat"><p className="n vio">{chapterGPA.toFixed(2)}</p><p className="l">{v("Meetings")} avg</p></div>
              <div className="dd-stat"><p className="n gold">{belowWatch.length}</p><p className="l">Below 3.0</p></div>
              <div className="dd-stat"><p className="n rose">{atRisk.length}</p><p className="l">At risk</p></div>
            </div>
            <div>
              <p className="dd-label">All {v("Member", true)} — Lowest First</p>
              <div className="dd-rows">
                {sorted.map(b => {
                  const tone = b.gpa < THRESHOLDS.gpaAtRisk ? "rose" : b.gpa < THRESHOLDS.gpaWatch ? "gold" : "";
                  const barPct = Math.round(Math.max(5, ((b.gpa - 2.0) / 2.0) * 100));
                  return (
                    <div key={b.id} className="dd-bar-row">
                      <span className="nm">{b.name.split(" ")[0]}</span>
                      <div className="dd-track"><i className={tone} style={{ width: `${barPct}%` }} /></div>
                      <span className={`val ${tone}`}>{b.gpa.toFixed(1)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {atRisk.length > 0 ? (
              <div className="dd-note rose">
                <b>{atRisk.length} brother{atRisk.length > 1 ? "s" : ""} below 2.7 GPA</b> — consider academic check-in or intervention.
              </div>
            ) : belowWatch.length > 0 ? (
              <div className="dd-note gold">
                <b>{belowWatch.length} brother{belowWatch.length > 1 ? "s" : ""} below 3.0</b> — monitor and encourage academic support.
              </div>
            ) : (
              <div className="dd-note ok center">All {v("Member", true).toLowerCase()} meeting academic standards.</div>
            )}
          </>
        );
      }

      case "service": {
        const sorted = [...brotherList].sort((a, b) => a.serviceHours - b.serviceHours);
        const belowGoal = brotherList.filter(b => b.serviceHours < THRESHOLDS.serviceHoursGoal);
        return (
          <>
            <div className="dd-stats c3">
              <div className="dd-stat"><p className="n ok">{totalServiceHrs}h</p><p className="l">Total hours</p></div>
              <div className="dd-stat"><p className="n">{onTrackSvc}</p><p className="l">On track</p></div>
              <div className="dd-stat"><p className="n gold">{belowGoal.length}</p><p className="l">Below goal</p></div>
            </div>
            <div>
              <p className="dd-label">All {v("Member", true)} — Fewest Hours First</p>
              <div className="dd-rows">
                {sorted.map(b => {
                  const isOnTrack = b.serviceHours >= THRESHOLDS.serviceHoursGoal;
                  const barPct = Math.min(100, Math.round((b.serviceHours / THRESHOLDS.serviceHoursGoal) * 100));
                  const tone = isOnTrack ? "ok" : "gold";
                  const remaining = Math.max(0, THRESHOLDS.serviceHoursGoal - b.serviceHours);
                  return (
                    <div key={b.id} className="dd-bar-row act group">
                      <span className="nm">{b.name.split(" ")[0]}</span>
                      <div className="dd-track"><i className={tone} style={{ width: `${barPct}%` }} /></div>
                      <span className={`val ${tone}`}>{b.serviceHours}h</span>
                      <span className={`hint ${isOnTrack ? "ok" : ""}`}>{isOnTrack ? "✓" : `-${remaining}h`}</span>
                      <button onClick={() => addServiceHour(b)} className="dd-row-act">+1h</button>
                    </div>
                  );
                })}
              </div>
            </div>
            {belowGoal.length > 0 ? (
              <div className="dd-note gold">
                <b>{belowGoal.length} brother{belowGoal.length > 1 ? "s" : ""} still need{belowGoal.length === 1 ? "s" : ""} service hours</b> before the semester ends. Goal: {THRESHOLDS.serviceHoursGoal}h each.
              </div>
            ) : (
              <div className="dd-note ok center">All {v("Member", true).toLowerCase()} have met the service hours goal!</div>
            )}
          </>
        );
      }

      case "treasury": {
        if (liveBalance === null || liveProjected === null) {
          return <div className="dd-empty">No treasury data yet — log an expense or revenue to start the books.</div>;
        }
        const firstMonth = liveTrend[0];
        const lastMonth  = liveTrend[liveTrend.length - 1];
        // A single month (or none) has no growth to report against.
        const growth = firstMonth && lastMonth ? lastMonth.balance - firstMonth.balance : 0;
        const growthPct = firstMonth?.balance ? Math.round((growth / firstMonth.balance) * 100) : 0;
        return (
          <>
            <div className="dd-stats c2">
              <div className="dd-stat"><p className="n vio">{fmt$(liveBalance)}</p><p className="l">Current balance</p></div>
              <div className="dd-stat"><p className="n ok">{fmt$(liveProjected)}</p><p className="l">Projected end</p></div>
            </div>
            {liveTrend.length > 0 && (
              <>
                <div>
                  <p className="dd-label">Treasury Trend</p>
                  <DrawerTrendChart data={liveTrend} />
                </div>
                <div>
                  <p className="dd-label">Monthly Breakdown</p>
                  <div className="dd-rows">
                    {liveTrend.map((t, i) => {
                      const prev = i > 0 ? liveTrend[i - 1].balance : t.balance;
                      const delta = t.balance - prev;
                      return (
                        <div key={t.month} className="dd-bar-row">
                          <span className="nm" style={{ width: 32 }}>{t.month}</span>
                          <div className="dd-track"><i style={{ width: `${liveProjected ? Math.round((t.balance / liveProjected) * 100) : 0}%` }} /></div>
                          <span className="val" style={{ width: 56 }}>{fmt$(t.balance)}</span>
                          {i > 0 && (
                            <span className={`hint ${delta >= 0 ? "ok" : "rose"}`} style={{ width: 52 }}>
                              {delta >= 0 ? "+" : ""}{fmt$(delta)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
            <div className="dd-note">
              {growth !== 0
                ? <>Treasury {growth > 0 ? "grew" : "shrank"} by <b>{fmt$(Math.abs(growth))} ({Math.abs(growthPct)}%)</b> this period. Projected end balance: <b>{fmt$(liveProjected)}</b>.</>
                : <>Projected end balance: <b>{fmt$(liveProjected)}</b>.</>}
            </div>
          </>
        );
      }

      case "door": {
        const sortedEvents = [...partyList].sort((a, b) => b.doorRevenue - a.doorRevenue);
        const avgRevenue = partyList.length > 0 ? Math.round(totalDoorRev / partyList.length) : 0;
        return (
          <>
            <div className="dd-stats c3">
              <div className="dd-stat"><p className="n rose">{fmt$(totalDoorRev)}</p><p className="l">Total revenue</p></div>
              <div className="dd-stat"><p className="n">{partyList.length}</p><p className="l">Events</p></div>
              <div className="dd-stat"><p className="n">{fmt$(avgRevenue)}</p><p className="l">Avg/event</p></div>
            </div>
            <div>
              <p className="dd-label">Revenue by Event — Best First</p>
              <div className="dd-feed">
                {sortedEvents.map(e => {
                  const barPct = maxRevenue > 0 ? Math.round((e.doorRevenue / maxRevenue) * 100) : 0;
                  const isTop = bestEvent ? e.id === bestEvent.id : false;
                  return (
                    <div key={e.id} className={`dd-event ${isTop ? "top" : ""}`}>
                      <div className="eh">
                        <p className="t">{isTop && <span className="best">Best</span>}{e.name}</p>
                        <span className="m">{fmt$(e.doorRevenue)}</span>
                      </div>
                      <div className="dd-track"><i className={isTop ? "" : "muted"} style={{ width: `${barPct}%` }} /></div>
                      <div className="meta">
                        <span>{e.date}</span>
                        <span>{e.attendance} attendees</span>
                        {e.notes && <span className="note">{e.notes}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="dd-note rose">
              {bestEvent ? <>Best event: <b>{bestEvent.name}</b> at <b>{fmt$(bestEvent.doorRevenue)}</b>. Avg per event: <b>{fmt$(avgRevenue)}</b>.</> : "No events logged yet."}
            </div>
          </>
        );
      }

      default:
        return null;
    }
  }

  return (
    <>
      <div className={`dash-drawer-backdrop ${isOpen ? "" : "closed"}`} onClick={onClose} />
      <div className={`dash-drawer ${isOpen ? "" : "closed"}`}>
        {cfg && (
          <>
            <div className="dd-head">
              <div className={`dd-icon ${cfg.tone}`}>
                <SvgIcon d={KPI_ICONS[cfg.iconKey] ?? ""} />
              </div>
              <h2 className="dd-title">{drawerTitle}</h2>
              <button onClick={onClose} className="dd-x" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="dd-body">
              {renderContent()}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ─── Widget Drawer ────────────────────────────────────────────────────────────

type WidgetDrawerKey = "health" | "digest" | "deadlines" | "activity";

function WidgetDetailDrawer({
  activeKey, onClose,
  weeklyDigest, weekRange, digestNarration,
  deadlineList, activityFeed,
  health,
  onOpenModal, onAddTask,
  onCompleteDeadline, onDeleteDeadline, onEditDeadline,
}: {
  activeKey: WidgetDrawerKey | null;
  onClose: () => void;
  weeklyDigest: {
    deadlinesDue: Task[];
    igDue: InstagramTask[];
    eventsThisWeek: CalendarEvent[];
    partiesThisWeek: PartyEvent[];
    atRiskCount: number;
    overdueCount: number;
  };
  weekRange: { start: string; end: string };
  digestNarration: string | null;
  deadlineList: Task[];
  activityFeed: ActivityEntry[];
  health: { score: number; label: "Healthy" | "Needs Attention" | "Critical"; breakdown: Record<string, number> };
  onOpenModal: (key: "deadline" | "attendance") => void;
  onAddTask:          () => void;
  onCompleteDeadline: (id: number) => void;
  onDeleteDeadline:   (id: number) => void;
  onEditDeadline:     (id: number) => void;
}) {
  const v = useVocab();
  const isOpen = activeKey !== null;

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // `tone` drives the top accent hairline + header — warm dusk accents only.
  const WIDGET_CONFIGS: Record<WidgetDrawerKey, { title: string; tone: string }> = {
    health:     { title: `${v("Meetings")} Health Score`, tone: ""     },
    digest:     { title: "Weekly Digest",          tone: ""     },
    deadlines:  { title: "Deadlines",             tone: ""     },
    activity:   { title: "Activity Feed",         tone: "ok"   },
  };

  const cfg = activeKey ? WIDGET_CONFIGS[activeKey] : null;

  const dot: Record<ActivityEntry["type"], string> = {
    success: "ok",
    warning: "gold",
    info:    "info",
  };

  function renderContent() {
    if (!activeKey) return null;

    switch (activeKey) {
      case "health": {
        const scoreTone = health.score >= 80 ? "" : health.score >= 60 ? "watch" : "risk";
        const noteTone  = health.score >= 80 ? "ok" : health.score >= 60 ? "gold" : "rose";
        const METRIC_DESC: Record<string, string> = {
          Attendance: "30% weight — avg chapter attendance percentage",
          GPA:        "25% weight — scaled from 2.0–4.0 range",
          Dues:       "20% weight — % of brothers fully paid up",
          Service:    "15% weight — % of brothers at service hour goal",
          Deadlines:  "10% weight — −15 pts per urgent deadline",
        };
        return (
          <>
            <div className="dd-hero">
              <div className={`ring ${scoreTone}`}><span>{health.score}</span></div>
              <span className={`state ${scoreTone}`}>{health.label}</span>
              <p className="cap">out of 100 · weighted composite</p>
            </div>
            <div>
              <p className="dd-label">Score Breakdown</p>
              <div>
                {Object.entries(health.breakdown).map(([k, val]) => {
                  const tone = val >= 80 ? "ok" : val >= 60 ? "watch" : "risk";
                  return (
                    <div key={k} className="dd-score">
                      <div className="sh">
                        <span className="k">{k}</span>
                        <span className={`pct ${tone}`}>{val}%</span>
                      </div>
                      <div className="track"><i className={tone} style={{ width: `${val}%` }} /></div>
                      <p className="desc">{METRIC_DESC[k] ?? ""}</p>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className={`dd-note ${noteTone}`}>
              {health.score >= 80
                ? "Chapter is performing well across all metrics."
                : health.score >= 60
                ? `Some areas need attention — address urgent deadlines and at-risk ${v("Member", true).toLowerCase()}.`
                : "Immediate action required — multiple metrics are critically low."
              }
            </div>
          </>
        );
      }

      case "digest": {
        const { deadlinesDue, igDue, eventsThisWeek, partiesThisWeek, atRiskCount, overdueCount } = weeklyDigest;
        const total = deadlinesDue.length + igDue.length + eventsThisWeek.length + partiesThisWeek.length;
        const sections: { label: string; tone: string; count: number; rows: { key: string; title: string; meta: string }[] }[] = [
          { label: "Deadlines", tone: "vio", count: deadlinesDue.length,
            rows: deadlinesDue.map(d => ({ key: `d${d.id}`, title: d.title, meta: `${d.dueDate ? fmtDate(d.dueDate) : "No date"} · ${taskAssigneeLabel(d, 1)}` })) },
          { label: "Instagram", tone: "rose", count: igDue.length,
            rows: igDue.map(t => ({ key: `i${t.id}`, title: t.title, meta: `${fmtDate(t.dueDate)} · ${t.type}` })) },
          { label: "Events", tone: "info", count: eventsThisWeek.length,
            rows: eventsThisWeek.map(e => ({ key: `e${e.id}`, title: e.title, meta: e.time ? `${fmtDate(e.date)} · ${e.time}` : fmtDate(e.date) })) },
          { label: "Parties", tone: "vio", count: partiesThisWeek.length,
            rows: partiesThisWeek.map(p => ({ key: `p${p.id}`, title: p.name, meta: fmtDate(p.date) })) },
        ];
        return (
          <>
            <div className="flex items-center justify-between">
              <p className="dd-meta" style={{ fontSize: 12 }}>{fmtRange(weekRange.start, weekRange.end)}</p>
              <div className="flex items-center gap-2">
                {overdueCount > 0 && (
                  <span className="dd-chip rose">{overdueCount} overdue</span>
                )}
                {atRiskCount > 0 && (
                  <span className="dd-chip gold">{atRiskCount} at risk</span>
                )}
              </div>
            </div>
            {digestNarration && (
              <div className="dd-ai">
                <span className="tag">AI</span>
                <p>{digestNarration}</p>
              </div>
            )}
            <div className="dd-stats c4">
              {sections.map(s => (
                <div key={s.label} className="dd-stat"><p className="n">{s.count}</p><p className="l">{s.label}</p></div>
              ))}
            </div>
            {total === 0 ? (
              <div className={`dd-note center ${overdueCount > 0 ? "" : "ok"}`}>
                {overdueCount > 0
                  ? `Nothing scheduled this week — but ${overdueCount} deadline${overdueCount === 1 ? " is" : "s are"} already overdue.`
                  : "Nothing on the agenda this week"}
              </div>
            ) : (
              sections.map(s => s.rows.length > 0 && (
                <div key={s.label}>
                  <p className="dd-label">{s.label} <span className="ct">({s.rows.length})</span></p>
                  <div className="dd-feed">
                    {s.rows.map(r => (
                      <div key={r.key} className={`dd-feed-row ${s.tone}`}>
                        <p className="t">{r.title}</p>
                        <p className="m">{r.meta}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </>
        );
      }

      case "deadlines": {
        // Open tasks bucket by COMPUTED urgency (lib/tasks/urgency); done tasks
        // sit in their own bucket. Urgency replaces the old stored 4-status.
        const open = deadlineList.filter(d => d.status !== "done");
        const done = deadlineList.filter(d => d.status === "done");
        const urgencyOf = (d: Task): TaskUrgency => taskUrgency(d.dueDate);
        const buckets: { key: string; label: string; tone: string; items: Task[] }[] = [
          { key: "overdue",  label: "Overdue",  tone: "rose", items: open.filter(d => urgencyOf(d) === "overdue") },
          { key: "urgent",   label: "Urgent",   tone: "rose", items: open.filter(d => urgencyOf(d) === "urgent") },
          { key: "due-soon", label: "Due soon", tone: "gold", items: open.filter(d => urgencyOf(d) === "due-soon") },
          { key: "upcoming", label: "Upcoming", tone: "",     items: open.filter(d => urgencyOf(d) === "upcoming") },
          { key: "none",     label: "No date",  tone: "",     items: open.filter(d => urgencyOf(d) === "none") },
          { key: "done",     label: "Done",     tone: "ok",   items: done },
        ];
        const overdueCt = buckets[0].items.length;
        const dueSoonCt = buckets[1].items.length + buckets[2].items.length;
        return (
          <>
            <div className="dd-stats c4">
              {([["Overdue", overdueCt, "rose"], ["Due soon", dueSoonCt, "gold"], ["Open", open.length, ""], ["Done", done.length, "ok"]] as const).map(([label, count, tone]) => (
                <div key={label} className="dd-stat"><p className={`n ${tone}`}>{count}</p><p className="l">{label}</p></div>
              ))}
            </div>
            {deadlineList.length === 0 ? (
              <p className="dd-empty">No tasks yet — open the Tasks page to create one</p>
            ) : (
              buckets.map(bucket => {
                if (bucket.items.length === 0) return null;
                return (
                  <div key={bucket.key}>
                    <p className="dd-label">{bucket.label} <span className="ct">({bucket.items.length})</span></p>
                    <div className="dd-feed">
                      {bucket.items.map(d => (
                        <div key={d.id} className={`dd-feed-row stacked ${bucket.tone}`}>
                          <div className="min-w-0 flex-1">
                            <p className={`t ${d.status === "done" ? "done" : ""}`} style={{ fontWeight: 500 }}>{d.title}</p>
                            <p className="m">{d.dueDate ? fmtDate(d.dueDate) : "No date"} · {taskAssigneeLabel(d, 1)}</p>
                          </div>
                          <div className="dd-acts hover-reveal">
                            {d.status !== "done" && (
                              <button onClick={() => onCompleteDeadline(d.id)} title="Mark complete" className="dd-act ok">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                              </button>
                            )}
                            <button onClick={() => onEditDeadline(d.id)} title="Edit" className="dd-act">
                              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                            </button>
                            <button onClick={() => onDeleteDeadline(d.id)} title="Delete" className="dd-act danger">
                              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
            <button onClick={() => { onAddTask(); onClose(); }} className="dd-btn-ghost">
              + Add Deadline
            </button>
          </>
        );
      }

      case "activity": {
        return (
          <>
            <div className="dd-stats c3">
              {([
                ["Success", activityFeed.filter(e => e.type === "success").length, "ok"],
                ["Warning", activityFeed.filter(e => e.type === "warning").length, "gold"],
                ["Info",    activityFeed.filter(e => e.type === "info").length,    "info"],
              ] as const).map(([label, count, tone]) => (
                <div key={label} className="dd-stat"><p className={`n ${tone}`}>{count}</p><p className="l">{label}</p></div>
              ))}
            </div>
            <div>
              <p className="dd-label">Full History <span className="ct">({activityFeed.length} entries)</span></p>
              {activityFeed.length === 0 ? (
                <p className="dd-empty">No activity yet</p>
              ) : (
                <div className="dd-history">
                  {activityFeed.map(e => (
                    <div key={e.id} className="a">
                      <span className={`dot ${dot[e.type]}`} />
                      <p>{e.message}</p>
                      <time>{e.timestamp}</time>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        );
      }

      default:
        return null;
    }
  }

  return (
    <>
      <div className={`dash-drawer-backdrop ${isOpen ? "" : "closed"}`} onClick={onClose} />
      <div className={`dash-drawer ${isOpen ? "" : "closed"}`}>
        {cfg && (
          <>
            <div className={`dd-accent ${cfg.tone}`} />
            <div className="dd-head">
              <h2 className="dd-title">{cfg.title}</h2>
              <button onClick={onClose} className="dd-x" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="dd-body">
              {renderContent()}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ─── Custom Metric Detail Drawer ──────────────────────────────────────────────

function CustomMetricDetailDrawer({
  snap,
  onClose,
}: {
  snap: MetricSnapshot | null;
  onClose: () => void;
}) {
  const isOpen = snap !== null;

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  return (
    <>
      <div className={`dash-drawer-backdrop ${isOpen ? "" : "closed"}`} onClick={onClose} />
      <div className={`dash-drawer ${isOpen ? "" : "closed"}`}>
        {snap && (
          <>
            <div className="dd-head">
              <div className="dd-icon">
                <SvgIcon d={KPI_ICONS["custom"] ?? ""} />
              </div>
              <h2 className="dd-title">{snap.name}</h2>
              <button onClick={onClose} className="dd-x" aria-label="Close">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="dd-body">
              <div className="dd-stats c3">
                <div className="dd-stat"><p className="n ok">{snap.onTrackCount}</p><p className="l">On Track</p></div>
                <div className="dd-stat"><p className="n gold">{snap.totalCount - snap.onTrackCount}</p><p className="l">Not on Track</p></div>
                <div className="dd-stat"><p className="n">{snap.goal}{snap.unit ?? ""}</p><p className="l">Goal</p></div>
              </div>
              <div>
                <p className="dd-label">Summary</p>
                <div className="dd-panel">
                  <div className="dd-kv" style={{ justifyContent: "space-between" }}>
                    <span className="k" style={{ width: "auto" }}>Aggregation</span>
                    <span className="v" style={{ textTransform: "capitalize" }}>{snap.aggregation.replace("_", " ")}</span>
                  </div>
                  <div className="dd-kv" style={{ justifyContent: "space-between" }}>
                    <span className="k" style={{ width: "auto" }}>
                      {snap.aggregation === "avg" ? "Chapter avg" : snap.aggregation === "sum" ? "Chapter total" : "On track"}
                    </span>
                    <span className="v" style={{ color: "var(--vio)", fontFamily: "var(--mono)" }}>
                      {Number.isInteger(snap.headline) ? snap.headline : snap.headline.toFixed(1)}{snap.unit ?? ""}
                    </span>
                  </div>
                  <div className="dd-kv" style={{ justifyContent: "space-between" }}>
                    <span className="k" style={{ width: "auto" }}>Members recorded</span>
                    <span className="v" style={{ fontFamily: "var(--mono)" }}>{snap.totalCount}</span>
                  </div>
                </div>
              </div>
              <p className="dd-meta">
                Open a member&apos;s profile drawer and switch to the Metrics tab to view or update individual values.
              </p>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Home() {
  // Org-wide member-status cutoffs (shared via OrganizationConfig). Named
  // THRESHOLDS so the many inline `THRESHOLDS.x` references below read the org
  // value without per-line edits.
  const THRESHOLDS = useThresholds();
  const v = useVocab();
  // Per-section visibility for the dashboard's toggleable widgets. Each is keyed
  // under the always-on "operations" workflow; a section is shown unless an admin
  // hid it. The mobile layout reads the same flags via its own useFeature() calls.
  const feature = useFeature();
  // Which built-in per-member metrics this org actually tracks. A metric the
  // org switched off in onboarding stores a 0 for everyone, so it must not
  // become a roster column, feed the health score, or flag anyone At Risk.
  const tracked = useTrackedMetrics();
  // Today, as local ISO. State rather than a mount-time const: dashboards get
  // left open for days, and a frozen "today" silently freezes the week's agenda
  // and every overdue calculation with it.
  const todayISO = useRollingToday();
  // ── UI state ──────────────────────────────────────────────────────────────
  const [search,         setSearch]         = useState("");
  const [statusFilter,   setStatusFilter]   = useState("All");
  const [sortKey,        setSortKey]        = useState<keyof Brother | null>(null);
  const [sortDir,        setSortDir]        = useState<"asc" | "desc">("asc");
  const [sidebarOpen,    setSidebarOpen]    = useState(false);
  const [activeModal,    setActiveModal]    = useState<"deadline" | "task" | "revenue" | "ig" | "attendance" | "pick-event" | "edit-deadline" | "expense" | "excuse" | "event" | "pick-event-for-excuse" | null>(null);
  const [selectedEventForAttendance, setSelectedEventForAttendance] = useState<CalendarEvent | null>(null);
  const [calendarList,   setCalendarList]   = useState<CalendarEvent[]>([]);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  // The calendar is fetched by this page, not by ChapterContext, so it has no
  // entry in `sectionErrors` — it needs its own failure flag to feed This Week's
  // error state alongside the context-owned sections.
  const [calendarFailed, setCalendarFailed] = useState(false);
  const [eventTypes,     setEventTypes]     = useState<CalEventType[]>([]);
  // The This Week row whose detail sheet is open. Holds the record itself, not
  // an id: the row already had it, and a refetch mid-peek must not blank the sheet.
  const [weekPeek,       setWeekPeek]       = useState<WeekPeekTarget | null>(null);
  // Org roles for the "New task" modal's assignee picker (mirrors the tasks page).
  const [roles,          setRoles]          = useState<RoleOption[]>([]);
  const [rolesLoaded,    setRolesLoaded]    = useState(false);
  const [activeDrawer,   setActiveDrawer]   = useState<KPIDrawerKey | null>(null);
  const [widgetDrawer,   setWidgetDrawer]   = useState<WidgetDrawerKey | null>(null);
  const [editingAttId,      setEditingAttId]      = useState<number | null>(null);
  const [editAttVal,        setEditAttVal]        = useState("");
  const [selectedBrotherId, setSelectedBrotherId] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [announcementEditorOpen, setAnnouncementEditorOpen] = useState(false);
  const [customMetricSnapshots, setCustomMetricSnapshots] = useState<MetricSnapshot[]>([]);
  const [activeCustomMetricId, setActiveCustomMetricId] = useState<number | null>(null);
  const [activeSection,  setActiveSection]  = useState("Dashboard");
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; label: string } | null>(null);
  const [payTarget,    setPayTarget]    = useState<Brother | null>(null);
  const [payAmountStr, setPayAmountStr] = useState("");
  const [duesTx,       setDuesTx]       = useState<{ brother: Brother; amount: number } | null>(null);
  // "Log service hours" modal (opened from the Brother drawer's + control).
  // Logs hours for the drawer's member against a chosen service event, mirroring
  // the service page's self-service flow but on the member's behalf.
  const [logHoursFor,    setLogHoursFor]    = useState<Brother | null>(null);
  const [logHoursEvents, setLogHoursEvents] = useState<DashServiceEvent[]>([]);
  const [logHoursEventId, setLogHoursEventId] = useState<number | null>(null);
  const [logHoursStr,    setLogHoursStr]    = useState("");
  const [logHoursBusy,   setLogHoursBusy]   = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const attendanceReqRef = useRef<AbortController | null>(null);
  const welcomeToastShownRef = useRef(false);
  const toast = useToast();

  // ── Data state ─────────────────────────────────────────────────────────────
  const { currentUser, brotherList, setBrotherList, taskList, setTaskList, igTaskList, setIgTaskList, partyList, setPartyList, activityFeed, setActivityFeed, treasuryData, setTransactionList, reimbursementList, loadError, loadedSections, sectionErrors, mutationError, setMutationError, refreshChapterData, setDisabledFeaturesLocal, setSelfNameLocal, avatarRevision, can } = useChapter();
  const isAdmin = currentUser?.isAdmin ?? false;
  // Granular permission gates for new UI checks. Existing `isAdmin` is kept
  // unchanged for prop-chains into QuickActionsMenu / KPIDrawer / Modal title
  // copy — those flow through multiple sub-components and are best refactored
  // incrementally. New gates below prefer can(...) so officers (Treasurer,
  // Social Chair, etc.) see actions matching their role without admin.
  const canTreasury    = can("MANAGE_TREASURY");
  const canBrothers    = can("MANAGE_BROTHERS");
  const canAttendance  = can("MANAGE_ATTENDANCE");
  const canTasks       = can("MANAGE_TASKS");
  const canEvents      = can("MANAGE_EVENTS");
  // Invite links are credentials, gated on MANAGE_SETTINGS rather than
  // MANAGE_BROTHERS — the same split the roster page makes.
  const canSettings    = can("MANAGE_SETTINGS");
  // The announcement bar's Edit button was rendered unconditionally, so every
  // ordinary member saw a control that 403'd on save.
  const canAnnounce    = can("MANAGE_ANNOUNCEMENTS");
  const selfId  = currentUser?.id ?? null;

  const router  = useRouter();
  const orgPath = useOrgPath();
  const activeSemester = useActiveSemester();
  const handleSemesterError = useSemesterErrorHandler();

  // Whether the viewer is an admin of the *active* org. This — not a permission
  // bit — is what gates the inline "hide widget" affordance, because the server
  // (setDisabledFeatures) authorizes on isOrgAdmin/isPlatformAdmin, not on
  // MANAGE_SETTINGS. Resolved the same way /api/auth/me does. Platform admins
  // pass because /me marks their active membership isOrgAdmin.
  const isActiveOrgAdmin =
    currentUser?.memberships?.find(m => m.organizationId === currentUser.orgId)?.isOrgAdmin ?? false;

  // The dashboard's currently-hidden widgets, intersected with the registry so a
  // stale/unknown id never leaks into the tray. Drives the "Hidden widgets" tray.
  const hiddenOps = useMemo(() => {
    const disabled = new Set((currentUser?.org?.disabledFeatures as DisabledFeatures | undefined)?.operations ?? []);
    return WORKFLOW_FEATURES.operations.filter(f => disabled.has(f.id));
  }, [currentUser?.org?.disabledFeatures]);

  // Hide or re-show a dashboard widget by rewriting the org's disabledFeatures
  // map (operations workflow). Optimistic: we patch local state first so the
  // widget appears/disappears on the very next render (no network wait), then
  // PATCH in the background and roll back only if it fails. This avoids the
  // round-trip + full refreshChapterData() refetch the slow path would incur.
  // Sending only disabledFeatures leaves enabledWorkflows/vocab/thresholds
  // untouched (each setter is independent server-side). Admin-gated at the call
  // sites; the server re-checks isOrgAdmin regardless.
  const setWidgetHidden = useCallback(async (featureId: string, hidden: boolean) => {
    const current = (currentUser?.org?.disabledFeatures ?? {}) as DisabledFeatures;
    const ops = new Set(current.operations ?? []);
    if (hidden) ops.add(featureId); else ops.delete(featureId);
    const next: DisabledFeatures = { ...current };
    if (ops.size) next.operations = [...ops]; else delete next.operations;

    // Optimistic local update — instant visual change.
    setDisabledFeaturesLocal(next as Record<string, string[]>);
    try {
      await requestJson("/api/orgs/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabledFeatures: next }),
      });
    } catch {
      // Roll back to the pre-toggle map and surface the error.
      setDisabledFeaturesLocal(current as Record<string, string[]>);
      setMutationError("Couldn't update the dashboard. Try again.");
    }
  }, [currentUser?.org?.disabledFeatures, setDisabledFeaturesLocal, setMutationError]);

  // Welcome toast after sign-in. /auth/callback redirects linked users to
  // /?toast=welcome; once the org name resolves we show a one-time toast and
  // strip the param from the URL (replaceState, no navigation/Suspense needed).
  const orgName = currentUser?.org?.name ?? null;
  // Matches the timeline/settings deadline modal: when the org's Instagram page
  // is visible, the form offers to log the deadline as an Instagram post instead.
  const igEnabled      = isNavVisible("Instagram", currentUser?.org?.enabledWorkflows ?? []);
  // Orgs without the `finance` workflow (a sports team, say) have no Treasury
  // page at all — the dashboard must not show them a treasury either. This gates
  // both treasury surfaces.
  const financeEnabled = isNavVisible("Treasury",  currentUser?.org?.enabledWorkflows ?? []);
  // Gates the "Add your first event" move on the empty This Week card — an org
  // that doesn't run the events workflow has no calendar to add to.
  const eventsEnabled  = isNavVisible("Programming", currentUser?.org?.enabledWorkflows ?? []);
  // Polls are part of the tasks workflow, so an org that doesn't run it has no
  // ballots to answer. Folded together with the widget's own toggle so a hidden
  // ballot card never even asks the server for polls.
  const ballotEnabled  = isNavVisible("Tasks", currentUser?.org?.enabledWorkflows ?? []) && feature("operations", "ballot");
  // "New Event" picker options — creatable, workflow-enabled, non-hidden types.
  // Slug → type, for resolving a peeked event's category label and color.
  const eventTypeMap = useMemo(() => new Map(eventTypes.map(t => [t.slug, t])), [eventTypes]);
  const eventCategoryOptions = useMemo<CategoryOption[]>(
    () => eventTypes
      .filter(t => isEventTypeVisibleInPicker(t, currentUser?.org?.enabledWorkflows ?? []))
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map(t => ({ slug: t.slug, label: t.label, color: t.colorDark ?? t.color, mandatoryDefault: t.mandatoryDefault })),
    [eventTypes, currentUser?.org?.enabledWorkflows],
  );
  useEffect(() => {
    if (welcomeToastShownRef.current || !orgName) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("toast") !== "welcome") return;
    welcomeToastShownRef.current = true;
    toast.success(`Welcome to ${orgName}`);
    params.delete("toast");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [orgName, toast]);

  // ── Treasury — live from DB ────────────────────────────────────────────────
  // `treasuryData` is null while the fetch is in flight AND when it fails, so
  // there is no safe number to fall back to: a fabricated balance is worse than
  // no balance. Every treasury surface renders an explicit empty state instead.
  const hasTreasury   = treasuryData != null;
  const liveBalance   = treasuryData?.balance   ?? null;
  const liveProjected = treasuryData?.projected ?? null;
  const liveTrend     = treasuryData?.trend     ?? [];

  // ── Activity logger ────────────────────────────────────────────────────────
  const addActivity = useCallback((message: string, type: ActivityEntry["type"]) => {
    const optimisticId = _nextId++;
    setActivityFeed(prev => [{ id: optimisticId, message, timestamp: "just now", type }, ...prev]);
    requestJson<ActivityEntry>("/api/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, type }),
    })
      .then(saved => {
        setMutationError(null);
        setActivityFeed(prev => prev.map(e => e.id === optimisticId ? { ...saved, timestamp: "just now" } : e));
      })
      .catch(error => {
        console.error(error);
        setActivityFeed(prev => prev.filter(e => e.id !== optimisticId));
        setMutationError("Activity could not be saved to the database.");
      });
  }, [setActivityFeed, setMutationError]);

  function persistMutation<T>(
    operation: Promise<T>,
    errorMessage: string,
    rollback?: () => void,
    onSuccess?: (value: T) => void,
    onError?: (error: unknown) => void,
  ) {
    operation
      .then(value => {
        setMutationError(null);
        onSuccess?.(value);
      })
      .catch(error => {
        console.error(error);
        rollback?.();
        // Semester-aware callers pass onError to route or show a specific
        // message; otherwise fall back to the generic mutation banner.
        if (onError) onError(error);
        else setMutationError(errorMessage);
      });
  }

  // ── Health score ───────────────────────────────────────────────────────────
  // Drives the briefing HealthDial (score + per-metric breakdown) and the health
  // detail drawer. Only metrics the org tracks are scored, and the surviving
  // weights are renormalized — otherwise an org that skipped GPA/dues/service
  // would be mathematically capped well below "Healthy" no matter how it ran.
  const health = useMemo(
    () => calcHealthScore(brotherList, taskList, THRESHOLDS, todayISO, tracked),
    [brotherList, taskList, THRESHOLDS, todayISO, tracked],
  );
  // Hold the health widget back for orgs with too few tracked measures to
  // composite. With one per-member metric the "score" is that metric plus a
  // deadline count, which says less than the KPI tile already does.
  const healthMeaningful = trackedCount(tracked) >= 2;

  // ── Announcement (pinned single record) ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    requestJson<Announcement | null>("/api/announcement")
      .then(data => { if (!cancelled) setAnnouncement(data); })
      .catch(() => { /* placeholder renders on null — non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    requestJson<MetricSnapshot[]>("/api/metrics/snapshot")
      .then(data => { if (!cancelled) setCustomMetricSnapshots(data); })
      .catch(() => { /* non-fatal — dashboard renders without custom metrics */ });
    return () => { cancelled = true; };
  }, []);

  // ── Ballot (open polls awaiting my vote) ──────────────────────────────────
  // Scoped server-side to polls this member may actually vote on, so the answer
  // is usually an empty array and the card stays absent. Polls they've already
  // answered are dropped on arrival: the ballot is an errand, and a finished
  // errand belongs on /tasks, not on the dashboard. Deliberately NOT bootstrapped
  // through ChapterContext — that would fetch every poll in the org (closed ones,
  // other people's, manager rosters) to render one question.
  const [ballotPolls, setBallotPolls] = useState<Poll[]>([]);
  useEffect(() => {
    if (!ballotEnabled) { setBallotPolls([]); return; }
    let cancelled = false;
    requestJson<Poll[]>("/api/polls?assignee=me&status=open")
      .then(rows => { if (!cancelled) setBallotPolls(rows.filter(p => p.myVoteOptionId == null)); })
      .catch(() => { /* non-fatal — the card simply stays hidden */ });
    return () => { cancelled = true; };
  }, [ballotEnabled]);

  // Cast from the rail. Returns the unsealed poll so the card can phase straight
  // into the tally; errors propagate so it can hold the ballot and say so.
  const castBallotVote = useCallback(async (pollId: number, optionId: number): Promise<Poll> => {
    const saved = await requestJson<Poll>(`/api/polls/${pollId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId }),
    });
    setBallotPolls(list => list.map(p => (p.id === saved.id ? saved : p)));
    return saved;
  }, []);

  // The card is done with this poll (voted and read). Dropping it here is what
  // makes the widget disappear; a reload agrees, since a voted poll is filtered
  // out on arrival.
  const dismissBallot = useCallback((pollId: number) => {
    setBallotPolls(list => list.filter(p => p.id !== pollId));
  }, []);

  // ── Scroll spy ────────────────────────────────────────────────────────────
  useEffect(() => {
    const mainEl = mainRef.current;
    if (!mainEl) return;

    function updateActive() {
      const el = mainRef.current;
      if (!el) return;
      const mainRect = el.getBoundingClientRect();
      const detectY = mainRect.top + el.clientHeight * 0.25;
      let current = "Dashboard";
      for (const [label, id] of Object.entries(SECTION_IDS)) {
        const section = document.getElementById(id);
        if (!section) continue;
        if (section.getBoundingClientRect().top <= detectY) current = label;
      }
      setActiveSection(current);
    }

    mainEl.addEventListener("scroll", updateActive, { passive: true });
    updateActive();
    return () => mainEl.removeEventListener("scroll", updateActive);
  }, []);

  // ── Scroll to section requested by sidebar cross-page nav ─────────────────
  useEffect(() => {
    const target = sessionStorage.getItem("scrollTo");
    if (!target) return;
    sessionStorage.removeItem("scrollTo");
    // small delay so the page has painted before we scroll
    const t = setTimeout(() => scrollToSection(target), 80);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Scroll-to helpers ──────────────────────────────────────────────────────
  function scrollToSection(label: string) {
    const id = SECTION_IDS[label];
    if (!id) return;
    const el = document.getElementById(id);
    if (!el || !mainRef.current) return;
    const mainRect = mainRef.current.getBoundingClientRect();
    const elRect   = el.getBoundingClientRect();
    const offset   = mainRef.current.scrollTop + (elRect.top - mainRect.top) - 16;
    mainRef.current.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
    setActiveSection(label);
  }

  // ── Brother profile save ───────────────────────────────────────────────────
  function updateBrother(id: number, updates: Omit<Brother, "id" | "duesOwed">) {
    const prev = brotherList.find(b => b.id === id);
    if (!prev) return;
    setBrotherList(list => list.map(b => b.id === id ? { ...b, ...updates } : b));
    addActivity(`${updates.name || prev.name} profile updated`, "info");
    // Renaming YOURSELF also has to move the greeting and the sidebar profile,
    // which read currentUser (loaded once from /api/auth/me) rather than the
    // roster — otherwise the app keeps using your old name until a reload.
    const renamingSelf = currentUser?.id === id && !!updates.name && updates.name !== prev.name;
    if (renamingSelf) setSelfNameLocal(updates.name);
    persistMutation(
      requestJson<Brother>(`/api/brothers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }),
      "Brother profile update failed. Local changes were reverted.",
      () => {
        setBrotherList(list => list.map(b => b.id === id ? prev : b));
        if (renamingSelf) setSelfNameLocal(prev.name);
      },
    );
  }

  // ── Fetch calendar events (attendance event picker + This Week) ───────────
  // A callback rather than an inline effect body so This Week's Retry can re-run
  // exactly this request — the calendar is page-owned, so refreshChapterData()
  // does not cover it.
  const loadCalendar = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await orgFetch("/api/calendar", signal ? { signal } : undefined);
      // 401 here means the fetch raced the session cookie on a hard
      // navigation. ChapterContext's redirect handler covers the real
      // unauth case; treating this as an error just spams the console.
      if (r.status === 401) { setCalendarFailed(false); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCalendarList((await r.json()) as CalendarEvent[]);
      setCalendarFailed(false);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      console.error("Failed to load calendar", err);
      // Without this, the calendar is marked settled below and an empty list
      // reads as "No events on the calendar yet" — a confident answer assembled
      // from a request that never came back.
      setCalendarFailed(true);
    } finally {
      // Settled either way. The digest needs to know the difference between "no
      // events this week" and "events haven't arrived yet" before it will claim
      // the week is quiet.
      setCalendarLoaded(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadCalendar(controller.signal);
    return () => controller.abort();
  }, [loadCalendar]);

  // Per-org event types feed the "New Event" picker (labels/colors/workflow gating).
  useEffect(() => {
    requestJson<CalEventType[]>("/api/calendar/event-types")
      .then(setEventTypes)
      .catch(() => {});
  }, []);

  // Roles power the "New task" modal's assignee picker. Fetched unconditionally
  // on mount (mirroring the tasks page) rather than gated on canTasks: that flag
  // is also what reveals the Quick Actions button that opens the modal, so
  // gating the fetch behind it meant the request only started once the button
  // was already clickable, racing the modal open.
  useEffect(() => {
    requestJson<RoleOption[]>("/api/roles").then(setRoles).catch(() => setRoles([])).finally(() => setRolesLoaded(true));
  }, []);

  // ── KPIs ──────────────────────────────────────────────────────────────────
  // Attendance-exempt members carry the -1 sentinel rather than a percentage,
  // so they're excluded from every attendance aggregate — averaging -1 in would
  // drag the headline down and invent a "below watch" warning.
  const attendees       = useMemo(() => brotherList.filter(b => !isAttendanceExempt(b.attendance)), [brotherList]);
  const avgAttendance   = useMemo(() => avg(attendees.map(b => b.attendance)), [attendees]);
  const outstandingDues = useMemo(() => brotherList.reduce((s, b) => s + b.duesOwed, 0), [brotherList]);
  const chapterGPA      = useMemo(() => avg(brotherList.map(b => b.gpa)), [brotherList]);
  const belowAttCount   = useMemo(() => attendees.filter(b => b.attendance < THRESHOLDS.attendanceWatch).length, [attendees, THRESHOLDS]);
  const owingCount      = useMemo(() => brotherList.filter(b => b.duesOwed > 0).length, [brotherList]);
  const belowGpaCount   = useMemo(() => brotherList.filter(b => b.gpa < THRESHOLDS.gpaWatch).length, [brotherList, THRESHOLDS]);
  const totalServiceHrs = useMemo(() => brotherList.reduce((s, b) => s + b.serviceHours, 0), [brotherList]);
  const totalDoorRev    = useMemo(() => partyList.reduce((s, e) => s + e.doorRevenue, 0), [partyList]);
  const onTrackSvc      = useMemo(() => brotherList.filter(b => b.serviceHours >= THRESHOLDS.serviceHoursGoal).length, [brotherList, THRESHOLDS]);

  // ── Three kinds of nothing ────────────────────────────────────────────────
  // A brand-new org's dashboard used to be a wall of confident zeros: 0.0%
  // attendance, $0 dues, 0.00 GPA, 0h service — four numbers nobody measured,
  // printed in the same face and size as real data, under a health dial reading
  // "0 · Critical". None of it computed wrong; the page just had one vocabulary
  // for emptiness. These flags separate "no records exist" from "records exist
  // and are fine", so a measure with nothing behind it renders an em-dash and a
  // reason instead of a fabricated reading.
  //
  // Derived entirely client-side from data the page already holds — no new
  // server coverage signal. `rosterLoaded` guards the lot: an in-flight roster
  // is an empty array, and unset-until-proven would flash the invite copy at a
  // 60-member chapter on every cold load.
  const rosterLoaded   = loadedSections.has("brothers");
  const treasuryLoaded = loadedSections.has("treasury");
  // Per-widget readiness. Sections now commit the moment their own request
  // returns rather than all together at the end of the fan-out (see
  // ChapterContext's loadSections), so each widget can wait on exactly the data
  // it reads and no longer. A widget fed by several sections waits for all of
  // them: a queue assembled from two of its three inputs is not a short queue,
  // it is a wrong one.
  const activityLoaded  = loadedSections.has("activity");
  const attentionLoaded = rosterLoaded && loadedSections.has("deadlines") && loadedSections.has("reimbursements");
  // …and the failure counterpart. A failed section never joins `loadedSections`,
  // so without this its widget would pulse a skeleton forever — an animation
  // that promises arrival, pointing at data that isn't coming. `retrySections`
  // is the same all-or-nothing refresh the error banner offers.
  const rosterFailed    = sectionErrors.has("brothers");
  const treasuryFailed  = sectionErrors.has("treasury");
  const activityFailed  = sectionErrors.has("activity");
  const weekFailed      = sectionErrors.has("deadlines") || calendarFailed;
  // Not `weekFailed` — the attention queue reads deadlines, never the calendar.
  const attentionFailed = rosterFailed || sectionErrors.has("deadlines") || sectionErrors.has("reimbursements");
  const retrySections   = useCallback(() => { void refreshChapterData(); }, [refreshChapterData]);
  // This Week's retry has to cover the calendar too: it's page-owned, so
  // refreshChapterData() alone would leave the half that actually failed unfetched.
  const retryWeek       = useCallback(() => { void refreshChapterData(); void loadCalendar(); }, [refreshChapterData, loadCalendar]);
  // `trend` is bucketed from transaction + party months, so an empty trend means
  // the books have literally no entries. `treasuryData != null` does NOT mean
  // that — a successful fetch on a new org returns {balance: 0, trend: []}, which
  // is why the Treasury tile printed $0 on day one despite already having an
  // em-dash branch.
  //
  // An org that stated an opening balance has a real number to show even with no
  // transactions yet — that is the point of asking. So a set opening balance counts
  // as data; only an org that has answered nothing and recorded nothing is unset.
  const hasTreasuryData   = liveTrend.length > 0 || treasuryData?.openingBalance != null;
  const hasAttendanceData = useMemo(() => attendees.some(b => b.attendance > 0), [attendees]);
  const hasGpaData        = useMemo(() => brotherList.some(b => b.gpa > 0), [brotherList]);
  const hasServiceData    = useMemo(() => brotherList.some(b => b.serviceHours > 0), [brotherList]);
  // A mature org where everyone has paid shows all-zero duesOwed, which alone is
  // indistinguishable from "dues were never assigned". Live books are the
  // tiebreak. Accepted limit: an org with dues assigned, everyone paid, and zero
  // transactions reads as unset — rare, self-correcting on the first entry, and
  // the failure is a soft invitation rather than a false number.
  const hasDuesData       = useMemo(() => brotherList.some(b => b.duesOwed !== 0), [brotherList]) || hasTreasuryData;
  // Because dues leans on the books for its tiebreak, it isn't decidable until
  // BOTH fetches land — otherwise a paid-up org flashes "No dues set yet" for
  // the moment the treasury request is still open.
  const duesKnown = rosterLoaded && treasuryLoaded;
  const hasAnyData = rosterLoaded &&
    (hasAttendanceData || hasGpaData || hasServiceData || hasDuesData);

  // `tracked` says which metrics the org opted into; `measured` narrows that to
  // the ones with at least one record behind them anywhere in the org. Anything
  // reading a member's *standing* uses `measured`, for the reason already stated
  // in tracked-metrics.ts: a stored 0 is not a measurement and must not flag
  // anyone. Without this, day one flags the founder AT RISK off their own 0%
  // attendance and 0.00 GPA — the same fabrication as the zeros in the strip,
  // wearing a rose chip — and the "nothing to watch yet" copy below can never
  // fire, because there is always exactly one phantom item in the queue.
  //
  // On any org that has recorded something this is identity: every flag is true,
  // so `measured` equals `tracked` and nothing downstream changes.
  const measured = useMemo<TrackedMetrics>(() => ({
    attendance:   tracked.attendance   && hasAttendanceData,
    gpa:          tracked.gpa          && hasGpaData,
    duesOwed:     tracked.duesOwed     && hasDuesData,
    serviceHours: tracked.serviceHours && hasServiceData,
  }), [tracked, hasAttendanceData, hasGpaData, hasDuesData, hasServiceData]);

  const maxRevenue      = useMemo(() => partyList.length ? Math.max(...partyList.map(e => e.doorRevenue)) : 0, [partyList]);
  const bestEvent       = useMemo(() => partyList.length ? partyList.reduce((a, b) => b.doorRevenue > a.doorRevenue ? b : a) : null, [partyList]);

  // ── Day-one invite link ───────────────────────────────────────────────────
  // The founder is pinned to the roster at org creation, so "day one" is a
  // one-row table of your own name — not the zero-row state the roster's empty
  // copy was written for. `founderOnlyRoster` is that real state, and the invite
  // is the one move the entire product depends on at this moment.
  //
  // The link is FETCHED, never minted here: pressing a button must not silently
  // create a credential. An existing active link is copied; with none, the
  // button hands off to the settings section that creates one, and says so.
  // Listing invites requires MANAGE_SETTINGS, so the request is gated on both
  // the permission and the state that would show the button.
  const founderOnlyRoster = rosterLoaded && brotherList.length <= 1;
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  useEffect(() => {
    if (!canSettings || !founderOnlyRoster) return;
    let cancelled = false;
    requestJson<InviteSummary[]>("/api/invites")
      .then(rows => {
        if (cancelled) return;
        const active = rows.find(r => r.status === "active");
        setInviteLink(active ? `${window.location.origin}/join/${active.token}` : null);
      })
      .catch(() => { /* non-fatal — the button falls back to the settings route */ });
    return () => { cancelled = true; };
  }, [canSettings, founderOnlyRoster]);

  const goToInvites = useCallback(() => {
    router.push(`${orgPath("/settings")}?section=invitations`);
  }, [router, orgPath]);

  const handleInvite = useCallback(() => {
    if (!inviteLink) { goToInvites(); return; }
    navigator.clipboard.writeText(inviteLink)
      .then(() => toast.success("Invite link copied"))
      // Clipboard access can be denied (insecure context, permissions policy).
      // Falling through to the settings list still gets the founder to a link.
      .catch(() => goToInvites());
  }, [inviteLink, goToInvites, toast]);

  // `measured`, not `tracked` — see its definition. An unmeasured metric can't
  // put anyone in a bucket.
  const statusCounts = useMemo(() => ({
    Good:      brotherList.filter(b => getBrotherStatus(b, THRESHOLDS, measured) === "Good").length,
    Watch:     brotherList.filter(b => getBrotherStatus(b, THRESHOLDS, measured) === "Watch").length,
    "At Risk": brotherList.filter(b => getBrotherStatus(b, THRESHOLDS, measured) === "At Risk").length,
  }), [brotherList, THRESHOLDS, measured]);

  // ── Needs-attention queue ───────────────────────────────────────────────────
  // Overdue deadlines, outstanding dues (aggregated), and at-risk members.
  const needsAttention = useMemo(
    () => deriveNeedsAttention(brotherList, taskList, THRESHOLDS, todayISO, reimbursementList, measured),
    [brotherList, taskList, THRESHOLDS, todayISO, reimbursementList, measured],
  );

  // ── Weekly Digest ──────────────────────────────────────────────────────────
  // Forward-looking "this week's agenda" for the current calendar week (Mon–Sun).
  const weekRange = useMemo(() => isoWeekBounds(new Date(`${todayISO}T00:00:00`)), [todayISO]);
  const weeklyDigest = useMemo(() => {
    const { start, end } = weekRange;
    const inWeek = (iso: string) => iso >= start && iso <= end; // zero-padded ISO compares chronologically
    return {
      // Open deadlines only — a task you already finished is not still "due",
      // and leaving it in also fed the AI digest as outstanding work. Matches
      // the same filter deriveNeedsAttention applies.
      deadlinesDue:    taskList.filter(d => d.status !== "done" && d.dueDate != null && inWeek(d.dueDate)),
      igDue:           igTaskList.filter(t => t.status !== "posted" && inWeek(t.dueDate)),
      // Every event on the calendar this week, not just mandatory ones. A week
      // full of optional socials, rehearsals or practices is still a week with
      // an agenda — filtering to `mandatory` made those weeks read as empty and
      // suppressed the digest entirely.
      eventsThisWeek:  calendarList.filter(e => inWeek(e.date)),
      partiesThisWeek: partyList.filter(p => inWeek(p.date)),
      atRiskCount:     statusCounts["At Risk"],
      // Not "this week", but the most useful thing to say when this week is
      // quiet: work that is already late.
      overdueCount:    taskList.filter(d => d.status !== "done" && d.dueDate != null && d.dueDate < todayISO).length,
    };
  }, [weekRange, taskList, igTaskList, calendarList, partyList, statusCounts, todayISO]);
  const digestTotal =
    weeklyDigest.deadlinesDue.length + weeklyDigest.igDue.length +
    weeklyDigest.eventsThisWeek.length + weeklyDigest.partiesThisWeek.length;
  // Something worth narrating: either scheduled items, or late work to flag.
  const digestHasSignal = digestTotal > 0 || weeklyDigest.overdueCount > 0;
  // The week's inputs have all arrived, so an empty week can be reported as
  // empty rather than as "still loading".
  const digestReady = calendarLoaded && loadedSections.has("deadlines");

  // ── AI narration (gpt-4o-mini via /api/ai/digest) ──────────────────────────
  // A stable content key identifies this exact weekly-digest state. Narration is
  // generated once per key: cached client-side in localStorage and server-side
  // in-memory, so a plain reload makes zero API calls. The key only changes when
  // the week's items/counts change, which triggers a single fresh generation.
  const digestKey = useMemo(() => {
    const ids = (arr: { id: number }[]) => arr.map(x => x.id).sort((a, b) => a - b).join(",");
    return [
      "v5", // bump when the AI prompt/length changes, to invalidate cached narrations
      weekRange.start, weekRange.end,
      `d:${ids(weeklyDigest.deadlinesDue)}`,
      `i:${ids(weeklyDigest.igDue)}`,
      `e:${ids(weeklyDigest.eventsThisWeek)}`,
      `p:${ids(weeklyDigest.partiesThisWeek)}`,
      `r:${weeklyDigest.atRiskCount}`,
      `o:${weeklyDigest.overdueCount}`,
    ].join("|");
  }, [weekRange, weeklyDigest]);

  const [digestNarration, setDigestNarration] = useState<string | null>(null);
  const [digestNarrationLoading, setDigestNarrationLoading] = useState(false);

  useEffect(() => {
    // Don't judge the week until the data behind it has actually arrived —
    // empty arrays mean "not fetched yet" as often as they mean "nothing there"
    // (see ChapterContext's loadedSections doc).
    if (!calendarLoaded || !loadedSections.has("deadlines")) return;

    // Genuinely quiet week: say so plainly rather than hiding the line. No model
    // call — there is nothing to summarize, and a canned sentence must not wear
    // the AI chip.
    if (!digestHasSignal) { setDigestNarration(null); setDigestNarrationLoading(false); return; }

    const cacheKey = `chaptos_digest_narration:${digestKey}`;
    try {
      const stored = localStorage.getItem(cacheKey);
      if (stored) { setDigestNarration(stored); return; } // persisted — no API call
    } catch { /* localStorage unavailable — fall through to fetch */ }

    const controller = new AbortController();
    setDigestNarrationLoading(true);
    setDigestNarration(null);
    orgFetch("/api/ai/digest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        key: digestKey,
        weekRange,
        deadlines: weeklyDigest.deadlinesDue.map(d => ({ title: d.title, dueDate: d.dueDate })),
        instagram: igEnabled ? weeklyDigest.igDue.map(t => ({ title: t.title, dueDate: t.dueDate })) : [],
        events:    weeklyDigest.eventsThisWeek.map(e => ({ title: e.title, date: e.date })),
        parties:   weeklyDigest.partiesThisWeek.map(p => ({ name: p.name, date: p.date })),
        atRiskCount: weeklyDigest.atRiskCount,
        overdueCount: weeklyDigest.overdueCount,
      }),
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: { narration?: string | null } | null) => {
        const text = data?.narration ?? null;
        setDigestNarration(text);
        if (text) { try { localStorage.setItem(cacheKey, text); } catch { /* ignore */ } }
      })
      .catch(() => { /* network/abort — leave narration absent, card still renders */ })
      .finally(() => setDigestNarrationLoading(false));

    return () => controller.abort();
  }, [digestKey, digestHasSignal, weekRange, weeklyDigest, igEnabled, calendarLoaded, loadedSections]);

  // A metric the org stops tracking loses its roster column, so a sort still
  // pointing at it would silently order rows by an invisible value.
  useEffect(() => {
    if (sortKey && sortKey in tracked && !tracked[sortKey as BuiltinMetricId]) setSortKey(null);
  }, [sortKey, tracked]);

  // ── Filtered/sorted brothers ───────────────────────────────────────────────
  const filteredBrothers = useMemo((): Brother[] => {
    let result = brotherList.filter(b => {
      const q = search.trim().toLowerCase();
      // Match the title the roster actually SHOWS (relational roles, joined),
      // not just the free-text `role` — searching "Treasurer" should find the
      // treasurer even when their free-text label says something else.
      return (q === "" || b.name.toLowerCase().includes(q) || roleTitle(b).toLowerCase().includes(q)) &&
             (statusFilter === "All" || getBrotherStatus(b, THRESHOLDS, measured) === statusFilter);
    });
    if (sortKey) {
      result = [...result].sort((a, b) => {
        const av = a[sortKey] as number, bv = b[sortKey] as number;
        return sortDir === "asc" ? av - bv : bv - av;
      });
    }
    return result;
  }, [brotherList, search, statusFilter, sortKey, sortDir, THRESHOLDS, measured]);

  function toggleSort(key: keyof Brother) {
    // A new column opens DESCENDING: every sortable column here is a metric,
    // and "worst first" is the question being asked. Opening ascending meant
    // the first click on Dues showed the people who owe nothing.
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const brotherNames = useMemo(() => brotherList.map(b => b.name), [brotherList]);

  // ── Inline attendance edit ─────────────────────────────────────────────────
  function startAttEdit(b: Brother) {
    setEditingAttId(b.id);
    setEditAttVal(String(b.attendance));
  }

  function saveAttEdit(b: Brother) {
    const val = Math.min(100, Math.max(0, Math.round(Number(editAttVal))));
    if (!isNaN(val) && val !== b.attendance) {
      setBrotherList(prev => prev.map(x => x.id === b.id ? { ...x, attendance: val } : x));
      addActivity(`${b.name} attendance updated to ${val}%`, "info");
      persistMutation(
        requestJson<Brother>(`/api/brothers/${b.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attendance: val }),
        }),
        "Attendance update failed. Local changes were reverted.",
        () => setBrotherList(prev => prev.map(x => x.id === b.id ? b : x)),
      );
    }
    setEditingAttId(null);
  }

  // ── Quick Action handlers ──────────────────────────────────────────────────
  function handleAddCalendarEvent(draft: CalendarDraft) {
    const tempId = _nextId++;
    const optimistic: CalendarEvent = { id: tempId, ...draft };
    setCalendarList(prev => [...prev, optimistic]);
    addActivity(`New event added: "${draft.title}"`, "info");
    setActiveModal(null);
    requestJson<CalendarEvent>("/api/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    })
      .then(saved => {
        setCalendarList(prev => prev.map(e => e.id === tempId ? saved : e));
        setMutationError(null);
      })
      .catch(error => {
        console.error(error);
        setCalendarList(prev => prev.filter(e => e.id !== tempId));
        handleSemesterError(error, setMutationError, "Calendar event could not be saved. Local changes were reverted.");
      });
  }

  async function handleAddTransaction(data: Omit<Transaction, "id" | "createdAt" | "updatedAt" | "deletedAt">) {
    const optimisticId = -Date.now();
    const optimistic: Transaction = { ...data, id: optimisticId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    setTransactionList(prev => [optimistic, ...prev]);
    const label = data.type === "expense" ? "Expense" : "Revenue";
    addActivity(`${label} logged: ${data.category} — ${fmt$(data.amount)}`, data.type === "expense" ? "warning" : "success");
    setActiveModal(null);
    try {
      const saved = await requestJson<Transaction>("/api/transactions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      setTransactionList(prev => prev.map(t => t.id === optimisticId ? saved : t));
      setMutationError(null);
      // Refresh chapter data so treasury KPIs update.
      refreshChapterData().catch(() => undefined);
    } catch (e) {
      console.error(e);
      setTransactionList(prev => prev.filter(t => t.id !== optimisticId));
      setMutationError("Transaction could not be saved. Please try again.");
    }
  }

  function handleAddRevenue(e: { name: string; date: string; doorRevenue: number; attendance: number; notes: string }) {
    const tempId = _nextId++;
    setPartyList(prev => [...prev, { id: tempId, theme: "", collabOrg: "", expenses: 0, partyType: "Open", completed: false, completedAt: null, ...e }]);
    addActivity(`Revenue logged: ${e.name} — ${fmt$(e.doorRevenue)}`, "success");
    setActiveModal(null);
    persistMutation(
      requestJson<PartyEvent>("/api/parties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(e),
      }),
      "Revenue entry could not be saved. Local changes were reverted.",
      () => setPartyList(prev => prev.filter(x => x.id !== tempId)),
      saved => setPartyList(prev => prev.map(x => x.id === tempId ? saved : x)),
    );
  }

  function handleAddIGTask(t: { title: string; dueDate: string; type: InstagramType }) {
    const tempId = _nextId++;
    setIgTaskList(prev => [...prev, { id: tempId, ...t, status: "open" }]);
    addActivity(`IG task added: "${t.title}"`, "info");
    setActiveModal(null);
    persistMutation(
      requestJson<InstagramTask>("/api/instagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(t),
      }),
      "Instagram task could not be saved. Local changes were reverted.",
      () => setIgTaskList(prev => prev.filter(x => x.id !== tempId)),
      saved => setIgTaskList(prev => prev.map(x => x.id === tempId ? saved : x)),
    );
  }

  // ── Task quick actions ────────────────────────────────────────────────────
  // The dashboard surfaces tasks (dated = deadlines) read-mostly: complete and
  // delete act inline. Creating a task happens in-place via the shared TaskForm
  // modal (below); editing still routes to the dedicated /tasks page.
  // Create a task from the dashboard's "New task" modal. Mirrors the tasks page
  // submit: POST, then append the saved row to the shared taskList.
  function handleAddDeadline(value: TaskFormValue) {
    setActiveModal(null);
    persistMutation(
      requestJson<Task>("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: value.title,
          dueDate: value.dueDate || undefined,
          notes: value.notes || undefined,
          assigneeBrotherIds: value.assigneeBrotherIds,
          assigneeRoleIds: value.assigneeRoleIds,
        }),
      }),
      "Task could not be saved. Please try again.",
      undefined,
      saved => {
        setTaskList(prev => [...prev, saved]);
        addActivity(`Task added: "${saved.title}"`, "info");
      },
    );
  }

  function completeDeadline(id: number) {
    const d = taskList.find(x => x.id === id);
    if (!d || d.status === "done") return;
    setTaskList(prev => prev.map(x => x.id === id ? { ...x, status: "done" } : x));
    addActivity(`"${d.title}" marked complete`, "success");
    persistMutation(
      requestJson<Task>(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }),
      "Task update failed. Local changes were reverted.",
      () => setTaskList(prev => prev.map(x => x.id === id ? d : x)),
      saved => setTaskList(prev => prev.map(x => x.id === id ? saved : x)),
    );
  }

  function deleteDeadline(id: number) {
    const d = taskList.find(x => x.id === id);
    if (!d) return;
    setConfirmDelete({ id, label: d.title });
  }

  function confirmDeleteDeadline(id: number) {
    const d = taskList.find(x => x.id === id);
    if (!d) return;
    setTaskList(prev => prev.filter(x => x.id !== id));
    addActivity(`Task removed: "${d.title}"`, "info");
    persistMutation(
      requestJson<void>(`/api/tasks/${id}`, { method: "DELETE" }),
      "Task delete failed. Local changes were reverted.",
      () => setTaskList(prev => [...prev, d].sort((a, b) => a.id - b.id)),
    );
  }

  function openEditDeadline(id: number) {
    // Editing a task (title/date/assignees) happens on the Tasks page.
    router.push(orgPath(`/tasks?task=${id}`));
  }

  async function handleLogAttendance(attendedIds: number[], eventId: number) {
    // Abort any in-flight attendance request before starting a new one
    attendanceReqRef.current?.abort();
    const controller = new AbortController();
    attendanceReqRef.current = controller;
    try {
      const updated = await requestJson<Brother[]>("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendarEventId: eventId, attendedIds }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setBrotherList(updated);
      addActivity(`Attendance logged — ${attendedIds.length} present`, "info");
      setActiveModal(null);
      setSelectedEventForAttendance(null);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMutationError("Attendance log failed. Please try again.");
    }
  }

  function openAttendanceLog(event?: CalendarEvent) {
    if (event) {
      setSelectedEventForAttendance(event);
      setActiveModal("attendance");
    } else {
      // Refresh calendar list so newly-added events show up
      orgFetch("/api/calendar")
        .then(r => r.ok ? r.json() : Promise.reject())
        .then((data: CalendarEvent[]) => setCalendarList(data))
        .catch(() => undefined);
      setActiveModal("pick-event");
    }
  }

  function closeModal() { setActiveModal(null); }

  function handleQuickAction(key: QuickActionKey) {
    if (key === "expense"  && !canTreasury) return;
    if (key === "revenue"  && !canTreasury) return;
    if (key === "excuse") {
      // Refresh calendar so the picker shows the latest mandatory events.
      orgFetch("/api/calendar")
        .then(r => r.ok ? r.json() : Promise.reject())
        .then((data: CalendarEvent[]) => setCalendarList(data))
        .catch(() => undefined);
      setActiveModal("pick-event-for-excuse");
      return;
    }
    setActiveModal(key);
  }

  function openPayDues(b: Brother) {
    setPayTarget(b);
    setPayAmountStr(String(b.duesOwed));
  }

  // "Record Payment" hands off to the pre-filled transaction form — the treasurer
  // confirms the ledger entry and posts it there (recordDuesTx). Posting is what mints
  // the income row and decrements the balance together (createTransaction).
  function submitPayDues() {
    if (!payTarget) return;
    const amount = Math.max(0, parseFloat(payAmountStr) || 0);
    if (amount === 0) return;
    setDuesTx({ brother: payTarget, amount });
    setPayTarget(null);
    setPayAmountStr("");
  }

  // Post the dues payment through the ordinary transaction endpoint; the server moves
  // both books in one DB transaction, so refresh chapter data to show the lowered
  // balance. Overpayment/a lost race arrives as a 409 whose message names the balance.
  async function recordDuesTx(
    data: Omit<Transaction, "id" | "createdAt" | "updatedAt" | "deletedAt" | "calendarEvents"> & { calendarEventIds: number[]; brotherId?: number },
  ) {
    const b = duesTx?.brother;
    setDuesTx(null);
    try {
      await requestJson<Transaction>("/api/transactions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      await refreshChapterData();
      addActivity(`${b?.name ?? "Member"} — ${fmt$(data.amount)} dues payment recorded`, "success");
    } catch (e) {
      addActivity(apiErrorMessage(e, "Dues payment failed. Nothing was recorded."), "warning");
    }
  }

  function addServiceHour(b: Brother, hours = 1) {
    const newHrs = b.serviceHours + hours;
    setBrotherList(prev => prev.map(x => x.id === b.id ? { ...x, serviceHours: newHrs } : x));
    addActivity(`${b.name} — service hours updated to ${newHrs}h`, "info");
    persistMutation(
      requestJson<Brother>(`/api/brothers/${b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceHours: newHrs }),
      }),
      "Service hour update failed. Local changes were reverted.",
      () => setBrotherList(prev => prev.map(x => x.id === b.id ? b : x)),
    );
  }

  // ── Log service hours (Brother drawer +) ────────────────────────────────────
  // Opens a modal to log hours for `b` against a service event. Unlike the old
  // blind +1h PATCH, this writes a ServiceParticipation row so the total is
  // event-attributed and recomputed server-side (see recalc-service-hours).
  function openLogServiceHours(b: Brother) {
    setLogHoursFor(b);
    setLogHoursStr("");
    setLogHoursEventId(null);
    requestJson<DashServiceEvent[]>("/api/service-events")
      .then(events => {
        const sorted = [...events].sort((a, z) => z.date.localeCompare(a.date));
        setLogHoursEvents(sorted);
        setLogHoursEventId(sorted[0]?.id ?? null);
      })
      .catch(() => toast.error("Could not load service events."));
  }

  async function submitLogServiceHours() {
    if (!logHoursFor || logHoursEventId == null) return;
    const hours = Math.max(0, parseFloat(logHoursStr) || 0);
    const b = logHoursFor;
    setLogHoursBusy(true);
    try {
      await requestJson(`/api/service-events/${logHoursEventId}/participation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: [{ brotherId: b.id, hours }] }),
      });
      // serviceHours is recomputed server-side from participations; pull fresh totals.
      const fresh = await requestJson<Brother[]>("/api/brothers");
      setBrotherList(fresh);
      const updated = fresh.find(x => x.id === b.id);
      addActivity(`${b.name} — logged ${hours}h service${updated ? ` (${updated.serviceHours}h total)` : ""}`, "info");
      toast.success("Service hours logged.");
      setLogHoursFor(null);
    } catch {
      toast.error("Could not log service hours.");
    } finally {
      setLogHoursBusy(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="main-route-transition flex h-screen overflow-hidden bg-[#07090f]">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeSection={activeSection}
        onNavClick={scrollToSection}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">

        {/* ── Mobile toolbar (hamburger + breadcrumb) ──────────────────────────
            Matches every other page: a frosted slim bar that opens the sidebar
            drawer and labels the section. The ledger below reflows into a single
            column at phone widths, folding the My Standing / Quick Actions
            controls into BriefingActions exactly as the desktop pane does. */}
        <header className="toolbar-frosted dash-toolbar relative z-20 flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.05] px-4 sm:px-6 lg:hidden">
          <button onClick={() => setSidebarOpen(true)}
            className="tb-icon-btn flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white/[0.07] lg:hidden"
            aria-label="Open menu">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="truncate text-[13px] font-semibold text-[#ece7dd]">Dashboard</span>
        </header>

        {/* ── Scrollable body ──────────────────────────────────────────────── */}
        <main ref={mainRef} className="page-ambient flex-1 overflow-y-auto">
          {/* Error banner — shared by desktop and mobile views.
              There is deliberately no "Syncing chapter data from the database…"
              state here any more. It was a page-level announcement of a wait the
              page was already showing: it appeared above a dashboard of confident
              zeros, said nothing about WHICH data was missing, and pushed every
              widget down a row when it left. Each widget now reports its own
              section (see the `loading` props below), so the only thing left worth
              interrupting the page for is a failure. */}
          {(loadError || mutationError) && (
            <div className="mx-auto max-w-[1400px] px-4 pt-6 sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-[12px] text-red-200">
                <span>{loadError ?? mutationError}</span>
                {loadError ? (
                  <button onClick={() => void refreshChapterData()} className="rounded-lg border border-red-300/20 px-2.5 py-1 font-semibold text-red-100 hover:bg-red-500/15">
                    Retry
                  </button>
                ) : (
                  <button onClick={() => setMutationError(null)} className="rounded-lg border border-red-300/20 px-2.5 py-1 font-semibold text-red-100 hover:bg-red-500/15">
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── "Chapter Ledger" — responsive at all widths ──────────────────
              Warm editorial pane, scoped under `.dash` (dashboard-ledger.css).
              The two-column grid reflows to a single column below 1280px and
              compresses further on phones (see the <768px block in the CSS), so
              the dashboard now reflows like every other page instead of swapping
              in a bespoke tabbed shell. The sidebar, toolbar, drawers, and modals
              live outside this wrapper and keep their own styling. */}
          <div className="dash" data-dashboard-theme="dusk">

            {/* ── Briefing + health dial ──────────────────────────────────── */}
            <BriefingHeader
              firstName={currentUser?.name?.split(" ")[0] ?? null}
              weekStart={weekRange.start}
              weekEnd={weekRange.end}
              digest={digestNarration}
              digestLoading={digestNarrationLoading}
              digestQuiet={digestReady && !digestHasSignal}
              onExpandDigest={digestReady ? () => setWidgetDrawer("digest") : undefined}
              actions={
                <BriefingActions
                  onMyStanding={
                    selfId !== null && brotherList.some(b => b.id === selfId)
                      ? () => setSelectedBrotherId(selfId)
                      : undefined
                  }
                  onLogAttendance={canAttendance ? () => openAttendanceLog() : undefined}
                  onQuickAction={handleQuickAction}
                  quickActionsAdmin={isAdmin || canTreasury || canAttendance}
                  quickActionsCanManageTasks={canTasks}
                  enabledWorkflows={currentUser?.org?.enabledWorkflows}
                />
              }
              // `hasAnyData` on top of `healthMeaningful`: the latter tests
              // CONFIG (≥2 tracked measures), never DATA, so a brand-new org
              // scored 0 out of nothing and got "Critical" in rose as the first
              // thing on its first screen. Hiding beats scoring an absence; the
              // dial returns on its own once any tracked measure has a record.
              health={feature("operations", "health") && healthMeaningful && hasAnyData ? (
                <div className="dash-group">
                  <HealthDial
                    score={health.score}
                    label={health.label}
                    breakdown={health.breakdown}
                    onExpand={() => setWidgetDrawer("health")}
                  />
                  {isActiveOrgAdmin && <DashHideButton label="Health widget" onHide={() => setWidgetHidden("health", true)} />}
                </div>
              ) : null}
            />

            {/* ── Billing needs attention ─────────────────────────────────── */}
            {/* Self-gating and admin-only: org.billingAlert is null for anyone
                who can't act on it (computed server-side in /api/auth/me). */}
            <BillingAlert />

            {/* ── Pinned announcement ─────────────────────────────────────── */}
            {feature("operations", "announcement") && (
              <PinnedAnnouncement
                announcement={announcement}
                onEdit={() => setAnnouncementEditorOpen(true)}
                canEdit={canAnnounce}
                hideButton={isActiveOrgAdmin ? <DashHideButton label="Announcement" onHide={() => setWidgetHidden("announcement", true)} /> : undefined}
              />
            )}

            {/* ── Ledger strip ────────────────────────────────────────────── */}
            {/* No sparklines: the app stores no metric history, so the only
                series available would be invented. A real trend needs a
                periodic snapshot table — until then the headline stands alone. */}
            {(feature("operations", "kpi-attendance") || feature("operations", "kpi-dues") ||
              feature("operations", "kpi-gpa") || feature("operations", "kpi-service") ||
              customMetricSnapshots.length > 0) && (
              <LedgerStrip>
                {/* Each measure below asks the same question first: is there a
                    single record behind this number? With none, it prints an
                    em-dash and a reason rather than a 0 that was never measured,
                    and — where the viewer can act — the one next move. The
                    em-dash keeps the value's size and baseline so the strip
                    doesn't jump when real data lands. While the roster fetch is
                    still in flight nothing is known either way, so the note is
                    omitted instead of guessing. */}
                {feature("operations", "kpi-attendance") && (
                  <Measure
                    label="Attendance"
                    loading={!rosterLoaded}
                    error={rosterFailed}
                    onRetry={retrySections}
                    unset={!hasAttendanceData}
                    value={hasAttendanceData ? avgAttendance.toFixed(1) : "—"}
                    unit="%"
                    note={hasAttendanceData
                      ? `${belowAttCount} below ${THRESHOLDS.attendanceWatch}%`
                      : rosterLoaded ? "No meetings recorded yet." : undefined}
                    noteWarn={hasAttendanceData && belowAttCount > 0}
                    onClick={() => setActiveDrawer("attendance")}
                    hideButton={isActiveOrgAdmin ? <DashHideButton label="Attendance KPI" onHide={() => setWidgetHidden("kpi-attendance", true)} /> : undefined}
                  />
                )}
                {feature("operations", "kpi-dues") && (
                  <Measure
                    label={`${v("Dues")} outstanding`}
                    /* Two sections, per duesKnown above — the roster holds the
                       balances and the books are the tiebreak. */
                    loading={!duesKnown}
                    error={rosterFailed || treasuryFailed}
                    onRetry={retrySections}
                    unset={!duesKnown || !hasDuesData}
                    unitLeading="$"
                    value={duesKnown && hasDuesData ? outstandingDues.toLocaleString() : "—"}
                    note={duesKnown && hasDuesData
                      ? `${owingCount} ${v("Member", owingCount !== 1).toLowerCase()} owe`
                      : duesKnown ? `No ${v("Dues").toLowerCase()} set yet.` : undefined}
                    noteWarn={duesKnown && hasDuesData && owingCount > 0}
                    noteAction={duesKnown && !hasDuesData && canTreasury && financeEnabled
                      ? { label: "Set an amount", onClick: () => router.push(orgPath("/treasury")) }
                      : undefined}
                    onClick={() => setActiveDrawer("dues")}
                    hideButton={isActiveOrgAdmin ? <DashHideButton label="Dues KPI" onHide={() => setWidgetHidden("kpi-dues", true)} /> : undefined}
                  />
                )}
                {feature("operations", "kpi-gpa") && (
                  <Measure
                    label="Average GPA"
                    loading={!rosterLoaded}
                    error={rosterFailed}
                    onRetry={retrySections}
                    unset={!hasGpaData}
                    value={hasGpaData ? chapterGPA.toFixed(2) : "—"}
                    note={hasGpaData
                      ? `${belowGpaCount} below ${THRESHOLDS.gpaWatch.toFixed(1)}`
                      : rosterLoaded ? "No grades on file yet." : undefined}
                    onClick={() => setActiveDrawer("gpa")}
                    hideButton={isActiveOrgAdmin ? <DashHideButton label="GPA KPI" onHide={() => setWidgetHidden("kpi-gpa", true)} /> : undefined}
                  />
                )}
                {feature("operations", "kpi-service") && (
                  <Measure
                    label={v("Service")}
                    loading={!rosterLoaded}
                    error={rosterFailed}
                    onRetry={retrySections}
                    unset={!hasServiceData}
                    value={hasServiceData ? `${totalServiceHrs}` : "—"}
                    unit="h"
                    note={hasServiceData
                      ? `${onTrackSvc} of ${brotherList.length} on track`
                      : rosterLoaded ? "Nothing logged this term." : undefined}
                    onClick={() => setActiveDrawer("service")}
                    hideButton={isActiveOrgAdmin ? <DashHideButton label="Service Hours KPI" onHide={() => setWidgetHidden("kpi-service", true)} /> : undefined}
                  />
                )}
                {customMetricSnapshots.map(snap => {
                  const fmtHeadline = Number.isInteger(snap.headline) ? String(snap.headline) : snap.headline.toFixed(1);
                  const headline =
                    snap.aggregation === "count_on_track"
                      ? `${snap.headline} / ${snap.totalCount}`
                      : snap.unit
                      ? `${fmtHeadline}${snap.unit}`
                      : fmtHeadline;
                  const note =
                    snap.aggregation === "count_on_track"
                      ? `${snap.onTrackCount} on track`
                      : `Goal ${snap.goal}${snap.unit ?? ""}`;
                  return (
                    <Measure
                      key={snap.definitionId}
                      label={snap.name}
                      value={headline}
                      note={note}
                      onClick={() => setActiveCustomMetricId(snap.definitionId)}
                    />
                  );
                })}
              </LedgerStrip>
            )}

            {/* ── Content grid ────────────────────────────────────────────────
                Two real columns on desktop: the left column stacks Needs
                attention → Roster, the right column is the rail (This Week +
                Treasury, then Socials/Instagram/Activity). Stacking each side in
                its own flex column keeps them continuous (no cross-column row
                coupling / gaps). On tablet (≤1279) both columns dissolve via
                `display: contents` and the regions reflow into one column with
                the high-signal This Week + Treasury pair lifted above the Roster
                (see dashboard-ledger.css). DOM order within each column equals
                the on-screen order at every width, so focus order stays correct. */}
            <div className="grid">
              {/* Left column — Needs attention, then Roster */}
              <div className="col col-main">
                {feature("operations", "needs-attention") && (
                  <div className="area-needs">
                  <NeedsAttention
                    items={needsAttention}
                    onMarkDone={completeDeadline}
                    onOpenProfile={(id) => setSelectedBrotherId(id)}
                    onSendReminder={() => setActiveDrawer("dues")}
                    onOpenReimbursements={() => router.push(orgPath("/treasury?tab=Reimbursements"))}
                    hasData={hasAnyData}
                    loading={!attentionLoaded}
                    error={attentionFailed}
                    onRetry={retrySections}
                    tracked={measured}
                    hideButton={isActiveOrgAdmin ? <DashHideButton label="Needs attention" onHide={() => setWidgetHidden("needs-attention", true)} /> : undefined}
                  />
                  </div>
                )}
                {feature("operations", "brother-tracking") && (
                  <div className="area-roster">
                  <RosterTable
                    brothers={filteredBrothers}
                    totalCount={brotherList.length}
                    statusCounts={statusCounts}
                    statusFilter={statusFilter}
                    onFilter={setStatusFilter}
                    search={search}
                    onSearch={setSearch}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={toggleSort}
                    onRowClick={(id) => setSelectedBrotherId(id)}
                    selectedId={selectedBrotherId}
                    onOpenAll={() => router.push(orgPath("/brothers"))}
                    onInvite={canSettings ? handleInvite : undefined}
                    inviteLabel={inviteLink ? "Copy invite link" : "Create an invite link"}
                    loading={!rosterLoaded}
                    error={rosterFailed}
                    onRetry={retrySections}
                    thresholds={THRESHOLDS}
                    selfId={selfId}
                    selfAvatarUrl={currentUser?.avatarUrl}
                    avatarRevision={avatarRevision}
                    tracked={tracked}
                    measured={measured}
                    hideButton={isActiveOrgAdmin ? <DashHideButton label="Member tracking" onHide={() => setWidgetHidden("brother-tracking", true)} /> : undefined}
                  />
                  </div>
                )}
              </div>

              {/* Right column — rail: This Week + Treasury (priority), then the rest */}
              <div className="col rail col-rail">
                {/* Priority pair — lifts above the Roster on tablet */}
                <div className="area-priority">
                  {/* Above This Week on purpose: a ballot is the only rail item
                      that expires and asks for an action, so it outranks the
                      agenda while it exists — and it renders nothing at all the
                      rest of the time. */}
                  {ballotEnabled && (
                    <BallotCard
                      polls={ballotPolls}
                      today={todayISO}
                      onVote={castBallotVote}
                      onDismiss={dismissBallot}
                    />
                  )}
                  <ThisWeek
                    events={weeklyDigest.eventsThisWeek}
                    deadlines={weeklyDigest.deadlinesDue}
                    weekStart={weekRange.start}
                    weekEnd={weekRange.end}
                    today={todayISO}
                    onAll={() => setWidgetDrawer("deadlines")}
                    onSelect={setWeekPeek}
                    calendarEmpty={calendarLoaded && calendarList.length === 0}
                    /* Same two sections the digest waits on — the agenda merges
                       calendar events with deadlines due this week. */
                    loading={!digestReady}
                    error={weekFailed}
                    onRetry={retryWeek}
                    onAddEvent={canEvents && eventsEnabled ? () => setActiveModal("event") : undefined}
                  />
                  {financeEnabled && (
                    <TreasuryRail
                      balance={liveBalance}
                      projected={liveProjected}
                      trend={liveTrend}
                      openingBalance={treasuryData?.openingBalance ?? null}
                      loading={!treasuryLoaded}
                      error={treasuryFailed}
                      onRetry={retrySections}
                      onLogTransaction={canTreasury ? () => router.push(orgPath("/treasury?tab=Transactions")) : undefined}
                    />
                  )}
                </div>

                {/* Remaining rail — Activity */}
                <div className="area-rail">
                <ActivityRail entries={activityFeed} loading={!activityLoaded} error={activityFailed} onRetry={retrySections} onAll={() => setWidgetDrawer("activity")} />
                </div>
              </div>
            </div>

            {/* ── Hidden widgets tray (admin un-hide path) ────────────────── */}
            {isActiveOrgAdmin && hiddenOps.length > 0 && (
              <div className="hidden-tray">
                <p className="lbl">Hidden widgets</p>
                <div className="chips">
                  {hiddenOps.map(f => (
                    <button key={f.id} onClick={() => setWidgetHidden(f.id, false)} title={`Show ${f.label}`}>{f.label}</button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Footer ──────────────────────────────────────────────────── */}
            <footer>{currentUser?.org?.name ?? "ChaptOS"}</footer>

          </div>
        </main>
      </div>

      {/* ── Modals ──────────────────────────────────────────────────────────── */}
      {/* Detail sheet for a This Week row. Read-only: it answers the questions a
          one-line agenda row raises, then hands off to the page that owns editing. */}
      {weekPeek && (
        <WeekItemPeek
          target={weekPeek}
          today={todayISO}
          eventTypes={eventTypeMap}
          /* Attendance-exempt members are excluded from every other attendance
             aggregate on this page, so they must not pad this denominator either. */
          rosterSize={attendees.length}
          onClose={() => setWeekPeek(null)}
          onOpenEvent={(ev) => { setWeekPeek(null); router.push(orgPath(`/timeline?event=${ev.id}`)); }}
          onOpenTask={(t) => { setWeekPeek(null); router.push(orgPath(`/tasks?task=${t.id}`)); }}
        />
      )}
      {activeModal === "expense" && isAdmin && (
        <Modal title="Log Expense" tone="dusk" onClose={closeModal}>
          <TxForm lockType="expense" tone="dusk" onSubmit={handleAddTransaction} onCancel={closeModal} />
        </Modal>
      )}
      {activeModal === "event" && (
        <Modal title="New Event" tone="dusk" onClose={closeModal}>
          <CalendarEventForm submitLabel="Add Event" onSubmit={handleAddCalendarEvent} categoryOptions={eventCategoryOptions} minDate={activeSemester?.startDate} maxDate={activeSemester?.endDate} />
        </Modal>
      )}
      {activeModal === "deadline" && canTasks && (
        <Modal title="New deadline" tone="dusk" onClose={closeModal}>
          <TaskForm
            brothers={brotherList}
            roles={roles}
            brothersLoading={!rosterLoaded}
            rolesLoading={!rolesLoaded}
            minDate={activeSemester?.startDate}
            maxDate={activeSemester?.endDate}
            submitLabel="Create deadline"
            onSubmit={handleAddDeadline}
          />
        </Modal>
      )}
      {activeModal === "task" && canTasks && (
        <Modal title="New task" tone="dusk" onClose={closeModal}>
          <TaskForm
            brothers={brotherList}
            roles={roles}
            brothersLoading={!rosterLoaded}
            rolesLoading={!rolesLoaded}
            minDate={activeSemester?.startDate}
            maxDate={activeSemester?.endDate}
            submitLabel="Create task"
            onSubmit={handleAddDeadline}
          />
        </Modal>
      )}
      {activeModal === "revenue" && (
        <Modal title="Log Revenue" tone="dusk" onClose={closeModal}>
          <AddRevenueForm onSubmit={handleAddRevenue} />
        </Modal>
      )}
      {igEnabled && activeModal === "ig" && (
        <Modal title="Add Instagram Task" tone="dusk" onClose={closeModal}>
          <AddIGTaskForm onSubmit={handleAddIGTask} />
        </Modal>
      )}
      {activeModal === "attendance" && selectedEventForAttendance && (
        <Modal title="Log Attendance" tone="dusk" onClose={closeModal}>
          <LogAttendanceForm event={selectedEventForAttendance} bList={brotherList} onSubmit={handleLogAttendance} />
        </Modal>
      )}
      {activeModal === "pick-event-for-excuse" && (
        <Modal title="Select Event to Excuse" tone="dusk" onClose={closeModal}>
          <p className="mb-3 text-[12px] text-[#958d7c]">Pick a required event you (or, if you&rsquo;re an admin, another brother) need an excuse for.</p>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {calendarList.filter(e => e.mandatory).length === 0 && (
              <p className="text-[12px] text-[#6b6354]">No required events found.</p>
            )}
            {calendarList.filter(e => e.mandatory).sort((a, b) => a.date.localeCompare(b.date)).map(e => (
              <button key={e.id} onClick={() => { setSelectedEventForAttendance(e); setActiveModal("excuse"); }}
                className="w-full rounded-lg border border-[rgba(236,231,221,0.08)] bg-[rgba(236,231,221,0.03)] px-3 py-2.5 text-left transition-colors hover:border-[#a78bfa]/30 hover:bg-[#a78bfa]/10">
                <p className="text-[13px] font-medium text-[#ece7dd]">{e.title}</p>
                <p className="text-[11px] text-[#6b6354]">{e.date}{e.location ? ` · ${e.location}` : ""}</p>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {activeModal === "excuse" && selectedEventForAttendance && (
        <Modal title={isAdmin ? "Approve Excuse" : "Submit Excuse"} tone="dusk" onClose={closeModal}>
          <ExcuseForm
            event={selectedEventForAttendance}
            bList={brotherList}
            isAdmin={isAdmin}
            selfBrotherId={selfId}
            onDone={({ excuseStatus }) => {
              const eventTitle = selectedEventForAttendance.title;
              if (excuseStatus === "approved") {
                addActivity(`Excuse approved for ${eventTitle}`, "success");
              } else {
                addActivity(`Excuse submitted for review (${eventTitle})`, "info");
              }
              setSelectedEventForAttendance(null);
              setActiveModal(null);
              // Refresh chapter data so attendance numbers reflect the new approval.
              refreshChapterData().catch(() => undefined);
            }}
          />
        </Modal>
      )}
      {activeModal === "pick-event" && (
        <Modal title="Select Event to Log" tone="dusk" onClose={closeModal}>
          <p className="mb-3 text-[12px] text-[#958d7c]">Pick a required event to log attendance for.</p>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {calendarList.filter(e => e.mandatory).length === 0 && (
              <p className="text-[12px] text-[#6b6354]">No required events found.</p>
            )}
            {calendarList.filter(e => e.mandatory).sort((a, b) => a.date.localeCompare(b.date)).map(e => (
              <button key={e.id} onClick={() => { setSelectedEventForAttendance(e); setActiveModal("attendance"); }}
                className="w-full rounded-lg border border-[rgba(236,231,221,0.08)] bg-[rgba(236,231,221,0.03)] px-3 py-2.5 text-left transition-colors hover:border-[#a78bfa]/30 hover:bg-[#a78bfa]/10">
                <p className="text-[13px] font-medium text-[#ece7dd]">{e.title}</p>
                <p className="text-[11px] text-[#6b6354]">{e.date}{e.location ? ` · ${e.location}` : ""}</p>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {/* ── Pay Dues Modal ──────────────────────────────────────────────────── */}
      {payTarget && (
        <Modal title="Record Payment" tone="dusk" onClose={() => setPayTarget(null)}>
          <div className="space-y-4">
            <div>
              <p className="text-[12px] text-[#958d7c] mb-3">
                {payTarget.name} owes <span className="font-semibold text-[#d9b08b]">{fmt$(payTarget.duesOwed)}</span>
              </p>
              <FieldLabel tone="dusk">Amount Paid ($)</FieldLabel>
              <input
                type="number"
                min="0"
                max={payTarget.duesOwed}
                step="0.01"
                className={inputDuskCls}
                value={payAmountStr}
                onChange={e => setPayAmountStr(e.target.value)}
                autoFocus
                onKeyDown={e => { if (e.key === "Enter") submitPayDues(); }}
              />
              {parseFloat(payAmountStr) > 0 && (
                <p className="mt-1.5 text-[11px] text-[#6b6354]">
                  Opens the transaction form pre-filled — review and post it to record
                  the payment.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPayTarget(null)}
                className={btnDuskGhostCls}
              >
                Cancel
              </button>
              <button
                onClick={submitPayDues}
                disabled={!(parseFloat(payAmountStr) > 0)}
                className={btnDuskActionCls}
              >
                Continue
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Record Dues Payment (pre-filled transaction form) ──────────────────── */}
      {duesTx && (
        <Modal title="Record Dues Payment" tone="dusk" onClose={() => setDuesTx(null)}>
          <TxForm
            tone="dusk"
            duesFor={{ id: duesTx.brother.id, name: duesTx.brother.name }}
            initial={{
              type:        "income",
              category:    "Dues",
              amount:      duesTx.amount,
              date:        todayStr(),
              description: `Dues payment — ${duesTx.brother.name}`,
            }}
            onSubmit={recordDuesTx}
            onCancel={() => setDuesTx(null)}
          />
        </Modal>
      )}

      {/* ── Log Service Hours Modal ─────────────────────────────────────────── */}
      {logHoursFor && (
        <Modal title="Log Service Hours" tone="dusk" onClose={() => !logHoursBusy && setLogHoursFor(null)}>
          <div className="space-y-4">
            <p className="text-[12px] text-[#958d7c]">
              Logging hours for <span className="font-semibold text-[#ece7dd]">{logHoursFor.name}</span> against a service event.
            </p>
            <div>
              <FieldLabel tone="dusk">Service Event</FieldLabel>
              {logHoursEvents.length === 0 ? (
                <p className="mt-1 text-[12px] text-[#6b6354]">No service events yet. Create one on the Service page first.</p>
              ) : (
                <select
                  className={inputDuskCls}
                  value={logHoursEventId ?? ""}
                  onChange={e => setLogHoursEventId(e.target.value ? Number(e.target.value) : null)}
                >
                  {logHoursEvents.map(ev => (
                    <option key={ev.id} value={ev.id}>{ev.title} · {fmtDate(ev.date)}</option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <FieldLabel tone="dusk">Hours</FieldLabel>
              <input
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                className={inputDuskCls}
                value={logHoursStr}
                placeholder="0"
                autoFocus
                onChange={e => setLogHoursStr(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && logHoursEventId != null && logHoursStr !== "") submitLogServiceHours(); }}
              />
              <p className="mt-1.5 text-[11px] text-[#6b6354]">
                Sets {logHoursFor.name.split(" ")[0]}&apos;s hours for this event. Their total recomputes from all logged events.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setLogHoursFor(null)}
                disabled={logHoursBusy}
                className={btnDuskGhostCls}
              >
                Cancel
              </button>
              <button
                onClick={submitLogServiceHours}
                disabled={logHoursBusy || logHoursEventId == null || logHoursStr === ""}
                className={btnDuskActionCls}
              >
                {logHoursBusy ? "Saving…" : "Log Hours"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Announcement Editor ─────────────────────────────────────────────── */}
      {announcementEditorOpen && (
        <AnnouncementEditor
          current={announcement}
          onClose={() => setAnnouncementEditorOpen(false)}
          onSave={(saved) => {
            setAnnouncement(saved);
            setAnnouncementEditorOpen(false);
          }}
        />
      )}

      {/* ── Widget Detail Drawer ────────────────────────────────────────────── */}
      <WidgetDetailDrawer
        activeKey={widgetDrawer}
        onClose={() => setWidgetDrawer(null)}
        weeklyDigest={weeklyDigest}
        weekRange={weekRange}
        digestNarration={digestNarration}
        deadlineList={taskList}
        activityFeed={activityFeed}
        health={health}
        onOpenModal={setActiveModal}
        onAddTask={canTasks ? () => setActiveModal("deadline") : () => router.push(orgPath("/tasks?new=1"))}
        onCompleteDeadline={completeDeadline}
        onDeleteDeadline={deleteDeadline}
        onEditDeadline={openEditDeadline}
      />

      {/* ── Brother Detail Drawer ───────────────────────────────────────────── */}
      <BrotherDrawer
        brotherId={selectedBrotherId}
        brotherList={brotherList}
        onClose={() => setSelectedBrotherId(null)}
        onSave={updateBrother}
        onPayDues={openPayDues}
        onLogServiceHours={openLogServiceHours}
        isAdmin={isAdmin}
        canTreasury={canTreasury}
        selfId={selfId}
      />

      {/* ── Confirm Delete Dialog ───────────────────────────────────────────── */}
      {confirmDelete && (
        <ConfirmDialog
          tone="dusk"
          title="Delete Deadline"
          message={<>Delete <span className="font-semibold text-[#ece7dd]">{confirmDelete.label}</span>? This cannot be undone.</>}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            confirmDeleteDeadline(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}

      {/* ── KPI Detail Drawer ───────────────────────────────────────────────── */}
      <KPIDetailDrawer
        activeKey={activeDrawer}
        onClose={() => setActiveDrawer(null)}
        brotherList={brotherList}
        partyList={partyList}
        openPayDues={openPayDues}
        addServiceHour={addServiceHour}
        avgAttendance={avgAttendance}
        outstandingDues={outstandingDues}
        chapterGPA={chapterGPA}
        totalServiceHrs={totalServiceHrs}
        onTrackSvc={onTrackSvc}
        totalDoorRev={totalDoorRev}
        maxRevenue={maxRevenue}
        bestEvent={bestEvent}
        liveBalance={liveBalance}
        liveProjected={liveProjected}
        liveTrend={liveTrend}
        onOpenModal={setActiveModal}
        onOpenAttendance={openAttendanceLog}
        isAdmin={isAdmin}
        canTreasury={canTreasury}
        hasDuesData={duesKnown && hasDuesData}
      />
      <CustomMetricDetailDrawer
        snap={customMetricSnapshots.find(s => s.definitionId === activeCustomMetricId) ?? null}
        onClose={() => setActiveCustomMetricId(null)}
      />
    </div>
  );
}
