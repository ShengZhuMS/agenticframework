// Direct Engine HTTP protocol used by Microsoft's agents-copilotstudio-client.
// Fetch deadlines also bound the SSE body; reconnecting POSTs could duplicate turns.
export async function readStudioActivities(response) {
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 405 && detail.includes('App-only S2S access is not enabled for this environment')) {
      throw new Error('Copilot Studio app-only S2S access is not enabled for this environment. Microsoft must enable this preview capability; changing the agent to anonymous access will not fix it.');
    }
    throw new Error(`Copilot Studio returned HTTP ${response.status}. Check application consent, agent access and publication.`);
  }
  if (!response.body) throw new Error('Copilot Studio returned no response stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const activities = [];
  let buffer = '', bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Copilot Studio closed its stream before the end event.');
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Copilot Studio response exceeds 1 MiB.');
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n');
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        if (event === 'end') return { activities, conversationId: response.headers.get('x-ms-conversationid') || activities.find((a) => a.conversation?.id)?.conversation.id };
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (event === 'error') throw new Error('Copilot Studio reported a conversation error.');
        if (event !== 'activity' || !data) continue;
        const activity = JSON.parse(data);
        if (activity.attachments?.some((a) => a.contentType === 'application/vnd.microsoft.card.oauth')) throw new Error('This Copilot Studio agent requires interactive user sign-in; it cannot be invoked as the configured application.');
        activities.push(activity);
        if (activities.length > 100) throw new Error('Copilot Studio response exceeds 100 activities.');
      }
    }
  } finally { await reader.cancel(); }
}

async function postStudio(c, suffix, body, { headers, fetchFn = fetch } = {}) {
  if (!/^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(c.agentId || '')) throw new Error('Copilot Studio requires its published schema name.');
  const base = new URL(c.baseUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password ||
      !base.hostname.endsWith('.environment.api.powerplatform.com')) throw new Error('Copilot Studio requires its approved Power Platform environment endpoint.');
  const path = `/copilotstudio/dataverse-backed/authenticated/bots/${encodeURIComponent(c.agentId)}/conversations`;
  return readStudioActivities(await fetchFn(new URL(`${path}${suffix}?api-version=2022-03-01-preview`, base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body)
  }));
}

export async function probeStudio(c, options) {
  const start = await postStudio(c, '', { emitStartConversationEvent: false }, options);
  if (!start.conversationId) throw new Error('Copilot Studio returned no conversation identifier.');
  return start;
}

export async function invokeStudio(c, question, options) {
  const start = await probeStudio(c, options);
  const result = await postStudio(c, `/${encodeURIComponent(start.conversationId)}`, {
    activity: { type: 'message', text: question, conversation: { id: start.conversationId } },
    conversationId: start.conversationId
  }, options);
  const answer = result.activities.filter((a) => a.type === 'message' && typeof a.text === 'string').map((a) => a.text).join('\n');
  if (!answer.trim()) throw new Error('Copilot Studio returned no answer.');
  return { answer, provider: 'm365', source: c.agentId };
}
