import * as Schema from "effect/Schema";
import { IsoDateTime, NodeId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const Revision = Schema.Int.check(Schema.isGreaterThan(0));
const PlanVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const TeamPlanTaskId = TrimmedNonEmptyString;
export type TeamPlanTaskId = typeof TeamPlanTaskId.Type;
export const TeamPlanTaskRef = Schema.Struct({ taskId: TeamPlanTaskId, revision: Revision });
export type TeamPlanTaskRef = typeof TeamPlanTaskRef.Type;
export const TeamPlanDependency = TeamPlanTaskRef;
export type TeamPlanDependency = TeamPlanTaskRef;
export const TeamPlanExecutionRef = Schema.Struct({
  subagentId: NodeId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
});
export type TeamPlanExecutionRef = typeof TeamPlanExecutionRef.Type;
export const TeamPlanAcceptanceStatus = Schema.Literals([
  "pending",
  "accepted",
  "issues",
  "blocked",
]);
export type TeamPlanAcceptanceStatus = typeof TeamPlanAcceptanceStatus.Type;
const AcceptanceProvenance = {
  actor: Schema.optional(Schema.Literals(["user", "coordinator"])),
  reviewerThreadId: Schema.optional(ThreadId),
};
export const TeamPlanAcceptance = Schema.Struct({
  status: TeamPlanAcceptanceStatus,
  note: Schema.String,
  updatedAt: IsoDateTime,
  ...AcceptanceProvenance,
});
export type TeamPlanAcceptance = typeof TeamPlanAcceptance.Type;
const TaskContent = {
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  role: TrimmedNonEmptyString,
  modelSelection: Schema.NullOr(ModelSelection),
  dependencies: Schema.Array(TeamPlanDependency),
};
const RevisionFields = {
  ...TaskContent,
  revision: Revision,
  confirmedRevision: Schema.NullOr(Revision),
  acceptance: TeamPlanAcceptance,
  executions: Schema.Array(TeamPlanExecutionRef),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};
export const TeamPlanTaskRevision = Schema.Struct(RevisionFields);
export type TeamPlanTaskRevision = typeof TeamPlanTaskRevision.Type;
export const TeamPlanTaskDraft = Schema.Struct({
  ...TaskContent,
  taskId: TrimmedNonEmptyString,
  priority: Schema.Int,
});
export type TeamPlanTaskDraft = typeof TeamPlanTaskDraft.Type;
export const TeamPlanTask = Schema.Struct({
  ...RevisionFields,
  taskId: TrimmedNonEmptyString,
  priority: Schema.Int,
  history: Schema.Array(TeamPlanTaskRevision),
});
export type TeamPlanTask = typeof TeamPlanTask.Type;
export const TeamPlan = Schema.Struct({
  threadId: ThreadId,
  version: PlanVersion,
  revision: Revision,
  goal: Schema.String,
  confirmedRevision: Schema.NullOr(Revision),
  dispatchPaused: Schema.optionalKey(Schema.Boolean),
  tasks: Schema.Array(TeamPlanTask),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamPlan = typeof TeamPlan.Type;

const SetGoal = Schema.Struct({ type: Schema.Literal("set_goal"), goal: TrimmedNonEmptyString });
const AddTask = Schema.Struct({ type: Schema.Literal("add_task"), task: TeamPlanTaskDraft });
const EditTask = Schema.Struct({
  type: Schema.Literal("edit_task"),
  taskId: TrimmedNonEmptyString,
  changes: Schema.Struct({
    title: Schema.optional(TrimmedNonEmptyString),
    prompt: Schema.optional(TrimmedNonEmptyString),
    role: Schema.optional(TrimmedNonEmptyString),
    modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
    dependencies: Schema.optional(Schema.Array(TeamPlanDependency)),
  }),
});
const Reprioritize = Schema.Struct({
  type: Schema.Literal("reprioritize"),
  taskId: TrimmedNonEmptyString,
  priority: Schema.Int,
});
const SetDependencies = Schema.Struct({
  type: Schema.Literal("set_dependencies"),
  taskId: TrimmedNonEmptyString,
  dependencies: Schema.Array(TeamPlanDependency),
});
const ConfirmPlan = Schema.Struct({ type: Schema.Literal("confirm_plan"), revision: Revision });
const ConfirmTask = Schema.Struct({
  type: Schema.Literal("confirm_task"),
  ...TeamPlanTaskRef.fields,
});
const SetDispatchPaused = Schema.Struct({
  type: Schema.Literal("set_dispatch_paused"),
  paused: Schema.Boolean,
});
const BindExecution = Schema.Struct({
  type: Schema.Literal("bind_execution"),
  ...TeamPlanTaskRef.fields,
  execution: TeamPlanExecutionRef,
});
const AcceptTaskFields = {
  type: Schema.Literal("accept_task"),
  ...TeamPlanTaskRef.fields,
  status: TeamPlanAcceptanceStatus,
  note: Schema.String,
};
const AgentAcceptTask = Schema.Struct(AcceptTaskFields);
const AcceptTask = Schema.Struct({ ...AcceptTaskFields, ...AcceptanceProvenance });
/** The server must verify owner, linked child and completed run before accepting an agent verdict. */
export const TeamPlanAgentOperation = Schema.Union([
  SetGoal,
  AddTask,
  EditTask,
  Reprioritize,
  SetDependencies,
  AgentAcceptTask,
]);
export type TeamPlanAgentOperation = typeof TeamPlanAgentOperation.Type;
export const TeamPlanOperation = Schema.Union([
  SetGoal,
  AddTask,
  EditTask,
  Reprioritize,
  SetDependencies,
  ConfirmPlan,
  ConfirmTask,
  BindExecution,
  SetDispatchPaused,
  AcceptTask,
]);
export type TeamPlanOperation = typeof TeamPlanOperation.Type;
export const TeamPlanPatch = Schema.Struct({
  expectedPlanVersion: PlanVersion,
  operations: Schema.Array(TeamPlanOperation).check(Schema.isMinLength(1)),
});
export type TeamPlanPatch = typeof TeamPlanPatch.Type;
