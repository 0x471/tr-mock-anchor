import { ApiError } from "./errors.js";

export type AnchorMode = "zkpassport" | "legacy";

export const POLICY_PENDING_CODE = "zkpassport_policy_pending";
export const POLICY_PENDING_MESSAGE =
  "Native proof verification is diagnostic only. Eligibility and payout authorization are disabled until a binding policy is implemented.";

export function economicActionsEnabled(cfg: {
  anchorMode?: AnchorMode;
}): boolean {
  return cfg.anchorMode === "legacy";
}

export function assertEconomicActionsEnabled(cfg: {
  anchorMode?: AnchorMode;
}): void {
  if (!economicActionsEnabled(cfg)) {
    throw new ApiError(403, POLICY_PENDING_CODE, POLICY_PENDING_MESSAGE);
  }
}
