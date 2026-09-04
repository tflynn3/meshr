import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const topologySource = readFileSync(
  new URL("../src/components/TopologyCanvas.tsx", import.meta.url),
  "utf8",
);
const ledgerSource = readFileSync(
  new URL("../src/components/AgentActivityLedger.tsx", import.meta.url),
  "utf8",
);
const providerDialogSource = readFileSync(
  new URL("../src/auth/ProviderLinkDialog.tsx", import.meta.url),
  "utf8",
);
const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("inaccessible deep links remain addressed and render an unavailable state", () => {
  const selection = appSource.slice(
    appSource.indexOf("const selectedMesh"),
    appSource.indexOf("const topology"),
  );
  assert.doesNotMatch(selection, /activityState\.meshes\[0\]/);
  assert.match(appSource, /title="Mesh unavailable"/);
  assert.match(appSource, /title="Conversation unavailable"/);
  assert.match(appSource, /requested address has been preserved/);
});

test("setup host selection is an honest grouped-button control", () => {
  const picker = appSource.slice(
    appSource.indexOf('id="agent-host-picker-label"'),
    appSource.indexOf('{mode === "browser" ?'),
  );
  assert.match(picker, /role="group"/);
  assert.match(picker, /aria-pressed=/);
  assert.doesNotMatch(picker, /role="tab"|aria-selected=/);
  assert.match(appSource, /aria-labelledby="agent-host-picker-label"/);
});

test("visibility and ledger coverage match enforced and recorded boundaries", () => {
  assert.match(appSource, /unlisted: "Joined-only"/);
  assert.match(appSource, /Only joined agents can open it/);
  assert.doesNotMatch(appSource, /Link access only/);
  assert.match(ledgerSource, /Recorded: exact conversation reads and authored posts or replies/);
  assert.match(ledgerSource, /Not recorded: discovery, lists, observation, follows, joins, or profile reads/);
});

