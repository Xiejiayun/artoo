import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import type { RunStartPayload } from "../../../packages/domain/dist/index.js";
import type { NodeToServerMessage } from "../../../packages/protocol/dist/index.js";
import { createNodeClient } from "../../../apps/artood/dist/node-client.js";
import { openLocalJournal, type FreshLaunchPermit, type JournalRun, type LiveDeliveryClaim } from "../../../apps/artood/dist/managed/journal.js";
import { absent, eventually, physicalFixture, observations, type SpawnObservation } from "./live.fixture.js";

const spawnObservation = vi.hoisted(() => ({ observer: undefined as SpawnObservation | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
    spawnObservation.observer?.(args[0], Array.isArray(args[1]) ? args[1] : [],
      (Array.isArray(args[1]) ? args[2] : args[1]) as SpawnOptions | undefined, child);
    return child;
  } };
});
type Fixture = Awaited<ReturnType<typeof physicalFixture>>;
async function withFixture(body: (f: Fixture) => Promise<void>, options: Parameters<typeof physicalFixture>[0] = {}) {
  const f = await physicalFixture(options); spawnObservation.observer = f.observe;
  let failure: unknown;
  try { await body(f); } catch (error) { failure = error; }
  try { await f.close(failure === undefined); }
  catch (error) { failure = failure === undefined ? error : new AggregateError([failure,error], "test and cleanup failed"); }
  finally { spawnObservation.observer = undefined; }
  if (failure !== undefined) throw failure;
}
const query = (f: Fixture, runId: string) => ({ expectedNamespace: f.journal.namespace, runId });
const isEvent = (m: NodeToServerMessage, type: string) => m.kind === "run.event" && m.event.type === type;
const terminalMessages = (f: Fixture) => f.exposed.filter((r) => r.message.kind === "run.event" && r.message.event.type === "run.lifecycle" && r.message.event.payload.phase !== "started");
function assertTerminalAfterPhysicalClosure(f: Fixture) {
  expect(terminalMessages(f).length).toBeGreaterThan(0);
  for (const row of terminalMessages(f)) {
    const processes = row.processes?.owned.filter((p) => p.role !== "git") ?? [];
    expect(processes.some((p) => p.role === "cli")).toBe(true);
    expect(processes.some((p) => p.role === "guardian")).toBe(true);
    for (const p of processes) expect(p).toMatchObject({ exitObserved: true, stdioCloseObserved: true, childAbsent: true, groupAbsent: true });
  }
}
async function closed(f: Fixture, payload: RunStartPayload) {
  const run = await f.journal.lookupRun(query(f,payload.run_id));
  expect(run).toMatchObject({ phase: "closed", receipt: { kind: "process_exit_confirmed" }, stopRequested: true });
  assertTerminalAfterPhysicalClosure(f); return run!;
}
function readRows(f: Fixture, runId: string) {
  const db = new DatabaseSync(join(f.journalOptions.directory,"journal.sqlite"), { readOnly: true, allowExtension: false });
  // Bounded inspection-only wait; the production worker retains its50ms policy.
  try { db.exec("PRAGMA busy_timeout=500"); return db.prepare("SELECT sequence,event_id,content_json,content_sha256,committed,attempts_json,role,deadline_tick_ms,clock_id FROM outbox WHERE namespace=? AND run_id=? ORDER BY sequence").all(f.journal.namespace,runId); }
  finally { db.close(); }
}

