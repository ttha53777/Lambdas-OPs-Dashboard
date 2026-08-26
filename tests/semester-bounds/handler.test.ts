import { describe, it, expect } from "vitest";
import { ApiError } from "@/app/lib/api";
import { resolveMutationError } from "@/app/hooks/useSemesterErrorHandler";

const FALLBACK = "Could not move event.";
const api = (status: number, body: unknown) => new ApiError("x", status, body);
const msg = (err: unknown) => resolveMutationError(err, FALLBACK).message;

/**
 * The regression these pin: a server error written FOR the officer used to be
 * replaced by the caller's generic fallback, so a stage gate that knows exactly
 * what is missing arrived as "Could not move event."
 */
describe("resolveMutationError", () => {
  it("surfaces a stage-gate ValidationError instead of the fallback", () => {
    expect(msg(api(400, {
      error: "Needs date + location before it can move to confirmed.",
      code: "VALIDATION",
    }))).toBe("Needs date + location before it can move to confirmed.");
  });

  it("surfaces the confirm-before-done gate", () => {
    expect(msg(api(400, {
      error: "Confirm this event before wrapping it. Done means it happened, and the chapter was never told it was on.",
      code: "VALIDATION",
    }))).toMatch(/^Confirm this event before wrapping it\./);
  });

  it("still surfaces DATE_OUTSIDE_SEMESTER prose the old special case handled", () => {
    expect(msg(api(400, {
      error: "Date falls outside the active semester.",
      code: "VALIDATION",
      details: { code: "DATE_OUTSIDE_SEMESTER" },
    }))).toBe("Date falls outside the active semester.");
  });

  it("routes NO_ACTIVE_SEMESTER to setup rather than showing a message alone", () => {
    const r = resolveMutationError(
      api(400, { error: "No active semester", code: "VALIDATION", details: { code: "NO_ACTIVE_SEMESTER" } }),
      FALLBACK,
    );
    expect(r.goToSemesterSetup).toBe(true);
    expect(r.message).toBe("Set up an active semester before adding dated items.");
  });

  // buildContext short-circuits before toResponse and emits a bare
  // { error: "Forbidden" } with no code, so the officer gets the caller's
  // fallback rather than the word "Forbidden" on its own.
  it("uses the fallback for the bare 403 buildContext emits", () => {
    expect(msg(api(403, { error: "Forbidden" }))).toBe(FALLBACK);
  });

  // The bare shells toResponse() emits for unmapped failures carry no `code`,
  // so they must not reach the officer as if they were advice.
  it("uses the fallback for a bare 500", () => {
    expect(msg(api(500, { error: "Internal server error" }))).toBe(FALLBACK);
  });

  it("uses the fallback for a bare Prisma constraint 409", () => {
    expect(msg(api(409, { error: "Foreign key constraint" }))).toBe(FALLBACK);
  });

  it("uses the fallback when the body has no error string at all", () => {
    expect(msg(api(502, null))).toBe(FALLBACK);
  });

  it("names a network failure distinctly from a refusal", () => {
    expect(msg(new TypeError("Failed to fetch")))
      .toBe("Couldn't reach the server. Check your connection and try again.");
  });

  it("does not route to semester setup on an ordinary failure", () => {
    expect(resolveMutationError(api(500, { error: "Internal server error" }), FALLBACK).goToSemesterSetup)
      .toBe(false);
  });
});
