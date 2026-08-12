import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provider = readFileSync(
  resolve(root, "app/_components/MarketDataProvider.tsx"),
  "utf8",
);
const board = readFileSync(
  resolve(root, "app/_components/MarketBoard.tsx"),
  "utf8",
);

test("shared market provider commits server leaders only after loaded-page revalidation succeeds", () => {
  assert.match(provider, /leaders: BoardMarketSource\["leaders"\]/);
  assert.match(provider, /fixture\?\.leaders \?\? emptyMarketLeaders/);
  assert.match(provider, /setLeaders\(result\.leaders\)/);
  assert.match(provider, /\bmarketMode,\s*\n\s*tokens,\s*\n\s*leaders,/);

  const refresh = provider.slice(
    provider.indexOf("const refresh = async"),
    provider.indexOf("const handleVisibilityChange"),
  );
  assert.equal(
    refresh.match(/setLeaders\(result\.leaders\)/g)?.length,
    1,
    "each successful first-page refresh should publish one leader snapshot",
  );
  assert.ok(
    refresh.indexOf("setLeaders(result.leaders)") >
      refresh.indexOf("tokensRef.current = refreshedTokens"),
    "leaders must not publish before every requested older page has revalidated",
  );

  const loadMore = provider.slice(
    provider.indexOf("const loadMore = useCallback"),
    provider.indexOf("const value = useMemo"),
  );
  assert.doesNotMatch(
    loadMore,
    /setLeaders/,
    "pagination responses must not replace the first-page global leader snapshot",
  );
});

test("live featured tabs consume global server leaders while fixtures retain local ranking", () => {
  const featuredSelection = board.slice(
    board.indexOf("const featured = useMemo"),
    board.indexOf("useEffect(() =>", board.indexOf("const featured = useMemo")),
  );

  assert.match(featuredSelection, /marketMode === "live"/);
  assert.match(featuredSelection, /leaders\.mostTraded/);
  assert.match(featuredSelection, /leaders\.newest/);
  assert.match(featuredSelection, /leaders\.biggestMover/);
  assert.match(featuredSelection, /return rankedToken\(featureTab, tokens\)/);
  assert.ok(
    featuredSelection.indexOf("marketMode === \"live\"") <
      featuredSelection.indexOf("rankedToken(featureTab, tokens)"),
    "live selection must return before the fixture-only local ranker",
  );
});

test("live Board stays in server newest order and scopes controls to loaded pages", () => {
  assert.match(board, /if \(marketMode === "live"\) return matchingTokens;/);
  assert.match(board, /disabled=\{marketMode === "live"\}/);
  assert.match(board, /<option value="newest">Newest indexed first<\/option>/);
  assert.match(
    board,
    /Search and filters apply to loaded newest pages only/,
  );

  const liveSortOptions = board.slice(
    board.indexOf('{marketMode === "live" ? (', board.indexOf("<span>Sort</span>")),
    board.indexOf(") : (", board.indexOf('{marketMode === "live" ? (', board.indexOf("<span>Sort</span>"))),
  );
  assert.doesNotMatch(liveSortOptions, /Most traded|24h volume|Biggest mover|Market cap/);
});

test("empty global leader categories explain eligibility without denying indexed launches", () => {
  assert.match(board, /tokens\.length === 0/);
  assert.match(board, /No indexed trades yet\./);
  assert.match(board, /No eligible 24h mover yet\./);
  assert.match(board, /at least two qualifying indexed swaps in the trailing 24 hours/);
});

test("feature controls stay keyboard-reachable when the active leader category is empty", () => {
  const section = board.slice(
    board.indexOf('<section\n        className="featured-section content-width"'),
    board.indexOf('<section className="protocol-strip"'),
  );
  const articleIndex = section.indexOf('<article className="featured-token">');
  const tablistIndex = section.indexOf('role="tablist"');
  const conditionalPanelIndex = section.indexOf("{featured ? (");

  assert.ok(articleIndex >= 0);
  assert.ok(tablistIndex > articleIndex);
  assert.ok(
    conditionalPanelIndex > tablistIndex,
    "the tablist must render outside the nullable featured-token branch",
  );
  assert.match(
    section.slice(conditionalPanelIndex),
    /className="empty-state"[\s\S]*role="tabpanel"[\s\S]*aria-labelledby=\{`feature-tab-\$\{featureTab\}`\}/,
  );
  assert.match(section, /tabIndex=\{featureTab === tab\.id \? 0 : -1\}/);
  assert.match(section, /handleFeatureTabKeyDown\(event, tabIndex\)/);
});