it("held writer streams started/output durably; actual post-exit answer/usage/artifact preserve full transformed content", async () => {
  let uploads = 0;
  await withFixture(async (f) => {
    const value = f.payload("complete"); f.start("start",value); expect(await f.channel.ack("start")).toMatchObject({ status: "accepted" });
    await eventually(() => existsSync(join(value.workspace.root,"ready")) && f.exposed.some((r) => isEvent(r.message,"run.output")));
    expect(f.records()).toHaveLength(1); expect(absent(f.records()[0]!.pid)).toBe(false);
    const before = readRows(f,value.run_id); expect(before.some((r) => JSON.parse(String(r.content_json)).type === "run.output")).toBe(true);
    expect(before.some((r) => ["run.answer","run.usage","artifact.created"].includes(JSON.parse(String(r.content_json)).type))).toBe(false);
    expect(terminalMessages(f)).toHaveLength(0);
    f.start("same-live",structuredClone(value)); expect(await f.channel.ack("same-live")).toMatchObject({ status: "accepted" });
    const changed = structuredClone(value); changed.context_pack.payload!.task.description = "changed";
    f.start("changed",changed); expect(await f.channel.ack("changed")).toMatchObject({ status: "rejected" });
    f.release(value); await f.finishDelivery(); const run = await closed(f,value);
    expect(JSON.parse(run.finalOutcomeJson!).terminal.payload.phase).toBe("completed"); expect(run.liveAbort).toBeNull();
    const rows = readRows(f,value.run_id); expect(rows.every((r) => r.committed === 1)).toBe(true);
    expect(rows.map((r) => r.sequence)).toEqual(rows.map((_r,i) => i));
    const events = rows.map((r) => JSON.parse(String(r.content_json)));
    expect(events).toContainEqual({ type: "run.answer", payload: { text: "fixture final answer" } });
    expect(events.find((e) => e.type === "run.usage").payload).toMatchObject({ input_tokens: 11, output_tokens: 7, provider_session_id: "fixture-session" });
    expect(events.find((e) => e.type === "artifact.created").payload).toMatchObject({ uri: "/fixture/artifacts/stable", metadata: { path: "new.bin", fixture_tag: "full body retained" } });
    expect(uploads).toBe(1); expect(f.records()).toHaveLength(1);
    f.start("same-finished",structuredClone(value)); expect(await f.channel.ack("same-finished")).toMatchObject({ status: "accepted" });
    expect(f.records()).toHaveLength(1);
    observations.push({ case: "live-flow-existing-emission-timing", before, rows, run, uploads,
      scope: "Started/output observed while real CLI alive. Canonical answer/usage/artifact are emitted during actual producer finish; upload is a fixture." });
  }, { artifact: true, uploadArtifact: async (_run,_root,event) => { uploads++; return { type: "artifact.created", payload: { ...event.payload, uri: "/fixture/artifacts/stable", metadata: { ...event.payload.metadata, fixture_tag: "full body retained" } } }; } });
});

it.each(["started","output","answer","usage","artifact"])("%s receipt rejection stops genuine execution before failed/incomplete settlement and never becomes user_cancelled", async (kind) => {
  await withFixture(async (f) => {
    const value = f.payload(`reject-${kind}`);
    f.rejectManaged((m) => m.kind === "run.event" && (kind === "started" ? m.event.type === "run.lifecycle" && m.event.payload.phase === "started"
      : m.event.type === (kind === "artifact" ? "artifact.created" : `run.${kind}`)));
    f.start("start",value); expect(await f.channel.ack("start")).toMatchObject({ status: "accepted" });
    if (!["started","output"].includes(kind)) { await eventually(() => existsSync(join(value.workspace.root,"ready"))); f.release(value); }
    await f.finishDelivery(); const run = await closed(f,value), final = JSON.parse(run.finalOutcomeJson!);
    expect(final.terminal.payload.phase).toBe("failed"); expect(final.terminal.payload.reason).not.toBe("user_cancelled");
    expect(final.retained.payload.outcome).toBe("incomplete_delivery"); expect(run.liveAbort).not.toBeNull();
    if (["started","output"].includes(kind)) {
      const rejected = f.exposed.find((r) => r.message.kind === "run.event" && (kind === "started" ? r.message.event.type === "run.lifecycle" : r.message.event.type === "run.output"))!;
      expect(rejected.processes?.owned.some((p) => p.role === "cli" && !p.childAbsent)).toBe(true);
    }
    expect(f.records()).toHaveLength(1); observations.push({ case: `rejected-${kind}`, run, rows: readRows(f,value.run_id), receiver: "explicit local rejected receipt fixture" });
  }, { artifact: true });
});

