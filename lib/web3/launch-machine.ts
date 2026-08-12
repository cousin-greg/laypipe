export type LaunchPhase =
  | "draft"
  | "reviewed"
  | "connecting"
  | "wallet-ready"
  | "preparing"
  | "approval-required"
  | "approval-pending"
  | "ready-to-launch"
  | "launch-pending"
  | "succeeded"
  | "failed";

export interface LaunchMachineState {
  phase: LaunchPhase;
  recoverTo: Exclude<LaunchPhase, "failed">;
  message?: string;
}

export type LaunchMachineEvent =
  | { type: "EDIT" }
  | { type: "REVIEW" }
  | { type: "CONNECT" }
  | { type: "CONNECTED" }
  | { type: "PREPARE" }
  | { type: "PREPARED"; needsApproval: boolean }
  | { type: "APPROVAL_SUBMITTED" }
  | { type: "APPROVAL_CONFIRMED"; needsAnotherApproval: boolean }
  | { type: "LAUNCH_SUBMITTED" }
  | { type: "LAUNCH_CONFIRMED" }
  | { type: "RESTORE_PENDING"; action: "approval" | "launch" }
  | { type: "RESTORE_LAUNCH_CONFIRMED" }
  | { type: "FAIL"; message: string; recoverTo: Exclude<LaunchPhase, "failed"> }
  | { type: "RECOVER" };

export const INITIAL_LAUNCH_STATE: LaunchMachineState = {
  phase: "draft",
  recoverTo: "draft",
};

export function reduceLaunchMachine(
  state: LaunchMachineState,
  event: LaunchMachineEvent,
): LaunchMachineState {
  switch (event.type) {
    case "EDIT":
      return INITIAL_LAUNCH_STATE;
    case "REVIEW":
      return { phase: "reviewed", recoverTo: "reviewed" };
    case "CONNECT":
      return { phase: "connecting", recoverTo: "reviewed" };
    case "CONNECTED":
      return { phase: "wallet-ready", recoverTo: "wallet-ready" };
    case "PREPARE":
      return { phase: "preparing", recoverTo: "wallet-ready" };
    case "PREPARED":
      return event.needsApproval
        ? { phase: "approval-required", recoverTo: "approval-required" }
        : { phase: "ready-to-launch", recoverTo: "ready-to-launch" };
    case "APPROVAL_SUBMITTED":
      return { phase: "approval-pending", recoverTo: "approval-required" };
    case "APPROVAL_CONFIRMED":
      return event.needsAnotherApproval
        ? { phase: "approval-required", recoverTo: "approval-required" }
        : { phase: "ready-to-launch", recoverTo: "ready-to-launch" };
    case "LAUNCH_SUBMITTED":
      return { phase: "launch-pending", recoverTo: "ready-to-launch" };
    case "LAUNCH_CONFIRMED":
      return { phase: "succeeded", recoverTo: "succeeded" };
    case "RESTORE_PENDING":
      return event.action === "approval"
        ? { phase: "approval-pending", recoverTo: "wallet-ready" }
        : { phase: "launch-pending", recoverTo: "wallet-ready" };
    case "RESTORE_LAUNCH_CONFIRMED":
      return { phase: "succeeded", recoverTo: "succeeded" };
    case "FAIL":
      return { phase: "failed", recoverTo: event.recoverTo, message: event.message };
    case "RECOVER":
      return { phase: state.recoverTo, recoverTo: state.recoverTo };
  }
}
