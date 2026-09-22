/**
 * GLUE 2 — publish a Foundry agent as an MCP server in API Management.
 *
 * CAP-099  Share an agent my team built
 * CAP-100  Declare what an agent reads and may do
 * CAP-102  Publish a skill so it is callable from Ask, an agent or an automation
 *
 * WHY THIS FILE EXISTS
 * There is no documented way to expose a Foundry agent as an MCP server.
 * Foundry's own registration path (Control Plane "Register custom agent")
 * produces an HTTP or A2A API in APIM — not MCP. So Cortex does it:
 *
 *   1. Cortex hosts a generic invocation shim: POST /shim/agents/{id}/invoke
 *      which calls the Foundry Responses API with agent_reference.
 *   2. On publish, Cortex generates an OpenAPI document for that one agent
 *      and imports it into APIM as a REST API.
 *   3. Cortex creates an MCP server in APIM over that API — an API resource
 *      with properties.type = 'mcp' and its tools inline in mcpTools, one
 *      per capability, each pointing at a backing operation by full ARM id.
 *   4. Cortex writes the resulting MCP endpoint back onto the Entry, so the
 *      agent reappears in the Marketplace as a part others can build with.
 *
 * Steps 2-4 use documented, supported APIM management APIs. Only the shim is
 * our code, and it is about a hundred lines.
 *
 * IDEMPOTENT BY DESIGN. The demo will be rehearsed many times; publishing an
 * agent that already exists must update it, never fail.
 */

import index from '../index/store.js';
import config from '../config.js';
import { resolveDefinition } from './agents.js';
import { connectionsConfigured, ensureMcpConnection } from '../adapters/foundry-connections.js';
import { prepare, act, canRedTeam, allAssessments, assessmentById, saveAssessments, publicationVerdict, agentVersion } from './redteam.js';
import { collection } from '../state/store.js';
import { evidenceGates } from './evidence.js';
import { gatesForDefinition } from './agents.js';
import { publishChannels } from '../adapters/channels.js';

const publishing = new Set();

export async function requestPublication(entryId, { baseUrl, visibility, user, microsoft365, acknowledge = false }) {
  const entry = index.get(entryId);
  if (!canRedTeam(entry, user)) throw new Error('Only the recorded builder or a red-team reviewer may publish this agent.');
  if (publishing.has(entryId)) throw new Error('A publication request for this agent is already being prepared.');
  publishing.add(entryId);
  try {
    if (acknowledge) return await publishAgent(entryId, { baseUrl, visibility, user, acknowledge: true });
    const existing = allAssessments().find((r) => r.agentId === entryId && r.publication && !['published','blocked'].includes(r.publication.status));
    if (existing) {
      if (existing.ownerId !== user.id) throw new Error('An assessment is already running for another publisher.');
      if (JSON.stringify(existing.publication.microsoft365 || null) !== JSON.stringify(microsoft365 || null)) throw new Error('An assessment with different channel options is already running. Wait for it to finish before requesting another publication.');
      return existing;
    }
    const r = await prepare(entry, user);
    r.publication = { baseUrl, visibility, user: { id: user.id, name: user.name, groups: user.groups || [] }, status: r.status === 'failed' ? 'blocked' : 'assessing', requestedAt: new Date().toISOString() };
    if (microsoft365) r.publication.microsoft365 = microsoft365;
    r.policy = 'Automatic pre-publication sandbox policy: enable every generated prohibited-action scenario; all three evaluators must pass every sample; zero errors.';
    await saveAssessments();
    return r;
  } finally { publishing.delete(entryId); }
}

let checkingPublications = false;
export async function advancePublications() {
  if (checkingPublications) return;
  checkingPublications = true;
  try {
    for (const r of allAssessments().filter((r) => r.publication?.status === 'assessing')) {
      try {
        if (Date.now() - Date.parse(r.publication.requestedAt) > 24 * 3600000) throw new Error('Assessment exceeded the 24-hour publication window.');
        if (r.status === 'taxonomy-pending') await act(r.id, r.publication.user, 'refresh');
        if (r.status === 'review-required') {
          r.reviewedBy = 'Configured automatic pre-publication policy';
          await act(r.id, r.publication.user, 'start');
        } else if (r.runId && !['completed','failed','canceled','cancelled'].includes(r.status)) await act(r.id, r.publication.user, 'refresh');
        if (r.error || ['failed','canceled','cancelled','submission-unknown','submitting'].includes(r.status)) throw new Error(r.error || `Assessment status: ${r.status}. Inspect Foundry before retrying.`);
        if (r.status === 'completed') {
          const verdict = publicationVerdict(r);
          if (!verdict.passed) throw new Error(verdict.reason);
          await publishAgent(r.agentId, { ...r.publication, assessmentId: r.id });
          if (r.publication.microsoft365) {
            if (['submitting', 'submitted-for-approval'].includes(r.publication.channel?.state)) throw new Error('A Microsoft 365 submission already exists or has an uncertain outcome. Review it before another submission.');
            const entry = index.get(r.agentId);
            await publishChannels(index.foundry, entry._source?.id || entry.id, r.target.version, r.publication.microsoft365, async (progress) => {
              r.publication.channel = { ...r.publication.channel, ...progress };
              await saveAssessments();
            });
          }
          r.publication.status = 'published';
        }
      } catch (err) {
        r.publication.status = 'blocked';
        r.publication.error = err.message;
        console.error('[publication]', r.id, err.message);
      }
      await saveAssessments();
    }
  } finally { checkingPublications = false; }
}

