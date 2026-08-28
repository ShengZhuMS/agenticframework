# Cortex — Prioritised PoC backlog

**Derived from `Copy of cortex-capability-backlog.xlsx`. Every row traces to a capability ID in that workbook.**

---

## Why this document exists

The source backlog contains **190 unique capabilities across 359 capability×tool rows**, 9 sections, 18 users, 46 epics and 124 distinct tools. It is a specification of the whole product.

Critically, **the source made no PoC decisions**: the `In PoC` column reads `Undecided` on 326 rows and `No` on 33. Not one row says `Yes`. So this prioritisation is ours, and it is written down here so it can be argued with.

The workbook's own `Priority` column — 101 `Must`, 37 `Should`, 12 `Could`, 209 blank — was used as **an input, not the answer**. Several `Must` capabilities are out of the PoC because they serve the operational product rather than the sales narrative, and a handful of unprioritised ones are in because they carry disproportionate demo weight.

---

## The scoring model

| Axis | Question | Weight |
|---|---|---|
| **Demo weight** | Does the CTO see it in the twelve-minute golden path? | ×3 |
| **Proof weight** | Does it prove a claim that would otherwise be an assertion? Governance, provenance and the publish loop score highest. | ×2 |
| **Build cost** | Effort, with a heavy penalty for anything needing a new Azure service or a dependency the client has flagged as absent. | ×−1 |

A capability enters Phase 1 only if it is **on the golden path** or **proves something the golden path claims**.

---

## Phase 1 — build this (33 capabilities)

These are the demo. Nothing else ships until these run end to end.

#### Marketplace — find and filter

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-010 | Land on what exists rather than an empty search box | The marketplace list, not Ask, is the page a user arrives on. The ask box is offered from there as one route in, under the search field. | Must | WP3 |
| CAP-023 | Search the marketplace by name, owner or cluster | A single search field over the register matches free text against an entry’s name, description, owner team and cluster name. Results redraw as the use… | Must | WP3 |
| CAP-024 | Search from any page | A search field sits in the black masthead on every screen. Submitting it moves the user to the marketplace list with their term already applied. | Must | WP3 |
| CAP-025 | Filter what exists by category | Checkbox filters narrow the register to any combination of the four categories: agents, data, skills and apps. Category is derived rather than declare… | Must | WP3 |
| CAP-026 | Filter by cluster | Checkbox filters narrow the register to any of the nine clusters. Opening a cluster card from Browse by cluster applies the same filter and jumps to t… | — | WP3 |
| CAP-015 | See the visibility state and what to do next about it | Every entry carries one of six visibility states, each shown as a distinct shape with a label, and each mapped to a different next action: use it now,… | Must | WP4 |

#### Marketplace — the entry standard

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-039 | Open one entry and read the full entry standard | An entry page shows every mandatory field of the entry standard in a table, alongside a readable left column covering what it is, its limitations, its… | Must | WP5 |
| CAP-040 | See where each field came from and who maintains it | Every row of the entry standard table carries a small line naming its source and who maintains it, agent or human. The table caption states that owner… | Must | WP5 |
| CAP-041 | See known limitations before using something | Every entry has a known limitations field written for somebody outside the owning team, describing how the data misleads rather than what it contains.… | Should | WP5 |
| CAP-042 | See lineage and dependencies, and follow them | An entry lists what it depends on, and where a dependency is itself a registered entry the name is a link. Where a dependency is an unregistered sourc… | Must | WP5 |
| CAP-043 | See the licence and who it covers | Every entry states its licence model and, in the same sentence, who that licence covers. The seat-limited commercial example spells out that a tool ca… | Must | WP5 |
| CAP-044 | See use, cost per use and health over 90 days | Three numbered boxes on every entry show calls and distinct consumers, cost per use, and error rate with median latency and a health marker. Absolute … | Must | WP5 |
| CAP-046 | See the minimum aggregation enforced on an entry | An entry that can only be answered at an aggregate level states the minimum grouping as a field of the entry, with a note that it is enforced on every… | Must | WP5 |
| CAP-022 | Request access to an entry | An entry whose visibility state is "Available to you, needs a request" carries a Request access button, and the request goes to the named owner and ap… | Must | WP5 |

