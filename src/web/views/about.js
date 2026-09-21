/**
 * About — the story of Cortex for two audiences on one page.
 *
 * Leadership first (the problem, what changes, why it is safe, what we need),
 * then what it means for the person using it, then how it is built. Every
 * figure on the page is either read live from the register or is a worked
 * example that says so — the same "no number without a source" rule as the
 * rest of the service.
 *
 * No client JavaScript. The diagrams are inline SVG and CSS, each with a text
 * alternative, so the page reads the same with images off or a screen reader on.
 */

import { esc, attr, visMark, layout } from '../layout.js';
import { VIS, VIS_ORDER } from '../../bff/services/visibility.js';

/* ----------------------------------------------------------- content */

const CONTENTS = [
  ['in-brief', 'In brief'],
  ['the-problem', 'The problem we are solving'],
  ['as-is-to-be', 'From four platforms to one front door'],
  ['what-changes', 'What changes'],
  ['for-you', 'What it means for you'],
  ['how-it-works', 'How it works'],
  ['why-safe', 'Why it is safe'],
  ['where-next', 'Where we are and what we need']
];

/** The as-is / to-be comparison, from the architecture review. */
const COMPARE = [
  {
    n: '01',
    theme: 'Interface',
    asIs: 'No front door. Copilot and Teams agents are turned off for anyone outside the Cloud Centre of Excellence.',
    toBe: 'Cortex in the browser is the front door, open to any member of staff who signs in.'
  },
  {
    n: '02',
    theme: 'Orchestration',
    asIs: 'The catalogue, the gateway and the agent platform are all live in the landing zone. The plumbing is in.',
    toBe: 'Unchanged. Nothing is replaced and nothing moves.'
  },
  {
    n: '03',
    theme: 'Connection',
    asIs: 'The platforms cannot talk to each other as agents. Four systems, each answering only for itself.',
    toBe: 'A thin slice of connections, and one principle: every platform exposes an API and an agent interface by default.'
  },
  {
    n: '04',
    theme: 'Data and agents',
    asIs: 'Projects, each with its own AI and its own data, each answering only for itself.',
    toBe: 'The same platforms, now reachable from one place. Data stays where it is.'
  }
];

/** Worked example from the architecture review: management information today and with Cortex. */
const HANDOFFS_TODAY = [
  ['Manager asks', 'Tells the management information team.'],
  ['Request goes out', 'By email, spreadsheet or form.'],
  ['Responder digs', 'Logs in, runs a report, finds the data.'],
  ['Responder replies', 'The answer comes back by email.'],
  ['Paste and collate', 'Into a spreadsheet with all the others.'],
  ['Feeds a dashboard', 'The spreadsheet is connected to a dashboard.'],
  ['Manager reads', 'Looks at the dashboard.']
];

const HANDOFFS_CORTEX = [
  ['Manager asks once', 'In one place. Cortex first checks what they can already reach themselves.'],
  ['The holder’s agent drafts first', 'Before the responder opens the request, their agent has read it, drafted an answer from data it is allowed to reach, and recorded the method.'],
  ['The holder reviews and releases', 'Checks the method and the answer, then releases it. Nothing leaves without a person.'],
  ['Dashboard updates', 'The response feeds the dashboard, with its method attached.']
];

const VALUE = [
  {
    title: 'Governed by default',
    body: 'Who you are in Microsoft Entra decides what you see. Nothing in Cortex grants access on its own, and an agent can never reach further than the person who built it.'
  },
  {
    title: 'Nothing copied, nothing moves',
    body: 'Cortex connects to data where it lives. There is no upload, no file picker and no second copy to govern.'
  },
  {
    title: 'Reuse over rebuild',
    body: 'Every agent anyone publishes becomes a part in the marketplace that the next team can build with. That is the difference between thousands of agents and a platform.'
  },
  {
    title: 'The method comes with the answer',
    body: 'Every answer names its sources, how fresh they are and what it could not reach. No number appears without a source.'
  }
];

