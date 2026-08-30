/**
 * Per-workflow *feature* registry. A feature is a toggleable sub-section of a
 * workflow's page — e.g. the Dashboard's Health widget or a KPI card — that an
 * org admin can hide without turning the whole page off.
 *
 * This is the finer-grained sibling of the workflow registry in
 * `lib/org-types.ts` (ALL_WORKFLOWS) and the nav map in `app/components/Sidebar.tsx`
 * (NAV_WORKFLOW_MAP). Same posture: the source of truth lives in code (small,
 * churns rarely, reviewable as a PR), and the DB column stores only a normalized
 * subset of it.
 *
 * Polarity is OPT-OUT: OrganizationConfig.disabledFeatures records only the
 * features an admin has turned *off*. A feature is enabled unless it appears in
 * its workflow's disabled list. This makes "on" the safe default — every existing
 * org and every newly added feature is on with no backfill, and a missing config
 * row means "everything on".
 *
 * Consumed by:
 *   - The org-config service (setDisabledFeatures): normalizes before persisting.
 *   - The Zod validator (updateOrgConfigInput): rejects unknown feature ids.
 *   - The pages themselves (via the useFeature hook): hides a section when its
 *     feature is disabled.
 *   - The Workflows settings section: renders a checkbox per feature.
 */

import { ALL_WORKFLOWS, type WorkflowId } from "@/lib/org-types";

/** One toggleable section within a workflow's page. */
export interface WorkflowFeature {
  /** Stored id. Stable — changing it orphans an org's stored toggle. */
  id: string;
  /** Shown next to the checkbox in settings. */
  label: string;
  /** One-line explanation of what hiding it removes. */
  description: string;
}

/**
 * The toggleable features each workflow exposes, keyed by WorkflowId. A workflow
 * with no toggleable sections maps to an empty array.
 *
 * Dashboard widgets are keyed under "operations" — the always-on workflow that
 * backs the Dashboard/Timeline/Chapter surfaces. The page can't be turned off,
 * but its individual widgets can, letting an admin curate the home screen.
 */
export const WORKFLOW_FEATURES: Record<WorkflowId, readonly WorkflowFeature[]> = {
  operations: [
    { id: "announcement",     label: "Announcement",     description: "Pinned chapter announcement at the top of the dashboard." },
    { id: "kpi-attendance",   label: "Attendance KPI",   description: "Attendance measure in the ledger strip." },
    { id: "kpi-dues",         label: "Dues KPI",         description: "Outstanding-dues measure in the ledger strip." },
    { id: "kpi-gpa",          label: "GPA KPI",          description: "Chapter-GPA measure in the ledger strip." },
    { id: "kpi-service",      label: "Service Hours KPI", description: "Service-hours measure in the ledger strip." },
    { id: "ballot",          label: "Ballot",            description: "Prompts a member to vote on an open poll assigned to them. Only appears when one is waiting." },
    { id: "health",          label: "Health widget",     description: "Chapter health dial and metric breakdown." },
    { id: "needs-attention", label: "Needs attention",   description: "Queue of overdue deadlines, outstanding dues, and at-risk members." },
    { id: "brother-tracking", label: "Member tracking",  description: "The sortable member roster table." },
  ],
  finance: [],
  members: [],
  events: [],
  attendance: [],
  parties: [],
  service: [],
  communications: [],
  docs: [],
  tasks: [],
  meetings: [],
};

/**
 * The stored shape: a sparse map of workflow id → list of disabled feature ids.
 * Absent workflow / absent id both mean "enabled".
 */
export type DisabledFeatures = Partial<Record<WorkflowId, string[]>>;

/** True when `feature` is a registered feature of `workflow`. */
export function featureExists(workflow: string, feature: string): boolean {
  const features = WORKFLOW_FEATURES[workflow as WorkflowId];
  if (!features) return false;
  return features.some(f => f.id === feature);
}

/**
 * The single gating predicate, used by both server and client so they never
 * drift. A feature is enabled unless it appears in its workflow's disabled list.
 * Unknown ids return true (fail open — showing a section is the safe default,
 * matching the opt-out polarity).
 */
export function isFeatureEnabled(
  workflow: WorkflowId,
  feature: string,
  disabled: DisabledFeatures | null | undefined,
): boolean {
  const list = disabled?.[workflow];
  if (!list) return true;
  return !list.includes(feature);
}

/**
 * Normalize a client-supplied disabled map to the canonical storage shape:
 *   - drop unknown workflow ids,
 *   - drop unknown / duplicate feature ids within a workflow,
 *   - order disabled ids by the registry for a stable column,
 *   - drop workflows whose disabled list ends up empty.
 *
 * Defense in depth — the Zod schema already rejects unknown ids at the route;
 * this is the same role ALL_WORKFLOWS.filter(...) plays in setWorkflows.
 */
export function normalizeDisabledFeatures(input: DisabledFeatures): DisabledFeatures {
  const out: DisabledFeatures = {};
  for (const workflow of ALL_WORKFLOWS) {
    const requested = input[workflow];
    if (!requested || requested.length === 0) continue;
    const requestedSet = new Set(requested);
    const normalized = WORKFLOW_FEATURES[workflow]
      .filter(f => requestedSet.has(f.id))
      .map(f => f.id);
    if (normalized.length > 0) out[workflow] = normalized;
  }
  return out;
}