it("upload failure before append keeps its cause and confirms real closure before any terminal", async () => {
  let calls = 0;
  await withFixture(async (f) => {
    const value=f.payload("upload");f.start("start",value);await f.channel.ack("start");await eventually(()=>existsSync(join(value.workspace.root,"ready")));
    f.release(value);await f.finishDelivery();const run=await closed(f,value);
    expect(JSON.parse(run.finalOutcomeJson!).terminal.payload).toEqual({phase:"failed",reason:"fixture upload failed"});
    expect(f.exposed.some((r)=>isEvent(r.message,"artifact.created"))).toBe(false);expect(calls).toBe(1);
    observations.push({case:"upload-failure-fixture",run,calls});
  },{artifact:true,uploadArtifact:async()=>{calls++;throw new Error("fixture upload failed");}});
});

it("a real prior failed terminal retains its reason through metadata rejection",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("prior-failed");f.rejectManaged((m)=>isEvent(m,"run.workspace.retained"));
    f.start("start",value);await f.channel.ack("start");await eventually(()=>existsSync(join(value.workspace.root,"ready")));f.release(value);await f.finishDelivery();
    const run=await closed(f,value),outcome=JSON.parse(run.finalOutcomeJson!);
    expect(outcome.terminal.payload.phase).toBe("failed");expect(outcome.terminal.payload.reason).toContain("23");
    expect(outcome.terminal.payload.reason).not.toContain("delivery");expect(run.liveAbort).toBeNull();
    observations.push({case:"real-prior-failed-terminal",run});
  },{mode:"failed"});
});

it("an explicit user Stop stays cancelled and duplicates cannot launch another writer",async()=>{
  let heldClaim: Extract<LiveDeliveryClaim, { kind: "claimed" }> | undefined;
  let releaseClaim!: () => void;
  const gate = new Promise<void>((resolve) => { releaseClaim = resolve; });
  await withFixture(async(f)=>{
    try {
      const value=f.payload("cancel");f.start("start",value);await f.channel.ack("start");await eventually(()=>existsSync(join(value.workspace.root,"ready")));
      await eventually(() => heldClaim !== undefined);
      const claim = heldClaim!;
      expect(JSON.parse(claim.event.contentJson)).toEqual({ type: "run.lifecycle", payload: { phase: "started" } });
      const before = readRows(f,value.run_id).find((row) => row.sequence === claim.event.sequence)!;
      expect(before).toMatchObject({ committed: 0, event_id: claim.event.eventId, content_sha256: claim.event.contentSha256,
        deadline_tick_ms: claim.deadlineTickMs, clock_id: claim.clockId });
      expect(JSON.parse(String(before.attempts_json))).toEqual([{ id: claim.attemptId, revision: claim.revision,
        claimedTickMs: claim.deadlineTickMs - 30000, failure: null, accepted: false }]);
      expect(f.exposed).toEqual([]);

      // Stop the real writer while the committed claim has not reached the channel.
      f.stop("stop",value.run_id);expect(await f.channel.ack("stop")).toMatchObject({status:"accepted"});
      const physical = f.lifetimes.filter((row) => row.role !== "git");
      expect(physical.map((row) => row.role).sort()).toEqual(["cli", "guardian"]);
      for (const row of physical) expect(Boolean(row.closedAt && row.groupAbsentAt && row.pid && absent(row.pid))).toBe(true);
      expect(f.exposed).toEqual([]);
      releaseClaim();
      await f.finishDelivery();

      const run=await closed(f,value);
      expect(JSON.parse(run.finalOutcomeJson!).terminal.payload).toEqual({ phase: "cancelled", reason: "user_cancelled" });
      expect(terminalMessages(f)).toHaveLength(1);
      for (const { message } of terminalMessages(f)) expect(message).toMatchObject({ kind: "run.event", run_id: value.run_id,
        event: { type: "run.lifecycle", payload: { phase: "cancelled", reason: "user_cancelled" } } });
      expect(f.channel.committed.filter((message) => message.kind === "run.event" && message.run_id === value.run_id
        && message.event.type === "run.lifecycle" && message.event.payload.phase === "cancelled")).toHaveLength(1);
      const rows = readRows(f,value.run_id), original = rows.find((row) => row.sequence === claim.event.sequence)!;
      expect(original).toMatchObject({ event_id: before.event_id, content_json: before.content_json,
        content_sha256: before.content_sha256, deadline_tick_ms: before.deadline_tick_ms, clock_id: before.clock_id, committed: 1 });
      const attempts = JSON.parse(String(original.attempts_json));
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ id: claim.attemptId, failure: "transport_failure", accepted: false });
      expect(attempts[1]).toMatchObject({ accepted: true });
      expect(rows.every((row) => row.committed === 1)).toBe(true);
      f.start("replay",structuredClone(value));expect(await f.channel.ack("replay")).toMatchObject({status:"accepted"});expect(f.records()).toHaveLength(1);
      observations.push({case:"user-stop-distinct-from-delivery-stop",run,before,claim,rows,
        scope:"Real committed first claim held before channel invocation; real user Stop and physical closure precede release. No event, claim, receipt, or writer is synthesized."});
    } finally { releaseClaim(); }
  }, { afterLiveClaim: async (claim) => {
    if (claim.kind !== "claimed" || heldClaim) return;
    heldClaim = structuredClone(claim);
    await gate;
  } });
});