const JOURNEY = [
  {
    step: 'Find',
    href: '/marketplace',
    label: 'Marketplace',
    body: 'Data, skills and agents from across Defra in one register. Every entry states honestly whether you can use it, and what to do if you cannot.',
    state: 'Working'
  },
  {
    step: 'Ask',
    href: '/ask',
    label: 'Ask a question',
    body: 'A question answered from the catalogue entries you are allowed to reach, with sources, freshness and what it could not reach.',
    state: 'Working'
  },
  {
    step: 'Build',
    href: '/build',
    label: 'Build an agent',
    body: 'Pick an approved model, tick the knowledge and actions you may use. Anything you cannot use is greyed out and explained. Seven assurance gates are worked out for you.',
    state: 'Working'
  },
  {
    step: 'Share',
    href: '/share',
    label: 'Share your data',
    body: 'Publish your agent back as a reusable part, or register data you hold and handle requests for it.',
    state: 'Working'
  },
  {
    step: 'Request',
    href: '/requests',
    label: 'Requests',
    body: 'Allowed the answer but not the data? Ask the person who holds it. Their agent drafts, they review and release.',
    state: 'Working'
  },
  {
    step: 'Automate',
    href: '/automate',
    label: 'Automate a task',
    body: 'Automations that draft, with a person at the checkpoint. Everything starts propose-only.',
    state: 'Next'
  }
];

const SAFE = [
  {
    title: 'Access management is unchanged',
    body: 'Nobody sees data they could not see before. The person who holds it still holds it and still runs the query.'
  },
  {
    title: 'Quality is approved',
    body: 'The method is recorded with the answer and reviewed before anything is released.'
  },
  {
    title: 'Appropriateness is managed',
    body: 'A person still decides whether this answer should be given at all. It is released by the person who was always accountable for it.'
  }
];

const PATTERN_REUSE = [
  'Freedom of information',
  'Parliamentary questions',
  'Spending Review 27',
  'Outcome reporting',
  'Financial requests'
];

const STATUS = [
  ['Marketplace, entry standard and map', 'Working'],
  ['Build an agent → assurance gates → test → publish → reappears in the marketplace', 'Working'],
  ['Ask, with sources and provenance, answered by a live agent', 'Working'],
  ['Requests: draft inside the holder’s permissions, a person releases', 'Working'],
  ['Share your data and the access-request queue', 'Working'],
  ['Automate a task', 'Next'],
  ['Requests and conversations kept across restarts', 'Next'],
  ['Granting access in the catalogue when a request is approved', 'Next'],
  ['Repeat requests issued on a schedule', 'Next']
];

const NOT_BUILT = [
  ['Automations that write to a source system', 'Agents read, summarise and cite in this phase. Nothing writes until an accountable owner turns it on.'],
  ['Reference data and canonical entities', 'The owning role does not yet exist. We do not build on a dependency the department has flagged as absent.'],
  ['Cost per use, carbon and estate coverage figures', 'No live source. Removed rather than labelled illustrative — a figure nobody can defend is worse than an absent one.']
];

const PROVE = [
  ['Landing-zone colleagues', 'Build with the people who own the plumbing, so we know it is connected to the interface.'],
  ['Management information', 'A live issue today. Get the management information function using it for real requests.'],
  ['Waste Crime observatory', 'A new capability emerging now — a good build, test and learn space. Get them on it as it is being built.']
];

const ASK = [
  'Adopt one architecture principle: every platform exposes an API and an agent interface by default. Thin slice first, not the whole estate.',
  'Turn Copilot and Teams agents on for people outside the Cloud Centre of Excellence, so the front door has somewhere to lead.',
  'Name a sponsor for each of the three proving grounds and let the proof of concept carry their real requests.',
  'Agree the next phase so requests and answers can be kept and the pattern can be reused beyond management information.'
];

/* ---------------------------------------------------------- partials */

function tag(state) {
  const tone = state === 'Working' ? 'green' : state === 'Next' ? 'blue' : 'grey';
  return `<strong class="govuk-tag govuk-tag--${tone}">${esc(state)}</strong>`;
}

