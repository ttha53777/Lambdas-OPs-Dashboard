"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiErrorCode } from "../lib/api";
import { useOrgPath } from "./useOrgPath";

/**
 * Translates a failed dated-item mutation into the right user-facing action.
 *
 * The semester guards in lib/services/semester-bounds.ts get named handling
 * because they imply a *destination* — the user has to go set a semester up:
 *
 *   NO_ACTIVE_SEMESTER  → route the user to semester setup (Settings).
 *
 * Everything else is a message problem, not a routing one, and the rule is:
 * prefer what the server wrote. Domain errors (lib/errors) carry prose composed
 * for this exact situation — "Needs date + location before it can move to
 * confirmed." — and replacing that with a caller's generic fallback is how a
 * gate with a clear, actionable reason reaches an officer as "Could not move
 * event." The fallback is for when there is genuinely nothing better to say.
 *
 * `code` is the test for "did a human write this": toResponse() emits it on
 * every DomainError and on nothing else, so the bare shells it produces for
 * unmapped failures ("Internal server error", "Foreign key constraint") have no
 * code and are correctly rejected in favour of the fallback. Matching on those
 * strings instead would break the moment one is reworded.
 *
 * Usage:
 *   const handleSemesterError = useSemesterErrorHandler();
 *   ...
 *   .catch(err => handleSemesterError(err, setMutationError,
 *     "Calendar event could not be saved."));
 */
export function useSemesterErrorHandler() {
  const router = useRouter();
  const orgPath = useOrgPath();

  return useCallback(
    (err: unknown, showMessage: (msg: string) => void, fallback: string) => {
      const resolved = resolveMutationError(err, fallback);
      showMessage(resolved.message);
      if (resolved.goToSemesterSetup) router.push(`${orgPath("/settings")}#set-semesters`);
    },
    [router, orgPath],
  );
}

export interface ResolvedMutationError {
  message: string;
  /** Whether the only fix is setting a semester up, i.e. send them there. */
  goToSemesterSetup: boolean;
}

/**
 * The decision, split from the hook so it can be tested without a React
 * renderer (this repo has no jsdom/RTL setup, and the branch table below is the
 * part worth pinning).
 */
export function resolveMutationError(err: unknown, fallback: string): ResolvedMutationError {
  if (apiErrorCode(err) === "NO_ACTIVE_SEMESTER") {
    return {
      message: "Set up an active semester before adding dated items.",
      goToSemesterSetup: true,
    };
  }

  // Not an ApiError at all: requestJson only throws these when the request never
  // completed (offline, timeout, non-JSON response). Naming that keeps a dropped
  // connection from reading as a permanent refusal — the officer needs to know
  // retrying is the fix.
  if (!(err instanceof ApiError)) {
    return {
      message: "Couldn't reach the server. Check your connection and try again.",
      goToSemesterSetup: false,
    };
  }

  return { message: serverMessage(err) ?? fallback, goToSemesterSetup: false };
}

/** The server's own prose, but only when a DomainError authored it (see above). */
function serverMessage(err: ApiError): string | null {
  const body = err.body as { error?: unknown; code?: unknown } | null;
  if (typeof body?.code !== "string") return null;
  const msg = body?.error;
  return typeof msg === "string" && msg.trim() ? msg : null;
}
