import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

const repo = path.resolve(__dirname, "../..");

const COPIES = [
  "src/plugins/agent-plugin/skills/paireto-viz/SKILL.md",
  "src/plugins/pi/assets/skills/paireto-viz/SKILL.md",
  "src/plugins/opencode/assets/commands/paireto-viz.md",
  "src/plugins/claude-code/assets/commands/viz.md",
];

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

function read(file: string): { frontmatter: string; body: string } {
  const text = fs.readFileSync(path.join(repo, file), "utf8");
  const match = FRONTMATTER.exec(text);
  assert.ok(match, `${file} has frontmatter`);
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

suite("viz skill copies", () => {
  test("every harness copy has the same body once the tool prefix is removed", () => {
    const bodies = COPIES.map((file) =>
      read(file).body.replaceAll("mcp__plugin_paireto_bridge__", ""),
    );
    for (const [index, body] of bodies.entries()) {
      assert.strictEqual(body, bodies[0], `${COPIES[index]} drifted from ${COPIES[0]}`);
    }
  });

  test("every copy has the same description", () => {
    const descriptions = COPIES.map(
      (file) => /^description: (.+)$/m.exec(read(file).frontmatter)?.[1],
    );
    assert.ok(descriptions[0]);
    assert.deepStrictEqual(new Set(descriptions).size, 1);
  });

  test("the skill copies are named for their slash command", () => {
    assert.match(read(COPIES[0]).frontmatter, /^name: paireto-viz$/m);
    assert.match(read(COPIES[1]).frontmatter, /^name: paireto-viz$/m);
  });

  test("the Claude Code copy names both tools by their plugin address", () => {
    const body = read("src/plugins/claude-code/assets/commands/viz.md").body;
    assert.ok(body.includes("`mcp__plugin_paireto_bridge__paireto_get_changes` tool"));
    assert.ok(body.includes("`mcp__plugin_paireto_bridge__paireto_show_viz` tool"));
  });

  test("the built Codex copy names both tools by their MCP address", () => {
    const built = fs.readFileSync(
      path.join(repo, "dist/plugins/agent-plugin/com.openai.codex/skills/paireto-viz/SKILL.md"),
      "utf8",
    );
    assert.ok(built.includes("`mcp__paireto__paireto_get_changes` tool"));
    assert.ok(built.includes("`mcp__paireto__paireto_show_viz` tool"));
  });
});