function hero() {
  return `
<section class="cortex-about-hero" aria-labelledby="about-heading">
  <div class="cortex-about-hero__inner">
    <span class="govuk-caption-l cortex-about-hero__caption">About Cortex</span>
    <h1 id="about-heading" class="govuk-heading-xl cortex-about-hero__title">One front door to what Defra already has.</h1>
    <p class="govuk-body-l cortex-about-hero__lede">
      Find the data, skills and agents Defra already holds. Build something with them.
      Share what you build — without changing who is allowed to see what.
    </p>
    <div class="cortex-about-hero__actions">
      <a class="govuk-button cortex-about-hero__button" href="/marketplace" role="button">Start now</a>
      <a class="govuk-link cortex-about-hero__link" href="#how-it-works">How it works</a>
    </div>
    <p class="cortex-about-hero__note">
      A proof of concept by the Cloud Centre of Excellence with the Strategic Innovation Team.
      Everything on it is live.
    </p>
  </div>
</section>`;
}

function contents() {
  return `
<nav class="cortex-about-contents" aria-label="On this page">
  <h2 class="govuk-heading-s govuk-!-margin-bottom-0">On this page</h2>
  <ol class="govuk-list cortex-about-contents__list">
    ${CONTENTS.map(([id, label]) => `<li><a class="govuk-link" href="#${attr(id)}">${esc(label)}</a></li>`).join('')}
  </ol>
</nav>`;
}

function inBrief(ctx, { stats, coverage }) {
  const cats = Object.entries(stats.byCat || {})
    .map(([k, v]) => `${esc(v)} ${esc(String(k).toLowerCase())}`)
    .join(' · ');
  const domains = Object.keys(coverage.byDomain || {}).length;
  return `
<section id="in-brief" class="cortex-about-section">
  <h2 class="govuk-heading-l">In brief</h2>
  <p class="govuk-body-l cortex-about-strap">The plumbing is in. Two gaps. One proof of concept.</p>
  <ol class="cortex-about-three">
    <li>
      <span class="cortex-about-three__n" aria-hidden="true">1</span>
      <h3 class="govuk-heading-s">The plumbing is already in</h3>
      <p class="govuk-body">Defra’s data catalogue, API gateway and agent platform are live in the landing zone.
      What is missing is the front door, and the connections between them.</p>
    </li>
    <li>
      <span class="cortex-about-three__n" aria-hidden="true">2</span>
      <h3 class="govuk-heading-s">We built the two pieces nobody ships</h3>
      <p class="govuk-body">Your catalogue as something an agent can read, and a way to publish an agent back
      as a reusable part. Neither is a new platform.</p>
    </li>
    <li>
      <span class="cortex-about-three__n" aria-hidden="true">3</span>
      <h3 class="govuk-heading-s">Every agent becomes a part</h3>
      <p class="govuk-body">Every agent anyone builds becomes a part everyone else can build with.
      That is the difference between thousands of agents and a platform.</p>
    </li>
  </ol>

  <div class="cortex-about-register">
    <div class="cortex-stats">
      <div class="cortex-stat">
        <span class="cortex-stat__n">${esc(stats.entries)}</span>
        <span class="cortex-stat__l">entries in the register today</span>
      </div>
      <div class="cortex-stat">
        <span class="cortex-stat__n">${esc(domains)}</span>
        <span class="cortex-stat__l">governance domain${domains === 1 ? '' : 's'}</span>
      </div>
      <div class="cortex-stat">
        <span class="cortex-stat__n">3</span>
        <span class="cortex-stat__l">platforms behind one front door</span>
      </div>
      <div class="cortex-stat">
        <span class="cortex-stat__n">0</span>
        <span class="cortex-stat__l">copies of anyone’s data</span>
      </div>
    </div>
    <p class="cortex-src">
      ${cats ? `${cats}. ` : ''}Read live from the register${ctx.lastRefresh ? `, last refreshed ${esc(ctx.lastRefresh)}` : ''}.
      What is registered is a fact; what exists unregistered is unknown, and we say so rather than estimate it.
    </p>
  </div>
</section>`;
}

