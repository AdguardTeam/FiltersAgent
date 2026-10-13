import { runMainSecretBoundary } from './cli/main-secret-boundary';

// Playwright's page.screenshot waits for document.fonts.ready before capturing, so one stalled
// webfont request hangs every screenshot — including the full-page evidence tiles — until its
// timeout, deterministically, on every retry (sifiraracal.com, 2026-08-15: three identical
// 30-second "waiting for fonts to load" failures burned the tool budget and the run). The
// escape hatch skips that wait process-wide; a capture with fallback fonts beats no capture.
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY ??= '1';

void runMainSecretBoundary();
