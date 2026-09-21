import { esc, layout } from '../layout.js';

const ARTICLE = 'https://blogs.microsoft.com/blog/2026/06/02/ai-alone-wont-change-your-business-the-system-running-it-will/';
const sections = [
  ['purpose', 'The opportunity'], ['problem', 'The problem'], ['system', 'The system, not just the model'],
  ['architecture', 'Business architecture'], ['value', 'What changes'], ['journey', 'See it in action'],
  ['governance', 'Trust and control'], ['readiness', 'The leadership decision']
];

function architecture() {
  return `<figure class="cx-exec-diagram">
    <svg viewBox="0 0 1080 900" role="img" aria-labelledby="architecture-title architecture-desc" style="display:block;width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">
      <title id="architecture-title">From a business question to a reusable, governed capability</title>
      <desc id="architecture-desc">People use one Data Cortex front door to discover, ask, build, test, publish and orchestrate. Purview provides trusted context, Foundry runs agents and assessments, and API Management connects reusable capabilities. Identity, human accountability and operational evidence surround the flow, on an Azure landing-zone foundation.</desc>
      <defs><marker id="cx-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#54708d"/></marker></defs>
      <rect x="16" y="16" width="1048" height="868" rx="20" fill="#f0f5fa" stroke="#c5d5e5"/>
      <text x="540" y="49" text-anchor="middle" font-size="18" fill="#17324d">TRUST THROUGHOUT: identity · access · evidence · human accountability</text>
      <rect x="126" y="75" width="828" height="66" rx="12" fill="#17324d"/>
      <text x="540" y="104" text-anchor="middle" font-size="23" fill="white" font-weight="700">Your people. Their questions. Your organisational knowledge.</text>
      <text x="540" y="128" text-anchor="middle" font-size="16" fill="#d6e5f5">Business users · Data owners · Agent builders · Platform and assurance teams</text>
      <path d="M540 143V173" stroke="#54708d" stroke-width="3" marker-end="url(#cx-arrow)"/>
      <rect x="66" y="177" width="948" height="104" rx="12" fill="#0067b8"/>
      <text x="540" y="215" text-anchor="middle" font-size="28" fill="white" font-weight="700">DATA CORTEX — ONE FRONT DOOR</text>
      <text x="540" y="251" text-anchor="middle" font-size="21" fill="white">Discover → Ask → Build → Test → Publish → Coordinate agents</text>
      <path d="M540 283V310M204 337V310H876V337M540 310V337" stroke="#54708d" stroke-width="3" fill="none"/>
      ${[
        { x: 46, name: 'TRUSTED CONTEXT', product: 'Microsoft Purview', lines: ['Find data and its owner', 'Understand meaning and access', 'Data Map + Unified Catalog'] },
        { x: 382, name: 'INTELLIGENT WORK', product: 'Microsoft Foundry', lines: ['Build and run agents', 'Ground answers in knowledge', 'Native red-team assessments'] },
        { x: 718, name: 'REUSABLE CAPABILITIES', product: 'API Management', lines: ['Connect APIs and MCP tools', 'Publish tested agent endpoints', 'Reuse across teams'] }
      ].map((c) => `<rect x="${c.x}" y="342" width="316" height="169" rx="12" fill="white" stroke="#9cb6cf"/>
        <text x="${c.x + 158}" y="371" text-anchor="middle" font-size="16" fill="#44627e" font-weight="700">${c.name}</text>
        <text x="${c.x + 158}" y="405" text-anchor="middle" font-size="24" fill="#17324d" font-weight="700">${c.product}</text>
        ${c.lines.map((line, i) => `<text x="${c.x + 158}" y="${437 + i * 25}" text-anchor="middle" font-size="17" fill="#17324d">${line}</text>`).join('')}`).join('')}
      <rect x="46" y="534" width="988" height="322" rx="12" fill="#dce9f4"/>
      <text x="540" y="563" text-anchor="middle" font-size="21" fill="#17324d" font-weight="700">Azure landing-zone foundation</text>
      <text x="540" y="590" text-anchor="middle" font-size="16" fill="#17324d">A governed platform for repeatable AI adoption, not a collection of isolated demos</text>
      ${[
        ['Identity and access', 'Entra, workload identities, RBAC', 'Accountable owners and least privilege'],
        ['Networking and connectivity', 'Perimeter, private endpoints, DNS', 'Controlled ingress and egress'],
        ['Data and session services', 'Storage, Search, durable state', 'Retention, residency and recovery'],
        ['Security and governance', 'Policy, secrets, classification', 'Threat protection and assurance'],
        ['Operate and improve', 'Monitor, traces, evaluation evidence', 'SLOs, incident response and FinOps'],
        ['Platform engineering', 'Subscriptions, IaC and release stages', 'Reusable deployments and rollback']
      ].map(([name, line1, line2], i) => {
        const x = 62 + (i % 3) * 326, y = 610 + Math.floor(i / 3) * 106;
        return `<rect x="${x}" y="${y}" width="310" height="94" rx="8" fill="white" stroke="#b4cadf"/>
          <text x="${x + 155}" y="${y + 25}" text-anchor="middle" font-size="17" font-weight="700" fill="#17324d">${name}</text>
          <text x="${x + 155}" y="${y + 50}" text-anchor="middle" font-size="14" fill="#17324d">${line1}</text>
          <text x="${x + 155}" y="${y + 73}" text-anchor="middle" font-size="13" fill="#44627e">${line2}</text>`;
      }).join('')}
      <text x="540" y="840" text-anchor="middle" font-size="13" fill="#44627e">Foundation cards describe the target design; service availability and controls depend on the deployed estate.</text>
    </svg>
    <figcaption class="govuk-body-s">A connected user experience over Microsoft platform services, not a replacement for them. Databricks, Fabric and Microsoft 365 connect through governed adapters; Teams and Copilot delivery use Azure Bot Service after assessment and tenant approval. Foundation cards are the target landing-zone design, not a claim that every control is deployed.</figcaption>
    <details class="govuk-details"><summary>Architecture text alternative</summary><p class="govuk-body">A business user enters through Data Cortex. Purview identifies data, owners and access routes. Foundry runs agents and native assessments. API Management exposes APIs, GraphQL and MCP capabilities. Databricks, Fabric and Microsoft 365 are connected sources; Azure Bot Service delivers approved agents to Teams and Copilot. The target Azure landing zone combines identity and RBAC; private networking and controlled egress; storage, search and session retention; policy, secrets and threat protection; monitoring, evaluation and FinOps; subscription organisation, infrastructure as code and rollback. These are design areas to implement and validate in each customer estate, not a blanket certification of the sandbox.</p></details>
  </figure>`;
}

