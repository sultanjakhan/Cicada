# Cicada 0.5.2

This release combines the completed goals candidate with the corrections identified after 0.5.0.

- Today and the main goal have distinct card boundaries again. The theme control sits to the right of Calendar on desktop and in the mobile header. The redundant Today shortcut above the workspace is removed.
- Calendar uses Day when no explicit initial-view preference is saved. Existing Month/Week preferences remain valid. The desktop date and period controls fit on one row where space allows.
- The dashboard shows AI work reports bound to native Cicada tasks. It labels them as reported statuses with unknown freshness, refreshes after native changes and hides an empty section. Reading reports never starts a human timer or completes a task. The local task plugin does not automatically register every chat.
- The centered update offer retains draft, focus and explicit-install protection.
- Goals open their details and subgoals in one window. Viewing a stage is separate from making it current; goal achievement and measured results remain separate from task and skill completion. Text actions retain visible keyboard focus and touch areas.

The existing compact Windows mode remains available. End Day is not included: its behavior still requires a product decision. The routines/event research mockup, full AI pipeline grouping and automatic chat registration are not shipped features.

Older clients may pause synchronization when they encounter the newer goal metadata; update the other devices before relying on mixed-version goal synchronization. Windows native QA, signed package checks and physical Mac/Android acceptance are separate evidence levels.