it("natural CLI/group exit between bridge and recordStarted still preserves the genuine receipt through held settlement",async()=>{
  let current:Fixture|undefined;let beforeStartup:unknown;let heldSettlement=false;let release!:()=>void;
  const barrier=new Promise<void>((resolve)=>{release=resolve;});
  await withFixture(async(f)=>{
    try {
    current=f;const value=f.payload("fast");f.start("start",value);expect(await f.channel.ack("start")).toMatchObject({status:"accepted"});
    await eventually(()=>heldSettlement);expect(terminalMessages(f)).toHaveLength(0);
    f.resume("resume-before-settle",value.run_id);expect(await f.channel.ack("resume-before-settle")).toMatchObject({status:"accepted"});
    f.stop("stop-before-settle",value.run_id);expect(await f.channel.ack("stop-before-settle")).toMatchObject({status:"accepted"});
    release();await f.finishDelivery();const run=await closed(f,value);expect(JSON.parse(run.finalOutcomeJson!).terminal.payload.phase).toBe("completed");
    observations.push({case:"natural-exit-before-recorded-start-with-retained-receipt",beforeStartup,run});
    } finally { release(); }
  },{beforeRecordStarted:async()=>{
    const f=current!;await eventually(()=>f.records().length===1);writeFileSync(join(f.records()[0]!.rawRoot,"release"),"natural exit before startup record");
    await eventually(()=>f.lifetimes.filter((p)=>p.role!=="git").every((p)=>!!p.closedAt&&!!p.pid&&absent(p.pid)&&absent(-p.pid)));
    beforeStartup=f.lifetimes.filter((p)=>p.role!=="git").map((p)=>({...p}));
  },beforeSettlement:async()=>{heldSettlement=true;await barrier;}});
});

it("a real live receipt timeout latches failure, stops the held writer, and late ACK cannot revive completion",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("timeout");f.holdManaged((m)=>isEvent(m,"run.output"));f.start("start",value);await f.channel.ack("start");
    await eventually(()=>f.held.length===1);expect(absent(f.records()[0]!.pid)).toBe(false);
    await f.finishDelivery();const run=await closed(f,value),original=run.finalOutcomeJson;
    expect(JSON.parse(original!).terminal.payload.phase).toBe("failed");expect(run.liveAbort?.code).toBe("receipt_timeout");
    f.releaseManaged();await eventually(()=>f.channel.committed.some((m)=>isEvent(m,"run.output")));
    // The receipt continuation can finish its journal write after receiver observation.
    let after:JournalRun|null=null;for(let i=0;i<100;i++){after=await f.journal.lookupRun(query(f,value.run_id));if(readRows(f,value.run_id).every((r)=>r.committed===1))break;await new Promise((resolve)=>setTimeout(resolve,10));}
    expect(after?.finalOutcomeJson).toBe(original);expect(after?.liveAbort).toEqual(run.liveAbort);
    f.resume("settled-resume",value.run_id);expect(await f.channel.ack("settled-resume")).toMatchObject({status:"rejected",error_code:"process_exited"});
    observations.push({case:"real-live-30s-deadline",run,after,rows:readRows(f,value.run_id)});
  });
});

