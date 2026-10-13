# Built-in AdGuard Browser Extension application procedure

This document is the contract of the built-in AdGuard route: the one way rules are applied when the
run's blocker is the AdGuard Browser Extension. The steps are a fixed message protocol with nothing
in them open to judgement, so the host performs them itself in code
(`src/orchestrator/host-extension-application.ts`) instead of paying a model session to send the
same messages. Nothing below is addressed to a model. The steps run inside a controlled browser
session that already has the prepared extension loaded.

## Rule application

The host performs exactly these steps, in this order, and invents none:

1. Open a page dedicated to these steps on the AdGuard Browser Extension options surface at
   `chrome-extension://<extension id>/pages/options.html`, using the extension id of the prepared
   extension the session was launched with, and close that page once the steps are done. Every app
   message below is sent from it, never from the page the phase observes its target on.
2. Wait until the options application reports it has finished initializing before changing
   anything: send `{"type": "getIsAppInitialized"}` and repeat the call while it answers anything
   but `true`. Its background message handlers and default filters settle asynchronously after a
   fresh install, and settings applied in that window can be overwritten.
3. Apply the prepared settings through the options application: send
   `{"type": "applySettingsJson", "data": {"json": "<the settings document the host built for this
   phase>"}}`, passing the document exactly as built, so the extension enables exactly the official
   filters the prepared expectation names and its Tracking-protection state. No other filter is
   added, removed or edited. A launch that runs a list slice carries it in the same document, as
   one trusted custom filter served from the run's own loopback server, while the built-in list it
   replaces stays off.
4. Confirm the import landed on exactly the expected filters, and turn off any extra one. A
   successful `applySettingsJson` is not proof on its own: the extension re-enables some filters
   from settings of its own after the import.
    1. Send `{"type": "getOptionsData"}`. Its `filtersMetadata.filters` array carries one entry per
       filter, with a `filterId` and an `enabled` flag.
    2. For every entry whose `enabled` is `true` and whose `filterId` is **not** among the official
       filter IDs the prepared expectation names — and, for a custom filter (`filterId` 1000 and
       up, whose id the import allocates), whose `name` is **not** a custom filter title the
       prepared expectation names — send
       `{"type": "disableFilter", "data": {"filterId": <that filterId>}}`.
    3. Read `getOptionsData` again and repeat step 4.2 while any unexpected filter is still
       enabled, for at most three rounds. No filter is ever switched on here: the import is the only
       step that turns filters on, and this protocol carries no message for switching one on at all.
    4. The `getOptionsData` reply is the only evidence this step needs. The surface page is not
       reloaded, its DOM is not read, and nothing waits for it to settle to confirm the filters: the
       state verification below reads the extension back independently afterwards.
5. For the candidate goal only, send
   `{"type": "saveUserRules", "data": {"value": "<the candidate rule the goal names>"}}`, passing
   the candidate rule exactly as written, as one line, and nothing else: no rewrites, no extra
   rules, nothing removed. The baseline goal names no user rule and this protocol writes none for
   it — a phase session always bootstraps a fresh profile, so it carries no user rule to clear, and
   the imported document is that same fresh profile's own export.

Every step is timed and recorded, and a step that fails or does not do what it was asked to leaves
the application incomplete with that step named. Whatever state the steps left behind is still read
back and judged: the verification below, not the steps, decides whether the phase applied.

## State verification

After the steps the host reads the blocker state back itself and credits the phase only when that
state contains exactly the rule content it expected. The host reads the live extension state:

read: extension-state user-rules
