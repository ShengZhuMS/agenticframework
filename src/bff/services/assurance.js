/**
 * The seven assurance gates.
 *
 * CAP-137  See which assurance gates apply and why
 * CAP-138  See where the evidence for a gate is, and open it
 *
 * These are COMPUTED from the agent definition, not hardcoded. That matters:
 * in a demo somebody will ask "what if it did read personal data?" and the
 * honest answer is to change the knowledge selection and watch the gate
 * table change. A static table cannot survive that question.
 *
 * Each gate returns a status, a tone, and — most importantly — the reason it
 * applies to THIS agent. "Required because the agent summarises for a
 * decision" is a far more useful sentence than "Required".
 */

export const GATE_STATUS = {
  complete: { label: 'Complete', tone: 'green' },
  notRequired: { label: 'Not required', tone: 'green' },
  notApplicable: { label: 'Not applicable', tone: 'green' },
  inProgress: { label: 'In progress', tone: 'orange' },
  notStarted: { label: 'Not started', tone: 'red' },
  outstanding: { label: 'Outstanding', tone: 'red' }
};

/**
 * @param {object} agent  { name, model, instructions, knowledge[], actions[] }
 * @param {object[]} knowledgeEntries  the resolved Entry objects attached
 * @param {object[]} models  the approved model catalogue
 */
export function gatesFor(agent, knowledgeEntries = [], models = []) {
  const k = knowledgeEntries;
  const actions = agent.actions || [];

  const hasPersonalData = k.some(
    (e) =>
      /personal|sickness|absence|employee|individual|staff record|identif/i.test(
        `${e.desc || ''} ${e.limits || ''} ${e.minAgg || ''}`
      ) || e.sens === 'Official–Sensitive'
  );
  const hasSensitive = k.some((e) => e.sens === 'Official–Sensitive');
  const summarises = actions.includes('summarise');
  const readsRetrieved = actions.includes('read') && k.length > 0;
  const writesOut = actions.includes('write') || actions.includes('send');
  const model = models.find((m) => m.id === agent.model);
  const modelApproved = model?.approved !== false;

  const gates = [];

  // 1 -----------------------------------------------------------------
  gates.push({
    id: 'dpia',
    name: 'Data protection impact assessment',
    ...(hasPersonalData
      ? {
          status: 'outstanding',
          reason: hasSensitive
            ? `Required. ${k.filter((e) => e.sens === 'Official–Sensitive').length} of the attached sources are Official–Sensitive.`
            : 'Required. At least one attached source may contain personal data.',
          evidence: '/help/assurance/dpia'
        }
      : {
          status: 'notRequired',
          reason: 'No personal data in the attached sources, in this phase.'
        })
  });

  // 2 -----------------------------------------------------------------
  const uncleared = k.filter((e) => e.vis === 'notcleared');
  gates.push({
    id: 'gateway',
    name: 'Security review of the gateway registration',
    ...(uncleared.length
      ? {
          status: 'outstanding',
          reason: `${uncleared.length} attached source has not cleared the gateway yet.`,
          evidence: '/help/assurance/gateway'
        }
      : {
          status: 'complete',
          reason: 'Per registration, by the AI Unit. Every attached source has cleared.'
        })
  });

  // 3 -----------------------------------------------------------------
  gates.push({
    id: 'rai',
    name: 'Responsible AI review',
    ...(summarises
      ? {
          status: 'inProgress',
          reason: 'Required because the agent summarises for a decision.',
          evidence: '/help/assurance/rai'
        }
      : {
          status: 'notRequired',
          reason: 'The agent retrieves but does not summarise for a decision.'
        })
  });

  // 4 -----------------------------------------------------------------
  gates.push({
    id: 'model',
    name: 'Model catalogue approval',
    ...(modelApproved
      ? {
          status: 'complete',
          reason: `${model?.name || agent.model} is a first-party model from the approved catalogue.`
        }
      : {
          status: 'outstanding',
          reason: 'A third-party model needs review before it may be used.',
          evidence: '/help/assurance/model'
        })
  });

  // 5 -----------------------------------------------------------------
  gates.push({
    id: 'redteam',
    name: 'Red team report',
    ...(readsRetrieved
      ? {
          status: 'notStarted',
          reason:
            'Indirect injection through retrieved content is the live risk. Tool descriptions and results from an MCP server are untrusted input.',
          evidence: '/help/assurance/redteam'
        }
      : {
          status: 'notApplicable',
          reason: 'The agent retrieves nothing, so there is no retrieved content to poison.'
        })
  });

  // 6 -----------------------------------------------------------------
  gates.push({
    id: 'a11y',
    name: 'Accessibility test to WCAG 2.2 AA',
    status: 'notStarted',
    reason: 'A legal obligation, not a nice-to-have. Applies to everything with a user interface.',
    evidence: '/help/accessibility'
  });

  // 7 -----------------------------------------------------------------
  gates.push({
    id: 'service',
    name: 'Service assessment',
    ...(writesOut
      ? {
          status: 'outstanding',
          reason: 'Required because the agent acts outside the organisation or writes to a source system.',
          evidence: '/help/assurance/service'
        }
      : {
          status: 'notApplicable',
          reason: 'Internal, staff only, behind the network. It reads and summarises; it does not act.'
        })
  });

  return gates.map((g) => ({ ...g, ...GATE_STATUS[g.status], statusKey: g.status }));
}

/** Gates that must be cleared before an agent may be shared beyond its builder. */
export function blockingGates(gates) {
  return gates.filter((g) => g.statusKey === 'outstanding');
}

/**
 * The four permitted actions. Two are available this phase and two are not.
 *
 * Showing the unavailable ones greyed out rather than hiding them is
 * deliberate: a builder should know the boundary exists and that it is
 * coming, not wonder whether they missed a setting.
 */
export const ACTIONS = [
  {
    id: 'read',
    label: 'Read registered sources',
    available: true,
    default: true,
    hint: 'Only the sources attached above, and only as the person using it.'
  },
  {
    id: 'summarise',
    label: 'Summarise and cite',
    available: true,
    default: true,
    hint: 'Answers name their sources and their freshness.'
  },
  {
    id: 'write',
    label: 'Write to a source system',
    available: false,
    default: false,
    hint: 'Not this phase. No agent built in Cortex may write to a source system.'
  },
  {
    id: 'send',
    label: 'Send externally',
    available: false,
    default: false,
    hint: 'Not this phase. Nothing leaves Defra through an agent.'
  }
];
