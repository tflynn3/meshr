# OpenAI WebMCP Challenge: official rules and complete criteria inventory

Researched 2026-08-30 against the current official OpenAI challenge page, the Devpost challenge overview, Official Rules, Resources/FAQ and organizer updates, the incorporated Devpost Terms and Privacy Policy, and the first-party WebMCP specification and browser documentation.

This document records the criteria only. It does **not** assess Meshr or any other prospective submission.

## Bottom line

The binding challenge is narrower and more concrete than the promotional copy:

- Build or meaningfully extend a **working, non-trivial WebMCP web app** during the submission period.
- Submit by **September 3, 2026 at 1:00 p.m. Pacific Time** with a working live URL, a public open-source repository, a prescribed description, and a public YouTube demo with audio that is **less than three minutes**.
- Keep the app free and unrestricted for judging, provide any credentials and instructions, and conservatively freeze the Devpost entry, video, repository, live site, and team when the deadline passes.
- Pass a theme/API viability screen, then compete on four **equally weighted** criteria: WebMCP Leverage, Execution, Potential Impact, and Creativity & Ambition.

The [Official Rules](https://webmcp.devpost.com/rules) expressly override inconsistent statements in the submission form, challenge website, FAQ, updates, or advertising. The Rules also incorporate the [Devpost Terms of Service](https://info.devpost.com/legal/terms-of-service), with the Rules controlling any challenge-specific conflict. The optional Devpost Plugin is expressly **not** a source of truth.

The pages contain several real inconsistencies. The most consequential are a one-hour difference in the historical opening time, an erroneous FAQ sentence saying there is no video, and different statements about whether judges will visit the live app. Those are reconciled in [Ambiguities and conflicts](#ambiguities-and-conflicts).

## Authority and interpretation

Use this order when deciding what controls:

1. **Official Rules** — the governing contract. They override the submission form, website, advertising, and other challenge materials when inconsistent ([Official Rules §§12.4, 15](https://webmcp.devpost.com/rules)).
2. **Devpost Terms of Service** — incorporated into the Rules. They add site-wide conduct, verification, licensing, and account obligations, but the Official Rules control challenge-specific conflicts ([Official Rules §15](https://webmcp.devpost.com/rules), [Devpost Terms](https://info.devpost.com/legal/terms-of-service)).
3. **Official challenge site, Resources/FAQ, and organizer updates** — useful clarifications and conservative operational instructions, subordinate to the Rules ([overview](https://webmcp.devpost.com/), [Resources/FAQ](https://webmcp.devpost.com/resources), [updates](https://webmcp.devpost.com/updates)).
4. **OpenAI challenge page** — first-party promotional summary that points entrants to Devpost for full eligibility and submission rules ([OpenAI challenge page](https://openai.com/webmcp-challenge/)).
5. **WebMCP specification and first-party implementation docs** — define what a valid, discoverable WebMCP implementation does; they are technical sources rather than additional prize rules ([draft specification](https://webmachinelearning.github.io/webmcp/), [OpenAI Site Tools guide](https://learn.chatgpt.com/docs/webmcp), [Chrome guide](https://developer.chrome.com/docs/ai/webmcp)).
6. **Starter templates, showcases, sponsor examples, and optional AI helpers** — inspiration only unless the Official Rules make a particular element mandatory. The Plugin may be inaccurate, incomplete, or outdated, and using it never shifts compliance responsibility away from the entrant ([Official Rules §5](https://webmcp.devpost.com/rules)).

Submission itself forms a contract among the entrant, OpenAI OpCo, LLC as Sponsor, and Devpost, Inc. as Administrator. No purchase or payment is necessary ([Official Rules preamble and §2](https://webmcp.devpost.com/rules)).

The Rules can be amended at any time; an amendment is effective at the stated time or, if none is stated, when posted. An entrant who sees ambiguity must request written clarification before the deadline. The published contact is `support@devpost.com` ([Official Rules §§12.5–12.7 and 16](https://webmcp.devpost.com/rules)). This is therefore a dated snapshot, not a substitute for a final-day reread.

## Master eligibility and submission checklist

This is the shortest complete go/no-go checklist. Later sections preserve every qualification and exception.

| ID | Required state | Authority | Evidence an entrant should retain |
|---|---|---|---|
| E-01 | Individual entrant and every participating individual is at least the age of majority where they reside. | [Rules §3](https://webmcp.devpost.com/rules) | Government identity/age evidence if requested. |
| E-02 | Entrant resides in, or organization is organized/incorporated and based in, a currently supported OpenAI API country/territory and is not otherwise excluded. | [Rules §3](https://webmcp.devpost.com/rules), [current supported-country list](https://developers.openai.com/api/docs/supported-countries) | Current country eligibility check and organization records. |
| E-03 | No entrant, member, employer, affiliate, family/household relationship, judge relationship, sponsor involvement, or other real/apparent conflict triggers an exclusion. | [Rules §3](https://webmcp.devpost.com/rules) | Team/employer/sponsor conflict check. |
| E-04 | A team or organization has an eligible, authorized Representative; all teammates are added and have accepted before the deadline. | [Rules §§3, 4](https://webmcp.devpost.com/rules), [organizer update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you) | Accepted Devpost team roster and authority to submit. |
| R-01 | Registration and final submission are completed, not merely saved as a draft, by September 3 at 1:00 p.m. PT. | [Rules §§1, 4](https://webmcp.devpost.com/rules), [organizer update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you) | Submitted confirmation screenshot/email. |
| P-01 | The project is a WebMCP-powered web app fitting the human-and-agent open-web theme. | [Rules §4](https://webmcp.devpost.com/rules) | Live app, source, and demonstration. |
| P-02 | The intended flow installs/runs consistently on its stated platform and works as represented. | [Rules §4](https://webmcp.devpost.com/rules) | Clean-session end-to-end test. |
| P-03 | It is new during the Submission Period, or pre-existing but meaningfully extended with WebMCP after the period began, with prior/new work clearly separated and dated. | [Rules §4](https://webmcp.devpost.com/rules) | Timestamped commits or equivalent dated evidence. |
| P-04 | Third-party SDKs, APIs, data, media, marks, code, and other materials are authorized and license-compliant. | [Rules §§4, 8](https://webmcp.devpost.com/rules) | Licenses, notices, permissions, and dependency inventory. |
| S-01 | Working live URL opens in ChatGPT's in-app browser or Chrome 149+ with WebMCP enabled. | [Rules §4](https://webmcp.devpost.com/rules) | Fresh/incognito/second-machine test. |
| S-02 | Any login credentials and complete testing instructions are supplied; access remains free and unrestricted through the Judging Period. | [Rules §4, Testing](https://webmcp.devpost.com/rules) | Dedicated judge account and reproducible test script. |
| S-03 | Description addresses all four requested prompts: WebMCP fit, better UX, newly possible human-agent work, and implementation. | [Rules §4, Submission Requirements](https://webmcp.devpost.com/rules) | Final Devpost text. |
| S-04 | Public GitHub, GitLab, or Bitbucket repository contains all necessary source, assets, and run instructions. | [Rules §4](https://webmcp.devpost.com/rules) | Logged-out repository check. |
| S-05 | Repository has a visible, detectable open-source license file, including visibility at the repository top/About area. | [Rules §4](https://webmcp.devpost.com/rules) | Logged-out license detection check. |
| S-06 | Repository contains actual WebMCP registration code; for ChatGPT compatibility it is imperative `document.modelContext.registerTool(...)` code in the top-level page. | [Rules §4](https://webmcp.devpost.com/rules), [OpenAI Site Tools limitations](https://learn.chatgpt.com/docs/webmcp) | Source pointer plus live tool discovery/call evidence. |
| S-07 | Public YouTube video is under 3:00, clearly shows the working app, and has narration covering the project and its WebMCP use. | [Rules §4](https://webmcp.devpost.com/rules), [organizer video clarification](https://webmcp.devpost.com/updates/46116-6-days-left-to-build) | Logged-out playback, duration, audio check. |
| S-08 | Submission and all supporting material are English, or complete English translations are included. | [Rules §4, Language Requirements](https://webmcp.devpost.com/rules) | English entry/video captions or translated materials. |
| S-09 | Entry is original, solely owned by the entrant/team/organization, and does not violate IP, contract, privacy, publicity, or other rights. | [Rules §§4, 8](https://webmcp.devpost.com/rules) | Contributor/IP assignment and third-party-rights check. |
| S-10 | Submission contains no malware or other harmful/malicious code and complies with the incorporated Devpost conduct rules. | [Rules §8](https://webmcp.devpost.com/rules), [Devpost Terms §4](https://info.devpost.com/legal/terms-of-service) | Dependency/security scan and content review. |
| S-11 | Final entry is actually submitted; after the deadline, conservatively freeze description, video, repo, live deployment, and team until winners are announced. | [Rules §6](https://webmcp.devpost.com/rules), [organizer freeze clarification](https://webmcp.devpost.com/updates/46116-6-days-left-to-build) | Immutable tag/commit/deployment and archived submission proof. |

## Dates, deadlines, and operating window

The controlling timetable in [Official Rules §1](https://webmcp.devpost.com/rules) is:

| Event | Pacific Time stated by Rules | PDT / UTC equivalent for these dates |
|---|---|---|
| Registration opens | August 25, 2026, 11:00 a.m. PT | August 25, 11:00 a.m. PDT / 18:00 UTC |
| Registration closes | September 3, 2026, 1:00 p.m. PT | September 3, 1:00 p.m. PDT / 20:00 UTC |
| Submission opens | August 25, 2026, 11:00 a.m. PT | August 25, 11:00 a.m. PDT / 18:00 UTC |
| Submission closes | September 3, 2026, 1:00 p.m. PT | September 3, 1:00 p.m. PDT / 20:00 UTC |
| Judging opens | September 4, 2026, 10:00 a.m. PT | September 4, 10:00 a.m. PDT / 17:00 UTC |
| Judging closes | September 21, 2026, 5:00 p.m. PT | September 21, 5:00 p.m. PDT / September 22, 00:00 UTC |
| Winners announced | On or around September 23, 2026, 2:00 p.m. PT | On/about September 23, 2:00 p.m. PDT / 21:00 UTC |

The Devpost header labels the deadline as `Sep 3, 2026 @ 1:00pm PDT` ([challenge overview](https://webmcp.devpost.com/)). The OpenAI page says the winner date may move depending on submission volume ([OpenAI challenge page](https://openai.com/webmcp-challenge/)).

Do not rely on last-minute upload attempts. The Rules disclaim responsibility for late, lost, corrupted, misdirected, or incomplete entries; proof of sending is not proof of receipt. A prompt request to resubmit after a known loss is the entrant's sole remedy and remains discretionary ([Rules §10](https://webmcp.devpost.com/rules)).

## Entrant eligibility

### Who may enter

An entrant may be:

- an individual who is at least the age of majority where they reside at entry;
- a team composed of eligible individuals; or
- an existing legal organization — including a corporation, nonprofit, LLC, partnership, or other legal entity — organized or incorporated at entry and based in a currently supported OpenAI API country/territory.

The residence/domicile must be on OpenAI's **current**, dynamic [API supported-country list](https://developers.openai.com/api/docs/supported-countries), not merely a country that was supported earlier. These conditions come from [Official Rules §3](https://webmcp.devpost.com/rules).

An eligible individual may join multiple teams or organizations and may also enter individually. The [official FAQ](https://webmcp.devpost.com/resources) says there is **no team-size cap**. This is distinct from prize fulfillment: OpenAI swag and one-year Pro accounts cover at most three team members.

### Representative requirement

A team or organization must appoint one eligible individual as its authorized Representative. Submission on its behalf warrants that the submitter has that authority. Prize cash and items are delivered to the Representative or organization; the Representative is responsible for allocation among participants ([Rules §§3, 4, 9](https://webmcp.devpost.com/rules)).

Devpost's incorporated Terms add that, if the identity of the maker is disputed, the email address used for entry and the person/entity assigned to it determine the maker; Devpost does not resolve internal ownership disputes and may disqualify the entry or suspend/withdraw a prize ([Devpost Terms §6.A(ii)](https://info.devpost.com/legal/terms-of-service)). Written contributor and prize-sharing agreements are therefore prudent even though the Rules do not mandate a particular agreement.

The organizer's current instruction is to add all teammates and have every invitation accepted **before** the deadline; teammates cannot be added afterward ([August 30 organizer update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)).

### Geographic exclusions

The binding rule excludes:

- any individual not resident in, or organization not domiciled in, a currently supported API country/territory;
- anyone for whom US or local law prohibits participation or receipt of a prize;
- specifically, without limitation, Brazil, China, Hong Kong, Quebec, Russia, Crimea, Cuba, Iran, North Korea, Syria, Venezuela, Donetsk, Luhansk, and any other US Treasury/OFAC-designated country or territory.

See [Official Rules §3](https://webmcp.devpost.com/rules). The Devpost overview's exclusion widget also lists **Belarus** ([overview](https://webmcp.devpost.com/)). Because the Rules use the dynamic supported-country list and say their examples are non-exhaustive, absence of Belarus from the Rules' parenthetical list does not establish eligibility.

### Relationship and conflict exclusions

The following are ineligible under [Official Rules §3](https://webmcp.devpost.com/rules):

- Sponsor, Administrator, or any organization involved in design, production, paid promotion, execution, or distribution of the challenge;
- those entities' employees, representatives, and agents;
- immediate family or household members of those people;
- any other person involved in design, production, promotion, execution, or distribution, plus their immediate family/household;
- any judge, or the company or individual employing a judge;
- a parent, subsidiary, or affiliate of any of those organizations; and
- anyone whose participation creates a real or apparent conflict in Sponsor/Administrator's sole discretion.

For these exclusions:

- Immediate family includes spouse, children/stepchildren, parents/stepparents, siblings/stepsiblings.
- Household includes anyone sharing the residence for at least three months of the year.
- An agent includes a person or organization creating a submission at a Promotion Entity's direction under a contract or similar relationship.
- An affiliate includes common control, common majority/controlling ownership or management, or substantial cross-ownership.

### Sponsor support conflict

A project cannot have been developed, or derived from a project developed, with financial or preferential support from OpenAI or Devpost. The non-exhaustive examples are Sponsor/Administrator funding or investment, development under contract, or a commercial license received from either before the Submission Period ends. Sponsor may also disqualify where awarding a prize creates a real or apparent conflict ([Rules §4, Financial or Preferential Support](https://webmcp.devpost.com/rules)).

This clause is unusually broad. It does not explain whether ordinary public OpenAI programs, an ordinary paid API account, or challenge-offered credits are “preferential support.” The Rules separately invite entrants to request hackathon credits, so those published benefits are unlikely to be the intended prohibition, but an entrant with OpenAI/Devpost funding, contracts, investment, or commercial licensing should obtain written clarification.

## Registration and entry mechanics

Entrants must:

1. Visit [webmcp.devpost.com](https://webmcp.devpost.com/), select **Join Hackathon**, and create or use a free Devpost account.
2. Obtain and use WebMCP tooling under its applicable license terms.
3. Complete all required fields on the **Enter a Submission** page during the Submission Period.
4. Finish the submission workflow so the project is submitted, not left as a saved draft.

These steps are in [Official Rules §4](https://webmcp.devpost.com/rules). The organizer update explicitly warns that a saved draft is not an entry and advises looking for the final green-button confirmation ([August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)).

Registration permits the Sponsor and Devpost to collect and maintain entrant information to operate and publicize the challenge. Devpost collects contact, team, and submission details and may share registration/submission information with OpenAI ([Rules §4](https://webmcp.devpost.com/rules), [Devpost Privacy Policy](https://info.devpost.com/legal/privacy-policy)).

The optional Devpost Hackathons Plugin is not required to enter, participate, or win. It is provided as-is; its AI output may be inaccurate; the entrant must verify everything; and its use is also subject to Devpost's Terms and Privacy Policy ([Rules §5](https://webmcp.devpost.com/rules)).

## Project requirements

### Theme and required technology

The project must be a **WebMCP-powered web app** that imagines or explores an open web where humans and agents interact, collaborate, and create together ([Rules §4](https://webmcp.devpost.com/rules)).

Stage One judging makes two elements pass/fail:

1. the project reasonably fits the theme; and
2. it reasonably applies the required APIs/SDKs featured in the challenge.

The Rules name WebMCP as the required technology and do not name any mandatory OpenAI model, OpenAI API, host, framework, or backend SDK. The [official FAQ](https://webmcp.devpost.com/resources) confirms that no OpenAI account, Codex, paid development tool, or specific hosting provider is required.

### Functionality and platform

The project must:

- be capable of successful installation;
- run consistently on its intended platform;
- work as depicted in the video and described in text; and
- run on the platform stated in the submission.

See [Rules §4, Project Requirements](https://webmcp.devpost.com/rules). This is both an eligibility requirement and a central Execution criterion. A local proof of concept that is not reachable at the submitted URL is insufficient.

### New versus pre-existing work

The project may be newly created during the Submission Period or pre-existing but **meaningfully extended using WebMCP after** the period opened.

For a pre-existing project:

- only work added during the Submission Period is evaluated;
- WebMCP work completed before August 25 does not count;
- the entrant must clearly distinguish prior work from new work; and
- dated/timestamped commit history or equivalent evidence must show the extension occurred in-window.

See [Rules §4](https://webmcp.devpost.com/rules), [FAQ](https://webmcp.devpost.com/resources), and the [organizer build update](https://webmcp.devpost.com/updates/46116-6-days-left-to-build).

The Rules do not define “meaningfully extended,” a minimum line count, a minimum number of tools, or a required percentage of new work. The judging criterion's “working, non-trivial implementation” is the best published signal.

### Third-party integrations

Any third-party SDK, API, or data must be used with authorization and in accordance with its terms and license. Open-source software or hardware is allowed only if the entrant complies with its license and creates software that enhances and builds on the underlying product's features/functionality ([Rules §4, Third Party Integrations and Intellectual Property](https://webmcp.devpost.com/rules)).

Third-party technical contractors may assist only if the submitted components remain the entrant's work product, result from the entrant's ideas and creativity, and are fully owned by the entrant. This is stricter than merely having permission to show contractor-owned code ([Rules §4, Intellectual Property](https://webmcp.devpost.com/rules)).

## WebMCP technical criteria and safest compatibility target

This section separates **challenge requirements** from **implementation guidance**. The challenge requires a functioning WebMCP implementation, but it does not incorporate every draft provision as a separately scored checklist.

### Browser access required by the challenge

Entrants and judges may use either:

- the ChatGPT desktop app's in-app browser, where site tools are enabled by default; or
- Google Chrome 149 or later with `chrome://flags/#enable-webmcp-testing` enabled and the browser restarted.

See [Rules §4](https://webmcp.devpost.com/rules) and the [Chrome developer guide](https://developer.chrome.com/docs/ai/webmcp). Chrome also offers an origin trial beginning in 149, but challenge entry does **not** require origin-trial enrollment; the local flag is an expressly accepted path ([Chrome origin-trial announcement](https://developer.chrome.com/blog/ai-webmcp-origin-trial)).

### Imperative registration is the cross-client target

The Rules show a repository example using:

```js
document.modelContext.registerTool({
  name: "search_products",
  description: "Search the product catalog",
  inputSchema: {},
  execute: async (input) => ({ ok: true }),
});
```

The Rules say repositories “should have” this code rather than cleanly saying a literal call is mandatory ([Rules §4](https://webmcp.devpost.com/rules)). However, ChatGPT's built-in browser currently does not support declarative form tools and does not discover tools in any iframe. OpenAI tells developers to register JavaScript tools in the **top-level page** ([OpenAI Site Tools limitations](https://learn.chatgpt.com/docs/webmcp)).

The safest compatibility target is therefore:

- actual imperative `document.modelContext.registerTool(...)` registration;
- executed in the top-level page;
- capability detection before registration; and
- at least one live tool that an agent can discover and successfully call in a submitted supported browser.

Declarative-only or iframe-only implementations may work in broader Chrome contexts but do not satisfy the advertised ChatGPT judge path. The challenge does not publish a minimum tool count, so one genuinely useful, non-trivial tool can be eligible; depth and breadth affect WebMCP Leverage.

### Normative WebMCP interface constraints

The current [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/) is a Community Group Report, not a W3C Standard or Standards Track document. It defines a JavaScript API in secure contexts:

- `name`, `description`, and `execute` are required tool fields.
- `title`, `inputSchema`, and `annotations` are optional.
- A name must be unique within the document, 1–128 characters, and use only ASCII alphanumerics, underscore, hyphen, or period.
- Name and description cannot be empty.
- `inputSchema`, if provided, is a JSON Schema object and must serialize successfully as JSON.
- The execute callback receives structured input and should return a JSON-serializable result.
- Current annotations are `readOnlyHint` and `untrustedContentHint`.
- `document.modelContext` is a Secure Context API.
- The `tools` Permissions Policy defaults to `self`; top-level and same-origin contexts are allowed, while cross-origin frames require explicit permission.
- Registration fails when the document is not origin-keyed, including when `document.domain` has been enabled, except for the spec's local-file handling.

Chrome summarizes the deployment consequence: WebMCP is disabled if the document opts out of origin isolation, such as with `Origin-Agent-Cluster: ?0` ([Chrome WebMCP security and permissions](https://developer.chrome.com/docs/ai/webmcp)).

### Official quality and safety guidance

OpenAI's current implementation guidance says to:

- begin with operations the human UI already supports;
- keep inputs narrow;
- describe side effects;
- return enough information for the human/agent to verify results;
- reuse existing authentication, authorization, and input validation; and
- preserve the normal human/browser interface for clients without WebMCP.

See [OpenAI Site Tools](https://learn.chatgpt.com/docs/webmcp). Each invocation in ChatGPT receives a safety review, and consequential actions may require confirmation; those checks do not make the page or its result trusted.

The WebMCP project's official explainer says the design goals are shared human-agent visibility, history, and control, more reliable structured interaction, code reuse, and preserving the human interface. Headless use, fully autonomous operation, replacing backend MCP, and replacing the human UI are explicit non-goals ([WebMCP explainer](https://github.com/webmachinelearning/webmcp)).

The draft identifies prompt/tool-description injection, tool-output injection, misrepresented intent, privacy leakage through over-parameterization, and origin-boundary failures as key risks ([WebMCP security and privacy considerations](https://webmachinelearning.github.io/webmcp/#security-and-privacy-considerations)). Chrome recommends accurate side-effect hints, explicit trusted origin exposure, succinct descriptions/outputs, and currently suggests budgets of 500 characters per tool description, 150 per parameter description, 30 per tool/parameter name, and 1.5K per tool output ([Chrome WebMCP tool security](https://developer.chrome.com/docs/ai/webmcp/secure-tools)).

Those character budgets and design goals are recommendations, not published disqualification thresholds. They remain relevant to WebMCP Leverage, Execution, and human-agent experience.

Chrome's official evaluation guide recommends proving that an agent selects the right tool, supplies correct parameters, uses outputs correctly in later calls, completes the full journey, handles alternative call ordering, and does not silently continue after a mid-chain failure. It distinguishes deterministic tool/UI/side-effect tests from probabilistic tool-selection evals ([Chrome WebMCP evals](https://developer.chrome.com/docs/ai/webmcp/evals)). Chrome DevTools can independently show the discovered tool list, invocation count, exact input/output, completion/error state, and schema violations ([Chrome DevTools WebMCP panel](https://developer.chrome.com/docs/devtools/application/webmcp)). These are not mandatory submission artifacts, but they are unusually direct evidence for WebMCP Leverage and Execution.

## Submission package

### Working live URL

The submission must provide a working live URL that judges can access in ChatGPT's in-app browser or WebMCP-enabled Chrome ([Rules §4](https://webmcp.devpost.com/rules)).

- Any hosting provider is allowed. The named examples — ChatGPT Sites, Cloudflare, Vercel, Render, and Netlify — are not exclusive.
- Authentication is allowed.
- If authenticated/private, credentials and testing instructions must be included in the submission form.
- The working project must remain free of charge and unrestricted for Sponsor, Administrator, and judges through the end of judging.
- For uncommon proprietary hardware, Sponsor/Administrator may require physical access at their discretion.

The organizer tells entrants to test from an incognito session or another machine. A localhost URL, cached local login, or expiring tunnel is an explicit failure mode ([August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)).

Judges are not required to build, install, or test the project. They may decide from description, images, and video alone ([Rules §4, Testing](https://webmcp.devpost.com/rules)).

### Required text description

The entry text must explain:

1. why the use case strongly fits WebMCP;
2. how WebMCP creates a better user experience;
3. what people and agents can now do together that was difficult or impossible before; and
4. briefly, how WebMCP was implemented.

See [Rules §4](https://webmcp.devpost.com/rules). The organizer further advises making a credible case rather than listing features, and the incorporated Terms require all claims about the entrant and work to be accurate ([August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you), [Devpost Terms §4](https://info.devpost.com/legal/terms-of-service)).

### Public repository

The submission must link a **public** repository on GitHub, GitLab, or Bitbucket containing:

- all source code needed for the project;
- all necessary assets;
- instructions required to make the project functional;
- an open-source license file; and
- WebMCP registration code.

The license must be detectable and visible at the top of the repository page/About section ([Rules §4](https://webmcp.devpost.com/rules)). The FAQ explicitly says there is no private-repository-with-shared-access alternative ([Resources/FAQ](https://webmcp.devpost.com/resources)). Test both repository and license while logged out.

The Rules do not name an approved-license list. “Open source” should be satisfied with an OSI-recognized license applied to the submitted code, not a source-available or bespoke noncommercial license. The entrant must still possess all rights needed to grant that license.

### Demo video

The binding video requirements are:

- **less than three minutes**; judges need not watch beyond three minutes;
- a clear demonstration of the project functioning;
- audio explaining what was built and how WebMCP was used;
- uploaded to YouTube;
- publicly visible, not private or unlisted; and
- no third-party trademarks, copyrighted music, or other copyrighted material without permission.

See [Rules §4](https://webmcp.devpost.com/rules). The organizer clarification says a silent screencast with background music fails, while the entrant's voice or AI text-to-speech narration is acceptable. Showing the working project in the first 10–15 seconds is strong official advice, not a formal requirement ([August 28 organizer update](https://webmcp.devpost.com/updates/46116-6-days-left-to-build)).

Because the Rules say “less than” three minutes while one update says “3 minutes maximum,” target a final runtime below `02:59` rather than exactly `03:00`.

### Language

Every submitted material must be in English. If an original is not English, the entrant must provide an English translation of the demo video, description, testing instructions, and every other submitted item ([Rules §4, Language Requirements](https://webmcp.devpost.com/rules)).

### Multiple entries

An entrant may submit more than one project. Every entry must be unique and substantially different from that entrant's other entries, as determined solely by Sponsor and Devpost ([Rules §4, Multiple Submissions](https://webmcp.devpost.com/rules)).

The Devpost Terms also prohibit content that substantially duplicates another submission or prior site content, whether entered by the same or another maker ([Devpost Terms §4](https://info.devpost.com/legal/terms-of-service)).

## Access, testing, and post-deadline freeze

The entrant must give Sponsor, Devpost, and judges free, unrestricted access for testing, evaluation, and use until September 21 at 5:00 p.m. PT. A functioning live URL and any credentials/instructions must survive a clean browser session for that period ([Rules §4, Testing](https://webmcp.devpost.com/rules)).

The binding Rules say:

- draft entries may be edited before the deadline;
- after the deadline, the **Submission** cannot be changed or altered;
- the separate Devpost portfolio project may still be updated; and
- Sponsor/Devpost may permit a narrowly scoped post-deadline edit to remove/replace potentially infringing, personally identifying, or inappropriate material, but the entry must remain substantively the same and only the authorized change is allowed.

See [Rules §6](https://webmcp.devpost.com/rules).

The later organizer guidance is stricter: change nothing after September 3 at 1:00 p.m. PT — not the description, video, repository, live site, project, or team — until winners are announced. It says any edit, however minor, risks prize eligibility and recommends continuing development only in a separate fork ([August 28 update](https://webmcp.devpost.com/updates/46116-6-days-left-to-build), [August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)).

Conservative compliance therefore means:

- freeze the Devpost entry;
- freeze the exact public commit and branch judges see;
- freeze or immutable-pin the deployment;
- keep the live service healthy without changing its judged behavior;
- freeze the YouTube artifact and visibility;
- freeze the accepted team roster; and
- develop later work in an unsubmitted fork.

The Rules do not explain whether an emergency availability-only redeploy of identical bits is a forbidden live-site change. Resolve that in writing rather than improvising during judging.

## Ownership, licenses, publicity, and team rights

### Entrant ownership warranty

The entry must be:

- original work of the individual/team/organization;
- solely owned by that entrant, with no other person/entity holding a right or interest; and
- free of infringement of copyright, trademark, patent, trade-secret, contractual, privacy, publicity, or other third-party rights.

Entrants also warrant that any third-party content is owned or used with permission and that the submission contains no virus, Trojan horse, worm, spyware, disabling device, or other harmful/malicious code ([Rules §§4, 8](https://webmcp.devpost.com/rules)).

AI-assisted coding is expressly welcomed in the official FAQ, but it does not relax ownership, licensing, accuracy, or originality warranties ([Resources/FAQ](https://webmcp.devpost.com/resources)). The FAQ's advice not to use AI to name the project and not to publish vague or overstated copy is guidance, not a separate disqualification rule; truthful representation is independently required by the Devpost Terms.

### What rights remain with the entrant

All submissions remain the intellectual property of their creators. The Official Rules grant OpenAI a non-exclusive license to use the entry for judging ([Rules §8](https://webmcp.devpost.com/rules)).

The Rules also let OpenAI and Devpost promote the submission and use contributor names, likenesses, voices, and images in challenge/result publicity during the challenge and for three years afterward. Some materials may be public; other materials may be visible to Sponsor, Devpost, and judges ([Rules §8](https://webmcp.devpost.com/rules)).

The incorporated Devpost Terms add a broader, **worldwide perpetual** non-exclusive, royalty-free promotional license to Devpost, OpenAI, and third parties acting for OpenAI. It permits public display/use and promotion on Devpost, sponsor/partner sites/apps, and other media ([Devpost Terms §8.B(iii)](https://info.devpost.com/legal/terms-of-service)). The entrant retains ownership, but these promotion licenses survive.

### Publicity consent

Participation also consents to worldwide promotion/display of the entry and promotional use of personal information — including name, likeness, photograph, voice, opinions, comments, hometown, and country — in existing or new media, without additional payment or review, except where law prohibits it ([Rules §11](https://webmcp.devpost.com/rules)).

This wording is broader than the Devpost Terms' winner-specific publicity clause. The Official Rules control this challenge.

## Prohibited content and conduct

The incorporated [Devpost Terms §4](https://info.devpost.com/legal/terms-of-service) require accurate identity, affiliation, and work claims, appropriate credit, respect for IP, and compliance with law. They prohibit submission/site use that:

- misrepresents a person, entity, affiliation, prior work, education, skills, or qualifications;
- uses another user's account or impersonates anyone;
- discloses employer/third-party confidential information without authority;
- is harmful, threatening, abusive, harassing, defamatory, derogatory, libelous, privacy-invasive, harmful to minors, or hateful based on protected traits;
- depicts hatred, incites or is likely to incite violence, or contains excessive vulgarity, obscenity, violence, pornography, or sexual activity;
- violates law, IP, contract, fiduciary duty, or proprietary rights;
- substantially duplicates prior software/submissions;
- contains affiliate/referral marketing, spam, junk mail, chain letters, pyramid schemes, unsolicited commercial ads, or excessive repetitive messages;
- contains malware or code meant to interrupt, destroy, or limit systems;
- discloses another person's email, phone, street/box address, Social Security number, or other personal information;
- disrupts dialogue, burdens the service, or excessively uses site features;
- scrapes, crawls, spiders, or robotically accesses Devpost/site content;
- forges headers or identifiers to conceal content origin;
- disparages another person, sponsor, or Devpost; or
- is otherwise inappropriate or inconsistent with the site in Devpost/Sponsor's judgment.

The Official Rules separately permit disqualification for actual or apparent entry-process tampering, rule or law violations, inappropriate or unsportsmanlike conduct, or conduct not in the challenge's best interests. Suspected attempts to undermine the challenge may trigger an investigation and referral to civil or criminal authorities ([Rules §12](https://webmcp.devpost.com/rules)).

There is no public-vote category in this challenge. The generic public-voting terms in Devpost's site agreement do not add a score or popular-vote prize to the four challenge criteria.

## Judging process, criteria, weights, and tie-break

### Stage One: pass/fail viability

Sponsor and Devpost first decide whether the project:

1. reasonably fits the challenge theme; and
2. reasonably uses the required featured APIs/SDKs.

Failing either prevents Stage Two consideration ([Rules §7](https://webmcp.devpost.com/rules)).

### Stage Two: four equal criteria

Every Stage Two criterion has equal weight. If normalized to 100%, that is one-fourth each, although the Rules do not publish a point scale.

| Order | Criterion | Binding question | Practical evidence the wording rewards |
|---:|---|---|---|
| 1 | **WebMCP Leverage** | How thoroughly and skillfully is WebMCP used? Does the code show genuine effort and a working, non-trivial implementation? | Purposeful, discoverable tool flows; robust schemas/results; real agent calls; shared UI state; clear source. |
| 2 | **Execution** | Is it working/runnable with a complete, coherent product experience rather than only a technical proof of concept? | Reliable live deployment, clean end-to-end flow, usable UI, auth/recovery/error handling, faithful demo. |
| 3 | **Potential Impact** | Is there a credible, specific real problem and audience, and does the demonstrated solution actually address it? | Named audience/problem, concrete before/after, demonstrated outcome rather than aspiration. |
| 4 | **Creativity & Ambition** | Is the concept creative and novel, and does it differ from existing concepts? | Distinct use case/interactions and ambitious but functioning scope. |

The exact binding wording is in [Rules §7](https://webmcp.devpost.com/rules) and repeated on the [Devpost overview](https://webmcp.devpost.com/).

OpenAI's promotional FAQ summarizes evaluation as usefulness, originality, execution, thoughtful WebMCP use, and quality of the human-agent experience ([OpenAI challenge page](https://openai.com/webmcp-challenge/)). Those are useful lenses, but they do not create extra weighted categories beyond the four in the Rules.

### Method and discretion

Sponsor/Administrator reserve sole discretion over eligibility and methodology. Evaluation may use expert panels, peer review, automated AI analysis, or a combination. Judges may be Sponsor employees or third parties, need not all be listed, may change before/during judging, and may sit in one or multiple rounds/panels ([Rules §7](https://webmcp.devpost.com/rules)).

The Rules do not publish:

- a numeric score range or rubric levels;
- the number of judges per entry;
- how multiple judge/panel scores are aggregated;
- a minimum Stage Two score;
- a minimum number of WebMCP tools;
- whether source, video, description, or live testing has any fixed evidence weight; or
- whether entrants receive scores or feedback.

### Tie-break

Ties are broken lexicographically in criterion order:

1. higher WebMCP Leverage;
2. then higher Execution;
3. then higher Potential Impact;
4. then higher Creativity & Ambition;
5. if still tied on all four, the judge panel votes.

See [Rules §7, Tie Breaking](https://webmcp.devpost.com/rules). WebMCP Leverage is therefore both equally weighted in normal scoring and the first tie-break.

## Prizes

The top ten eligible submissions each receive one prize bundle ([Rules §9](https://webmcp.devpost.com/rules)):

| Provider | Item per winning submission | Team-member cap stated |
|---|---|---|
| OpenAI | USD $3,000 cash | Per submission |
| OpenAI | Spotlight on `@OpenAIDevs` on Twitter/X | Per submission |
| OpenAI | One Codex Micro | The Rules do not specify otherwise |
| OpenAI | Swag | Up to 3 team members |
| OpenAI | Pro account for one year; organizer materials call this ChatGPT Pro | Up to 3 team members |
| Cloudflare | USD $10,000 Cloudflare credits | Per submission |
| Vercel | $300/month Vercel credits plus $50/month Gateway credits for 12 months, stated total $4,200 | Per submission |
| Render | USD $300 Render credits | Per submission |
| Netlify | USD $500 cash | Per submission |
| Shopify | USD $250 limited-edition Shopify Supply gear | Per submission |
| Google Chrome | Three-month Google AI Ultra subscription, approximately $300 value | “Per winning team member”; no cap stated |

Each winning submission therefore has **$3,500 cash**, and ten bundles yield the advertised **$35,000 challenge cash total**, plus credits/items/subscriptions. Official updates confirm that interpretation ([August 30 prize summary](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)).

Each project is eligible for one Prize; in this table, the multi-provider package is the single prize bundle. Prizes are non-transferable. Sponsor may substitute an equivalent-or-greater-value prize and may award nothing if there is no eligible submission/entrant ([Rules §9](https://webmcp.devpost.com/rules)).

The Rules do not state a Google AI Ultra team-size cap, country/account prerequisites for each subscription, whether credits have service-specific expiration/usage restrictions beyond the descriptions, or a cash alternative for noncash items. Provider fulfillment terms may therefore affect actual usability.

### Optional participant credits are not prizes

The [Resources page](https://webmcp.devpost.com/resources) separately advertises optional build benefits:

- $30 Vercel build credits for the first 1,000 builders, using the published code;
- $50 Render credits, initially up to 500 claims and valid for one year; and
- 3,000 Netlify credits for the first 1,000 eligible form completions.

The Rules specify that Netlify credit requests are limited to registered entrants, subject to supplies/approval, due September 1 at noon PT, non-cash, and redeemable by October 3, 2026 ([Rules §4](https://webmcp.devpost.com/rules)). These benefits are optional and do not affect judging eligibility.

## Winner verification and obligations

A top-scoring entrant is only a **potential** winner until Sponsor/Devpost verifies:

- identity;
- qualifications/eligibility; and
- role in creating the submission.

Post-competition prize affidavits and other Required Forms must be completed and verified. Sponsor/Administrator makes the final designation ([Rules §9](https://webmcp.devpost.com/rules)).

Required Forms are due within ten business days after they are sent. Incorrect or missing information can delay delivery, cause disqualification, or forfeit the prize. Delivery is promised within 60 days after completed forms are received ([Rules §9](https://webmcp.devpost.com/rules)).

Sponsor/Devpost may request additional information or access to verify functionality and authorship. Failure to respond or provide access may disqualify an entry, and public display on Devpost never proves eligibility ([Devpost Terms §6.B](https://info.devpost.com/legal/terms-of-service)).

Payment goes to the individual entrant, the team Representative, or the organization. The Representative allocates team/organization proceeds. Winners and all participating members bear wiring, exchange, banking, and tax obligations. US residents may need Form W-9; non-US residents may need Form W-8BEN. Withholding may apply, and winners must satisfy their jurisdiction's reporting and foreign-exchange rules ([Rules §9](https://webmcp.devpost.com/rules)).

Entrants agree that Sponsor, Administrator, and judge decisions are binding and final ([Rules §10](https://webmcp.devpost.com/rules)).

## Privacy and legal conditions

Devpost may collect names, emails, team members, project name/description, and other required registration/submission information, and may share it with OpenAI. Profiles and submissions may be public. Transactional account emails cannot be opted out of; personal information embedded in a submission may not be editable after the deadline until the challenge ends ([Devpost Privacy Policy](https://info.devpost.com/legal/privacy-policy)).

The Rules contain broad releases, indemnification, and liability limitations. They disclaim responsibility for platform/network failures and lost or corrupted entries. Sponsor/Administrator may cancel, suspend, or modify the challenge for technical failure, fraud, or unanticipated/uncontrolled events ([Rules §§10, 12, 13](https://webmcp.devpost.com/rules)).

Challenge disputes are governed by New York substantive law and, where legal, individual final/binding American Arbitration Association arbitration; class actions and certain damages are waived/limited ([Rules §14](https://webmcp.devpost.com/rules)). Devpost's general Terms have their own site-dispute provisions, but the Official Rules control a challenge-specific conflict.

These are material contract terms, not judging criteria. This report is a technical rules inventory, not legal advice.

## What is expressly not required

No official source found a requirement for:

- a purchase, entry fee, or paid host;
- a specific host;
- an OpenAI API account, API call, model, Codex, or ChatGPT Sites;
- a project built entirely from scratch;
- a particular programming language, framework, backend, or database;
- Chrome origin-trial enrollment;
- the declarative WebMCP API;
- a specific number of WebMCP tools;
- a private repository or proprietary source component;
- a team, or a team-size limit;
- public voting, likes, traffic, or participant popularity;
- use of the optional Devpost Plugin;
- polished video production; or
- a judge actually installing or live-testing the app.

The absence of a formal requirement does not mean the item is irrelevant to the four judging criteria. Multiple coherent tools may demonstrate stronger WebMCP Leverage, while a polished but nonworking demo cannot replace the functionality requirement.

## Ambiguities and conflicts

### 1. Opening time: 11:00 a.m. versus noon

- Official Rules: registration/submission opened August 25 at **11:00 a.m. PT**.
- OpenAI landing page: **12:00 p.m. PT**.

The Rules control ([Rules §§1, 12.4](https://webmcp.devpost.com/rules), [OpenAI page](https://openai.com/webmcp-challenge/)). This is now only a historical provenance issue; both agree on the submission deadline.

### 2. FAQ says “there's no video,” then requires one

One FAQ answer about judge testing includes the sentence “Since there's no video,” while the same FAQ later says a sub-three-minute video is required. The Rules, overview, OpenAI page, later FAQ answer, and organizer updates all require it ([FAQ](https://webmcp.devpost.com/resources), [Rules §4](https://webmcp.devpost.com/rules)). Treat the stray sentence as an obvious error.

### 3. Will judges visit the live URL?

- Rules: judges are **not required** to test and may judge from text, images, and video.
- FAQ: judges “will also visit” the live URL.

The live URL and access are mandatory, but no visit is guaranteed because the Rules control ([Rules §4, Testing](https://webmcp.devpost.com/rules), [FAQ](https://webmcp.devpost.com/resources)).

### 4. Exactly three minutes versus less than three

- Rules and overview: video must be **less than** three minutes.
- Organizer update: “3 minutes maximum.”

Submit below three minutes because that satisfies both ([Rules §4](https://webmcp.devpost.com/rules), [update](https://webmcp.devpost.com/updates/46116-6-days-left-to-build)).

### 5. Scope of the post-deadline freeze

- Rules: no changes to the Submission; Devpost portfolio may be updated; limited authorized corrections are possible.
- FAQ/updates: do not touch Devpost entry, repo, live site, video, project, or team until winners are announced.
- Rules also require the live project to remain available through judging, which can conflict operationally with an absolute no-deploy rule.

Follow the stricter freeze. Ask in writing whether an emergency identical-bit redeploy, credential repair, certificate renewal, or uptime fix is allowed.

### 6. Is the literal `registerTool` snippet mandatory?

The Rules say repositories “should have” a sample `document.modelContext.registerTool(...)` block, not “must contain this literal snippet.” Actual WebMCP use is mandatory, and ChatGPT currently needs imperative top-level registration. Treat real top-level `registerTool` code as required for the safest interpretation, but ask if a wrapper or framework-generated equivalent is acceptable ([Rules §4](https://webmcp.devpost.com/rules), [OpenAI Site Tools](https://learn.chatgpt.com/docs/webmcp)).

### 7. “Required APIs/SDKs” is plural but only WebMCP is named

Stage One refers generically to required APIs/SDKs. The project requirement names WebMCP, while the FAQ says no OpenAI account or particular tool is required. No official source identifies a second mandatory API/SDK. The reasonable reading is that WebMCP is the sole required technology, but the wording could be clarified in writing ([Rules §7](https://webmcp.devpost.com/rules), [FAQ](https://webmcp.devpost.com/resources)).

### 8. Geographic list differs

The Devpost overview names Belarus; the Rules' illustrative exclusion list does not. The Rules nevertheless require current OpenAI API support and make exclusions non-exhaustive. Check the live supported-country list and treat the overview's Belarus exclusion as operative absent written clarification ([Rules §3](https://webmcp.devpost.com/rules), [overview](https://webmcp.devpost.com/)).

### 9. Financial/preferential support is broad

The Rules do not define the boundary between disqualifying OpenAI/Devpost support and ordinary public products, accounts, challenge credits, or programs. Anyone with an OpenAI/Devpost investment, contract, commercial license, grant, incubation benefit, or other preferential relationship should disclose the facts and request a written ruling before entry ([Rules §4](https://webmcp.devpost.com/rules)).

### 10. Open-source-license detection

The Rules require an open-source license file “detectable and visible” in the repository's About/top area but do not define detection, approved licenses, or whether the hosting platform must recognize it automatically. Use a conventional root `LICENSE` file with an OSI-recognized license and verify the platform displays it while logged out ([Rules §4](https://webmcp.devpost.com/rules)).

### 11. Prize fulfillment details

The Rules do not state a cap for per-member Google AI Ultra, all subscription/account country restrictions, credit expiration/usage constraints, or whether Codex Micro is one per submission. Obtain clarification if team allocation or jurisdiction makes these material ([Rules §9](https://webmcp.devpost.com/rules)).

### 12. Authenticated submission form

The public Rules enumerate the substantive required artifacts, but Devpost can present additional required form fields after login. The Rules make the form subordinate if inconsistent, not optional. Open the form early, inventory every required field, and submit enough before the deadline to confirm receipt ([Rules §§4, 12.4](https://webmcp.devpost.com/rules)).

## Recommended written questions before the deadline

The Rules require pre-deadline written clarification of perceived ambiguities. Send material questions to `support@devpost.com` and preserve the response. Highest-value questions are:

1. May the entrant perform an emergency availability-only redeploy of identical judged code during the Judging Period, or must every deployment be immutable until winners are announced?
2. Does framework-generated or wrapper-based imperative WebMCP registration satisfy the repository's `document.modelContext.registerTool(...)` expectation?
3. Is WebMCP the only “required API/SDK” for Stage One?
4. Does any specific OpenAI/Devpost relationship, account, credit, grant, investment, contract, or license constitute prohibited financial/preferential support?
5. Are there team-member caps or jurisdiction/account restrictions for Google AI Ultra, Codex Micro, or other noncash items?
6. If authentication credentials expire during judging, may they be rotated without violating the freeze, and how should new credentials be communicated?

## Source register

### Governing and organizer sources

- [OpenAI WebMCP Challenge landing page](https://openai.com/webmcp-challenge/)
- [Devpost challenge overview](https://webmcp.devpost.com/)
- [Official Rules](https://webmcp.devpost.com/rules)
- [Resources and official FAQ](https://webmcp.devpost.com/resources)
- [Organizer updates index](https://webmcp.devpost.com/updates)
- [“6 days left to build” organizer update](https://webmcp.devpost.com/updates/46116-6-days-left-to-build)
- [“Halfway there. Where are you?” organizer update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)
- [Devpost Terms of Service](https://info.devpost.com/legal/terms-of-service)
- [Devpost Privacy Policy](https://info.devpost.com/legal/privacy-policy)
- [OpenAI API supported countries and territories](https://developers.openai.com/api/docs/supported-countries)

### First-party WebMCP technical sources

- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [WebMCP source and explainer](https://github.com/webmachinelearning/webmcp)
- [OpenAI Site Tools (WebMCP) guide](https://learn.chatgpt.com/docs/webmcp)
- [Chrome WebMCP developer guide](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome WebMCP origin-trial announcement](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- [Chrome WebMCP tool-security guide](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
- [Chrome WebMCP evals guide](https://developer.chrome.com/docs/ai/webmcp/evals)
- [Chrome DevTools WebMCP panel](https://developer.chrome.com/docs/devtools/application/webmcp)

Supporter templates, example apps, hosting documentation, showcases, Discord, and participant discussions were not treated as sources of binding criteria. They are linked from the [official Resources page](https://webmcp.devpost.com/resources) for implementation help and inspiration.
