# Open Work

What the agent does not do yet. Each item names the behavior that is missing; the code that already
covers part of it is named so the item does not get rebuilt from scratch.

## Reproduction environments

- [ ] **Regional proxy.** Derive the region a report needs from the issue and the evidence, and
      route the browser through a real regional proxy. A region counts as applied only after the
      runner has confirmed the exit IP and region. Today a requested region is reported back to the
      model as not applied, because there is no proxy backend. Acceptance case: a Brazil-only
      first-party player ad that a non-Brazilian runner sees as an HTTP 403 or 404; a verified
      Brazilian route must expose its egress provenance and either open the page or classify the
      exact target response.
- [ ] **Mobile and Safari products.** Reproduction environments for AdGuard for Android, AdGuard
      for iOS, AdGuard Content Blocker and AdGuard for Safari. Today mobile-app reports run in the
      AdGuard CLI environment and record the mobile execution gap as a conflict.
- [ ] **Mobile app versus extension in a mobile browser.** `select_environment` should choose the
      environment by what actually filtered the page: an AdGuard mobile app, or a browser extension
      installed in a mobile browser. Android or iOS alone should not route a report to the desktop
      executor. Today only the selection guidance text separates the two.
- [ ] **The reporter's browser.** Drive the browser the report names when an environment supports
      it. Firefox-family extensions already run in Playwright Firefox; a branded Edge still runs as
      CloakBrowser Chromium and is recorded as a browser approximation.

## Investigation and validation

- [ ] **Off-origin navigation after load.** The browser follows a site's own redirect while an
      admitted page loads. A navigation off the issue origin later — after consent setup, a click,
      or a script — is still refused. Decide whether related origins (consent pages, country
      mirrors) are admitted and how "related" is determined.
- [ ] **Anti-adblock scriptlets.** Scriptlet candidates are proposed and validated through the
      extension, but there is no anti-adblock targeting document beside the ads and
      incorrect-blocking ones.
- [ ] **Network candidate validation.** The network check confirms that a candidate blocked the
      third-party requests it targets. First-party collateral blocking is judged only by the vision
      review. Link a DOM symptom to the script that created it through the request initiator
      (CDP `Network.requestWillBeSent`).
- [ ] **Behavioral symptoms and `not_reproduced`.** A `not_reproduced` verdict is already refused for
      gated pages (login, region, bot challenge). Refuse it for behavioral symptoms as well — a popup
      opened by a click, an anti-adblock wall shown after a timer — where the honest outcome is
      `analysis_only` with a candidate for the mechanism.