#### Marketplace — the estate map

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-032 | Switch between list and map | A view toggle in the result bar moves between the register as a sortable table and the register as a cluster map. Both views carry the toggle and mark… | Should | WP14 |
| CAP-033 | See the estate as a map of clusters and dependencies | A drawn map places every entry as a small square inside its cluster ring, with lines between clusters where a dependency crosses them, and a filled sq… | Should | WP14 |
| CAP-035 | See how many cross-cluster dependencies exist | A footnote under the map states the count of cross-cluster links and says the count over time is the honest test of whether the programme is working. … | Must | WP14 |
| CAP-036 | Browse by cluster and see its owner and contents | Nine cluster cards, each with its number, name, entry count and owning team, and a link that opens the register filtered to that cluster. A cluster wi… | Should | WP14 |
| CAP-037 | See how much of the estate is connected against what is believed to exist | A coverage screen shows the percentage of the believed estate that is registered, the number of entries, the estimated total, the share with a confirm… | Must | WP14 |

#### Build an agent

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-131 | Assemble an agent from approved parts | A single form creates an agent: a name, a model, instructions, the knowledge it may read and the actions it may take. Creating it opens the assurance … | Should | WP9 |
| CAP-132 | Choose a model from the approved catalogue | A model choice offering first-party general, first-party small and fast, or a third-party model marked as needing review. The hint states that non-fir… | — | WP9 |
| CAP-133 | Write instructions | A free-text instructions field. The worked example tells the agent to name its sources and their freshness, to say what it could not see, and never to… | — | WP9 |
| CAP-134 | Be told to search the marketplace before building | A panel beside the build form states that roughly 2,500 agents already exist, most unexamined, and links to search agents in the marketplace. | — | WP9 |
| CAP-135 | Attach only knowledge I can already see | A checklist of knowledge sources limited to entries the builder can see, with anything they cannot see shown greyed out and disabled alongside the rea… | Must | WP9 |
| CAP-136 | Tick what the agent may do, and see what is not available this phase | Four permitted actions: read registered sources and summarise and cite are available and ticked; write to a source system and send a message on your b… | Must | WP9 |
| CAP-137 | See which assurance gates apply and why | A table of seven gates with status and the reason each applies: impact assessment, gateway security review, responsible AI review, model catalogue app… | Should | WP10 |

#### Publish and share

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-099 | Share an agent my team built | A tab for agents the team has made findable, with usage, and a form to share another: pick the agent, say what it is for in one sentence for somebody … | Should | WP12 |
| CAP-100 | Declare what an agent reads and may do | Sharing an agent requires declaring what it reads and what it may do, and both sit on its entry where neither can be quietly widened later. Its knowle… | Should | WP12 |
| CAP-102 | Publish a skill so it is callable from Ask, an agent or an automation | A tab for skills the team has published, with a form asking what question it answers and what registered entries it reads. A skill is one job; if desc… | Should | WP12 |

#### Ask a question

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-001 | Ask a question in my own words | A staff member types a question in ordinary language into the Ask page and Cortex answers it from the data that has been connected through the gateway… | Must | WP13 |
| CAP-002 | Follow up in the same thread | A question and its answer stay in a thread, and the next question is asked against what has already been established rather than from a blank page. Th… | — | WP13 |
| CAP-011 | See where an answer came from | Every answer carries a provenance panel showing the sources used and what was taken from each, a confidence level with a label explaining it, the assu… | Must | WP13 |

#### Cross-cutting

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-179 | Say whether a page was useful, and have that recorded | A feedback control at the foot of every page asking whether the page was useful, with yes and no buttons and a note that what the user searched for, a… | Must | WP15 |

---

## Phase 2 — build if time allows (9 capabilities)

#### Share your data

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-091 | See what my team shares and how much it is used | A table of everything the team has connected, with freshness, visibility, health and the number of teams calling it. Above it, five figures summarise … | Must | WP16 |
| CAP-092 | Connect a source through the gateway rather than upload a file | A short form names the source system, the object or endpoint, and the owning team, and submitting it raises a gateway registration request. Nothing is… | Must | WP16 |
| CAP-093 | Understand why there is no file picker | A callout on the Share data tab states plainly that connecting is not uploading, that nothing is copied and nothing moves, and that if the user is loo… | Must | WP16 |
| CAP-095 | Confirm my team owns an entry proposed from resource tags | Entries whose owner was proposed by an agent and never confirmed appear in a block on the matching Share tab, with what was proposed, from where, the … | Must | WP16 |
| CAP-097 | Handle access requests to what I share, in one place | A table of people asking for access to the team’s entries, with the requester, their purpose, how long they have waited with a colour marker, and appr… | Must | WP16 |

