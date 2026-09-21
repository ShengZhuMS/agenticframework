import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { explainError } from '../src/bff/services/explain.js';

describe('explainError', () => {
  test('the MCP 401 becomes a sentence about API Management keys and a fix', () => {
    const e = explainError(new Error('Foundry POST /openai/v1/responses failed 400: {"error":{"message":"Authentication failed when connecting to the MCP server https://prdcoreapimneu001.azure-api.net:443/magic-map-mcp/mcp: 401 Access denied due to missing subscription key."}}'));
    assert.equal(e.heading, 'The agent could not sign in to one of its tools');
    assert.match(e.message, /prdcoreapimneu001\.azure-api\.net:443\/magic-map-mcp\/mcp/);
    assert.match(e.message, /Rebuild/);
    assert.equal(e.fixable, true);
    assert.match(e.detail, /401/);
  });
  test('rate limits, timeouts and unknowns each read differently', () => {
    assert.equal(explainError(new Error('failed 429: too many')).heading, 'Foundry is busy');
    assert.equal(explainError(new Error('The operation was aborted due to timeout')).heading, 'The agent took too long to answer');
    assert.equal(explainError(new Error('something odd')).heading, 'The agent could not be reached just now');
  });
});
