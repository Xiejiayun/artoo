// Pure original-object admission coordination. No process or disk evidence is
// fabricated by these tests; native/host settlement is validated separately.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerApplicationPublicationResources, registerApplicationPublicationVerifierResources,
  applicationPublicationRunResources, assertApplicationPublicationRunAdmission, assertApplicationPublicationResourcesIdle,
  claimApplicationPublicationResources, assertApplicationPublicationAuditAvailable, withApplicationPublicationAuditScope,
  beginApplicationPublicationOwner, setApplicationPublicationOwnerQuiescent, closeApplicationPublicationOwner,
  releaseApplicationPublicationResources } from "./application-publication-coordination.js";

function fixture() {
  const root = `C:\\coordination-fixture\\${randomUUID()}`, profile = {}, verifier = {};
  registerApplicationPublicationVerifierResources(verifier, [`${root}\\verification`]);
  registerApplicationPublicationResources(profile, { id: "profile", workspace: `${root}\\source`, verifier,
    directories: [`${root}\\deployment`, `${root}\\verification`] });
  return { root, profile, verifier };
}
describe("publication original resource and quiescence coordination", () => {
  it("rejects same-source and shared-store work while allowing unrelated profiles", () => {
    const f = fixture(), reservation = claimApplicationPublicationResources(f.profile);
    try {
      expect(() => assertApplicationPublicationRunAdmission([`${f.root.toUpperCase()}\\SOURCE\\nested`])).toThrow(/busy/);
      expect(() => assertApplicationPublicationRunAdmission(applicationPublicationRunResources(`${f.root}\\other`, f.verifier))).toThrow(/busy/);
      expect(() => assertApplicationPublicationRunAdmission([`${f.root}\\unrelated`])).not.toThrow();
      expect(() => claimApplicationPublicationResources(f.profile)).toThrow(/busy/);
    } finally { releaseApplicationPublicationResources(reservation); }
  });
  it("rejects publication while an existing related writer owns resources", () => {
    const f = fixture();
    expect(() => assertApplicationPublicationResourcesIdle(f.profile, [[`${f.root}\\source`]])).toThrow(/active run/);
    expect(() => assertApplicationPublicationResourcesIdle(f.profile, [[`${f.root}\\unrelated`]])).not.toThrow();
  });
  it("requires matching original scope and actual quiescence for every audit", async () => {
    const f = fixture(), reservation = claimApplicationPublicationResources(f.profile), owner = {};
    try {
      expect(() => assertApplicationPublicationAuditAvailable(f.profile)).toThrow(/quiescent/);
      await withApplicationPublicationAuditScope(reservation, async () => {
        assertApplicationPublicationAuditAvailable(f.profile);
        beginApplicationPublicationOwner(reservation, owner);
        expect(() => assertApplicationPublicationAuditAvailable(f.profile)).toThrow(/quiescent/);
        setApplicationPublicationOwnerQuiescent(reservation, owner, true);
        await Promise.resolve(); assertApplicationPublicationAuditAvailable(f.profile);
        setApplicationPublicationOwnerQuiescent(reservation, owner, false);
        expect(() => assertApplicationPublicationAuditAvailable(f.profile)).toThrow(/quiescent/);
        expect(() => releaseApplicationPublicationResources(reservation)).toThrow(/closure/);
        closeApplicationPublicationOwner(reservation, owner);
      });
    } finally { releaseApplicationPublicationResources(reservation); }
    expect(() => withApplicationPublicationAuditScope(reservation, () => {})).toThrow(/active publication reservation/);
  });
  it("cannot reenter another overlapping profile through the current scope", () => {
    const f = fixture(), other = {};
    registerApplicationPublicationResources(other, { id: "other", workspace: `${f.root}\\other`, verifier: {}, directories: [`${f.root}\\deployment`] });
    const reservation = claimApplicationPublicationResources(f.profile);
    try {
      expect(() => withApplicationPublicationAuditScope(reservation, () => assertApplicationPublicationAuditAvailable(other))).toThrow(/quiescent/);
    } finally { releaseApplicationPublicationResources(reservation); }
  });
});