test("topology edge motion follows the user's reduced-motion preference", () => {
  assert.match(topologySource, /matchMedia\?\.\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(topologySource, /animated: !reducedMotion/);
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(stylesSource, /\.react-flow__edge\.animated path/);
});

test("topology badges retain full agent identity in accessible labels", () => {
  assert.match(topologySource, /const identity = `\$\{data\.agent\.name\} \(@\$\{data\.agent\.handle\}\)`/);
  assert.match(topologySource, /title=\{identity\}/);
  assert.match(topologySource, /aria-label=\{`Inspect agent: \$\{identity\}`\}/);
  assert.match(topologySource, /aria-label=\{identity\} title=\{identity\}>\{badge\}/);
});

test("topology refits after React Flow has measured a new layout", () => {
  assert.match(topologySource, /const nodesInitialized = useNodesInitialized\(\)/);
  assert.match(topologySource, /if \(!nodesInitialized\) return/);
  assert.match(topologySource, /const frame = window\.requestAnimationFrame\(\(\) => \{/);
  assert.match(topologySource, /fitView\(\{ padding: 0\.04, duration: 0 \}\)/);
  assert.match(topologySource, /return \(\) => window\.cancelAnimationFrame\(frame\)/);
  assert.match(topologySource, /key=\{layoutKey\}/);
  assert.match(topologySource, /<FitTopologyToNodes layoutKey=/);
  assert.match(topologySource, /observer\.disconnect\(\);\n  \}, \[presentation\]\);/);
});

test("changing the selected topic or traffic link remounts its inspector", () => {
  assert.match(appSource, /<TrafficInspector\s+key=\{selectedLink\.id\}/);
  assert.match(appSource, /<ConversationInspector\s+key=\{topic\.id\}/);
});

test("setup-ready guidance distinguishes existing portfolios from first-agent setup", () => {
  assert.match(appSource, /const hasAgents = agents\.length > 0/);
  assert.match(appSource, /hasAgents\s+\? "Choose an agent for page tools"\s+: "Codex can create your first agent"/);
  assert.match(appSource, /hasAgents\s+\? "Choose an agent to follow the signal"\s+: "Tell Codex what your agent should work on"/);
  assert.match(appSource, /const hasPortfolioAgents = portfolio\.length > 0/);
  assert.match(appSource, /hasPortfolioAgents\s+\? "Open Your agents to enable page tools"\s+: "Ask Codex to create your agent"/);
  assert.doesNotMatch(appSource, /Profiles synced/);
  assert.match(appSource, /Profiles saved in Meshr/);
});

test("mesh controls distinguish editable settings from read-only details", () => {
  assert.match(appSource, /const currentRole = mesh\.humanRoleAssignments\.find\(/);
  assert.match(appSource, /const canConfigureMesh = currentRole === "owner" \|\| currentRole === "steward"/);
  assert.match(appSource, /\{canConfigureMesh \? "Settings" : "Mesh details"\}/);
  assert.match(appSource, /<h3>CONNECTED THROUGH<\/h3>/);
  assert.match(appSource, /<strong>Page tools<\/strong>/);
});

test("closing the inspector preserves the medium-width mesh columns", () => {
  const mediumWidthStyles = stylesSource.slice(
    stylesSource.indexOf("@media (max-width: 980px)"),
    stylesSource.indexOf("@media (max-width: 720px)"),
  );

  assert.match(
    appSource,
    /className=\{`mesh-experience \$\{inspectorOpen \? "" : "inspector-closed"\}`\}/,
  );
  assert.match(
    appSource,
    /className="inspector-reopen"[^>]*>Open conversation details<\/button>/,
  );
  assert.doesNotMatch(
    mediumWidthStyles,
    /\.mesh-experience\.inspector-closed\s*\{[^}]*display:\s*block/,
    "the closed-inspector state must keep the agent panel and mesh stage in the responsive grid",
  );
});

test("the empty agent setup panel is content-sized, scroll-safe, and labelled", () => {
  assert.match(
    appSource,
    /<aside className=\{`mesh-agent-panel \$\{portfolio\.length === 0 \? "setup-empty" : ""\}`\} aria-labelledby="mesh-agent-panel-title">/,
  );
  assert.match(appSource, /<strong id="mesh-agent-panel-title">Agent activity<\/strong>/);
  assert.match(appSource, /className=\{`webmcp-status \$\{webMcpStatus\}`\} role="status"/);
  assert.match(
    stylesSource,
    /\.mesh-agent-panel\.setup-empty\s*\{[^}]*height:\s*auto/,
  );
  assert.match(
    stylesSource,
    /\.mesh-agent-list\s*\{[^}]*overflow-y:\s*auto/,
  );
});

test("responsive mesh overlays and floating controls stay inside narrow desktops", () => {
  const overlayStyles = stylesSource.slice(
    stylesSource.indexOf("@media (max-width: 1193px)"),
    stylesSource.indexOf("@media (max-width: 560px)"),
  );
  const narrowMeshStyles = stylesSource.slice(
    stylesSource.indexOf("@media (max-width: 980px)"),
    stylesSource.indexOf("@media (max-width: 720px)"),
  );

  assert.match(
    overlayStyles,
    /\.mesh-experience\s*\{[^}]*grid-template-columns:\s*205px minmax\(0, 1fr\)/,
  );
  assert.match(overlayStyles, /\.inspector\s*\{[^}]*position:\s*fixed/);
  assert.match(
    overlayStyles,
    /\.inspector\s*\{[^}]*left:\s*auto[^}]*width:\s*min\(340px, calc\(100vw - 28px\)\)/,
  );
  assert.match(narrowMeshStyles, /\.inspector-reopen\s*\{[^}]*position:\s*fixed/);
  assert.match(
    narrowMeshStyles,
    /@media \(max-width: 900px\)[\s\S]*\.guest-codex-invitation\s*\{[^}]*grid-template-columns:\s*1fr/,
  );
  assert.match(narrowMeshStyles, /\.map-key small\s*\{[^}]*display:\s*none/);

  const embeddedBrowserStyles = stylesSource.slice(
    stylesSource.lastIndexOf("@media (max-width: 560px)"),
  );
  assert.match(
    embeddedBrowserStyles,
    /\.meshr-app\s*\{[^}]*grid-template-columns:\s*44px minmax\(0, 1fr\)/,
  );
  assert.match(embeddedBrowserStyles, /\.rail-mesh\s*\{[^}]*width:\s*36px/);
  assert.match(
    embeddedBrowserStyles,
    /\.inspector\s*\{[^}]*width:\s*min\(340px, calc\(100vw - 64px\)\)/,
  );
  assert.match(
    embeddedBrowserStyles,
    /\.rail-profile\s*\{[^}]*grid-template-columns:\s*1fr[^}]*grid-template-rows:\s*30px 26px 26px/,
  );
});

test("view changes reset stale page offsets and dialogs contain their own scrolling", () => {
  assert.match(appSource, /const viewScrollKey = view\.kind === "mesh"/);
  assert.match(
    appSource,
    /useLayoutEffect\(\(\) => \{\s*window\.scrollTo\(\{ left: 0, top: 0 \}\);\s*\}, \[viewScrollKey\]\)/,
  );
  assert.match(appSource, /document\.body\.classList\.add\("modal-open"\)/);
  assert.match(providerDialogSource, /document\.body\.classList\.add\("modal-open"\)/);
  assert.match(stylesSource, /body\.modal-open\s*\{[^}]*overflow:\s*hidden/);
  assert.match(stylesSource, /\.inspector\s*\{[^}]*overscroll-behavior:\s*contain/);
  assert.match(stylesSource, /\.modal\s*\{[^}]*overscroll-behavior:\s*contain/);
  assert.match(stylesSource, /\.account-dialog\s*\{[^}]*overscroll-behavior:\s*contain/);
});

test("the mesh rail stays pinned while a compact mesh page scrolls", () => {
  assert.match(
    appSource,
    /className=\{`meshr-app \$\{view\.kind === "mesh" \? "mesh-open" : "portfolio-open"\}`\}/,
  );
  assert.match(
    stylesSource,
    /\.mesh-open > \.mesh-rail\s*\{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*height:\s*100dvh/,
  );
});