function problem() {
  const steps = (list, cls) =>
    `<ol class="cortex-about-handoffs ${cls}">
      ${list
        .map(
          ([t, d], i) => `<li class="cortex-about-handoffs__step">
            <span class="cortex-about-handoffs__n" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
            <span class="cortex-about-handoffs__body"><strong>${esc(t)}</strong><br>${esc(d)}</span>
          </li>`
        )
        .join('')}
    </ol>`;
  return `
<section id="the-problem" class="cortex-about-section">
  <h2 class="govuk-heading-l">The problem we are solving</h2>
  <p class="govuk-body-l cortex-about-strap">Allowed the answer. Not allowed the data.</p>
  <div class="govuk-grid-row">
    <div class="govuk-grid-column-two-thirds">
      <p class="govuk-body">
        A manager wants average days sick per employee. They are entitled to that answer. They are not
        entitled to the individual records behind it. Their AI inherits their access, so it cannot reach
        the records either — and that means an email, a spreadsheet and a week.
      </p>
      <p class="govuk-body">
        Two failures follow. <strong>No answer</strong>: their AI cannot give them a number they are
        allowed to have. <strong>No quality assurance</strong>: even with access, the requester is not
        expert enough in the data to check how the number was reached.
      </p>
      <p class="govuk-body">
        The same shape appears wherever someone must answer for data they hold. Management
        information is where it hurts most today, so that is where Cortex starts.
      </p>
    </div>
    <div class="govuk-grid-column-one-third">
      <div class="cortex-about-callout">
        <p class="govuk-body govuk-!-margin-bottom-0"><strong>What this costs today</strong></p>
        <ul class="govuk-list govuk-list--bullet govuk-!-margin-bottom-0">
          <li>A veneer of digitisation over manual work</li>
          <li>High cost to change anything</li>
          <li>Many places for it to go wrong</li>
        </ul>
      </div>
    </div>
  </div>

  <div class="cortex-about-compare cortex-about-compare--steps">
    <div class="cortex-about-compare__col">
      <h3 class="govuk-heading-m">Today: seven handoffs to produce one number</h3>
      ${steps(HANDOFFS_TODAY, 'cortex-about-handoffs--today')}
    </div>
    <div class="cortex-about-compare__col cortex-about-compare__col--to-be">
      <h3 class="govuk-heading-m">With Cortex: the same request, answered before it is opened</h3>
      ${steps(HANDOFFS_CORTEX, 'cortex-about-handoffs--cortex')}
      <p class="govuk-body-s govuk-!-margin-bottom-0">
        <strong>What changed:</strong> one step. Nothing about who holds the data changes. The work
        happens before the responder opens the request, and the method comes with the answer.
      </p>
    </div>
  </div>
  <p class="cortex-src">A worked example from the architecture review, not a measurement.</p>
</section>`;
}

function asIsToBe() {
  return `
<section id="as-is-to-be" class="cortex-about-section">
  <h2 class="govuk-heading-l">From four platforms to one front door</h2>
  <p class="govuk-body-l cortex-about-strap">Two additions make what Defra already owns usable. Neither is a new platform.</p>
  <table class="govuk-table cortex-about-table">
    <caption class="govuk-table__caption govuk-skip-link">As is and to be, by layer</caption>
    <thead>
      <tr>
        <th scope="col" class="govuk-table__header cortex-about-table__theme">Layer</th>
        <th scope="col" class="govuk-table__header">As is</th>
        <th scope="col" class="govuk-table__header cortex-about-table__to-be">To be</th>
      </tr>
    </thead>
    <tbody>
      ${COMPARE.map(
        (c) => `<tr class="govuk-table__row">
          <th scope="row" class="govuk-table__header cortex-about-table__theme">
            <span class="cortex-about-table__n" aria-hidden="true">${esc(c.n)}</span>${esc(c.theme)}
          </th>
          <td class="govuk-table__cell">${esc(c.asIs)}</td>
          <td class="govuk-table__cell cortex-about-table__to-be">${esc(c.toBe)}</td>
        </tr>`
      ).join('')}
    </tbody>
  </table>
</section>`;
}

