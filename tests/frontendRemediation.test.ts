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