it("journal loss while live still stops the captured producer; replacement worker/Node cannot adopt or create a terminal",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("unknown");f.holdManaged((m)=>isEvent(m,"run.output"));f.start("start",value);await f.channel.ack("start");await eventually(()=>f.held.length===1);
    await f.journal.close();f.releaseManaged();await f.client.stop(false);
    expect(terminalMessages(f)).toHaveLength(0);expect(f.lifetimes.filter((p)=>p.role!=="git").every((p)=>!!p.closedAt&&!!p.pid&&absent(p.pid)&&absent(-p.pid))).toBe(true);
    const reopened=await openLocalJournal(f.journalOptions);
    const cold=createNodeClient({nodeId:"computer_physical",transport:f.channel.transport,adapter:f.actualAdapter,workspace:f.workspace,ownedGit:f.ownedGit,
      managedJournal:{journal:reopened,channel:{...f.managedChannel,async exposeOnce(){throw new Error("Restart unknown must not expose a frame");}}}});
    try{
      const stored=await reopened.lookupRun({expectedNamespace:reopened.namespace,runId:value.run_id});expect(stored).toMatchObject({phase:"started",ownership:"unknown",receipt:{kind:"accepted"},finalOutcomeJson:null});
      expect(() => reopened.claimNextLiveDelivery({} as FreshLaunchPermit)).toThrow("exact live fresh");
      cold.start();f.resume("restart-resume",value.run_id);expect(await f.channel.ack("restart-resume")).toMatchObject({status:"rejected",error_code:"process_start_failed"});
      f.start("restart-start",structuredClone(value));expect(await f.channel.ack("restart-start")).toMatchObject({status:"rejected"});
      expect(f.records()).toHaveLength(1);expect(terminalMessages(f)).toHaveLength(0);
      observations.push({case:"actual-journal-worker-loss-and-node-replacement",stored,scope:"Real worker restart and new Node instance; not a new OS daemon process/adoption qualification"});
    }finally{await cold.stop(false);await reopened.close();}
  });
});

it("postsettlement retention rejection uses one durable correction after live events have committed",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("correction");f.rejectManaged((m)=>m.kind==="run.event"&&m.event.type==="run.workspace.retained"&&m.event.payload.outcome==="completed");
    f.start("start",value);await f.channel.ack("start");await eventually(()=>existsSync(join(value.workspace.root,"ready")));f.release(value);await f.finishDelivery();
    const run=await closed(f,value);expect(JSON.parse(run.finalOutcomeJson!).terminal.payload.phase).toBe("completed");
    const view=await f.journal.inspectClosedRunDelivery({expectedNamespace:f.journal.namespace,runId:run.runId,launchKey:run.launchKey!,physicalReceiptId:run.receipt!.id});
    expect(view).toMatchObject({revision:1,state:"delivered",possibleCompletedExposure:false});
    const rows=readRows(f,value.run_id);expect(rows.filter((r)=>String(r.role).startsWith("correction_"))).toHaveLength(2);
    const originalTerminal=rows.find((r)=>r.role==="original_terminal")!;expect(JSON.parse(String(originalTerminal.attempts_json))).toEqual([]);
    expect(terminalMessages(f).map((r)=>r.message.kind==="run.event"&&r.message.event.type==="run.lifecycle"?r.message.event.payload.phase:"invalid")).toEqual(["failed"]);
    const scope={expectedNamespace:f.journal.namespace,runId:run.runId,launchKey:run.launchKey!,physicalReceiptId:run.receipt!.id};
    const old=rows.find((row)=>row.role==="original_retention")!;const attempt=JSON.parse(String(old.attempts_json))[0];
    const receipt={sequence:Number(old.sequence),contentSha256:String(old.content_sha256),attemptId:String(attempt.id),status:"accepted" as const};
    const once=await f.journal.recordClosedRunEventReceipt(scope,receipt);const twice=await f.journal.recordClosedRunEventReceipt(scope,receipt);
    expect(once.committed).toBe(view.committed+1);expect(twice.committed).toBe(once.committed);expect(twice.superseded).toBe(view.superseded);expect(twice.correction).toEqual(view.correction);
    const repeated=await f.journal.recordClosedRunAttemptFailure(scope,{sequence:Number(old.sequence),attemptId:String(attempt.id),reason:"rejected"});
    expect(repeated).toEqual(twice);
    observations.push({case:"live-to-closed-single-correction",run,view,rows,once,twice,repeated});
  });
});