function whatChanges() {
  return `
<section id="what-changes" class="cortex-about-section">
  <h2 class="govuk-heading-l">What changes</h2>
  <ul class="cortex-about-tiles">
    ${VALUE.map(
      (v) => `<li class="cortex-about-tile">
        <h3 class="govuk-heading-s">${esc(v.title)}</h3>
        <p class="govuk-body-s govuk-!-margin-bottom-0">${esc(v.body)}</p>
      </li>`
    ).join('')}
  </ul>

  <h3 class="govuk-heading-m">Each answer makes the next one cheaper</h3>
  <ol class="cortex-about-cycle">
    <li><strong>Remove the friction.</strong> Manually collected data becomes easy to ask for and easy to share.</li>
    <li><strong>Requests increase.</strong> More people ask, because asking now works.</li>
    <li><strong>Owners see demand.</strong> Data owners can see what is being asked of them.</li>
    <li><strong>Owners publish.</strong> They make a live version available, and the manual burden falls.</li>
  </ol>
  <p class="govuk-body">
    Build it once for management information. The pattern then serves any request where the answer is
    allowed and the data is not:
    ${PATTERN_REUSE.map((p) => `<strong class="govuk-tag govuk-tag--grey cortex-about-chip">${esc(p)}</strong>`).join(' ')}
  </p>
</section>`;
}

function forYou() {
  return `
<section id="for-you" class="cortex-about-section">
  <h2 class="govuk-heading-l">What it means for you</h2>
  <p class="govuk-body-l cortex-about-strap">Sign in with your normal account. What you can see is what you were already allowed to see.</p>
  <ol class="cortex-about-journey">
    ${JOURNEY.map(
      (j, i) => `<li class="cortex-about-journey__step">
        <span class="cortex-about-journey__n" aria-hidden="true">${i + 1}</span>
        <h3 class="govuk-heading-s cortex-about-journey__title">
          <a class="govuk-link" href="${attr(j.href)}">${esc(j.step)}</a>
          <span class="cortex-src">${esc(j.label)}</span>
        </h3>
        <p class="govuk-body-s">${esc(j.body)}</p>
        ${tag(j.state)}
      </li>`
    ).join('')}
  </ol>

  <h3 class="govuk-heading-m">Every entry tells you where you stand</h3>
  <p class="govuk-body">
    The marketplace never shows a dead end. Each entry carries one of six states, worked out from your
    group membership, and each state says what to do next.
  </p>
  <dl class="cortex-about-states">
    ${VIS_ORDER.map(
      (s) => `<div class="cortex-about-states__row">
        <dt>${visMark(s)}</dt>
        <dd>${esc(VIS[s].next)}</dd>
      </div>`
    ).join('')}
  </dl>
  <p class="govuk-body">
    Sign in as a different person and the same page renders differently. Access is shown, not asserted.
    <a class="govuk-link" href="/profile">See what you can see.</a>
  </p>
</section>`;
}

/**
 * The architecture, as an inline SVG with a text alternative underneath.
 * Product names appear here deliberately: the point of this section is that
 * Cortex sits on things Defra already pays for.
 */
