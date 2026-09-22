/**
 * Turn a raw failure from a back end into something a person can act on.
 *
 * The agent test page used to print the whole Foundry error — a URL, a
 * status code and a JSON fragment — which told the person nothing about what
 * to do. Each pattern below names the cause in plain English and the fix,
 * and keeps the raw text behind a "technical detail" fold for whoever has to
 * debug it.
 */

/** The MCP server URL inside a Foundry error: scheme, host, optional port, path — stopping before ": 401". */
const MCP_URL = /connecting to the MCP server (https?:\/\/[^\s:]+(?::\d+)?[^\s:]*)/i;
const urlIn = (m) => (String(m.input || m[0]).match(MCP_URL) || [])[1] || 'the MCP server';

const PATTERNS = [
  {
    test: /Access denied[\s\S]*(?:managed identity|search service)|(?:search service|azure_ai_search)[\s\S]*(?:403|Access denied)/i,
    explain: () => ({
      heading: 'Foundry cannot access the Search index',
      message: 'The agent reached Foundry, but its Search tool was denied access. A new chat window will not fix this. Ask the platform owner to check the CognitiveSearch connection target and AAD authentication, identify the managed identity actually used by this Foundry project, and verify its Search data-reader permissions and network access. Cortex Search health uses a different identity and cannot prove this access. See Help: Diagnose Search access denied. Permission changes require administrator approval.',
      fixable: true
    })
  },
  {
    test: /Authentication failed when connecting to the MCP server .*?(401|missing subscription key)/i,
    explain: (m) => ({
      heading: 'The agent could not sign in to one of its tools',
      message:
        `The tool at ${urlIn(m)} sits behind API Management, which needs a subscription key on every call. ` +
        'The agent was not given one. Cortex now creates a Foundry project connection carrying the key for each tool — ' +
        'rebuild the agent (Build → your agent → Rebuild tools) or run `node scripts/bootstrap.js --only=connections`, then try again.',
      fixable: true
    })
  },
  {
    test: /connecting to the MCP server .*?(404|Not Found)/i,
    explain: (m) => ({
      heading: 'One of the agent\u2019s tools is not there',
      message: `The MCP server at ${urlIn(m)} answered "not found". It may have been removed from API Management, or published under a different address. Republish the skill or agent it belongs to.`,
      fixable: true
    })
  },
  {
    test: /connecting to the MCP server /i,
    explain: (m) => ({
      heading: 'One of the agent\u2019s tools could not be reached',
      message: `Foundry could not talk to the MCP server at ${urlIn(m)}. Check it is running (Help → Service status) and that the API Management gateway is reachable.`,
      fixable: true
    })
  },
  {
    test: /failed 404.*agent/i,
    explain: () => ({
      heading: 'The agent no longer exists in Foundry',
      message: 'It was deleted or renamed in the Foundry portal. Build it again from Cortex, or refresh the register so the Marketplace stops listing it.',
      fixable: true
    })
  },
  {
    test: /failed 429|rate limit|Too Many Requests/i,
    explain: () => ({
      heading: 'Foundry is busy',
      message: 'The model deployment hit its rate limit. Wait a few seconds and ask again. If it keeps happening, raise the deployment capacity.',
      fixable: false
    })
  },
  {
    test: /failed 40[13](?!.*MCP)/i,
    explain: () => ({
      heading: 'Cortex is not allowed to call Foundry',
      message: 'The Cortex identity is missing a Foundry role (Foundry User and Foundry Project Manager on the account). Re-run the deployment script, which grants them.',
      fixable: true
    })
  },
  {
    test: /DeploymentNotFound|model.*not found|does not exist/i,
    explain: () => ({
      heading: 'The model this agent uses is not deployed',
      message: 'The deployment named in the agent is not in this Foundry project. Rebuild the agent choosing a model from the approved catalogue.',
      fixable: true
    })
  },
  {
    test: /aborted|timeout|TimeoutError/i,
    explain: () => ({
      heading: 'The agent took too long to answer',
      message: 'Foundry did not reply within the time Cortex allows. Ask again — a first call after a quiet period is often the slow one.',
      fixable: false
    })
  },
  {
    test: /azure_ai_search|Search Index Data|index.*not found/i,
    explain: () => ({
      heading: 'The agent could not read its data index',
      message: 'The Azure AI Search index behind one of its data products is missing or not readable by Foundry. Rebuild the index from the data product page, or run `node scripts/bootstrap.js --only=search`.',
      fixable: true
    })
  }
];

/**
 * @returns {{ heading: string, message: string, detail: string, fixable: boolean }}
 */
export function explainError(err) {
  const raw = String(err?.message || err || '');
  for (const p of PATTERNS) {
    const m = raw.match(p.test);
    if (m) return { ...p.explain(m), detail: raw };
  }
  return {
    heading: 'The agent could not be reached just now',
    message: 'Something went wrong between Cortex and Foundry. Try again in a moment; if it keeps happening, the technical detail below is what the Cortex team needs.',
    detail: raw,
    fixable: false
  };
}
