import { isFeatureEnabled, type DisabledFeatures } from "./workflow-features";
import { BUILTIN_METRIC_IDS, type BuiltinMetricId } from "./onboarding/kinds";

/**
 * Built-in metric → the operations KPI widget it drives. An org that doesn't
 * track a built-in hides its widget via OrganizationConfig.disabledFeatures
 * (opt-out map), which is what provisionOrg writes from the interview's
 * per-member metrics answer.
 */
export const BUILTIN_METRIC_KPI: Record<BuiltinMetricId, string> = {
  attendance:   "kpi-attendance",
  gpa:          "kpi-gpa",
  duesOwed:     "kpi-dues",
  serviceHours: "kpi-service",
};

/** Which built-in per-member metrics an org actually tracks. */
export type TrackedMetrics = Record<BuiltinMetricId, boolean>;

/** Every built-in tracked — the default for orgs that never opted out of any. */
export const ALL_TRACKED: TrackedMetrics = {
  attendance: true, gpa: true, duesOwed: true, serviceHours: true,
};

/**
 * Resolve which built-in metrics an org tracks from its disabled-features map.
 *
 * This is the single source of truth behind the dashboard's org-type awareness:
 * a metric the org switched off in onboarding must not appear as a roster
 * column, must not contribute to the health score, and must not flag members
 * At Risk on a value nobody ever recorded.
 *
 * Built on isFeatureEnabled, so it inherits the opt-out polarity and its
 * fail-open behavior: an org with no disabledFeatures resolves to ALL_TRACKED
 * and behaves exactly as it did before this existed.
 */
export function resolveTrackedMetrics(disabled: DisabledFeatures | null | undefined): TrackedMetrics {
  const out = {} as TrackedMetrics;
  for (const id of BUILTIN_METRIC_IDS) {
    out[id] = isFeatureEnabled("operations", BUILTIN_METRIC_KPI[id], disabled);
  }
  return out;
}

/** How many per-member built-ins are tracked. */
export function trackedCount(tracked: TrackedMetrics): number {
  return BUILTIN_METRIC_IDS.filter(id => tracked[id]).length;
}
