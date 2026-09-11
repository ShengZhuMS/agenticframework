/**
 * Bootstrap's command line — including the two things the bootstrap job
 * depends on: --skip= and BOOTSTRAP_ARGS from the environment.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../scripts/bootstrap.js';

describe('parseArgs', () => {
  test('reads the flags and the sections to skip', () => {
    const p = parseArgs(['--dry-run', '--skip=data,search', '--no-wait'], {});
    assert.equal(p.dryRun, true);
    assert.equal(p.noWait, true);
    assert.deepEqual([...p.skip].sort(), ['data', 'search']);
    assert.equal(p.only, undefined);
    assert.deepEqual(p.unknownSkips, []);
  });

  test('BOOTSTRAP_ARGS in the environment is appended — how the job receives --no-wait', () => {
    const p = parseArgs(['--only=data', '--skip-roles'], { BOOTSTRAP_ARGS: '--no-wait' });
    assert.equal(p.only, 'data');
    assert.equal(p.skipRoles, true);
    assert.equal(p.noWait, true);
  });

  test('a later --only wins, so the environment can redirect the job to another section', () => {
    const p = parseArgs(['--only=data'], { BOOTSTRAP_ARGS: '--only=link' });
    assert.equal(p.only, 'link');
  });

  test('--wait is unknown and therefore harmless — the deploy script uses it to clear a previous --no-wait', () => {
    const p = parseArgs(['--only=data'], { BOOTSTRAP_ARGS: '--wait' });
    assert.equal(p.noWait, false);
    assert.equal(p.only, 'data');
  });

  test('a misspelt section to skip is reported rather than silently ignored', () => {
    const p = parseArgs(['--skip=data,serach'], {});
    assert.deepEqual(p.unknownSkips, ['serach']);
  });

  test('--principal= is read from either source', () => {
    assert.equal(parseArgs(['--principal=abc'], {}).principal, 'abc');
    assert.equal(parseArgs([], { BOOTSTRAP_ARGS: '--principal=def' }).principal, 'def');
    assert.equal(parseArgs([], {}).principal, '');
  });
});
