# Fixed QuickJS development process owner

This new executable implements the native part of
`../../src/application-runtime-process-protocol.md`. Keep it independent of the
existing windows-process-host v1, frozen diagnostic owners and LPAC gate.
It is a development Job owner; it grants no product qualification.

The entry and configuration are fixed to `application-runtime.mjs` and
`application-runtime.json`. Only the measured node executable and the exact
fixed argv may run. Pins protect original bytes and namespace continuity;
protected installation admission remains a separate caller obligation.

Keep the original request budget, actual stream write acknowledgements,
independent cancellation reader, original Process HANDLE/Job, one-process and
1.5 GiB process-commit limits/readback, natural pipe EOFs, and bounded cleanup.
Never reopen a PID or accept a receipt as process ownership. Do not equate source,
compilation or controlled fixtures with live-provider or product acceptance.

Native compilation and execution must be scheduled by the parent task while
the Windows acceptance environment is shared; source review can run independently.

The development owner additionally implements the fixed
compiler selector. It selects only `application-compiler-process.mjs` and
`application-compiler-process.json`, uses the same original ProcessOwner and
ownership primitives, and retains runtime v1 constants and behavior. Compiler
transport caps are fixed in OwnerMode.Compiler; no launch/request field selects
a mode, command, argv or resource limit. Compilation alone does not qualify a
packaged or executed native binary. Preserve the existing strict ctime admission.
