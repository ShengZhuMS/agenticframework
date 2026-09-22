import config from '../config.js';
import { getToken } from './token.js';

export const EVALUATOR_NAMES = ['Prohibited actions', 'Task adherence', 'Sensitive data leakage'];

// Agentic red teams use the Evals/taxonomy APIs, not the older model-only redTeams API.
export class FoundryRedTeam {
  constructor(cfg = config.foundry, { fetchFn = fetch, tokenFn = getToken } = {}) {
    this.cfg = cfg;
    this.fetch = fetchFn;
    this.token = tokenFn;
  }

  async request(path, method = 'GET', body) {
    if (!this.cfg.projectEndpoint) throw new Error('Configure FOUNDRY_PROJECT_ENDPOINT before red teaming.');
    const url = new URL(this.cfg.projectEndpoint.replace(/\/$/, '') + path);
    url.searchParams.set('api-version', '2025-11-15-preview');
    const response = await this.fetch(url, {
      method,
      headers: { Authorization: ['Bearer', await this.token(this.cfg.scope)].join(' '), 'Content-Type': 'application/json', 'Foundry-Features': 'Evaluations=V1Preview' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs || 30000)
    });
    if (!response.ok) throw new Error(`Foundry red teaming ${method} failed ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return response.status === 204 ? null : response.json();
  }

  createEvaluation(name) {
    return this.request('/openai/evals', 'POST', {
      name,
      data_source_config: { type: 'azure_ai_source', scenario: 'red_team' },
      testing_criteria: [
        { type: 'azure_ai_evaluator', name: 'Prohibited actions', evaluator_name: 'builtin.prohibited_actions', evaluator_version: '1' },
        { type: 'azure_ai_evaluator', name: 'Task adherence', evaluator_name: 'builtin.task_adherence', evaluator_version: '1', initialization_parameters: { deployment_name: this.cfg.model } },
        { type: 'azure_ai_evaluator', name: 'Sensitive data leakage', evaluator_name: 'builtin.sensitive_data_leakage', evaluator_version: '1' }
      ]
    });
  }

  createTaxonomy(name, target) {
    return this.request(`/evaluationtaxonomies/${encodeURIComponent(name)}`, 'PUT', {
      description: 'Data Cortex synthetic sandbox agent assurance',
      taxonomyInput: { type: 'agent', target, riskCategories: ['ProhibitedActions'] }
    });
  }

  getTaxonomy(name) {
    return this.request(`/evaluationtaxonomies/${encodeURIComponent(name)}`);
  }

  enableTaxonomy(name, taxonomy) {
    const categories = taxonomy.taxonomyCategories;
    if (!categories?.some((c) => c.subCategories?.length)) throw new Error('Foundry generated no prohibited-action scenarios to assess.');
    return this.request(`/evaluationtaxonomies/${encodeURIComponent(name)}`, 'PATCH', {
      id: taxonomy.id, name: taxonomy.name, version: taxonomy.version,
      description: 'Data Cortex automatic sandbox policy: assess every generated prohibited action',
      taxonomyCategories: categories.map((c) => ({
        ...c, subCategories: (c.subCategories || []).map((s) => ({ ...s, enabled: true }))
      }))
    });
  }

  start(record) {
    return this.request(`/openai/evals/${encodeURIComponent(record.evalId)}/runs`, 'POST', {
      name: `Data Cortex ${record.id}`,
      data_source: {
        type: 'azure_ai_red_team',
        item_generation_params: {
          type: 'red_team_taxonomy', attack_strategies: ['Flip', 'Base64', 'IndirectJailbreak'],
          num_turns: 5, source: { type: 'file_id', id: record.taxonomy.id }
        },
        target: record.target
      }
    });
  }

  getRun(record) {
    return this.request(`/openai/evals/${encodeURIComponent(record.evalId)}/runs/${encodeURIComponent(record.runId)}`);
  }

  async outputItems(record) {
    const items = [];
    let after;
    const cursors = new Set();
    do {
      const suffix = after ? `?after=${encodeURIComponent(after)}` : '';
      const page = await this.request(`/openai/evals/${encodeURIComponent(record.evalId)}/runs/${encodeURIComponent(record.runId)}/output_items${suffix}`);
      if (!Array.isArray(page.data)) throw new Error('Foundry returned an invalid output-items page.');
      items.push(...page.data);
      if (items.length > 10000) throw new Error('Red team report exceeds the 10,000-item limit; inspect it in Foundry.');
      if (!page.has_more) return items;
      after = page.last_id || page.data.at(-1)?.id;
      if (!after || cursors.has(after)) throw new Error('Foundry returned an invalid output-items cursor.');
      cursors.add(after);
    } while (after);
    return items;
  }
}
