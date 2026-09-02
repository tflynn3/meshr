# OpenAI WebMCP Challenge: authoritative rules refresh

Verified **September 1, 2026 at 12:47 a.m. PDT** against the current official OpenAI, Devpost, WebMCP, and Chrome sources listed at the end of this document.

This is a standalone rules dossier. It inventories every formal eligibility, project, submission, judging, ownership, access, and post-deadline condition found in the governing materials. It does **not** assess Meshr; that belongs in the separate compliance audit.

## Bottom line

The governing requirements remain unchanged from the August 30 dossier:

- Submit a working, non-trivial WebMCP web app by **Thursday, September 3, 2026 at 1:00 p.m. Pacific Daylight Time (`20:00 UTC`)**.
- The package must include a judge-accessible live URL, the prescribed four-part description, a public open-source repository containing the functional source/assets/instructions and visible license, and a **public YouTube demo shorter than three minutes with explanatory audio**.
- The project must be new during the Submission Period, or a pre-existing project meaningfully extended with WebMCP after August 25, with dated evidence separating old and new work.
- Access must remain free and unrestricted through judging. The safest reading of organizer instructions is to freeze the submitted project, repository, deployment, video, Devpost entry, and team at the deadline until winners are announced.
- Stage One is pass/fail theme-and-technology viability. Stage Two uses four equally weighted criteria: WebMCP Leverage, Execution, Potential Impact, and Creativity & Ambition.