function diagram() {
  const f = 'font-family="GDS Transport, arial, sans-serif"';
  const box = (x, y, w, h, fill, stroke, extra = '') =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="2" ${extra}/>`;
  const text = (x, y, s, size = 15, weight = 400, fill = '#0b0c0c', anchor = 'middle') =>
    `<text x="${x}" y="${y}" ${f} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
  const arrow = (x1, y1, x2, y2) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#505a5f" stroke-width="2" marker-end="url(#about-arrow)"/>`;

  const modules = ['Marketplace', 'Ask', 'Build', 'Publish', 'Requests'];
  const moduleBoxes = modules
    .map((m, i) => {
      const x = 70 + i * 176;
      return box(x, 186, 156, 44, '#ffffff', '#1d70b8') + text(x + 78, 214, m, 16, 700, '#0b0c0c');
    })
    .join('');

  const platforms = [
    ['Microsoft Purview', 'Data catalogue and governance', 'what exists, who owns it, what it means', 'reads catalogue metadata only'],
    ['Azure API Management', 'Gateway', 'APIs, agent endpoints, usage figures', 'publishes agents as reusable parts'],
    ['Microsoft Foundry', 'Agents and models', 'builds, tests and runs agents', 'creates and runs agents']
  ];
  const platformBoxes = platforms
    .map(([name, role, detail, link], i) => {
      const x = 50 + i * 310;
      const cx = x + 140;
      // The label sits on a white plate over the arrow so it stays legible.
      return (
        arrow(cx, 330, cx, 398) +
        box(cx - 115, 350, 230, 20, '#ffffff', '#ffffff') +
        text(cx, 365, link, 12, 400, '#505a5f') +
        box(x, 400, 280, 82, '#f3f2f1', '#0b0c0c') +
        text(cx, 428, name, 17, 700) +
        text(cx, 450, role, 14, 700, '#505a5f') +
        text(cx, 470, detail, 13, 400, '#505a5f')
      );
    })
    .join('');

  return `
<figure class="cortex-about-figure">
  <svg class="cortex-about-diagram" viewBox="0 0 1000 600" role="img" aria-labelledby="about-arch-title about-arch-desc" focusable="false">
    <title id="about-arch-title">How Cortex is built</title>
    <desc id="about-arch-desc">Staff sign in through the browser to Cortex, the front door. Cortex reads the data catalogue, publishes agents through the API gateway and runs them on the agent platform. Data stays on the platforms where it already lives.</desc>
    <defs>
      <marker id="about-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#505a5f"/>
      </marker>
    </defs>

    <!-- people -->
    ${box(50, 20, 900, 64, '#0b0c0c', '#0b0c0c')}
    ${text(500, 47, 'Any member of Defra staff', 18, 700, '#ffffff')}
    ${text(500, 70, 'Signs in with their normal Microsoft Entra account · a browser, nothing to install · works with JavaScript off', 13, 400, '#b1b4b6')}
    ${arrow(500, 84, 500, 138)}
    ${text(514, 116, 'group membership decides what they can see', 12, 400, '#505a5f', 'start')}

    <!-- cortex -->
    ${box(50, 140, 900, 190, '#ffffff', '#00703c', 'stroke-width="3"')}
    ${text(70, 168, 'Cortex — the front door', 18, 700, '#00703c', 'start')}
    ${text(930, 168, 'runs in Defra’s Azure landing zone · one identity of its own · no secrets in code', 12, 400, '#505a5f', 'end')}
    ${moduleBoxes}
    ${box(70, 246, 860, 36, '#f3f2f1', '#f3f2f1')}
    ${text(500, 269, 'Visibility engine (six states)  ·  Seven assurance gates  ·  Merged register of everything the platforms hold', 14, 700, '#0b0c0c')}
    ${box(70, 290, 424, 30, '#ffffff', '#4c2c92', 'stroke-dasharray="6 4"')}
    ${text(282, 310, 'Glue 1 · the catalogue as something an agent can read', 13, 400, '#4c2c92')}
    ${box(506, 290, 424, 30, '#ffffff', '#4c2c92', 'stroke-dasharray="6 4"')}
    ${text(718, 310, 'Glue 2 · an agent published back as a reusable part', 13, 400, '#4c2c92')}

    <!-- platforms -->
    ${platformBoxes}

    <!-- data -->
    ${box(50, 520, 900, 60, '#ffffff', '#b1b4b6', 'stroke-dasharray="6 4"')}
    ${text(500, 545, 'Data and platform agents stay where they already are', 15, 700, '#0b0c0c')}
    ${text(500, 567, 'Databricks · ServiceNow · AWS · Azure applications and data — nothing is copied and nothing moves', 13, 400, '#505a5f')}
  </svg>
  <figcaption class="cortex-src">Cortex sits on what Defra already owns. Only the front door and the two connections are new.</figcaption>
</figure>
<details class="govuk-details cortex-about-details">
  <summary class="govuk-details__summary"><span class="govuk-details__summary-text">Text version of this diagram</span></summary>
  <div class="govuk-details__text">
    <ol class="govuk-list govuk-list--number">
      <li><strong>People.</strong> Any member of Defra staff signs in with their normal Microsoft Entra account, in a browser. Their group membership decides what they can see.</li>
      <li><strong>Cortex, the front door.</strong> Marketplace, Ask, Build, Publish and Requests, resting on a visibility engine with six states, seven assurance gates and a merged register of everything the platforms hold. It runs in Defra’s Azure landing zone under one identity of its own, with no secrets in code.</li>
      <li><strong>Two pieces of glue.</strong> The catalogue exposed as something an agent can read — catalogue metadata only, never the underlying data — and a way to publish an agent back through the gateway as a reusable part.</li>
      <li><strong>The platforms Defra already owns.</strong> Microsoft Purview holds the data catalogue and governance. Azure API Management is the gateway for APIs, agent endpoints and usage figures. Microsoft Foundry builds, tests and runs agents.</li>
      <li><strong>The data.</strong> Databricks, ServiceNow, AWS and Azure applications and data stay where they already are. Nothing is copied and nothing moves.</li>
    </ol>
  </div>
</details>`;
}