it("large labelled committed-history storage fixture does not consume active capacity or change live replay identity",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("history");f.holdManaged((m)=>isEvent(m,"run.output"));f.start("start",value);await f.channel.ack("start");await eventually(()=>f.held.length===1);
    const held=f.held[0]!.frame;expect(held.kind).toBe("run.event");
    const db=new DatabaseSync(join(f.journalOptions.directory,"journal.sqlite"),{allowExtension:false});let first=0;
    try{
      db.exec("BEGIN IMMEDIATE");first=Number(db.prepare("SELECT next_sequence FROM runs WHERE namespace=? AND run_id=?").get(f.journal.namespace,value.run_id)!.next_sequence);
      const insert=db.prepare("INSERT INTO outbox(namespace,node_id,run_id,sequence,event_id,content_json,content_sha256,committed,role) VALUES(?,?,?,?,?,?,?,1,'event')");
      for(let index=0;index<10000;index++){
        const body=JSON.stringify({type:"run.output",payload:{stream:"stdout",text:`labelled committed-history fixture ${index}`}});
        insert.run(f.journal.namespace,"computer_physical",value.run_id,first+index,`fixture:history:${index}`,body,createHash("sha256").update(body).digest("hex"));
      }
      db.prepare("UPDATE runs SET next_sequence=next_sequence+10000, committed_count=committed_count+10000 WHERE namespace=? AND run_id=?").run(f.journal.namespace,value.run_id);db.exec("COMMIT");
    }finally{db.close();}
    f.releaseManaged();f.release(value);await f.finishDelivery();const run=await closed(f,value);
    const view=await f.journal.inspectClosedRunDelivery({expectedNamespace:f.journal.namespace,runId:run.runId,launchKey:run.launchKey!,physicalReceiptId:run.receipt!.id});
    expect(view.state).toBe("delivered");expect(view.committed).toBeGreaterThan(10000);
    const verify=new DatabaseSync(join(f.journalOptions.directory,"journal.sqlite"),{readOnly:true,allowExtension:false});
    let actual:Record<string,unknown>|undefined;let original:Record<string,unknown>|undefined;
    try{actual=verify.prepare("SELECT count(*) AS total,sum(committed) AS committed,sum(superseded) AS superseded FROM outbox WHERE namespace=? AND run_id=?").get(f.journal.namespace,value.run_id);
      original=verify.prepare("SELECT sequence,content_sha256,attempts_json FROM outbox WHERE namespace=? AND run_id=? AND sequence=?").get(f.journal.namespace,value.run_id,held.kind==="run.event"?held.sequence:-1);
    }finally{verify.close();}
    expect(actual).toMatchObject({total:view.committed,committed:view.committed,superseded:view.superseded});
    const receipt={sequence:Number(original!.sequence),contentSha256:String(original!.content_sha256),attemptId:String(JSON.parse(String(original!.attempts_json))[0].id),status:"accepted" as const};
    const scope={expectedNamespace:f.journal.namespace,runId:run.runId,launchKey:run.launchKey!,physicalReceiptId:run.receipt!.id};
    const duplicate=await f.journal.recordClosedRunEventReceipt(scope,receipt);expect(duplicate.committed).toBe(view.committed);expect(duplicate.superseded).toBe(view.superseded);
    expect(f.exposed.filter((r)=>r.message.kind==="run.event"&&held.kind==="run.event"&&r.message.sequence===held.sequence)).toHaveLength(1);
    observations.push({case:"large-history-storage-fixture",firstSeedSequence:first,seededCommittedRows:10000,view,run,
      scope:"Storage volume fixture only: these10000 rows are not claimed real transport/server ACKs or physical proof. Actual live frame identity/active capacity verified separately."});
  });
});

it("a copied producer is rejected before any execution or fake durable startup",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("copied");f.start("start",value);expect(await f.channel.ack("start")).toMatchObject({status:"rejected"});
    expect(f.records()).toEqual([]);expect(f.lifetimes.filter((p)=>p.role!=="git")).toEqual([]);
    expect(await f.journal.lookupRun(query(f,value.run_id))).toBeNull();expect(terminalMessages(f)).toEqual([]);
    observations.push({case:"copied-canonical-producer-rejected",actualWriters:0});
  },{copiedAdapter:true,expectedWriters:0});
});

