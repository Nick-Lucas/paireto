import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

interface MenuItem {
  command: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
) as { contributes: { menus: Record<string, MenuItem[]> } };

function entry(menu: string): MenuItem | undefined {
  return manifest.contributes.menus[menu].find((item) => item.command === "paireto.review.openUml");
}

suite("UML diff — ways to open it", () => {
  test("the Paireto view title bar always shows the UML Diff button", () => {
    const button = entry("view/title");
    assert.ok(button, "the button must be in the view title bar");
    assert.strictEqual(button.when, "view == paireto.main");
    assert.ok(button.group?.startsWith("navigation"), "it must be a visible title button");
  });

  test("a Paireto diff shows the UML Diff button beside Compare To", () => {
    const button = entry("editor/title");
    assert.ok(button, "the button must be in the editor title bar");
    assert.strictEqual(button.when, "paireto.reviewDiffActive");
    const compareTo = manifest.contributes.menus["editor/title"].find(
      (item) => item.command === "paireto.review.pickDiffCompareTo",
    );
    assert.ok(button.group?.startsWith("navigation"), "it must be a visible title button");
    assert.ok((button.group ?? "") > (compareTo?.group ?? ""), "it must come after Compare To");
  });

  test("the Changed Files row keeps its UML Diff button", () => {
    const button = entry("view/item/context");
    assert.strictEqual(button?.when, "view == paireto.main && viewItem =~ /^section:files/");
  });
});
