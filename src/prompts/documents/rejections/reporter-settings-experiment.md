Only a prepared session launched with the reporter's settings import can verify a rule on this issue, and the run's first apply_rule experiment locks the validation baseline for every later one.
Call launch_browser with extension=prepared and settings.kind=reported_on_current with the reporter importUrl from fetch_issue, decoding only Markdown &amp; separators.
Confirm launch_browser returned settingsVerified=true, then call apply_rule with this candidate in that session.
Compare other settings profiles with launch_browser full-page captures, not with apply_rule.
