# Project-scoped Windows desktop UI

The existing visual QA preset cannot control a native application on the
interactive desktop. This opt-in candidate adds a Windows UI Automation
helper using the existing bounded command runner. It operates only on
the approved executable in the foreground of the current interactive
Default desktop. Session 0, locked/secure desktop, other executables and
unverified window identities fail closed. It never changes foreground focus.

Studio enrollment can add fixed debug/release inspection variants through
EnableDesktopUI. Inspection counts bounded same-process UIA controls and
invokable controls; no window titles, text fields, screenshots or personal
desktop content are returned. An administrator may separately review and
configure a fixed Invoke profile for a specific non-destructive automation ID
and exact executable SHA256. This is not enabled by Studio enrollment.
Invoke requests require a unique enabled, visible matching control and
recheck the process and foreground identity. A returned invoke request
does not establish its application-side effect.

A separate EnableDesktopCapture opt-in provides local-only PNG evidence of
an approved foreground application through PrintWindow. The helper does not
fall back to desktop-wide capture; it rechecks the target and stores a unique
owner-only file under protected device state. Capture is bounded to 3840 by
2160 pixels, 16 MiB, and 20 retained images. It returns an evidence ID,
byte count and SHA-256, never image bytes. PrintWindow may not render GPU
content correctly; a receipt is not proof of visual parity.

No global keyboard or mouse injection, arbitrary coordinate action,
clipboard access, user-session switching, screenshot transfer, camera
activation, or new OAuth grant is introduced. Application-specific
accessibility support and a signed runtime are prerequisites. Real P520
interactive inspection, approved non-destructive action and independent
effect verification remain required. CI validates script parsing and
profile schema, not actual interactive UI behavior. A future screenshot
and richer control-discovery adapter must be separately scoped and tested.
