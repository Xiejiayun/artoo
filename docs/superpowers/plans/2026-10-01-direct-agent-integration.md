# Direct agent workflow integration

Base `d61af1e`. The preceding milestone passed native core and installed Mac
planning locally; its hosted run `36783627020` subsequently passed all three
gates, with all 37 retained client/browser images independently reviewed.

The reviewed shared CLI, native request/agent display and suite-contract
patches are integrated first. Root owns runner selection, immutable report
isolation/aggregation, CI wiring, real-client builds, visual review and pushes.
Parallel owners implement the installed Mac driver, independent native
assistant fixture/driver and shared read-only outcome verification. No agent
may run a build or E2E while these sources are being assembled.

## Scenario and ownership

- Preserve the full three-turn/four-process/two-answer scenario and all exact
  context/identity requirements from the direct-agent client E2E plan.
- Native assistant work uses its own `AssistantConversationUITests` class and
  fixture. It must not populate fake core fields or wait for core browser
  signals. Only native UI sends/retries/cancels; fixture control may start/stop
  the real node and expose read-only owned-process observations.
- Mac uses installed Settings stop/start and real request-scoped controls.
  Preserve prior planning, artifact, optional provider and cleanup workflows.
- Shared final verification accepts actual turns/messages/runs/usage/receipts,
  binds the computer and instance via server records (absent from context),
  and requires exact attempt counts and no live owned subprocess after cancel.
- Core and assistant have exact distinct XCTest selections, xcresults,
  attachments and HTML. Full verification aggregates both only from matching
  original source fingerprints. Subset success is always labeled as a subset.

## Verification order

1. Review interfaces and focused tests; freeze integrated sources.
2. Run assistant native E2E with actual screenshots, then matching-source core
   coverage and the aggregate. Diagnose and retain every failed attempt.
3. Run the fresh installed Mac gate, review screenshots and cleanup, then the
   matching native development archive where product source changed.
4. Update evidence/readiness, commit/push the verified milestone and inspect
   the exact new hosted run. Do not cancel the current hosted run with a
   premature progress-only push.

Real model, physical-device, signed distribution, deployed identity and
operator-policy gates remain separate commercial-release requirements.

Local execution completed: full native 110 unit + 8 UI, final Mac 14 checks /
16 inspected captures, and matching signed arm64 development archive. The
milestone ledger retains all failed attempts, exact source/hash evidence and
visual limits. The next step is committing/pushing this verified source and
following its own hosted run; the next-project mention fix remains isolated.
