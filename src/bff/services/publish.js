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
 *      with properties.type = 'mcp' — and adds one tool per capability.
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
export async function publishAgent(entryId, { baseUrl, visibility, user }) {
  const entry = index.get(entryId);
  if (!entry) throw new Error(`Unknown agent ${entryId}`);

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

  // ---- 3. project the API as an MCP server
  let mcp = null;
  try {
    mcp = await index.apim.createMcpServer({
      id: mcpId,
      displayName: `${entry.name} (MCP)`,
      description: spec.info.description,
      backingApiId: apiId
    });
    record('Created an MCP server over it', mcpId);

    await index.apim.addTool(mcpId, {
      toolId: 'ask',
      displayName: 'ask',
      description: spec.paths['/invoke'].post.description,
      backingApiId: apiId,
      backingOperationId: 'ask'
    });
    record('Added the "ask" tool to the MCP server', 'one tool per capability');
  } catch (err) {
    record('Creating the MCP server failed', err.message, false);
    throw err;
  }

  // ---- 4. write the endpoint back onto the entry
  const mcpUrl = mcp?.url || `${config.apim.gatewayUrl || 'https://apim-cortex.azure-api.net'}/${mcpId}/mcp`;
  const openApiUrl = `${config.apim.gatewayUrl || 'https://apim-cortex.azure-api.net'}/${apiId}/openapi.json`;

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
      ...entry._agent,
      published: true,
      publishedAt: new Date().toISOString(),
      publishedBy: user?.name,
      visibility: effectiveVisibility,
      apimApiId: apiId,
      apimMcpId: mcpId
    }
  });

  record('Registered it back in the marketplace', `visible as: ${vis.access}`);

  return { entry: updated, mcpUrl, openApiUrl, steps, apiId, mcpId };
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