export function startPublicationScheduler() {
  const timer = setInterval(() => advancePublications().catch((err) => console.error('[publication]', err.message)), 15000);
  timer.unref?.();
  return timer;
}

/**
 * The OpenAPI document APIM imports. One operation per agent, because APIM
 * MCP tools map one-to-one onto backing REST operations.
 */
export function openApiFor(entry, baseUrl) {
  const def = entry._agent?.definition || {};
  const { knowledge } = resolveDefinition(def);

  return {
    openapi: '3.0.3',
    info: {
      title: entry.name,
      version: String(entry._agent?.version || 1),
      description:
        `${def.instructions || entry.desc}\n\n` +
        `Built in Cortex by ${def.builtByTeam || entry.owner}. ` +
        `Reads: ${knowledge.map((k) => k.name).join(', ') || 'nothing'}. ` +
        `May: ${(def.actions || []).join(', ')}.`
    },
    servers: [{ url: `${baseUrl}/shim/agents/${entry.id}` }],
    paths: {
      '/invoke': {
        post: {
          // Must contain only letters, - and _ per the APIM/Foundry constraint.
          operationId: 'ask',
          summary: `Ask ${entry.name} a question`,
          description:
            `Ask a question and get an answer with its sources named. ` +
            `The agent answers only from ${knowledge.map((k) => k.name).join(', ') || 'its attached sources'}, ` +
            `and states what it could not reach.`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['question'],
                  properties: {
                    question: { type: 'string', description: 'The question, in ordinary language.' },
                    conversationId: {
                      type: 'string',
                      description: 'Optional. Continue an existing conversation.'
                    }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'An answer with its provenance.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      answer: { type: 'string' },
                      sources: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            freshness: { type: 'string' },
                            used: { type: 'string' }
                          }
                        }
                      },
                      couldNotReach: { type: 'array', items: { type: 'string' } },
                      confidence: { type: 'string' },
                      conversationId: { type: 'string' }
                    }
                  }
                }
              }
            },
            403: { description: 'The caller may not reach a source this agent depends on.' }
          }
        }
      }
    }
  };
}

/**
 * Publish. Returns the MCP endpoint and a step-by-step record of what
 * happened, which the UI shows — the steps ARE the demo.
 */