it("durable Stop-before-start fences repeated managed starts without inventing accepted startup",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("fenced");f.stop("stop",value.run_id);expect(await f.channel.ack("stop")).toMatchObject({status:"accepted"});
    f.start("start",value);expect(await f.channel.ack("start")).toMatchObject({status:"rejected"});
    f.stop("stop-again",value.run_id);expect(await f.channel.ack("stop-again")).toMatchObject({status:"accepted"});
    f.start("start-again",structuredClone(value));expect(await f.channel.ack("start-again")).toMatchObject({status:"rejected"});
    const run=await f.journal.lookupRun(query(f,value.run_id));expect(run).toMatchObject({phase:"closed",receipt:{kind:"run_fenced_unbound"},finalOutcomeJson:null});
    expect(f.records()).toEqual([]);expect(f.lifetimes.filter((p)=>p.role!=="git")).toEqual([]);expect(f.exposed).toEqual([]);
    observations.push({case:"durable-no-launch-fence",run,actualWriters:0});
  },{expectedWriters:0});
});

it("one possible transport exposure retries the same durable frame within the unchanged deadline",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("transport-retry");f.failManagedOnce((m)=>isEvent(m,"run.output"));
    f.start("start",value);await f.channel.ack("start");await eventually(()=>f.exposed.filter((r)=>isEvent(r.message,"run.output")).length>=2);
    expect(absent(f.records()[0]!.pid)).toBe(false);f.release(value);await f.finishDelivery();const run=await closed(f,value);
    const rows=readRows(f,value.run_id);const retried=rows.filter((r)=>JSON.parse(String(r.attempts_json)).length===2);expect(retried).toHaveLength(1);
    const row=retried[0]!,attempts=JSON.parse(String(row.attempts_json));expect(attempts[0].failure).toBe("transport_failure");expect(attempts[1].accepted).toBe(true);
    expect(attempts[1].claimedTickMs).toBeGreaterThan(attempts[0].claimedTickMs);expect(row.deadline_tick_ms).toBe(attempts[0].claimedTickMs+30000);
    const exposures=f.exposed.filter((r)=>r.message.kind==="run.event"&&r.message.sequence===row.sequence);expect(exposures).toHaveLength(2);expect(exposures[1]!.message).toEqual(exposures[0]!.message);
    expect(JSON.parse(run.finalOutcomeJson!).terminal.payload.phase).toBe("completed");expect(run.liveAbort).toBeNull();
    observations.push({case:"same-durable-frame-transport-retry",row,exposures,run,fixture:"One explicitly injected transport failure after possible exposure"});
  });
});

it("a held10s startup control ACK stops the genuine writer before any failed terminal",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("control-timeout");f.channel.holdWhen((m)=>m.kind==="command.ack"&&m.command_id==="start");
    f.start("start",value);await f.channel.ack("start");await eventually(()=>f.records().length===1&&existsSync(join(value.workspace.root,"ready")));
    expect(absent(f.records()[0]!.pid)).toBe(false);expect(f.exposed).toEqual([]);
    await f.finishDelivery();const run=await closed(f,value),original=run.finalOutcomeJson;
    expect(JSON.parse(original!).terminal.payload.phase).toBe("failed");expect(JSON.parse(original!).terminal.payload.reason).not.toBe("user_cancelled");
    expect(run.liveAbort).not.toBeNull();f.channel.release();expect((await f.journal.lookupRun(query(f,value.run_id)))!.finalOutcomeJson).toBe(original);
    observations.push({case:"actual-held10s-control-ack",run,fixture:"Held local control receipt; no real socket/server ACK"});
  });
});

