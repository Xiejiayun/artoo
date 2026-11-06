import {describe,it,expect,vi} from "vitest";
import {createImportedReviewClosure,finishImportedReviewFailure} from "./imported-review-closure.js";
describe("imported review closure attribution (controlled process facts, no native execution)",()=>{
  it("does not let a closed reviewer cover uncertain after-verifier closure",()=>{
    const state=createImportedReviewClosure();state.begin("before-verifier");state.confirm("before-verifier");state.begin("reviewer");state.confirm("reviewer");
    state.begin("after-verifier");expect(state.closed).toBe(false);expect(state.pending).toBe("after-verifier");
    expect(()=>state.confirm("reviewer")).toThrow("different");expect(state.closed).toBe(false);expect(state.pending).toBe("after-verifier");
  });
  it("requires each actual process phase to close before the next starts",()=>{
    const state=createImportedReviewClosure();state.begin("before-verifier");expect(()=>state.begin("reviewer")).toThrow("out of order");
    state.confirm("before-verifier");state.begin("reviewer");expect(()=>state.confirm("after-verifier")).toThrow("different");state.confirm("reviewer");
    state.begin("after-verifier");state.confirm("after-verifier");expect(state.closed).toBe(true);
  });
  it("classifies an after-verifier exception as uncertain without reusing the already closed reviewer",async()=>{
    const state=createImportedReviewClosure();state.begin("before-verifier");state.confirm("before-verifier");state.begin("reviewer");state.confirm("reviewer");state.begin("after-verifier");
    const oldReviewerClosure=vi.fn(async()=>{});
    expect(await finishImportedReviewFailure(state,Error("Controlled after-verifier closure unknown"),oldReviewerClosure))
      .toEqual({outcome:"uncertain",closed:false,reason:"Controlled after-verifier closure unknown"});
    expect(oldReviewerClosure).not.toHaveBeenCalled();expect(state.closed).toBe(false);
  });
  it("can classify a reviewer failure as closed only after its own closure succeeds",async()=>{
    const state=createImportedReviewClosure();state.begin("before-verifier");state.confirm("before-verifier");state.begin("reviewer");
    const close=vi.fn(async()=>{});expect(await finishImportedReviewFailure(state,Error("Controlled review failure"),close)).toMatchObject({outcome:"failed",closed:true});
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("retains unconfirmed reviewer closure on a failed stop",async()=>{
    const state=createImportedReviewClosure();state.begin("before-verifier");state.confirm("before-verifier");state.begin("reviewer");
    expect(await finishImportedReviewFailure(state,Error("Controlled review failure"),async()=>{throw Error("Controlled Job still open");}))
      .toMatchObject({outcome:"uncertain",closed:false,reason:expect.stringContaining("Job still open")});expect(state.closed).toBe(false);
  });
});
