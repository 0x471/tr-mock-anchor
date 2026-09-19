import { ApiError } from "./errors.js";

export type AnchorMode = "zkpassport" | "legacy";

export const POLICY_PENDING_CODE = "zkpassport_policy_pending";
export const POLICY_PENDING_MESSAGE =
  "Legacy economic routes are disabled in zkpassport mode. Use the separately configured proof-gated vault; it remains unavailable until explicitly configured.";

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