it("genuine spawned startup cancellation can resume closed pending delivery without an execution handle",async()=>{
  await withFixture(async(f)=>{
    const value=f.payload("startup-pending");let stopIssued=false;
    f.holdManaged((m)=>m.kind==="run.event"&&m.event.type==="run.lifecycle"&&m.event.payload.phase==="cancelled");
    f.onSpawn((command,args)=>{if(!stopIssued&&command===process.execPath&&args[0]==="-e"){stopIssued=true;f.stop("startup-stop",value.run_id);}});
    f.start("start",value);expect(await f.channel.ack("start")).toMatchObject({status:"rejected"});expect(await f.channel.ack("startup-stop")).toMatchObject({status:"accepted"});
    await eventually(()=>f.held.length===1);const run=await f.journal.lookupRun(query(f,value.run_id));expect(run).toMatchObject({phase:"closed",receipt:{kind:"process_exit_confirmed"}});
    expect(JSON.parse(run!.receipt!.contentJson).detail).toMatchObject({proofSource:"startup_error",producer:{facts:{childSpawned:true}}});
    expect(readRows(f,value.run_id).some((row)=>JSON.parse(String(row.content_json)).payload.phase==="started")).toBe(false);
    f.resume("closed-pending-resume",value.run_id);expect(await f.channel.ack("closed-pending-resume")).toMatchObject({status:"accepted"});
    f.start("replay",structuredClone(value));expect(await f.channel.ack("replay")).toMatchObject({status:"rejected"});
    expect(f.lifetimes.filter((p)=>p.role==="cli")).toHaveLength(1);assertTerminalAfterPhysicalClosure(f);
    f.releaseManaged();await f.finishDelivery();f.resume("closed-delivered-resume",value.run_id);expect(await f.channel.ack("closed-delivered-resume")).toMatchObject({status:"rejected",error_code:"process_exited"});
    observations.push({case:"real-startup-error-closed-pending-resume",run,stopIssued,programLaunches:f.records(),scope:"Real CLI and guardian spawned; cancellation may precede fixture program entry. No fake startup error or closure receipt."});
  },{expectProgramLaunch:false});
});

it("a labelled failure after real recordStarted commit retains the genuine handle until pending delivery drains",async()=>{
  let current:Fixture|undefined;let actualStarted:JournalRun|null=null;
  await withFixture(async(f)=>{
    current=f;const value=f.payload("startup-return-failure");
    f.holdManaged((m)=>m.kind==="run.event"&&m.event.type==="run.lifecycle"&&m.event.payload.phase==="failed");
    f.start("start",value);expect(await f.channel.ack("start")).toMatchObject({status:"rejected"});
    await eventually(()=>f.held.length===1);const run=await closed(f,value);
    expect(actualStarted).toMatchObject({phase:"started",receipt:{kind:"accepted"}});
    expect(JSON.parse(run.receipt!.contentJson).detail).toMatchObject({proofSource:"returned_handle",producer:{facts:{childSpawned:true}}});
    expect(JSON.parse(run.finalOutcomeJson!).terminal.payload).toEqual({phase:"failed",reason:"fixture failure after actual recordStarted commit"});
    f.resume("pending-resume",value.run_id);expect(await f.channel.ack("pending-resume")).toMatchObject({status:"accepted"});
    f.stop("closed-stop",value.run_id);expect(await f.channel.ack("closed-stop")).toMatchObject({status:"accepted"});
    expect(f.records()).toHaveLength(1);f.releaseManaged();await f.finishDelivery();
    f.resume("delivered-resume",value.run_id);expect(await f.channel.ack("delivered-resume")).toMatchObject({status:"rejected",error_code:"process_exited"});
    observations.push({case:"labelled-post-recordStarted-return-failure",actualStarted,run,fixture:"The real underlying recordStarted commits before a wrapper throws. Process handle, stop proof and journal settlement are genuine."});
  },{afterRecordStarted:async()=>{
    const f=current!;await eventually(()=>f.records().length===1&&existsSync(join(f.records()[0]!.rawRoot,"ready")));
    actualStarted=await f.journal.lookupRun(query(f,"run_startup-return-failure"));
    throw new Error("fixture failure after actual recordStarted commit");
  }});
});

afterAll(()=>{
  const directory=process.env["ARTOO_NODE_PHYSICAL_REPORT_DIR"];if(!directory)throw new Error("Owned report directory required");
  writeFileSync(join(directory,"live-observations.json"),JSON.stringify({scope:"Real producer/Node/journal; channel/upload fixtures explicitly labelled",observations},null,2)+"\n");
});
