# Fixed application compiler process

The Windows development owner has a separate fixed compiler selector. The child
accepts one bounded admission line followed by one compile JSON request and real
stdin EOF. Its fixed trusted TypeScript and guest scripts run in the guarded
QuickJS session; product TypeScript enters as string data. Product output is
never evaluated by this compiler. Runtime v1 keeps its existing limits and path.

The host binds the native helper, Node, fixed child entry/configuration, complete
vendor set, TypeScript implementation, guest bundle and library snapshot. The
compiler package has exactly four members. The captured snapshot supplies the
independent library expectations; installed operation does not read mutable
development node_modules to reconstruct them.

`prepareApplicationCompilerProcess` returns an original one-use preparation.
`startApplicationCompilerProcess` accepts that token, copied request bytes and the
original deadline. It returns `completed`, `closed`, `read` and `cancel`. Content
is withheld until exact input acknowledgements, original target/Job/pipe closure,
original helper exit/close/EOF, final installation rechecks and the original
deadline all pass. Failure revokes captured content. A receipt cannot be adopted
as process ownership.

The child installs the fixed import and Wasm guards before instantiation, refuses
module loading/host callbacks, bounds pointers and UTF-8/CString reads, and
disposes its original context/runtime before emitting output. Compiler-only FFI
limits cover the 52 MiB request, 100 MiB response and fixed trusted bootstraps.
Native lifetime remains 30 seconds, cleanup 5 seconds, one process, 1.5 GiB Job
commit, and 256 MiB Node old-space. Transport ceilings do not promise every input
can compile within those resource limits.

The fixed package builder is `apps/artood/scripts/build-application-compiler-child.mjs`.
It creates a fresh package and records its inputs/outputs; it does not install,
run or qualify it. Ordinary tsc output is not this host bundle. The artifact-only
package reader test is retained with its measured draft package rather than
being made a CI test that assumes an uncommitted package exists.

Source review, controlled tests, packaging and C# compilation have been performed
separately. Actual protected installation and native compiler execution remain
unverified. Content remains `compiler-response-content-only` and
`qualified_for_product: false`; protected staging, original node verification,
independent review and application publication remain separate work.
