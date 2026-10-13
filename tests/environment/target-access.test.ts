import { describe, expect, it } from 'vitest';
import {
    classifyObservedPageAccess,
    type TargetAccessClassification,
} from '../../src/environment/target-access';
import { PageObstruction } from '../../src/types/page-obstruction';

const rows: [string, number, PageObstruction, TargetAccessClassification][] = [
    [
        'an ordinary page vision saw as the site can carry a reproduction claim',
        200,
        PageObstruction.None,
        'accessible',
    ],
    [
        'a regional notice in place of the content is a regional block',
        200,
        PageObstruction.RegionBlock,
        'region_restricted',
    ],
    [
        'a sign-in page in place of the content is a login wall even with HTTP 200',
        200,
        PageObstruction.SignInWall,
        'authentication_required',
    ],
    ['a bot check is a challenge', 200, PageObstruction.AntiBotChallenge, 'bot_challenge'],
    [
        'an error or blank page shows nothing reported',
        200,
        PageObstruction.ErrorOrBlank,
        'content_absent',
    ],
    ['HTTP 451 is a regional block', 451, PageObstruction.None, 'region_restricted'],
    ['HTTP 401 is a login wall', 401, PageObstruction.None, 'authentication_required'],
    ['HTTP 403 is a login wall', 403, PageObstruction.None, 'authentication_required'],
    ['HTTP 404 no longer exposes the report', 404, PageObstruction.None, 'content_absent'],
    ['HTTP 410 no longer exposes the report', 410, PageObstruction.None, 'content_absent'],
    ['HTTP 500 is the server failing, not the reporter', 500, PageObstruction.None, 'server_error'],
];

describe('classifyObservedPageAccess', () => {
    it.each(rows)('%s', (_contract, statusCode, obstruction, expected) => {
        expect(classifyObservedPageAccess(statusCode, obstruction)).toBe(expected);
    });
});
