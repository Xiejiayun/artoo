import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";

export interface ParentGuardReceipt {
  readonly version: 1;
  readonly pid: number | null;
  readonly spawned: boolean;
  readonly exitObserved: boolean;
  readonly closeObserved: boolean;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly groupAbsentObserved: boolean;
  readonly disarmRequested: boolean;
  readonly cleanupConfirmed: boolean;
}
export interface ParentGuardedProcess extends EventEmitter {
  pid: number | undefined;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** A guardian lost after dispatch can have launched a child whose PID was not delivered. */
  cleanupUncertain: boolean;
  closeGuard(commandClosureConfirmed: boolean): Promise<ParentGuardReceipt>;
}

// The guardian establishes the daemon-lifetime IPC before launching the command.
// Unlike spawning a guard after the verifier, this leaves no unguarded launch window.
// Command stdout/stderr are data; process facts travel over a separate private IPC fd
// which is not inherited by the command. No workspace string becomes JavaScript.
const PARENT_GUARD = String.raw`
const {spawn}=require('node:child_process');
let child, launched=false, childSpawned=false, childExited=false, childClosed=false;
let cleaning=false, disarmed=false, groupAbsent=false, timer, start=0, killed=false;
const send=(message)=>{if(process.connected)try{process.send(message,()=>{});}catch{cleanup();}};
function probe(){
  if(groupAbsent)return true;
  if(!child?.pid)return childClosed;
  try{process.kill(-child.pid,0);return false;}catch(error){if(error.code==='ESRCH'){groupAbsent=true;return true;}return false;}
}
function signal(name){if(!childSpawned||probe())return;try{process.kill(-child.pid,name);}catch(error){if(error.code==='ESRCH')groupAbsent=true;}}
function exitGuard(status){clearTimeout(timer);process.exitCode=status;if(process.connected)process.disconnect();}
function poll(){
  if(!child){exitGuard(0);return;}
  const absent=probe();
  if(childClosed&&(!childSpawned||childExited)&&absent){exitGuard(0);return;}
  const elapsed=Date.now()-start;
  if(childSpawned&&!killed&&elapsed>=1000){killed=true;signal('SIGKILL');}
  if(elapsed>=5000){exitGuard(1);return;}
  timer=setTimeout(poll,10);
}
function cleanup(){
  if(disarmed||cleaning)return;cleaning=true;start=Date.now();
  // A closed downstream pipe can leave the command's pipe paused by relay
  // backpressure. Drain without forwarding so actual ChildProcess close can fire.
  child?.stdout.resume();child?.stderr.resume();
  signal('SIGTERM');poll();
}
process.on('disconnect',cleanup);
process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup);
process.stdout.on('error',cleanup);process.stderr.on('error',cleanup);
function relay(source,target){
  source.on('data',chunk=>{if(cleaning)return;if(!target.write(chunk))source.pause();});
  target.on('drain',()=>{if(!cleaning)source.resume();});
  source.on('error',()=>{send({kind:'stream_error'});cleanup();});
}
process.on('message',message=>{
  if(message?.kind==='disarm'){
    // The daemon already measured the command group's absence. Never signal that
    // numeric group again after that observation, including after PID reuse.
    if(!childClosed||(!childExited&&childSpawned)){send({kind:'protocol_error'});cleanup();return;}
    groupAbsent=true;disarmed=true;exitGuard(0);return;
  }
  if(message?.kind!=='launch'||launched||cleaning){send({kind:'protocol_error'});cleanup();return;}
  launched=true;
  try{child=spawn(message.executable,message.args,{cwd:message.cwd,env:message.env,detached:true,shell:false,stdio:['ignore','pipe','pipe']});}
  catch(error){childClosed=true;send({kind:'error',code:error.code||'UNKNOWN',not_started:true});send({kind:'close',code:null,signal:null});return;}
  child.on('spawn',()=>{childSpawned=true;send({kind:'spawn',pid:child.pid});if(cleaning)signal('SIGTERM');});
  child.on('error',error=>{send({kind:'error',code:error.code||'UNKNOWN',not_started:!childSpawned&&!child.pid});});
  child.on('exit',(code,signal)=>{childExited=true;send({kind:'exit',code,signal});});
  child.on('close',(code,signal)=>{childClosed=true;send({kind:'close',code,signal});if(cleaning){clearTimeout(timer);poll();}});
  relay(child.stdout,process.stdout);relay(child.stderr,process.stderr);
});
send({kind:'ready'});
`;

