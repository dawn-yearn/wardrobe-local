import assert from "node:assert/strict";
import test from "node:test";
import { reviewActionState, reviewStageForJob } from "../../src/import-job-state.js";

function job(crop, garment, modeled) {
  const stage = (status, decision = null) => ({ status, decision });
  return { stages: { crop: stage(...crop), garment: stage(...garment), modeled: stage(...modeled) } };
}

test("frontend and backend select the same review stage through the AI pipeline", () => {
  assert.equal(reviewStageForJob(job(["review"], ["pending"], ["pending"])), "crop");
  assert.equal(reviewStageForJob(job(["approved", "approved"], ["review"], ["pending"])), "garment");
  assert.equal(reviewStageForJob(job(["approved", "approved"], ["approved", "approved"], ["review"])), "modeled");
});

test("a current review action is accepted and a different stage is stale", () => {
  const current = job(["approved", "approved"], ["review"], ["pending"]);
  assert.deepEqual(reviewActionState(current, "garment", "approve"), { kind: "ready", reviewStage: "garment" });
  assert.deepEqual(reviewActionState(current, "crop", "reject"), { kind: "stale", reviewStage: "garment" });
});

test("a repeated successful decision is idempotent without making another transition", () => {
  const current = job(["approved", "approved"], ["processing"], ["pending"]);
  assert.deepEqual(reviewActionState(current, "crop", "approve"), { kind: "duplicate", reviewStage: null });
});
