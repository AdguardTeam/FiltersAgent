import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        // Browser-backed suites launch a Chromium or Firefox per worker; the default worker count
        // (one per CPU) exhausted the machine's memory during agent-driven runs. Two workers keep
        // the full suite within a few gigabytes; raise deliberately, not by removing the cap.
        maxWorkers: 2,
        // vitest is invoked by agents in non-interactive shells; never leave a watcher behind.
        watch: false,
    },
});
