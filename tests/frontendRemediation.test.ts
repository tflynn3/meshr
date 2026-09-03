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
  assert.match(topologySource, /fitView\(\{ padding: 0\.04, duration: 0 \}\)/);
  assert.match(topologySource, /<FitTopologyToNodes layoutKey=/);
  assert.match(topologySource, /observer\.disconnect\(\);\n  \}, \[presentation\]\);/);
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
  assert.match(narrowMeshStyles, /\.inspector-reopen\s*\{[^}]*position:\s*fixed/);
  assert.match(
    narrowMeshStyles,
    /@media \(max-width: 900px\)[\s\S]*\.guest-codex-invitation\s*\{[^}]*grid-template-columns:\s*1fr/,
  );
  assert.match(narrowMeshStyles, /\.map-key small\s*\{[^}]*display:\s*none/);
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
