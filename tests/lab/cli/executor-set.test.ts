import { describe, expect, it } from 'vitest';
import { filteringExecutors } from '../../../src/orchestrator/filtering-executors';
import { LAB_EXECUTOR_SET } from '../../../lab/cli/executor-set';

describe('LAB_EXECUTOR_SET', () => {
    it('registers exactly the declared lab executor set when the module is imported', () => {
        expect(filteringExecutors.names().slice().sort()).toEqual(LAB_EXECUTOR_SET.slice().sort());
    });
});
