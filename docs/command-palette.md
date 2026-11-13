# Global commands

Open the header search button or press Ctrl+K / Command+K. Search commands,
choose with the arrow keys and press Enter; Escape closes the panel and returns
focus to the initiating control. Tab stays inside the dialog. Held keys do not
repeatedly execute commands, and composition keys do not trigger navigation.
Another modal or the open mobile navigation drawer keeps its own keyboard flow.
Opening joins a pending page transition so its eventual commit does not dismiss
the new panel. Navigating away from an already open panel closes it.

The panel provides the registered views, project switching, Agent history,
project tasks, goals and channels, and the existing New task, New goal and
Connect Local Node flows. Creation commands open forms; they do not submit or
start agents. Prepared product sessions retain their existing restrictions on
manual goal creation.

## Search scope and data

The project selector initially follows the current project. Changing it inside
the panel only changes the search scope. Choosing a result applies the project
and destination together; selecting a task also updates the shared Workspace
task selection. Channel navigation continues through the server-validated room
and project path. Project switching clears the previous task as ordinary
navigation does.

Only the selected project's lists load while the panel is open. The panel
reuses bootstrap and task/goal/channel query keys and the selected project's
realtime subscription. It does not fan out across every project or claim a
server-wide full-text search. Names are filtered within the returned project
lists; the first 50 matches are displayed with a refinement prompt.

Project choices and agents come from the current bootstrap snapshot. Task and
goal results must match its organization and selected project; channels must
match the selected project. Failed lists show their own retry action and do not
present failed cached results as available destinations. A removed project
cannot be restored by a late list response. These presentation checks supplement
the existing server authorization at every data and mutation endpoint.

The bootstrap request may finish after a quick keyboard opening: the initial
project is adopted when it becomes available. An explicitly selected project
that becomes unavailable remains blocked until another project is chosen.

## Validation scope

Focused component and real Chromium workflow results are recorded in
[the opportunities progress record](opportunities-progress.md). They are
separate from the final integrated workspace gate and from native-client or
live-provider product acceptance.
