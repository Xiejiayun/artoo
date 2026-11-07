export type ImportedReviewPhase="before-verifier"|"reviewer"|"after-verifier";
/** Bookkeeping only: callers must confirm the actual phase's native/tool closure before confirm(). */
export function createImportedReviewClosure(){
  const phases:readonly ImportedReviewPhase[]=["before-verifier","reviewer","after-verifier"];
  let next=0,pending:ImportedReviewPhase|undefined;
  return {
    begin(phase:ImportedReviewPhase){if(pending!==undefined||phases[next]!==phase)throw Error("Imported review process phase is out of order");pending=phase;},
    confirm(phase:ImportedReviewPhase){if(pending!==phase)throw Error("Closure belongs to a different imported review process phase");pending=undefined;next++;},
    get pending(){return pending;},
    get closed(){return pending===undefined;},
  };
}
/** Negative result classification only; it cannot create reviewed evidence or writer authority. */
export async function finishImportedReviewFailure(closure:ReturnType<typeof createImportedReviewClosure>,error:unknown,closeReviewer?:()=>Promise<void>){
  let reason=error instanceof Error?error.message:"Imported review failed";
  if(closure.pending==="reviewer"&&closeReviewer){
    try{await closeReviewer();closure.confirm("reviewer");}
    catch(closureError){reason+=`; native closure unconfirmed: ${closureError instanceof Error?closureError.message:String(closureError)}`;}
  }
  return closure.closed
    ? {outcome:"failed" as const,closed:true as const,reason:reason.slice(0,2000)||"Imported review failed"}
    : {outcome:"uncertain" as const,closed:false as const,reason:reason.slice(0,2000)||"Imported review failed"};
}
