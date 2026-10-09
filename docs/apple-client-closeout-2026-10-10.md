# Apple client E2E — closeout, 2026-10-10

This is the user-requested consolidation of the work since main
`013c1122dae489ca9cb5c793b04fa3aabb051933` into one new main commit. It includes
the changes from `ebef45d0fe2b9ab3b7d4b27a4cc1cd97aa772a35` and
`877f45f2a50a474e4727dc10964f043e653144b7`, plus this verification record.
Further feature development stops at this closeout. Commercial release
acceptance remains open.

## Included changes

- Pairing visibility uses one public accessibility snapshot per observation
  and the device-name field's nearest owning Form. The system editing menu
  can no longer be mistaken for that Form. Twelve unit cases cover the
  observed regression, ambiguity, clipping and invalid geometry.
- Correction and retention UI tests confirm that Manual is selected before
  searching for an execution instance. A single measured retry is allowed
  only while Auto remains explicitly selected and the same Manual control
  is enabled, hittable and fully visible. The selection observations are
  retained as an XCTest attachment.
- Product UI and execution behavior are unchanged. The existing pairing
  timeout, stability, full-field visibility, keyboard bounds and Done target
  checks remain in force; assignment/business assertions are preserved.

## Verification at closeout

| Source / gate | Observed result |
| --- | --- |
| Main `013c112`, real mixed writer | 2/2 cases passed: seven real program entries and CLI/guardian pairs, eight duplicate/mutated deliveries, 244 process records; source/runtime stability and owned cleanup passed. |
| Main `013c112`, journal-worker failure | 2/2 cases and all 27 final checks passed: four real journal workers, two actual worker terminations, idle and active automatic closure observed before the test joins Stop. This does not establish main IPC or installed-client failure recovery. |
| Main `013c112`, hosted run [37731512802](https://github.com/Xiejiayun/artoo/actions/runs/37731512802) | Mac/shared passed; iOS failed after 159 passing units and 0/7 Core cases. Mac had 23 client checks, 14 cleanup flags and 57 distinct workflow PNGs, plus eight recovery checks/two browser PNGs. Installed journal preparation and cold restart passed with allocation disabled. |
| Pairing candidate `ebef45d`, hosted run [37950454220](https://github.com/Xiejiayun/artoo/actions/runs/37950454220) | Mac/shared passed. iOS: 171/171 units, Core 7/7, Assistant 1/1 and Mentions 1/1 passed; Correction 0/1 failed and Retention did not start. The aggregate remains failed. |
| Assignment candidate `877f45f`, local compilation | Release UI build-for-testing and 67 report/suite contracts passed with unchanged source. The preceding pairing candidate also passed Debug unit and Release UI builds. These compilation checks did not execute native tests. |
| Assignment candidate `877f45f`, hosted run [37963417425](https://github.com/Xiejiayun/artoo/actions/runs/37963417425) | At 2026-10-09 17:10 UTC (2026-10-10 01:10 Shanghai), Mac passed; iOS and shared were still running; installed Windows was skipped. No full candidate E2E acceptance is claimed. |
| Squashed main staging tree | Byte-identical to candidate `877f45f` before adding this document; all 67 report/suite contracts passed again, with source unchanged. |

In run 37950454220, Correction failed while finding the instance control for
its first assignment. Its original diagnostic image and hierarchy show Auto
selected, Manual unselected and the worktree toggle enabled. The reason the
earlier Manual tap did not retain selection is unqualified. The second
candidate adds a state check and bounded retry; its full native result was
still pending at closeout. Neither a squash nor an earlier passing subset
certifies the final main commit's complete E2E.

## Retained HTML and photographic evidence

Generated reports and original media remain outside Git, in the local
artifact directories below and in their corresponding hosted workflow
artifacts. Prior failures retain their own source and result. No new local
client E2E was started solely for this closeout.

- Main Mac: `artifacts/preview-gate/apple-ci-fixes-delivery-prep/finalized/hosted-37731512802/mac-review/report.html`.
- Main iOS failure: `artifacts/preview-gate/apple-ci-fixes-delivery-prep/finalized/hosted-37731512802/ios-review/reviews/20261009T145732Z-f30b8fa2/report.html` — zero native PNGs, one actual browser PNG.
- Pairing candidate Mac: `artifacts/preview-gate/apple-ci-fixes-delivery-prep/finalized/hosted-37950454220/mac-review/report.html` — 57 workflow captures / 56 distinct PNGs, plus two recovery photos; the duplicate is disclosed.
- Pairing candidate iOS: `artifacts/preview-gate/apple-ci-fixes-delivery-prep/finalized/hosted-37950454220/ios-review/reviews/20261009T165941Z-5dec0a9d/report.html` — 44 distinct original PNGs: 40 native and four browser. All five contact sheets were visually reviewed; the original Correction failure image was also inspected. `VISUAL-REVIEW.json` records this scope without changing the failed result.
- Mixed writer: `artifacts/managed-workspaces/attempt-20261009T151415Z-mixed-def9e86b/report.html`.
- Journal failure: `artifacts/managed-workspaces/attempt-20261009T152526Z-mixed-failure-257c5fd5/report.html`.
- Assignment compilation: `artifacts/preview-gate/resume-20261009/assignment-compiler-20261009T165217Z/report.html`.
- Final closeout contracts and preservation receipts: `artifacts/preview-gate/closeout-20261010/`.

The Mac evidence archives and candidate iOS failure-attachment archive had
their complete SHA/CRC checks verified. For the candidate iOS primary report
archive, only 23 JSON and four PNG selected members were downloaded and
verified; its full archive digest was not verified. The raw xcresult archive
was not downloaded. Backend gates and compilation have no UI photos and do
not count as client E2E.

| Reviewed HTML | SHA-256 |
| --- | --- |
| Main Mac | `19fdd48c31abef588626d9554356d7295b045436f23bb3651e3944702e084e51` |
| Main iOS | `1dbc79b175c472ab64c9b2956e51d528f7c05a9a74e432ba1a25fb0a0c7cedda` |
| Pairing candidate Mac | `ae657b2dfdcb62a805b762f7615bd8994894a443272df755d5383172e850c57c` |
| Pairing candidate iOS | `7adfd8426f513b0c5132a1c93902f865d846f3ebcf369426a909836b9f8bfdbb` |

## Remaining work

- Complete Correction and Retention native acceptance on the final source.
- Qualify enabled allocation through the installed Mac UI, Stop/restart and
  iOS remote assignment. The proposed installed-allocation module remains
  unimplemented.
- Implement and verify recovery after a prepared worker's fatal failure;
  uncertain physical cleanup must continue to block unsafe recovery.
- Complete live-provider/production authentication, signing/notarization,
  physical-device/TestFlight and commercial release acceptance.

The six pre-existing unrelated files and original stash are preserved.
Older worktrees and failed attempts remain available; this closeout does not
delete them or rewrite previously published main history.
