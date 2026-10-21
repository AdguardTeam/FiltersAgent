/**
 * Fixed run addresses the report suites render with.
 */
import type { ReportListSource } from '../../src/publisher/report-list-place';

/**
 * Link to the run artifacts a report points at.
 */
export const ARTIFACTS_LINK = 'https://github.com/owner/repo/actions/runs/42#artifacts';

/**
 * The repository revision a report's place in the list links to.
 */
export const LIST_SOURCE: ReportListSource = {
    repository: { owner: 'owner', repo: 'repo' },
    commit: '0123456789abcdef0123456789abcdef01234567',
};