/** Observations come from the trusted guardian's real ChildProcess events, not command output. */
export function spawnParentGuardedProcess(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): ParentGuardedProcess {
  const guardian: ChildProcess = spawn(process.execPath, ["-e", PARENT_GUARD], { cwd, detached: true, shell: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" } });
  if (!guardian.stdout || !guardian.stderr) throw new Error("Parent guardian pipes are unavailable");
  let guardSpawned = false, guardExited = false, guardClosed = false, status: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let guardAbsent = false, disarmRequested = false, launchDispatched = false, targetExited = false, targetClosed = false, failed = false;
  let closePromise: Promise<ParentGuardReceipt> | undefined;
  const handle = Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined, stdout: guardian.stdout, stderr: guardian.stderr, cleanupUncertain: false,
    closeGuard(commandClosureConfirmed: boolean): Promise<ParentGuardReceipt> {
      return closePromise ??= (async () => {
        if (commandClosureConfirmed && targetClosed && guardian.connected) {
          disarmRequested = true;
          try { guardian.send?.({ kind: "disarm" }, () => {}); } catch { guardian.disconnect(); }
        } else if (guardian.connected) guardian.disconnect(); // EOF invokes the guardian's own bounded cleanup.
        const until = performance.now() + 6000;
        while (performance.now() < until) {
          if (guardClosed) {
            if (guardian.pid === undefined) guardAbsent = !guardSpawned;
            else if (!guardAbsent) {
              try { process.kill(-guardian.pid, 0); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") guardAbsent = true; }
            }
            if (guardAbsent) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return Object.freeze({ version: 1, pid: guardian.pid ?? null, spawned: guardSpawned, exitObserved: guardExited,
          closeObserved: guardClosed, status, signal: exitSignal, groupAbsentObserved: guardAbsent, disarmRequested,
          cleanupConfirmed: guardClosed && guardAbsent && (!guardSpawned || guardExited) && !handle.cleanupUncertain });
      })();
    },
  });
  function failure(code: string): void {
    if (failed || targetClosed) return; failed = true;
    if (launchDispatched && handle.pid === undefined) handle.cleanupUncertain = true;
    const error = Object.assign(new Error("Parent guardian lost command ownership"), { code });
    handle.emit("error", error);
    // Do not synthesize a command close event when only the guardian closed.
    // The owner will time out conservatively if the command's status is unknown.
  }
  guardian.on("spawn", () => { guardSpawned = true; });
  guardian.on("error", (error: NodeJS.ErrnoException) => failure(error.code ?? "UNKNOWN"));
  guardian.on("exit", (code, signal) => {
    guardExited = true; status = code; exitSignal = signal;
    if (!targetClosed) failure("GUARD_EXITED");
  });
  guardian.on("close", (code, signal) => { guardClosed = true; status ??= code; exitSignal ??= signal; if (!targetClosed) failure("GUARD_CLOSED"); });
  guardian.on("message", (value: unknown) => {
    if (!value || typeof value !== "object") { failure("GUARD_PROTOCOL"); return; }
    const message = value as { kind?: string; pid?: unknown; code?: unknown; signal?: unknown; not_started?: unknown };
    if (message.kind === "ready" && !launchDispatched && !failed) {
      launchDispatched = true;
      try { guardian.send?.({ kind: "launch", executable, args, cwd, env }, (error) => { if (error) failure((error as NodeJS.ErrnoException).code ?? "GUARD_IPC"); }); }
      catch { failure("GUARD_IPC"); }
    } else if (message.kind === "spawn" && !handle.pid && Number.isSafeInteger(message.pid) && (message.pid as number) > 1) {
      handle.pid = message.pid as number; handle.emit("spawn");
    } else if (message.kind === "exit" && handle.pid && !targetExited
      && (message.code === null || Number.isInteger(message.code)) && (message.signal === null || typeof message.signal === "string")) {
      targetExited = true; handle.emit("exit", message.code, message.signal);
    } else if (message.kind === "close" && !targetClosed
      && (message.code === null || Number.isInteger(message.code)) && (message.signal === null || typeof message.signal === "string")) {
      targetClosed = true; handle.emit("close", message.code, message.signal);
    } else if (message.kind === "error" && typeof message.code === "string") {
      if (message.not_started === true && !handle.pid) launchDispatched = false;
      handle.emit("error", Object.assign(new Error("Guarded command failed to spawn"), { code: message.code }));
    } else failure("GUARD_PROTOCOL");
  });
  return handle;
}