The [Official Rules](https://webmcp.devpost.com/rules) control inconsistencies with the submission form, challenge site, FAQ, updates, and advertising. The incorporated [Devpost Terms](https://info.devpost.com/legal/terms-of-service) add general account, content, verification, license, and conduct obligations, but the Official Rules control challenge-specific conflicts.

## Changes from the August 30 dossier

### Binding and organizer-rule changes

**No binding amendment was found.** The current Official Rules preserve the same dates, eligibility language, required artifacts, judging criteria, prize table, and post-deadline modification language as the August 30 dossier. The [updates index](https://webmcp.devpost.com/updates) still contains exactly the same two organizer notices: [“6 days left to build”](https://webmcp.devpost.com/updates/46116-6-days-left-to-build) and [“Halfway there. Where are you?”](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you). No September 1 organizer notice was present at this snapshot.

The deadline and freeze guidance have **not** moved:

- Final submission: September 3 at 1:00 p.m. PDT.
- Rules-level freeze: the Submission may not be changed after the Submission Period, except for a narrow Sponsor/Devpost-authorized correction.
- Organizer-level freeze: change nothing in the project, video, repository, team, or live site after the deadline; work in a separate fork if development must continue.

### Time-sensitive change in status

The optional request deadline for the advertised 3,000 Netlify participant credits is now **today, September 1 at 12:00 p.m. PT**. It is an optional benefit, not an entry criterion, and remains subject to availability and approval. Credits are non-cash and must be redeemed by October 3, 2026 ([Official Rules §4](https://webmcp.devpost.com/rules)).

### Current-country-list caveat

OpenAI's [supported-country page](https://developers.openai.com/api/docs/supported-countries) was served with a September 1 modification timestamp and remains a dynamic eligibility dependency. The current list includes the United States and also includes **Brazil**, but the Challenge Rules independently and expressly exclude Brazil. Passing the OpenAI-country check is therefore necessary but not sufficient: the challenge-specific exclusion list and applicable law still control ([Official Rules §3](https://webmcp.devpost.com/rules)).

The earlier dossier did not preserve a prior full country-list snapshot, so this refresh does not claim which countries were added or removed. It records only the current rule: check the live list immediately before submission.

### Newly captured OpenAI runtime constraints

The current [OpenAI Site Tools guide](https://learn.chatgpt.com/docs/webmcp) adds important product-state constraints absent from the earlier dossier:

- Site tools currently require **GPT-5.6 Sol or GPT-5.6 Terra**; GPT-5.6 Luna has WebMCP disabled.
- The ChatGPT desktop app should be current.
- Site tools are currently unavailable in Enterprise and Edu workspaces.
- Availability also depends on rollout and the tools exposed by the current page.
- Tools belong to the providing page and can disappear when the page closes or navigates away.
- The browser exposes Available Site Tools and, when available, Recently Used/Sources for inspecting calls.

These are current OpenAI product limitations, **not new contest eligibility clauses**. They materially affect how to prove the live judge flow. Chrome 149+ with the testing flag remains the alternative explicitly accepted by the Rules.

### Technical-source status

The [WebMCP specification](https://webmachinelearning.github.io/webmcp/) is still the Draft Community Group Report dated August 26, 2026, not a W3C Standard or Standards Track document. Its source repository shows no commit after August 26 at this snapshot; current HEAD is [`41d12f0`](https://github.com/webmachinelearning/webmcp/commit/41d12f057167ccf5954dbcf49d99502cb6c84491).

The previous dossier omitted Chrome's August 26 [tool-design workflow](https://developer.chrome.com/docs/ai/webmcp/build-tools). That guide recommends defining the user goal and initial state, role-playing the whole interaction, accounting for variance, returning actionable failures, evaluating, and monitoring production behavior. It is useful judging-readiness guidance, not a formal challenge condition.

### Additional ambiguities identified

Two drafting defects should be added to the previous dossier's ambiguity list:

1. Rules §5 refers to `openai.devpost.com` even though the actual challenge site and entry path are `webmcp.devpost.com`. Use the live WebMCP challenge site.
2. The rendered `registerTool` example in Rules §4 lacks a comma between `inputSchema` and `execute`. It is illustrative malformed JavaScript, not a requirement to reproduce that typo. Actual working WebMCP registration is what matters.

## Authority hierarchy

Use this order:

1. [Official Rules](https://webmcp.devpost.com/rules): the governing challenge contract; expressly controls inconsistent submission-form, site, FAQ, update, or advertising text.
2. [Devpost Terms of Service](https://info.devpost.com/legal/terms-of-service): incorporated by Rules §15; Official Rules control a challenge-specific conflict.
3. [Challenge overview](https://webmcp.devpost.com/), [Resources/FAQ](https://webmcp.devpost.com/resources), and [organizer updates](https://webmcp.devpost.com/updates): official operational clarifications subordinate to the Rules.
4. [OpenAI challenge page](https://openai.com/webmcp-challenge/): first-party promotional summary that directs entrants to Devpost for full requirements.
5. [OpenAI Site Tools](https://learn.chatgpt.com/docs/webmcp), the [WebMCP draft](https://webmachinelearning.github.io/webmcp/), and [Chrome documentation](https://developer.chrome.com/docs/ai/webmcp): technical definitions and current runtime guidance, not extra prize-contract terms.
6. Templates, showcases, supporter examples, and the optional Devpost plugin: inspiration/helpers only.

Submission creates a contract among the entrant, OpenAI OpCo, LLC, and Devpost, Inc. No purchase or payment is necessary ([Official Rules preamble and §2](https://webmcp.devpost.com/rules)).

The Rules can be amended at any time. An amendment takes effect when stated or, if no time is stated, when posted. A perceived ambiguity must be raised in writing before the deadline; the published contact is `support@devpost.com` ([Official Rules §§12.5–12.7, 16](https://webmcp.devpost.com/rules)).

## Exact schedule

| Event               |                   Controlling Pacific time |                              UTC |
| ------------------- | -----------------------------------------: | -------------------------------: |
| Registration opened |            August 25, 2026, 11:00 a.m. PDT |             August 25, 18:00 UTC |
| Submission opened   |            August 25, 2026, 11:00 a.m. PDT |             August 25, 18:00 UTC |
| Registration closes |       **September 3, 2026, 1:00 p.m. PDT** |       **September 3, 20:00 UTC** |
| Submission closes   |       **September 3, 2026, 1:00 p.m. PDT** |       **September 3, 20:00 UTC** |
| Judging opens       |          September 4, 2026, 10:00 a.m. PDT |           September 4, 17:00 UTC |
| Judging closes      |          September 21, 2026, 5:00 p.m. PDT |          September 22, 00:00 UTC |
| Winners announced   | On/about September 23, 2026, 2:00 p.m. PDT | On/about September 23, 21:00 UTC |

Authority: [Official Rules §1](https://webmcp.devpost.com/rules). The OpenAI page still says the historical opening time was noon rather than 11:00 a.m.; the Rules control. OpenAI says the winner date may move with submission volume ([OpenAI challenge page](https://openai.com/webmcp-challenge/)).

There is no published grace period. The Rules disclaim responsibility for late, incomplete, misdirected, corrupted, or lost entries; proof of sending is not proof of receipt ([Official Rules §10](https://webmcp.devpost.com/rules)).

## Complete formal-criteria inventory

The following tables separate mandatory conditions from official advice. “Formal” means present in the Official Rules or incorporated Devpost Terms, not merely recommended by a technical guide.

### A. Entrant eligibility

| ID   | Formal condition                                                                                                                                                                                                                                                                                                    | Authority                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| E-01 | Every participating individual is at least the age of majority where they reside at the time of entry.                                                                                                                                                                                                              | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-02 | An individual resides in a country/territory currently supported for OpenAI API access.                                                                                                                                                                                                                             | [Rules §3](https://webmcp.devpost.com/rules), [live list](https://developers.openai.com/api/docs/supported-countries) |
| E-03 | An organization exists and was organized/incorporated by entry time, and is based in a supported country/territory.                                                                                                                                                                                                 | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-04 | A team consists only of eligible individuals.                                                                                                                                                                                                                                                                       | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-05 | A team/organization appoints an eligible individual with actual authority as its Representative.                                                                                                                                                                                                                    | [Rules §§3, 4](https://webmcp.devpost.com/rules)                                                                      |
| E-06 | Participation and prize receipt are legal under U.S. and local law.                                                                                                                                                                                                                                                 | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-07 | Entrant is not resident/domiciled in an expressly excluded place: Brazil, China, Hong Kong, Quebec, Russia, Crimea, Cuba, Iran, North Korea, Syria, Venezuela, Donetsk, Luhansk, or another OFAC-designated place. The overview separately lists Belarus, which is also absent from the current API-supported list. | [Rules §3](https://webmcp.devpost.com/rules), [overview](https://webmcp.devpost.com/)                                 |
| E-08 | Entrant is not a Sponsor/Administrator or another organization involved in design, production, paid promotion, execution, or distribution of the challenge.                                                                                                                                                         | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-09 | Entrant is not an employee, representative, or agent of a Promotion Entity.                                                                                                                                                                                                                                         | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-10 | Entrant is not an immediate-family or household member of such a person. Immediate family and three-month household definitions in §3 apply.                                                                                                                                                                        | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-11 | Entrant was not otherwise involved in challenge design, production, promotion, execution, or distribution, nor an immediate-family/household member of such a person.                                                                                                                                               | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-12 | Entrant is not a judge, a judge's employer, or a parent/subsidiary/affiliate of an excluded organization.                                                                                                                                                                                                           | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-13 | Participation creates no real or apparent conflict of interest in Sponsor/Administrator's sole judgment.                                                                                                                                                                                                            | [Rules §3](https://webmcp.devpost.com/rules)                                                                          |
| E-14 | If entering with teammates, every teammate is added and accepts the invitation before the deadline. This is explicit organizer eligibility guidance, though not separately worded in Rules §3.                                                                                                                      | [August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)                              |

Eligible individuals may enter individually, join multiple teams/organizations, and enter more than once subject to the unique-entry rule. The official FAQ states there is no team-size cap; prize items may have smaller recipient caps ([Resources/FAQ](https://webmcp.devpost.com/resources)).

### B. Registration and entry mechanics

| ID   | Formal condition                                                                                                                                       | Authority                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | Register through the WebMCP Devpost site using a free Devpost account.                                                                                 | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| R-02 | Complete every required field on the authenticated Enter a Submission form during the Submission Period.                                               | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| R-03 | Finish the submission workflow; a saved draft is not an entry.                                                                                         | [Rules §4](https://webmcp.devpost.com/rules), [August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you) |
| R-04 | Obtain/use the required development platform under its applicable license terms.                                                                       | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| R-05 | Consent to Sponsor/Devpost collection and maintenance of entrant data for challenge operation/publicity.                                               | [Rules §4](https://webmcp.devpost.com/rules), [Privacy Policy](https://info.devpost.com/legal/privacy-policy)                          |
| R-06 | If using the optional Devpost plugin, accept its additional as-is, data, non-reliance, and entrant-responsibility terms. The plugin is never required. | [Rules §5](https://webmcp.devpost.com/rules)                                                                                           |

### C. Project requirements

| ID   | Formal condition                                                                                                                                                                                                                           | Authority                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| P-01 | Build a **WebMCP-powered web app** exploring an open web where humans and agents interact, collaborate, and create together.                                                                                                               | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-02 | The project can be installed successfully where installation applies.                                                                                                                                                                      | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-03 | It runs consistently on its intended/submitted platform.                                                                                                                                                                                   | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-04 | It functions as depicted in the video and/or claimed in the description.                                                                                                                                                                   | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-05 | It is new during the Submission Period, or was meaningfully extended with WebMCP after August 25 at 11:00 a.m. PDT.                                                                                                                        | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-06 | For a pre-existing project, clearly distinguish prior work from new work and provide dated commit history or equivalent evidence. Only in-window work is judged; earlier WebMCP work does not count.                                       | [Rules §4](https://webmcp.devpost.com/rules), [FAQ](https://webmcp.devpost.com/resources) |
| P-07 | Every third-party SDK, API, and dataset is used with authorization and in compliance with its terms/licensing.                                                                                                                             | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-08 | Open-source software/hardware use complies with its licenses, and the entrant's submission enhances/builds on its functionality.                                                                                                           | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-09 | Any contractor assistance yields components that are the entrant's own work product, derive from entrant ideas/creativity, and are fully owned by the entrant.                                                                             | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-10 | The project was not developed, or derived from a project developed, with financial or preferential OpenAI/Devpost support before the Submission Period ended, including funding/investment, contract development, or a commercial license. | [Rules §4](https://webmcp.devpost.com/rules)                                              |
| P-11 | Awarding a prize creates no real/apparent Sponsor conflict. Sponsor retains sole discretion.                                                                                                                                               | [Rules §4](https://webmcp.devpost.com/rules)                                              |

### D. Required submission artifacts

| ID   | Formal condition                                                                                                                                                                   | Authority                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| S-01 | A working live URL is supplied.                                                                                                                                                    | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-02 | The URL works in ChatGPT's desktop in-app browser or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled and the browser restarted.                                   | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-03 | If authentication is required, valid credentials and complete testing instructions are placed in the submission.                                                                   | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-04 | The text explains why the use case strongly fits WebMCP.                                                                                                                           | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-05 | The text explains how WebMCP creates a better user experience.                                                                                                                     | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-06 | The text explains what people and agents can now do together that was difficult or impossible before.                                                                              | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-07 | The text briefly explains the WebMCP implementation.                                                                                                                               | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-08 | A public repository URL on GitHub, GitLab, or Bitbucket is supplied.                                                                                                               | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-09 | The repository includes all source code, assets, and instructions necessary for the project to function.                                                                           | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-10 | The repository includes an open-source license file that is detectable and visible at the top/About area.                                                                          | [Rules §4](https://webmcp.devpost.com/rules), [FAQ](https://webmcp.devpost.com/resources)                                              |
| S-11 | The repository contains real WebMCP registration code. Rules say repositories “should have” `document.modelContext.registerTool(...)`; actual functioning WebMCP use is mandatory. | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-12 | A demonstration video is **less than three minutes**. Target below `02:59`; judges need not watch beyond three minutes.                                                            | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-13 | The video clearly demonstrates the functioning project.                                                                                                                            | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-14 | The video has audio explaining what was built and how WebMCP was used. Human or AI narration is accepted; silent video/background music alone fails.                               | [Rules §4](https://webmcp.devpost.com/rules), [August 28 update](https://webmcp.devpost.com/updates/46116-6-days-left-to-build)        |
| S-15 | The video is uploaded to YouTube, made publicly visible—not private or unlisted—and linked in the form.                                                                            | [Rules §4](https://webmcp.devpost.com/rules), [August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you) |
| S-16 | The video contains no third-party trademarks, copyrighted music, or other copyrighted material without permission.                                                                 | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-17 | All submission material is English, or a complete English translation is supplied for the video, description, instructions, and all other material.                                | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |
| S-18 | The entry is the entrant/team/organization's original work product.                                                                                                                | [Rules §§4, 8](https://webmcp.devpost.com/rules)                                                                                       |
| S-19 | It is solely owned by that entrant, with no other person/entity holding a right or interest.                                                                                       | [Rules §§4, 8](https://webmcp.devpost.com/rules)                                                                                       |
| S-20 | It does not violate copyright, trademark, patent, trade-secret, contract, privacy, publicity, or other third-party rights.                                                         | [Rules §§4, 8](https://webmcp.devpost.com/rules)                                                                                       |
| S-21 | Submitted content contains no virus, Trojan horse, worm, spyware, disabling device, or harmful/malicious code.                                                                     | [Rules §8](https://webmcp.devpost.com/rules)                                                                                           |
| S-22 | If multiple projects are entered, each is unique and substantially different from the entrant's others in Sponsor/Devpost's sole judgment.                                         | [Rules §4](https://webmcp.devpost.com/rules)                                                                                           |

The Rules do not prescribe an approved-license list. A conventional root OSI-approved license is the safest implementation of S-10; a bespoke source-available/noncommercial license is not a safe substitute.

### E. Judge access and availability

| ID   | Formal condition                                                                                                                                                                                       | Authority                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| A-01 | Provide access to a working website, functioning demo, or test build for judging/testing.                                                                                                              | [Rules §4, Testing](https://webmcp.devpost.com/rules) |
| A-02 | Private/authenticated projects include functioning credentials and instructions.                                                                                                                       | [Rules §4, Testing](https://webmcp.devpost.com/rules) |
| A-03 | The project remains free of charge and unrestricted for Sponsor, Administrator, and judges through September 21 at 5:00 p.m. PDT.                                                                      | [Rules §4, Testing](https://webmcp.devpost.com/rules) |
| A-04 | If uncommon proprietary/third-party hardware is required, provide physical access if Sponsor/Devpost requests it. Smartphones, tablets, and desktop computers are excluded from that special category. | [Rules §4, Testing](https://webmcp.devpost.com/rules) |

Judges are **not required** to install or test the project; they may judge solely from text, images, and video. The live URL nevertheless remains mandatory ([Rules §4, Testing](https://webmcp.devpost.com/rules)). Test it logged out/incognito or on another machine; cached local login, localhost, and expiring tunnels are organizer-identified failure modes ([August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)).

### F. Submission modification and freeze

| ID   | Formal/official condition                                                                                                                                                                                                            | Authority                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-01 | Drafts may be saved and edited before the deadline.                                                                                                                                                                                  | [Rules §6](https://webmcp.devpost.com/rules)                                                                                                                                                                             |
| F-02 | After the deadline, no change or alteration to the Submission is allowed.                                                                                                                                                            | [Rules §6](https://webmcp.devpost.com/rules)                                                                                                                                                                             |
| F-03 | A Devpost portfolio project may technically continue to be updated, but this does not authorize altering the challenge Submission.                                                                                                   | [Rules §6](https://webmcp.devpost.com/rules)                                                                                                                                                                             |
| F-04 | Sponsor/Devpost may authorize a narrow change to remove/replace possible infringement, personal information, or inappropriate material; only the permitted change may be made and the submission must remain substantively the same. | [Rules §6](https://webmcp.devpost.com/rules)                                                                                                                                                                             |
| F-05 | Organizer guidance says to change **nothing** after September 3 at 1:00 p.m. PT: not project, video, repository, live site, description, or team, until winners are announced. Use a separate fork for continued work.               | [August 28 update](https://webmcp.devpost.com/updates/46116-6-days-left-to-build), [FAQ](https://webmcp.devpost.com/resources), [August 30 update](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you) |

The Rules do not say whether an identical-bit emergency redeploy, certificate repair, credential rotation, or outage recovery is permitted. The live-access obligation and absolute organizer freeze can conflict. Ask `support@devpost.com` in writing before the deadline rather than infer an exception.

### G. Incorporated Devpost Terms and conduct

The current [Devpost Terms](https://info.devpost.com/legal/terms-of-service) show “Last Updated: December 5, 2025.” Material entrant obligations include:

- use an account lawfully and protect its credentials;
- provide accurate identity, affiliation, work, education, skill, and qualification information;
- accurately represent work and credit others where appropriate/required;
- comply with law and respect IP, contract, confidentiality, fiduciary, privacy, and proprietary rights;
- do not impersonate, use another account, publish another's personal information, or expose employer/third-party confidential information without authority;
- do not submit abusive, threatening, defamatory, hateful, obscene, pornographic, violent, privacy-invasive, minor-harming, spammy, deceptive, or otherwise inappropriate material;
- do not duplicate another submission or prior software substantially;
- do not include malware or code intended to interrupt/destroy/limit systems;
- do not scrape/crawl/robotically access Devpost, forge identifiers, disrupt service/dialogue, overuse site features, or manipulate public-vote mechanisms; and
- respond to eligibility, identity, authorship, and functionality verification requests.

Violations can cause content removal, disqualification, account termination, or prize reversal. There is no public-vote criterion in this challenge.

The Terms also grant Devpost, OpenAI as Poster, and third parties acting for OpenAI a royalty-free, non-exclusive, worldwide, perpetual license to display and promote the submission while the maker retains ownership. Rules §8 separately grants OpenAI a non-exclusive judging license and three-year challenge/result promotion rights.

### H. Privacy and publicity conditions

The current [Devpost Privacy Policy](https://info.devpost.com/legal/privacy-policy) is effective August 10, 2026. Devpost may collect contact, account, team, and submission data; share hackathon registration/submission information with OpenAI; display profiles/submissions publicly; use transactional communications; and transfer/process data in the United States subject to its stated safeguards.

Rules §§8 and 11 allow worldwide promotion/display of the entry and promotional use of contributors' names, likenesses, photographs, voices, opinions/comments, hometowns, and countries without additional payment or review where law permits ([Official Rules](https://webmcp.devpost.com/rules)). These are contract conditions, not score criteria.

## Judging

### Stage One: pass/fail

The project must:

1. reasonably fit the human-agent/open-web theme; and
2. reasonably apply the required APIs/SDKs featured in the challenge.

The Rules name WebMCP as the required technology and identify no second mandatory API, OpenAI model, OpenAI API, host, framework, or backend SDK. The plural “APIs/SDKs” remains ambiguous, but the [FAQ](https://webmcp.devpost.com/resources) confirms no OpenAI account, Codex, paid tool, or particular host is required.

### Stage Two: four equal criteria

| Tie-break order | Criterion                 | Exact controlling question summarized                                                                                       |
| --------------: | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
|               1 | **WebMCP Leverage**       | How thoroughly and skillfully is WebMCP used? Does the code show genuine effort and a working, non-trivial implementation?  |
|               2 | **Execution**             | Is the project working/runnable with a complete, coherent product experience rather than only a technical proof of concept? |
|               3 | **Potential Impact**      | Is there a credible, specific real problem and audience, and does the demonstrated solution address it?                     |
|               4 | **Creativity & Ambition** | Is the concept creative, novel, and different from existing concepts?                                                       |

All four have equal normal weight. Ties are resolved in the table order, then by panel vote if still tied ([Rules §7](https://webmcp.devpost.com/rules)).

Sponsor/Devpost control eligibility and judging methodology. They may use expert panels, peer review, automated AI analysis, or a combination; judges may be employees or third parties, need not all be named, may change, and may operate in multiple rounds/panels. No numerical scale, minimum Stage Two score, minimum tool count, evidence weighting, score aggregation formula, or feedback commitment is published.

OpenAI's promotional page also mentions usefulness, originality, execution, thoughtful WebMCP use, and human-agent-experience quality. Those are interpretive lenses, not additional weighted categories ([OpenAI challenge page](https://openai.com/webmcp-challenge/)).

## Binding WebMCP compatibility versus non-binding quality guidance

### Safest binding compatibility target

For contest purposes, use:

- a secure, working live top-level web page;
- actual imperative JavaScript registration through `document.modelContext.registerTool(...)`;
- capability detection before registration;
- at least one useful, non-trivial tool that a supported agent can discover and call; and
- a visible human-facing interface reflecting the same state and authorization.

Why: Rules §4 requires a WebMCP app and shows imperative registration. ChatGPT's current [Site Tools guide](https://learn.chatgpt.com/docs/webmcp) does not support declarative form tools or any iframe-registered tools, including same-origin iframes. Chrome supports a broader API, but a declarative-only or iframe-only implementation would fail the advertised ChatGPT path.

### Current normative WebMCP draft

The [WebMCP draft](https://webmachinelearning.github.io/webmcp/) currently specifies:

- `Document.modelContext` and `ModelContext` only in secure contexts;
- required tool `name`, `description`, and `execute`; optional `title`, `inputSchema`, and `annotations`;
- unique names of 1–128 ASCII alphanumeric/underscore/hyphen/period characters;
- nonempty names/descriptions and JSON-serializable input schemas/results;
- `readOnlyHint` and `untrustedContentHint` annotations;
- abort-driven unregister/cancellation, `getTools`, `executeTool`, and `toolchange` support;
- same-origin tool exposure by default, with explicit trustworthy-origin `exposedTo`/`fromOrigins` controls;
- a `tools` Permissions Policy defaulting to `self`; and
- origin-keyed isolation: enabling `document.domain`, including through `Origin-Agent-Cluster: ?0`, disables the API except for the draft's local-file handling.

These technical semantics determine whether code works, but each bullet is not separately scored or disqualifying unless it breaks the required live WebMCP implementation.

### Official quality/security/evaluation guidance

Not formal checklist gates, but directly relevant to WebMCP Leverage and Execution:

- Design tools around concrete user goals, initial state, permissions, and the full conversational journey; handle variations and recovery ([Chrome build-tools](https://developer.chrome.com/docs/ai/webmcp/build-tools)).
- Prefer clear, single-purpose, non-overlapping tools; mostly static registration; concise names/descriptions; visible UI state; strict implementation-side validation; descriptive failures; and graceful rate/error handling ([Chrome best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices)).
- Treat definitions and results as untrusted, use truthful annotations, expose cross-origin tools narrowly, and keep metadata/output bounded. Chrome currently recommends about 500 characters/tool description, 150/parameter description, 30/tool or parameter name, and 1.5K/tool output ([Chrome security](https://developer.chrome.com/docs/ai/webmcp/secure-tools)).
- Test deterministic code/UI/side effects; probabilistic direct and ambiguous prompts; correct tool/parameter selection; output use; alternate ordering; full journeys; and mid-chain failures ([Chrome evals](https://developer.chrome.com/docs/ai/webmcp/evals)).
- OpenAI says to reuse existing authentication, authorization, and input validation; keep inputs narrow; disclose side effects; return verifiable results; and preserve the normal non-WebMCP interface ([OpenAI Site Tools](https://learn.chatgpt.com/docs/webmcp)).

## Prizes and winner verification

Ten eligible submissions each receive one multi-provider bundle ([Rules §9](https://webmcp.devpost.com/rules)):

- OpenAI: $3,000 cash, `@OpenAIDevs` spotlight, one Codex Micro, swag for up to three members, and one-year Pro accounts for up to three members;
- Netlify: $500 cash;
- Cloudflare: $10,000 credits;
- Vercel: $300/month Vercel plus $50/month Gateway credits for 12 months ($4,200 stated total);
- Render: $300 credits;
- Shopify: $250 limited-edition gear; and
- Google Chrome: three-month Google AI Ultra subscription per winning team member, approximately $300/member, with no published team cap in the Rules.

That is $3,500 cash per winning submission and $35,000 challenge cash total. Each project can receive one prize bundle. Prizes are non-transferable; Sponsor can substitute equal-or-greater value and can award none if no eligible entry exists.

Potential winners must verify identity, qualifications, eligibility, and role in creating the project. Required forms are due within ten business days after delivery; errors/nonresponse can delay delivery, disqualify, or forfeit the prize. Delivery is promised within 60 days after completed forms. The individual, team Representative, or organization receives payment and handles allocation, fees, banking/exchange, withholding, tax, and applicable W-9/W-8BEN obligations ([Rules §9](https://webmcp.devpost.com/rules)).

## Legal conditions that are not score criteria

Entrants agree to the Rules and final/binding decisions; broad releases, defense/indemnity, and liability limitations; possible challenge cancellation/suspension/modification for failures, fraud, or uncontrolled events; and disqualification for tampering, rule/law violations, unsportsmanlike/inappropriate conduct, or conduct contrary to challenge interests ([Rules §§10–13](https://webmcp.devpost.com/rules)).

Challenge disputes are governed by New York substantive law and, where enforceable, individual final/binding AAA arbitration. Class proceedings and specified damages are waived/limited ([Rules §14](https://webmcp.devpost.com/rules)). This dossier is a technical compliance inventory, not legal advice.

## What is not required

No official source imposes:

- a purchase, entry fee, paid host, or paid development tool;
- OpenAI API use, an OpenAI model/API account, Codex, or ChatGPT Sites;
- a specific hosting provider, language, framework, backend, or database;
- a project built entirely from scratch;
- Chrome origin-trial enrollment;
- declarative WebMCP support;
- more than one tool or any specific tool count;
- a team or a team-size maximum;
- private/proprietary repository access as an alternative to public source;
- public votes, likes, traffic, or participant popularity;
- use of the optional Devpost plugin;
- polished video production; or
- actual judge installation/live testing.

Absence as a formal requirement does not make an item irrelevant to Stage Two. A reliable multi-tool journey can improve WebMCP Leverage; a deployed coherent UI can improve Execution.

## Current ambiguity register

1. **Historical opening time:** Rules say August 25 at 11:00 a.m.; OpenAI page says noon. Rules control.
2. **FAQ video typo:** one answer says “Since there's no video,” while Rules, overview, later FAQ, and updates require video. Video is mandatory.
3. **Judge visit:** Rules say judges need not test; FAQ says they will visit. Live URL is mandatory, visit is not guaranteed.
4. **Video duration:** Rules say less than three minutes; update says three minutes maximum. Submit below three minutes.
5. **Freeze scope:** Rules freeze the Submission; updates freeze project, repository, live site, video, and team. Follow the stricter instruction.
6. **Emergency maintenance:** no published answer for identical-bit redeploy, certificate/credential repair, or outage response during freeze.
7. **Literal snippet:** Rules say repositories “should have” a sample `registerTool` call. Actual imperative use is mandatory for the safest reading; a literal `search_products` tool is not.
8. **Malformed snippet:** the rendered sample omits a comma before `execute`; do not copy the syntax error.
9. **Plural APIs/SDKs:** Stage One uses a generic plural, but only WebMCP is identified as required.
10. **Challenge host typo:** §5 says `openai.devpost.com`; the actual challenge is `webmcp.devpost.com`.
11. **Geography:** the overview names Belarus; the Rules' illustrative list does not. The dynamic supported-country condition independently excludes unsupported Belarus.
12. **Brazil:** the current API-supported list includes Brazil, but Rules §3 expressly excludes it. The explicit challenge exclusion controls.
13. **Preferential support:** no boundary is published for ordinary accounts/public credits versus prohibited OpenAI/Devpost support. Funding, investment, contracts, grants, or commercial licensing warrant written clarification.
14. **License detection:** no license list or detection test is defined. Use a conventional root OSI-approved license and verify logged-out platform detection.
15. **Prize details:** no complete country/account/expiry constraints or cash substitutes for every noncash item are published.
16. **Authenticated form:** public rules cannot reveal every current authenticated required form field. The form must still be completed.

## Final authoritative checklist

Before the deadline, preserve evidence that:

- entrant eligibility and conflicts were checked against the current country list and §3 exclusions;
- the final Devpost project shows **submitted**, not draft, and all teammates accepted;
- the live URL works from a clean supported browser with any supplied credentials;
- a compatible agent discovers and successfully calls a real WebMCP tool;
- the core human-agent journey works end to end and matches all claims/video;
- the description answers all four required questions;
- the public repository contains all functional source/assets/instructions, a detected open-source license, and WebMCP registration code;
- pre-existing versus in-window work is documented if relevant;
- third-party code, APIs, data, media, marks, generated assets, narration, and music have documented rights;
- the public YouTube video is under three minutes, narrated, and demonstrates the working project;
- judge access remains free/unrestricted through September 21;
- an immutable final commit/tag, deployment identity, video URL, entry capture, and team roster are archived; and
- the submitted artifacts remain frozen after September 3 at 1:00 p.m. PDT under the stricter organizer guidance.

## Source register

### Governing and organizer sources

- [OpenAI WebMCP Challenge](https://openai.com/webmcp-challenge/)
- [Devpost challenge overview](https://webmcp.devpost.com/)
- [Official Rules](https://webmcp.devpost.com/rules)
- [Resources and official FAQ](https://webmcp.devpost.com/resources)
- [Organizer updates index](https://webmcp.devpost.com/updates)
- [“6 days left to build”](https://webmcp.devpost.com/updates/46116-6-days-left-to-build)
- [“Halfway there. Where are you?”](https://webmcp.devpost.com/updates/46123-halfway-there-where-are-you)
- [Devpost Terms of Service](https://info.devpost.com/legal/terms-of-service) — page states last updated December 5, 2025
- [Devpost Privacy Policy](https://info.devpost.com/legal/privacy-policy) — effective August 10, 2026
- [OpenAI API supported countries and territories](https://developers.openai.com/api/docs/supported-countries)

### First-party technical sources

- [OpenAI Site Tools](https://learn.chatgpt.com/docs/webmcp)
- [WebMCP Draft Community Group Report](https://webmachinelearning.github.io/webmcp/)
- [WebMCP source/explainer](https://github.com/webmachinelearning/webmcp)
- [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [Chrome best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices)
- [Chrome build-tools workflow](https://developer.chrome.com/docs/ai/webmcp/build-tools)
- [Chrome security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools)
- [Chrome evaluation guidance](https://developer.chrome.com/docs/ai/webmcp/evals)
- [Chrome DevTools WebMCP panel](https://developer.chrome.com/docs/devtools/application/webmcp)

Supporter templates, showcases, Discord messages, participant discussions, search snippets, and secondary commentary were not treated as authoritative criteria.
