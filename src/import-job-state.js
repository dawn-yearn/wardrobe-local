export const IMPORT_REVIEW_STAGES = ["modeled", "garment", "crop"];

export function reviewStageForJob(job) {
  return IMPORT_REVIEW_STAGES.find((stage) => job?.stages?.[stage]?.status === "review") || null;
}

export function reviewActionState(job, stage, decision) {
  const stageState = job?.stages?.[stage];
  if (!stageState || !["approve", "reject"].includes(decision)) {
    return { kind: "invalid", reviewStage: reviewStageForJob(job) };
  }

  const completedStatus = decision === "approve" ? "approved" : "rejected";
  if (stageState.status === completedStatus && stageState.decision === completedStatus) {
    return { kind: "duplicate", reviewStage: reviewStageForJob(job) };
  }

  const reviewStage = reviewStageForJob(job);
  return reviewStage === stage
    ? { kind: "ready", reviewStage }
    : { kind: "stale", reviewStage };
}