export async function publishAgent(entryId, { baseUrl, visibility, user, assessmentId, acknowledge = false }) {
  const entry = index.get(entryId);
  if (!entry) throw new Error(`Unknown agent ${entryId}`);
  if (!canRedTeam(entry, user)) throw new Error('Only the recorded builder or a red-team reviewer may publish this agent.');
  const assessment = assessmentById(assessmentId);
  const passing = assessment && assessment.agentId === entryId && assessment.ownerId === user.id && publicationVerdict(assessment).passed;
  if (!passing && !acknowledge) throw new Error('Publication requires a successful native Foundry red-team assessment or explicit acknowledgement of outstanding findings.');
  const live = await index.foundry.getAgent(entry._source?.id || entry.id);
  const version = String(agentVersion(live) || '');
  if (!version || (passing && (version !== assessment.target.version || assessment.target.name !== (entry._source?.id || entry.id))) ||
      (!passing && version !== String(entry._agent?.version))) throw new Error('The agent changed after its assessment or recorded definition. Refresh or rebuild before publishing.');
  const acknowledgedFindings = acknowledge ? evidenceGates(entry, await gatesForDefinition(entry._agent?.definition || {}))
    .filter((gate) => !['complete', 'notRequired', 'notApplicable'].includes(gate.statusKey))
    .map(({ id, label, reason, evidence }) => ({ id, label, reason, evidence })) : [];

  /**
   * Republishing must never silently narrow who can reach an agent. If no
   * visibility is given and the agent is already published, keep the
   * visibility it already has. A publish that quietly un-shares something is
   * a data-loss bug, and the demo republishes constantly.
   */
  const effectiveVisibility = visibility || entry._agent?.visibility || 'team';

  const steps = [];
  const record = (label, detail, ok = true) => steps.push({ label, detail, ok });

  const apiId = `${entry.id}-api`;
  const mcpId = `${entry.id}-mcp`;
  const spec = openApiFor(entry, baseUrl);

  record('Generated an OpenAPI description', `${apiId} — one operation, "ask"`);

  // ---- 2. import the shim as a REST API in APIM
  let api = null;
  try {
    api = await index.apim.importOpenApi({
      id: apiId,
      displayName: entry.name,
      description: spec.info.description,
      spec,
      path: apiId
    });
    record('Imported it into API Management as a REST API', apiId);
  } catch (err) {
    record('Import into API Management failed', err.message, false);
    throw err;
  }

  // ---- 3. project the API as an MCP server, tools inline
  // One PUT carries the type AND the tools. Sent separately, API Management
  // silently drops the type and the "server" is a plain API that no agent
  // can call — the 500 that bootstrap chased for two rounds.
  let mcp = null;
  try {
    mcp = await index.apim.createMcpServer({
      id: mcpId,
      displayName: `${entry.name} (MCP)`,
      description: spec.info.description,
      tools: [
        {
          name: 'ask',
          description: spec.paths['/invoke'].post.description,
          backingApiId: apiId,
          backingOperationId: 'ask'
        }
      ]
    });
    record('Created an MCP server over it', `${mcpId} — type mcp, verified`);
    record('Registered the "ask" tool on it', 'one tool per capability, inline in the server definition');
  } catch (err) {
    record('Creating the MCP server failed', err.message, false);
    throw err;
  }

  // ---- 4. write the endpoint back onto the entry
  const mcpUrl = mcp?.url || `${config.apim.gatewayUrl}/${mcpId}/mcp`;
  const openApiUrl = `${config.apim.gatewayUrl}/${apiId}/openapi.json`;

  // ---- 4b. a Foundry project connection carrying the APIM key, so another
  // agent can call this one without the 401 the first agents hit.
  let connectionName = null;
  if (connectionsConfigured() && config.apim.subscriptionKey) {
    try {
      const c = await ensureMcpConnection({ apiId: mcpId, target: mcpUrl });
      connectionName = c.name;
      record('Gave Foundry a connection to it', `${c.name} — carries the API Management key, so agents can call it`);
    } catch (err) {
      record('Foundry connection not created', `${err.message} — agents calling this server will be refused until it exists`, false);
    }
  } else {
    record('Foundry connection skipped', 'Foundry project location or the APIM key is not configured; agents calling this server will be refused', false);
  }

  /**
   * Widening only. The groups the builder already had keep access — otherwise
   * a builder can be locked out of the agent they made, because a team's
   * display name and its directory group name are not the same string
   * ("Waste Crime observatory" vs "waste-crime").
   */
  const builderGroups = entry.allowedGroups || [];
  const visibilityMap = {
    team: { access: 'Open to the team that built it', groups: builderGroups },
    directorate: {
      access: 'Open to the cluster',
      groups: [...new Set([...builderGroups, entry.cluster])]
    },
    all: {
      access: 'Open to all staff',
      groups: [...new Set([...builderGroups, 'all-staff'])]
    }
  };
  const vis = visibilityMap[effectiveVisibility] || visibilityMap.team;

  const updated = index.upsert({
    ...entry,
    access: vis.access,
    allowedGroups: vis.groups,
    flags: (entry.flags || []).filter((f) => f !== 'new'),
    _endpoints: { ...entry._endpoints, mcp: mcpUrl, openapi: openApiUrl },
    _agent: {
      ...index.get(entryId)._agent,
      published: true,
      publishedAt: new Date().toISOString(),
      publishedBy: user?.name,
      publishedVersion: version,
      assessmentId: passing ? assessment.id : null,
      assuranceAcknowledgement: acknowledge ? { by: user.id, at: new Date().toISOString(), version, findings: acknowledgedFindings } : null,
      visibility: effectiveVisibility,
      apimApiId: apiId,
      apimMcpId: mcpId,
      connection: connectionName
    }
  });
  const storedAgents = collection('agents', {});
  await storedAgents.flush();
  if (storedAgents.lastError) throw new Error(`Publication reached APIM but its state could not be saved: ${storedAgents.lastError}`);

  record('Registered it back in the marketplace', `visible as: ${vis.access}`);

  return { entry: updated, mcpUrl, openApiUrl, steps, apiId, mcpId };
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