export function aboutPage(ctx, { stats = {}, coverage = {} } = {}) {
  const cards = (items) => `<div class="cx-exec-grid">${items.map(([title, body]) => `<article class="cx-exec-card"><h3 class="govuk-heading-m">${title}</h3><p class="govuk-body">${body}</p></article>`).join('')}</div>`;
  return layout({ ...ctx, title: 'About Data Cortex', section: 'about' }, `
  <div class="cx-exec">
    <header class="cx-exec-hero">
      <p class="cx-exec-eyebrow">Microsoft technology accelerator · Leadership briefing</p>
      <h1>Turn disconnected AI experiments<br>into shared organisational capability.</h1>
      <p>One place to discover trusted data, build and test agents, and reuse what works — connecting people to the value of your Microsoft AI landing zone.</p>
      <a class="govuk-button" href="/marketplace">Explore the live marketplace</a>
      <a class="cx-exec-hero-link" href="#architecture">See the business architecture ↓</a>
    </header>
    <nav class="cx-exec-contents" aria-label="About contents">${sections.map(([id, title]) => `<a href="#${id}">${title}</a>`).join('')}</nav>
    <section id="purpose">
      <p class="cx-exec-eyebrow">01 / The opportunity</p>
      <h2 class="govuk-heading-l">Make your platform useful to the whole organisation.</h2>
      <p class="govuk-body-l">Investing in AI infrastructure is only the beginning. People need a practical way to find information, understand who can use it, turn it into useful agents, and share those capabilities without rebuilding the same connections.</p>
      <p class="govuk-body">Data Cortex is that demonstration: a customer-neutral front door to Microsoft Purview, API Management and Foundry. The same code and synthetic demonstration pack can introduce the connected platform story to any industry.</p>
      <div class="cx-exec-metrics"><div><strong>${esc(coverage.registered ?? stats.entries ?? 0)}</strong> registered entries</div><div><strong>${esc(stats.domains ?? stats.clusters ?? 0)}</strong> governance domains</div><div><strong>One</strong> connected experience</div></div>
      <p class="govuk-hint">Figures are read live from the register. They describe registered content, not total estate coverage or realised business value. Unavailable sources can leave the register incomplete.</p>
    </section>
    <section id="problem">
      <p class="cx-exec-eyebrow">02 / The problem</p>
      <h2 class="govuk-heading-l">The bottleneck is often the work around the AI.</h2>
      ${cards([
        ['Knowledge is hard to find', 'Useful data, APIs and agents sit behind different portals. People rely on personal networks to find the right asset or owner.'],
        ['Teams repeat the same work', 'Every project reconnects systems and recreates context. A successful pilot does not automatically become a reusable capability.'],
        ['Trust arrives too late', 'Access, provenance and evaluation can become separate conversations after development. Leaders struggle to see what is ready to share.']
      ])}
      <p class="govuk-body">These are common design challenges, not claims about a particular customer. Cortex makes the alternative tangible in a live, synthetic demonstration.</p>
    </section>
    <section id="system" class="cx-exec-feature">
      <p class="cx-exec-eyebrow">03 / The strategic message</p>
      <h2>“AI alone won’t change your business. The system running it will.”</h2>
      <p>Microsoft's 2 June 2026 article argues for a coherent operating system around AI: enterprise context, coordinated agents, governance and a human-directed improvement loop — not simply more chatbots or isolated pilots.</p>
      <p><a href="${ARTICLE}">Read the original Microsoft article</a></p>
      ${cards([
        ['One integrated system', '<strong>Cortex makes it visible:</strong> discovery, composition, assessment and publication connect the catalogue, runtime and gateway in one user journey. The model is one component, not the whole solution.'],
        ['Secured and governed by design', '<strong>Cortex makes it practical:</strong> sign-in, explicit access routes, source context and pre-publication red-team evidence appear in the workflow. Platform controls and accountable owners still matter.'],
        ['Improve continuously', '<strong>Cortex makes it repeatable:</strong> inspect outputs, review evaluation findings, revise an agent, test again and share a reusable version. This is a governed improvement loop, not autonomous self-training.']
      ])}
      <p>The article's broader platform vision includes GitHub, Microsoft IQ, Agent 365 and Microsoft 365. Those are strategic integration opportunities, not capabilities this PoC claims to have implemented.</p>
    </section>
    <section id="architecture">
      <p class="cx-exec-eyebrow">04 / The business architecture</p>
      <h2 class="govuk-heading-l">One front door. Clear responsibilities behind it.</h2>
      ${architecture()}
    </section>
    <section id="value">
      <p class="cx-exec-eyebrow">05 / What changes</p>
      <h2 class="govuk-heading-l">From individual projects to reusable building blocks.</h2>
      <table class="govuk-table"><caption class="govuk-table__caption">The operating-model shift this accelerator demonstrates</caption><thead><tr><th scope="col">Today’s friction</th><th scope="col">The Cortex experience</th><th scope="col">What to measure in a pilot</th></tr></thead><tbody>
        <tr><td>Find the right person, then the right system</td><td>Discover products, owners, access routes and dependencies in one register</td><td>Time to find a suitable asset or accountable owner</td></tr>
        <tr><td>Build a new integration for each question</td><td>Compose agents from existing data, APIs and MCP tools</td><td>Reuse rate and time to first useful draft</td></tr>
        <tr><td>Demonstrate an answer without its evidence</td><td>Review sources, limits, tool calls and assessment output</td><td>Grounded-answer quality and reviewer acceptance</td></tr>
        <tr><td>Pass work manually between disconnected tools</td><td>Coordinate ordered agents with step results and a final human-reviewed draft</td><td>Handoffs avoided and exception-handling effort</td></tr>
      </tbody></table>
      ${cards([
        ['For business teams', 'A simpler route from a question to the right capability, with clear next steps when access is restricted.'],
        ['For data owners and builders', 'Make assets discoverable, see demand, and turn a useful agent into a capability others can reuse.'],
        ['For platform and assurance leaders', 'Show how existing Microsoft services work together, with visible evidence and an explicit route to production controls.']
      ])}
      <p class="govuk-hint">Benefits are hypotheses to measure with a customer, not guaranteed savings, compliance outcomes or return-on-investment figures.</p>
    </section>
    <section id="journey">
      <p class="cx-exec-eyebrow">06 / A five-minute demonstration</p>
      <h2 class="govuk-heading-l">See the connected journey, not just a model response.</h2>
      <ol class="govuk-list govuk-list--number govuk-list--spaced">
        <li><strong>Discover:</strong> browse the marketplace and domain map; open a synthetic product and its owner, schema and access route.</li>
        <li><strong>Ask and compose:</strong> explore accessible context, then build an agent from available knowledge and read-only tools.</li>
        <li><strong>Test and publish:</strong> one action starts native Foundry red teaming; publication waits for complete passing evidence and pins the tested version.</li>
        <li><strong>Coordinate:</strong> chain two or more agents, retaining each result and a final draft for human review.</li>
        <li><strong>Reuse and improve:</strong> inspect the evidence, revise the capability, and assess it again before sharing a new version.</li>
      </ol>
      <p class="govuk-body">A second identity can demonstrate access differences. Microsoft-inspired and Novo Nordisk-inspired apps present the same neutral story; branding is not an access or customer-isolation boundary.</p>
    </section>
    <section id="governance">
      <p class="cx-exec-eyebrow">07 / Trust and control</p>
      <h2 class="govuk-heading-l">Evidence before sharing. Accountability after it.</h2>
      ${cards([
        ['Identity and context', 'Entra sign-in and group mappings inform access routes. Agent creation validates attachments server-side; data owners remain accountable for access and meaning.'],
        ['Assessment in the workflow', 'Native Foundry red teaming runs before new publication. Failed, incomplete or stale assessments block it. Passing an automated scan is not a safety certification.'],
        ['Human judgement remains central', 'Requests require a human release and multi-agent tasks retain drafts. External tools still need independent authorization and read-only controls.']
      ])}
      <p class="govuk-body">Metadata, transcripts and assessment evidence are stored; synthetic files are indexed for grounding. This is not a claim that nothing moves. Scheduled tasks use captured owner permissions, and shared backend services are not a customer isolation boundary.</p>
    </section>
    <section id="readiness" class="cx-exec-decision">
      <p class="cx-exec-eyebrow">08 / The leadership decision</p>
      <h2 class="govuk-heading-l">Back a measured next step, not an unbounded rollout.</h2>
      <p class="govuk-body-l">Select a low-risk workflow, name its business and data owners, agree the success measures, and use the accelerator to evaluate the connected platform experience.</p>
      <p class="govuk-body"><strong>What this PoC demonstrates:</strong> connected discovery, governed composition, evaluation-led publication and ordered multi-agent drafts using real Microsoft services and synthetic content.</p>
      <p class="govuk-body"><strong>Before production:</strong> validate workload-specific risks, live permission revalidation, scoped identities and tool authorization, durable multi-writer state, network controls, monitoring, retention and operational ownership. Preview API and model availability must be established in the target environment.</p>
      <p class="govuk-body">No customer endorsement, production certification, medical or other professional decision support, or measured business outcome is implied. The opportunity is to demonstrate the system, then prove its value responsibly.</p>
      <a class="govuk-button" href="/marketplace">Start with the marketplace</a>
    </section>
  </div>`);
}