#### Ask — depth

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-003 | Go back to a question I asked before | Previous conversations are listed down the left of the Ask page, grouped into Today, Yesterday and Earlier, and selecting one reopens the whole thread… | Must | WP13 |
| CAP-012 | See the working when nothing was found | When no connected source can answer, the provenance panel changes shape and shows what was searched, why nothing came back, and what would fix it. Con… | — | WP13 |
| CAP-014 | Jump from a claim to the entry it came from | Numbered citation markers sit inline in the answer text next to the specific claim they support, and each one links to the marketplace entry it came f… | — | WP13 |

#### Your data and agents

| ID | Capability | What it does | Backlog priority | Work package |
|---|---|---|---|---|
| CAP-165 | See what I own, its usage, cost and health in one place | A My things screen listing everything the user owns with who used it, what it cost and its error rate, drawn from telemetry that already exists. | Must | WP16 |

---

## Phase 3 — now built

**Requests (CAP-052 → CAP-090) has been built as a working lifecycle**, not a walkthrough: raise a request, Cortex proposes who holds the data, the holder's agent drafts an answer *inside the holder's permissions*, and a person reviews the method before releasing it. Automate remains out of scope by the backlog's own read-and-summarise-only rule.

The rest of this section is the original reasoning, kept for the record.

## Phase 3 — the original assessment

**Requests** (CAP-052 → CAP-090, 39 capabilities) and **Automate a task** (CAP-143 → CAP-164, 22 capabilities).

The Requests section carries the strongest narrative in all the source material — the deck's worked example of seven handoffs to produce one number, collapsed to one, with the responder's agent drafting before the responder even opens the form. It is also the most expensive thing in the backlog to build properly, because it needs a request lifecycle, a method registry, versioned approvals, a recurrence engine and a release workflow.

**Recommendation:** build **four static, clickable screens** of the sick-days walkthrough in Phase 1 (WP17) and present them as "what the investment buys". Showing the destination costs a day. Building it costs a quarter.

---

## Out of scope, with reasons

| Excluded | Capability range | Reason |
|---|---|---|
| Impact assessments | CAP-117 → CAP-122 | Governance workflow. Essential to the product, invisible in a demo. |
| Data-sharing agreements | CAP-123 → CAP-130 | As above. |
| Reference data and canonical entities | CAP-111 → CAP-116 | The workbook names **Reference data owner** as a role that *does not exist* — "named as the critical open dependency". Do not build on a dependency the client has already flagged as absent. |
| Standards and conformance | CAP-104 → CAP-106 | The workbook records that there is **no owner for data standards**. Same reasoning. |
| Automations with write access | CAP-143 → CAP-164 | The source itself constrains agents to read, summarise and cite this phase. Writing to source systems is out of scope by the backlog's own rules. |
| Notifications, profile, interests | CAP-050, CAP-051 | Product furniture. No demo weight. |
| Coverage by category detail | CAP-038 | The headline coverage figure (CAP-037) carries the point; the breakdown does not add to it. |
| iPad client | — | A third mockup (SwiftUI, 11 files) exists and is the only source for the Run section and My things. Out of scope entirely. |
| Copilot and Teams agent enablement | — | A tenant configuration change, not application code. It belongs in the deck, not the build. |

---

## Open questions carried forward

The workbook logs **59 open questions** on its Gaps sheet. Three block build decisions and need an answer from Defra before the relevant work package starts:

1. **Who owns reference data?** Named as the critical open dependency. Blocks CAP-111 → CAP-116 permanently until answered.
2. **Who owns data standards?** The Standard setters role "partly does not exist". Blocks CAP-104 → CAP-106.
3. **What is the gateway review throughput?** The workbook names gateway reviewers (AI Unit and CCoE) as "the throughput risk for the whole programme", and the mockup shows 17 requests ahead with an 11-working-day median. If that is real, it is the rate limit on the entire platform — and it is worth putting on a slide, because it is a problem Cortex makes visible rather than causes.

The remaining 56 are recorded in the source workbook and do not block Phase 1.
