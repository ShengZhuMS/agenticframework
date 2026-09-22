import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStudioActivities, invokeStudio, probeStudio } from '../src/bff/adapters/studio.js';

const config = { baseUrl: 'https://synthetic.00.environment.api.powerplatform.com', agentId: 'cortex_SyntheticGuide' };
const event = (activity) => `event: activity\r\ndata: ${JSON.stringify(activity)}\r\n\r\n`;
const end = 'event: end\r\ndata: {}\r\n\r\n';
function stream(text, headers = {}) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream', ...headers } });
}

test('Studio SSE handles chunk boundaries, end events and conversation headers', async () => {
  const result = await readStudioActivities(stream(event({ type: 'message', text: 'Synthetic guide' }) + end, { 'x-ms-conversationid': 'conversation-one' }));
  assert.equal(result.conversationId, 'conversation-one');
  assert.equal(result.activities[0].text, 'Synthetic guide');
});

test('authenticated Studio invocation preserves the conversation and bounds both HTTP calls', async () => {
  const calls = [];
  const answer = await invokeStudio(config, 'Explain Data Cortex', { headers: { Authorization: 'test-only' }, fetchFn: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return calls.length === 1
      ? stream(end, { 'x-ms-conversationid': 'conversation/one' })
      : stream(event({ type: 'message', text: 'A synthetic catalogue guide.' }) + end);
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.emitStartConversationEvent, false);
  assert.ok(calls[1].url.pathname.endsWith('/conversations/conversation%2Fone'));
  assert.equal(calls[1].body.activity.text, 'Explain Data Cortex');
  assert.equal(calls[1].body.conversationId, 'conversation/one');
  assert.equal(answer.answer, 'A synthetic catalogue guide.');
});

test('disabled app-only preview fails preflight without sending an agent question', async () => {
  let calls = 0;
  await assert.rejects(probeStudio(config, { fetchFn: async () => {
    calls++;
    return new Response('App-only S2S access is not enabled for this environment.', { status: 405 });
  } }), /Microsoft must enable this preview capability/);
  assert.equal(calls, 1);
});

test('incomplete streams and interactive sign-in cannot be reported as successful answers', async () => {
  await assert.rejects(readStudioActivities(stream(event({ type: 'message', text: 'Partial answer' }))), /before the end event/);
  await assert.rejects(readStudioActivities(stream(event({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.oauth' }] }) + end)), /interactive user sign-in/);
  await assert.rejects(readStudioActivities(new Response('Forbidden', { status: 403 })), /HTTP 403/);
});

test('Studio refuses an unapproved endpoint before transmitting credentials', async () => {
  await assert.rejects(probeStudio({ ...config, baseUrl: 'https://unrelated.example.test' }, { fetchFn: () => assert.fail('must not fetch') }), /approved Power Platform/);
});
