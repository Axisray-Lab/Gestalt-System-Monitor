import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  encodeOverviewRegion,
  validateOverviewTrackBuffer,
} from './rmuc2026-pages-replay.mjs';

const databaseSha256 = 'a'.repeat(64);

function eastFixture() {
  const series = [];
  const expectedRounds = [];
  let gameId = 1_700_000_000_000;
  let webGameId = 80_000;
  for (let matchNumber = 1; matchNumber <= 88; matchNumber += 1) {
    const roundCount = matchNumber <= 27 ? 3 : 2;
    const config = {
      key: `rmuc2026-east-m${String(matchNumber).padStart(3, '0')}`,
      regionKey: 'east',
      matchNumber,
      roundCount,
      rounds: [],
    };
    const rounds = [];
    for (let roundNumber = 1; roundNumber <= roundCount; roundNumber += 1) {
      gameId += 1;
      webGameId += 1;
      const identity = { roundNumber, gameId, webGameId, durationSeconds: 1 };
      config.rounds.push(identity);
      rounds.push({
        match: identity,
        sampleMaxSecond: 1,
        byRobot: new Map([
          [
            1,
            [
              {
                second: 1,
                hp: 100,
                pose: { x: matchNumber, y: roundNumber, z: 10 },
              },
            ],
          ],
        ]),
      });
      expectedRounds.push({
        key: `${config.key}-g${roundNumber}`,
        matchNumber,
        roundNumber,
        gameId,
        webGameId,
        durationMs: 1_000,
      });
    }
    series.push({ config, rounds });
  }
  return { series, expectedRounds };
}

describe('RMUC2026 overview track binary', () => {
  it('encodes and validates the exact 203-game eastern region', () => {
    const fixture = eastFixture();
    const encoded = encodeOverviewRegion('east', fixture.series, databaseSha256);
    const validated = validateOverviewTrackBuffer(
      encoded.buffer,
      'east',
      databaseSha256,
      fixture.expectedRounds
    );

    assert.equal(validated.roundCount, 203);
    assert.equal(validated.timelineSampleCount, 203);
    assert.equal(validated.entitySampleCount, 203);
  });

  it('rejects an unknown record flag instead of degrading the preview', () => {
    const fixture = eastFixture();
    const encoded = encodeOverviewRegion('east', fixture.series, databaseSha256);
    const corrupted = Buffer.from(encoded.buffer);
    const firstRecordFlags = 64 + 28 + 2 + 6;
    corrupted[firstRecordFlags] = 2;

    assert.throws(
      () =>
        validateOverviewTrackBuffer(
          corrupted,
          'east',
          databaseSha256,
          fixture.expectedRounds
        ),
      /flags drifted/
    );
  });
});
