import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { resolveResearchRevisionOrigin } from "./research-revision-origin-service.js";
import { assertCurrentResearchHandoff, assertResearchHandoffDestinationOwner } from "./research-handoff-guard.js";
import { appendEvent, goalProductHandoffs as handoffs, goalProductHandoffOperations as operations, goalProductHandoffDeliveries as deliveries, goals, plans, tasks, devices, deviceTokens, agentInstances, computers, runs } from "@artoo/db";
import { ProductSourceHandoffIntentV1Schema, ProductSourceOperationV1Schema, ProductSourceOperationResultV1Schema,
  productSourceOperationDigestV1, productSourceTransferRequestDigestV2, canonicalProductSourceTransferValueV1 as canonical,
  inspectProductSourceOperationResultV1, PRODUCT_SOURCE_OPERATIONS_FEATURE_V1, TaskSpecSchema, type ProductSourceOperationV1 } from "@artoo/domain";
import { productSourceOperationAckSchema, productSourceOperationResultSchema, type NodeTransport, type ProductSourceOperationAck, type ProductSourceOperationResult, type ServerToNodeMessage } from "@artoo/protocol";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DrizzleDb } from "@artoo/storage";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { readContentAddressedBlob, requireArtifactStore, type ArtifactStorageOptions } from "../content-addressed-blob.js";
import { assertSemanticCapsuleResearch } from "../product-source-semantic-transfer-routes.js";
import { admitProductSourceSemanticTransferInTransaction, assertMeasurementV2TransferSessions, type AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { requireActiveMember } from "./member-status.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { unsettledGoalRunIds, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";

const sha=(value:string|Uint8Array)=>`sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash=(value:unknown)=>sha(canonical(value));
type Row=typeof handoffs.$inferSelect;
function actor(ctx:ServerContext,row:Pick<Row,"actorUserId">) {
  if(ctx.automationActor?.id!=="goal_runner"||ctx.actorUserId!==row.actorUserId) throw AppError.permissionDenied("Only the original user's goal runner owns this handoff");
}
function view(row:Row){return {transfer_id:row.id,qualified_receipt:row.qualifiedReceipt,stop_requested:row.stopRequested,
  state:row.stopRequested?"stopped_or_fenced":row.qualifiedReceipt?"qualified_receipt_waiting_target_review":"pending",execution_authorized:false,automatic_review_authorized:false} as const;}
async function permitsNextEffect(ctx:ServerContext,tx:DrizzleDb,intent:ReturnType<typeof ProductSourceHandoffIntentV1Schema.parse>,operationId?:string,admittingUnboundRevision=false){
  const base=intent.request.byte_request,[goal]=await tx.select().from(goals).where(and(eq(goals.id,base.goal_id),eq(goals.organizationId,ctx.organizationId))).for("update");
  if(!goal||goal.status!=="running"||goal.currentPlanId!==base.plan_id)throw AppError.conflict("Handoff requires the current running goal");
  await assertCurrentResearchHandoff(ctx,tx,intent,{admittingUnboundRevision});
  const {budgets}=supportedGoalPolicy(goal.budgets,goal.stopConditions);
  if(budgets.max_elapsed_ms!==null&&goal.runningSince!==null&&Math.max(0,Date.parse(ctx.clock.nowIso())-Date.parse(goal.runningSince))>=budgets.max_elapsed_ms)throw AppError.conflict("Goal elapsed time budget has been reached");
  if(budgets.max_retries!==null&&goal.retryCount>budgets.max_retries)throw AppError.conflict("Goal retry budget would be exceeded");
  const unresolved=(await unsettledStandaloneExecutions(ctx,tx,{goalId:base.goal_id})).filter(item=>item.kind!=="handoff"||item.id!==operationId);
  if(unresolved.some(item=>item.result!==null))throw AppError.conflict("Another operation has unconfirmed closure; keep its workspace fenced");
  if(budgets.max_concurrent_runs!==null){
    const runIds=new Set(await unsettledGoalRunIds(ctx,tx,base.goal_id));for(const item of unresolved)if(item.kind==="design")runIds.add(item.runId);
    const active=runIds.size+unresolved.filter(item=>item.kind!=="design").length;
    if(active>=budgets.max_concurrent_runs)throw AppError.conflict("Goal concurrent run limit has been reached");
  }
  const [next]=await tx.select().from(tasks).where(and(eq(tasks.id,intent.next_task_id),eq(tasks.organizationId,ctx.organizationId))).for("update");
  const [source]=await tx.select().from(tasks).where(eq(tasks.id,base.source.task_id)),[plan]=await tx.select().from(plans).where(eq(plans.id,base.plan_id));
  const sourceOrigin=source?await resolveResearchRevisionOrigin(ctx,tx,source):undefined;
  const sourceRef=sourceOrigin?.specRef??source?.sourcePlanSpecRef;
  const specs=Array.isArray(plan?.taskSpecs)?plan.taskSpecs:[],index=Number(next?.sourcePlanSpecRef),sourceIndex=Number(sourceRef);
  const spec=Number.isSafeInteger(index)?TaskSpecSchema.safeParse(specs[index]):null;
  if(!next||next.goalId!==base.goal_id||next.sourcePlanId!==base.plan_id||next.projectId!==base.project_id||next.status!=="ready"
    ||next.sourcePlanSpecRef===null||String(index)!==next.sourcePlanSpecRef||!source||sourceRef==null||String(sourceIndex)!==sourceRef
    ||!spec?.success||spec.data.development_stage!=="design"||!spec.data.dependencies.some(dependency=>dependency.ref===sourceRef&&["blocks","artifact_required"].includes(dependency.type)))
    throw AppError.conflict("Handoff requires its ready dependent design task in the accepted plan");
}
/** Opt-in scheduler primitive. It never assigns a next-stage task or changes legacy fixed workspace bindings. */
export async function ensureGoalProductHandoff(ctx:ServerContext,input:unknown) {
  const intent=ProductSourceHandoffIntentV1Schema.parse(input),request=intent.request,base=request.byte_request,digest=hash(intent);
  actor(ctx,{actorUserId:base.authorization.actor_user_id});
  return ctx.db.transaction(async tx=>{
    await admitProductSourceSemanticTransferInTransaction(ctx,tx,request);
    const [existing]=await tx.select().from(handoffs).where(eq(handoffs.id,base.transfer_id)).for("update");
    if(existing){if(existing.organizationId!==ctx.organizationId||existing.intentDigest!==digest||canonical(existing.intent)!==canonical(intent))throw AppError.conflict("Handoff ID is bound to another immutable intent");return view(existing);}
    await permitsNextEffect(ctx,tx,intent,undefined,true);
    await assertResearchHandoffDestinationOwner(ctx,tx,intent,{admittingUnboundRevision:true});
    const now=ctx.clock.nowIso();
    const [row]=await tx.insert(handoffs).values({id:base.transfer_id,organizationId:ctx.organizationId,goalId:base.goal_id,planId:base.plan_id,nextTaskId:intent.next_task_id,
      sourceRunId:base.source.run_id,actorUserId:base.authorization.actor_user_id,consentId:base.authorization.consent_id,policyVersion:base.authorization.policy_version,
      intentDigest:digest,intent,createdAt:now,updatedAt:now}).returning();
    for(const kind of ["upload","import_verify"] as const){const operation=ProductSourceOperationV1Schema.parse({version:1,operation_id:ctx.idGen.generate("sourceop"),kind,
      request_digest:productSourceTransferRequestDigestV2(request,sha),intent});
      await tx.insert(operations).values({id:operation.operation_id,handoffId:base.transfer_id,kind,computerId:kind==="upload"?base.source.node_id:base.destination.node_id,
        payloadDigest:productSourceOperationDigestV1(operation,sha),payload:operation,createdAt:now});}
    await appendEvent(tx,buildEvent(ctx,{type:"goal.product-handoff.created",actorType:"system",actorId:"goal_runner",correlationId:base.transfer_id,
      goalId:base.goal_id,projectId:base.project_id,payload:{transfer_id:base.transfer_id,intent_digest:digest,actor_user_id:base.authorization.actor_user_id}}));
    return view(row!);
  });
}
export async function requestGoalProductHandoffStop(ctx:ServerContext,id:string){return ctx.db.transaction(async tx=>{
  const [initial]=await tx.select().from(handoffs).where(and(eq(handoffs.id,id),eq(handoffs.organizationId,ctx.organizationId)));
  if(!initial)throw AppError.notFound("Handoff not found");actor(ctx,initial);
  await tx.select().from(goals).where(eq(goals.id,initial.goalId)).for("update");
  const [row]=await tx.update(handoffs).set({stopRequested:true,updatedAt:ctx.clock.nowIso()}).where(eq(handoffs.id,id)).returning();return view(row!);
});}

/** Cancellation keeps the existing request and result history; it never reassigns an ordinary run ID. */
export async function stopGoalProductHandoffs(ctx:ServerContext,goalId:string){
  const ids=await ctx.db.transaction(async tx=>{
    await tx.select().from(goals).where(and(eq(goals.id,goalId),eq(goals.organizationId,ctx.organizationId))).for("update");
    const rows=await tx.select().from(handoffs).where(and(eq(handoffs.goalId,goalId),eq(handoffs.organizationId,ctx.organizationId)));
    const pending:string[]=[];
    for(const row of rows){actor(ctx,row);await tx.update(handoffs).set({stopRequested:true,updatedAt:ctx.clock.nowIso()}).where(eq(handoffs.id,row.id));
      for(const operation of await tx.select().from(operations).where(eq(operations.handoffId,row.id)))
        if(ProductSourceOperationResultV1Schema.safeParse(operation.result).data?.closed!==true)pending.push(operation.id);
    }
    return pending;
  });
  for(const id of ids)await ctx.onProductSourceOperationQueued?.(id,"stop");return ids;
}

async function workspaceFence(ctx:ServerContext,tx:DrizzleDb,payload:ProductSourceOperationV1){
  const base=payload.intent.request.byte_request,node=payload.kind==="upload"?base.source:base.destination;
  const [source]=await tx.select().from(runs).where(and(eq(runs.id,base.source.run_id),eq(runs.organizationId,ctx.organizationId)));
  const instanceId=payload.kind==="upload"?source?.agentInstanceId:payload.intent.destination_start.agent_instance_id;
  if(!instanceId)throw AppError.conflict("Source operation instance is missing");
  const [instance]=await tx.select().from(agentInstances).where(and(eq(agentInstances.id,instanceId),eq(agentInstances.organizationId,ctx.organizationId))).for("update");
  if(instance&&instance.projectId!==base.project_id)throw AppError.conflict("Source operation instance no longer belongs to this project's squad");
  if(instance&&instance.computerId!==node.node_id)throw AppError.conflict("Source operation instance belongs to another computer");
  const [computer]=await tx.select().from(computers).where(and(eq(computers.id,node.node_id),eq(computers.organizationId,ctx.organizationId))).for("update");
  if(!computer||computer.status!=="online")throw AppError.conflict("Source operation computer is unavailable");
  if(payload.kind==="import_verify")await assertResearchHandoffDestinationOwner(ctx,tx,payload.intent);
  await assertSourceLineageDispatch(ctx,tx,node.node_id,node.workspace_root);
  const uncertain=new Set(await unconfirmedDisconnectRunIds(ctx,tx,{computerId:node.node_id}));
  const neighbors=await tx.select().from(runs).where(and(eq(runs.organizationId,ctx.organizationId),eq(runs.computerId,node.node_id)));
  if(neighbors.some(run=>(!['completed','failed','cancelled'].includes(run.status)||uncertain.has(run.id))
    &&(run.agentInstanceId===instanceId||!run.workspaceRoot||automationWorkspacesOverlap(run.workspaceRoot,node.workspace_root,computer.os))))
    throw AppError.conflict("Source operation agent or workspace has an active ordinary execution");
  const standalone=await unsettledStandaloneExecutions(ctx,tx,{computerId:node.node_id});
  if(standalone.some(item=>(item.kind!=="handoff"||item.id!==payload.operation_id)
    &&(item.participantInstanceIds.includes(instanceId)||automationWorkspacesOverlap(item.workspaceRoot,node.workspace_root,computer.os))))
    throw AppError.conflict("Source operation agent or workspace has another unsettled operation");
}

/** A current authenticated node transport owns this binding; never accept its identity/session from a frame. */
export function createGoalProductHandoffBinding(ctx:ServerContext,options:ArtifactStorageOptions & {identity:AuthenticatedTransferNode;sessionId:string;isCurrent:()=>boolean;transport:Pick<NodeTransport,"send">}) {
  const artifactStore = requireArtifactStore(options);
  const identity=Object.freeze({...options.identity}),computerId=identity.computerId;
  const current=()=>{if(!options.isCurrent())throw AppError.permissionDenied("Handoff node session is no longer current");};
  async function credential(tx:DrizzleDb){
    const [observed]=await tx.select().from(devices).where(and(eq(devices.id,identity.deviceId),eq(devices.organizationId,ctx.organizationId)));
    if(!observed)throw AppError.permissionDenied("Handoff node credential is no longer paired");
    await requireActiveMember(ctx,observed.enrolledByUserId,tx);
    const [device]=await tx.select().from(devices).where(and(eq(devices.id,identity.deviceId),eq(devices.organizationId,ctx.organizationId))).for("update");
    const [token]=await tx.select().from(deviceTokens).where(and(eq(deviceTokens.deviceId,identity.deviceId),eq(deviceTokens.organizationId,ctx.organizationId),
      eq(deviceTokens.tokenLookup,identity.tokenLookup),eq(deviceTokens.kind,"node"),eq(deviceTokens.status,"active"),isNull(deviceTokens.revokedAt))).for("update");
    current();
    if(!device||device.trust!=="active"||device.revokedAt!==null||device.computerId!==computerId||device.enrolledByUserId!==observed.enrolledByUserId
      ||!token||token.expiresAt!==null&&Date.parse(token.expiresAt)<=Date.parse(ctx.clock.nowIso()))throw AppError.permissionDenied("Handoff node credential is no longer paired");
  }
  async function load(tx:DrizzleDb,operationId:string){const [operation]=await tx.select().from(operations).where(eq(operations.id,operationId));
    const [handoff]=operation?await tx.select().from(handoffs).where(and(eq(handoffs.id,operation.handoffId),eq(handoffs.organizationId,ctx.organizationId))):[];
    if(!operation||!handoff||operation.computerId!==computerId)throw AppError.permissionDenied("Handoff operation belongs to another node");
    return {operation,handoff,payload:ProductSourceOperationV1Schema.parse(operation.payload)};}
  async function running(tx:DrizzleDb,record:Awaited<ReturnType<typeof load>>){
    actor(ctx,record.handoff);if(record.handoff.stopRequested)throw AppError.conflict("Handoff stop is retained");
    if(ProductSourceOperationResultV1Schema.safeParse(record.operation.result).data?.closed===false)throw AppError.conflict("Unconfirmed operation closure permits only status or stop");
    await admitProductSourceSemanticTransferInTransaction(ctx,tx,record.payload.intent.request);current();
    // Cancellation takes the goal fence before updating this row. Re-read after obtaining that fence.
    const [fenced]=await tx.select().from(handoffs).where(eq(handoffs.id,record.handoff.id)).for("update");
    if(!fenced||fenced.stopRequested)throw AppError.conflict("Handoff stop is retained");
    await permitsNextEffect(ctx,tx,record.payload.intent,record.operation.id);await workspaceFence(ctx,tx,record.payload);await credential(tx);
    // receive() does not take the goal fence and may settle this operation while admission waits.
    // Keep its device -> operation lock order, then hold the fresh result through dispatch.
    const [operation]=await tx.select().from(operations).where(eq(operations.id,record.operation.id)).for("update");
    if(!operation)throw AppError.conflict("Handoff operation disappeared");
    if(ProductSourceOperationResultV1Schema.safeParse(operation.result).data?.closed===false)throw AppError.conflict("Unconfirmed operation closure permits only status or stop");
    await credential(tx);
    assertMeasurementV2TransferSessions(ctx,record.payload.intent.request);
    if(ctx.supportsExecutionFeature?.(computerId,PRODUCT_SOURCE_OPERATIONS_FEATURE_V1)!==true)throw AppError.conflict("Current node lacks prepared operation support");
    return operation;
  }
  return {
    async dispatch(operationId:string,control:"start"|"stop"|"status"="start"){
      current();let command:ServerToNodeMessage;
      const record=await ctx.db.transaction(async tx=>{
        const initial=await load(tx,operationId);actor(ctx,initial.handoff);
        if(control==="start"){
          await running(tx,initial);
          if(initial.payload.kind==="import_verify"){
            const [upload]=await tx.select().from(operations).where(and(eq(operations.handoffId,initial.handoff.id),eq(operations.kind,"upload")));
            if(ProductSourceOperationResultV1Schema.safeParse(upload?.result).data?.outcome!=="uploaded")throw AppError.conflict("Destination waits for the bound upload result");
          }
        }else {if(control==="stop"&&!initial.handoff.stopRequested)throw AppError.conflict("Persist stop intent before sending cancellation");await credential(tx);}
        const [prior]=await tx.select().from(deliveries).where(and(eq(deliveries.operationId,operationId),eq(deliveries.sessionId,options.sessionId),eq(deliveries.control,control)));
        const delivery=prior??(await tx.insert(deliveries).values({id:ctx.idGen.generate("sourcedelivery"),operationId,sessionId:options.sessionId,control,createdAt:ctx.clock.nowIso()}).returning())[0]!;
        current();return {...initial,delivery};
      });
      current();
      const common={kind:"command" as const,id:record.delivery.id,idempotency_key:`${operationId}:${control}:${record.operation.payloadDigest}`};
      command=control==="start"?{...common,type:"product.source.operation.v1",payload:record.payload}
        :{...common,type:control==="stop"?"product.source.operation.stop.v1":"product.source.operation.status.v1",payload:{version:1,operation_id:operationId,payload_digest:record.operation.payloadDigest,request_digest:record.payload.request_digest}};
      // The immutable delivery is already committed. A read-only dispatch fence now rechecks every
      // live prerequisite and holds its locks while the transport enqueues the command.
      await ctx.db.transaction(async tx=>{const fresh=await load(tx,operationId);actor(ctx,fresh.handoff);
        if(control==="start")await running(tx,fresh);else await credential(tx);
        current();await options.transport.send(command);current();});return command;
    },
    async acknowledge(input:ProductSourceOperationAck){const ack=productSourceOperationAckSchema.parse(input);current();
      if(ack.node_id!==computerId)throw AppError.permissionDenied("ACK node differs");
      await ctx.db.transaction(async tx=>{await credential(tx);const {operation}=await load(tx,ack.payload.operation_id);
        const [delivery]=await tx.select().from(deliveries).where(and(eq(deliveries.id,ack.command_id),eq(deliveries.operationId,operation.id),eq(deliveries.sessionId,options.sessionId))).for("update");
        await credential(tx);if(!delivery||ack.payload.payload_digest!==operation.payloadDigest)throw AppError.conflict("ACK differs from the issued delivery");
        if(delivery.ack!==null&&canonical(delivery.ack)!==canonical(ack))throw AppError.conflict("ACK is immutable");
        if(delivery.ack===null)await tx.update(deliveries).set({ack}).where(eq(deliveries.id,delivery.id));await credential(tx);});
    },
    async receive(input:ProductSourceOperationResult){const message=productSourceOperationResultSchema.parse(input);current();
      if(message.node_id!==computerId)throw AppError.permissionDenied("Result node differs");
      await ctx.db.transaction(async tx=>{
        await credential(tx);
        const record=await load(tx,message.payload.operation_id),{operation,payload}=record;
        const [delivery]=await tx.select().from(deliveries).where(and(eq(deliveries.id,message.command_id),eq(deliveries.operationId,operation.id),eq(deliveries.sessionId,options.sessionId)));
        if(!delivery||message.payload.payload_digest!==operation.payloadDigest||message.payload.request_digest!==payload.request_digest)throw AppError.conflict("Result has no corresponding issued command");
        let research=new Uint8Array();
        if(message.payload.outcome==="verified"){
          const source=payload.intent.request.byte_request.source,bytes=await readContentAddressedBlob(artifactStore,source.capsule_digest,source.capsule_bytes);
          assertSemanticCapsuleResearch(bytes,payload.intent.request);
          const capsule=JSON.parse(bytes.toString("utf8")) as {files:{path:string;base64:string}[]};
          research=Buffer.from(capsule.files.find(file=>file.path===".artoo/product/research.json")!.base64,"base64");
        }
        const result=inspectProductSourceOperationResultV1(payload,message.payload,research,sha);await credential(tx);
        const [locked]=await tx.select().from(operations).where(eq(operations.id,operation.id)).for("update");
        await credential(tx);
        if(locked!.result!==null&&canonical(locked!.result)!==canonical(result))throw AppError.conflict("Operation result is immutable");
        if(locked!.result===null)await tx.update(operations).set({result}).where(eq(operations.id,operation.id));await credential(tx);
      });
      await ctx.db.transaction(async tx=>{await credential(tx);await options.transport.send({kind:"command",id:message.command_id,idempotency_key:`receipt:${message.command_id}`,type:"product.source.operation.receipt.v1",
        payload:{version:1,operation_id:message.payload.operation_id,payload_digest:message.payload.payload_digest},result_digest:hash(message.payload),status:"accepted"});current();});
    },
    async qualify(operationId:string){current();return ctx.db.transaction(async tx=>{
      const record=await load(tx,operationId),operation=await running(tx,record);
      const measured=ProductSourceOperationResultV1Schema.safeParse(operation.result).data;
      if(record.payload.kind!=="import_verify"||measured?.outcome!=="verified"||measured.fresh.verification.outcome!=="passed")throw AppError.conflict("Fresh destination receipt is not recorded");
      const [row]=await tx.update(handoffs).set({qualifiedReceipt:true,updatedAt:ctx.clock.nowIso()}).where(eq(handoffs.id,record.handoff.id)).returning();
      await credential(tx);assertMeasurementV2TransferSessions(ctx,record.payload.intent.request);return view(row!);
    });},
  };
}