function howItWorks() {
  return `
<section id="how-it-works" class="cortex-about-section">
  <h2 class="govuk-heading-l">How it works</h2>
  <p class="govuk-body-l cortex-about-strap">Cortex is not a new platform. It is the front door to three Defra already runs, and the connections between them.</p>
  ${diagram()}

  <div class="govuk-grid-row">
    <div class="govuk-grid-column-one-half">
      <h3 class="govuk-heading-m">The two pieces of glue</h3>
      <p class="govuk-body">
        <strong>Your catalogue as something an agent can read.</strong> There is no off-the-shelf way for an
        agent to look up a data product. Cortex provides one. It answers “what exists, who owns it, what
        does it mean” — never “give me the rows”. Catalogue metadata only, so the access-control story
        stays clean.
      </p>
      <p class="govuk-body">
        <strong>An agent published back as a reusable part.</strong> There is no off-the-shelf way to publish
        an agent through the gateway so the next agent can use it. Cortex generates the interface,
        registers it, and writes the endpoint back to the register. The loop closes: what you build is
        now something another team can build with.
      </p>
    </div>
    <div class="govuk-grid-column-one-half">
      <h3 class="govuk-heading-m">Built on what Defra already has</h3>
      <dl class="govuk-summary-list cortex-about-summary">
        <div class="govuk-summary-list__row">
          <dt class="govuk-summary-list__key">Reused</dt>
          <dd class="govuk-summary-list__value">The data catalogue, the API gateway, the agent platform, the key vault, the container registry and monitoring — as they are, where they are.</dd>
        </div>
        <div class="govuk-summary-list__row">
          <dt class="govuk-summary-list__key">Created</dt>
          <dd class="govuk-summary-list__value">Two small container apps and one identity of Cortex’s own, so its permissions can be reasoned about and revoked without touching anything else.</dd>
        </div>
        <div class="govuk-summary-list__row">
          <dt class="govuk-summary-list__key">Everything is live</dt>
          <dd class="govuk-summary-list__value">No demo mode, no sample data. Publish an agent and it is genuinely registered; retire a data product in the catalogue and it leaves the marketplace on the next refresh.</dd>
        </div>
        <div class="govuk-summary-list__row">
          <dt class="govuk-summary-list__key">Accessible by design</dt>
          <dd class="govuk-summary-list__value">GOV.UK Design System pages. No client-side scripts, so it works with JavaScript off and reads well with a screen reader. Every state is shown by shape and words, never colour alone.</dd>
        </div>
        <div class="govuk-summary-list__row">
          <dt class="govuk-summary-list__key">Re-runnable</dt>
          <dd class="govuk-summary-list__value">One command deploys it and can be run again safely. Nothing only works the first time.</dd>
        </div>
      </dl>
    </div>
  </div>
</section>`;
}

function whySafe() {
  return `
<section id="why-safe" class="cortex-about-section">
  <h2 class="govuk-heading-l">Why it is safe</h2>
  <p class="govuk-body-l cortex-about-strap">None of the controls move. Only the drafting does.</p>
  <ol class="cortex-about-three cortex-about-three--safe">
    ${SAFE.map(
      (s, i) => `<li>
        <span class="cortex-about-three__n" aria-hidden="true">${i + 1}</span>
        <h3 class="govuk-heading-s">${esc(s.title)}</h3>
        <p class="govuk-body">${esc(s.body)}</p>
      </li>`
    ).join('')}
  </ol>
  <div class="govuk-inset-text">
    <p class="govuk-body govuk-!-margin-bottom-0">
      Three rules are enforced in the service and tested, not just described: an agent can never reach
      further than the person who built it; a request is drafted inside the holder’s permissions, never
      the requester’s; and nothing reaches a requester until a person releases it.
    </p>
  </div>
</section>`;
}

function whereNext() {
  return `
<section id="where-next" class="cortex-about-section">
  <h2 class="govuk-heading-l">Where we are and what we need</h2>
  <p class="govuk-body-l cortex-about-strap">An alpha, live against Defra’s own platforms, with an honest list of what is next.</p>

  <div class="govuk-grid-row">
    <div class="govuk-grid-column-one-half">
      <h3 class="govuk-heading-m">Where we are</h3>
      <dl class="govuk-summary-list cortex-about-summary cortex-about-summary--status">
        ${STATUS.map(
          ([what, state]) => `<div class="govuk-summary-list__row">
            <dt class="govuk-summary-list__key">${esc(what)}</dt>
            <dd class="govuk-summary-list__value">${tag(state)}</dd>
          </div>`
        ).join('')}
      </dl>
      <p class="govuk-body-s">
        Backed by an automated test suite, and exercised against the real platforms in live runs. A small
        number of paths are written to the documented shapes but not yet run live, and the service
        status on the <a class="govuk-link" href="/help">Help page</a> shows what is reachable right now.
      </p>
    </div>
    <div class="govuk-grid-column-one-half">
      <h3 class="govuk-heading-m">Three places to prove it</h3>
      <p class="govuk-body">Start where the access, the capability and the live problem already are.</p>
      <ol class="govuk-list govuk-list--number govuk-list--spaced">
        ${PROVE.map(([who, why]) => `<li><strong>${esc(who)}.</strong> ${esc(why)}</li>`).join('')}
      </ol>

      <h3 class="govuk-heading-m">Deliberately not built yet</h3>
      <dl class="govuk-summary-list cortex-about-summary">
        ${NOT_BUILT.map(
          ([what, why]) => `<div class="govuk-summary-list__row">
            <dt class="govuk-summary-list__key">${esc(what)}</dt>
            <dd class="govuk-summary-list__value">${esc(why)}</dd>
          </div>`
        ).join('')}
      </dl>
    </div>
  </div>

  <div class="cortex-about-ask">
    <h3 class="govuk-heading-m">What we are asking for</h3>
    <ol class="govuk-list govuk-list--number govuk-list--spaced govuk-!-margin-bottom-0">
      ${ASK.map((a) => `<li>${esc(a)}</li>`).join('')}
    </ol>
  </div>

  <p class="govuk-body">
    Questions, ideas or a request to join a pilot: email
    <a class="govuk-link" href="mailto:sheng.zhu@defra.gov.uk">sheng.zhu@defra.gov.uk</a>,
    or try it now — <a class="govuk-link" href="/marketplace">open the marketplace</a>.
  </p>
</section>`;
}

/* -------------------------------------------------------------- page */

export function aboutPage(ctx, { stats, coverage }) {
  const content = `
${hero()}
<div class="govuk-grid-row">
  <div class="govuk-grid-column-one-quarter">
    ${contents()}
  </div>
  <div class="govuk-grid-column-three-quarters cortex-about-body">
    ${inBrief(ctx, { stats, coverage })}
    ${problem()}
    ${asIsToBe()}
    ${whatChanges()}
    ${forYou()}
    ${howItWorks()}
    ${whySafe()}
    ${whereNext()}
  </div>
</div>`;
  return layout({ ...ctx, title: 'About Cortex', section: 'about' }, content);
}

export default aboutPage;
