import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { Generator } from "../../src/generator/index.js";
import {
  buildCopilotInstructions,
  buildDirectoryInstructions,
  renderDirectoryInstructionsFile,
} from "../../src/generator/instructions-writer.js";
import type { AnalysisResult, SkillDefinition } from "../../src/analyzer/types.js";

function skill(name: string, sourceDir: string): SkillDefinition {
  return {
    name,
    description: `${name} skill`,
    sourceDir,
    patterns: [`Follow ${name} conventions`],
    triggers: [],
    category: "patterns",
    examples: [],
  };
}

function analysis(skills: SkillDefinition[]): AnalysisResult {
  return { repoName: "demo", skills, agents: [], tools: [], hooks: [], summary: "" };
}

describe("path-specific instructions", () => {
  it("writes each file to .github/instructions instead of the folder itself", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentsmith-instructions-"));
    try {
      const file = ".github/instructions/agentsmith-src-api.instructions.md";
      const result = await new Generator(root).generate(analysis([skill("api", "src/api")]));

      expect(result.files).toContain(file);
      expect(await fs.readFile(path.join(root, file), "utf-8")).toContain('applyTo: "src/api/**"');
      await expect(fs.access(path.join(root, "src/api/.copilot-instructions.md")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("gives each folder its own file and an applyTo glob that matches its literal name", () => {
    const instructions = buildDirectoryInstructions(analysis([
      skill("blog-route", "app/blog/[slug]"),
      skill("blog-folder", "app/blog/slug"),
      skill("marketing", "app/(marketing),old"),
    ]));

    expect(instructions.map(({ file, applyTo }) => ({ file, applyTo }))).toEqual([
      {
        file: ".github/instructions/agentsmith-app-blog-slug.instructions.md",
        applyTo: "app/blog/?slug?/**",
      },
      {
        file: ".github/instructions/agentsmith-app-blog-slug-2.instructions.md",
        applyTo: "app/blog/slug/**",
      },
      {
        file: ".github/instructions/agentsmith-app-marketing-old.instructions.md",
        applyTo: "app/?marketing??old/**",
      },
    ]);
  });

  it("keeps frontmatter first and preserves user edits when the managed block is refreshed", () => {
    const [instruction] = buildDirectoryInstructions(analysis([skill("api", "src/api")]));
    const fresh = renderDirectoryInstructionsFile(instruction);
    expect(fresh.startsWith('---\napplyTo: "src/api/**"\n---\n\n<!-- agentsmith:managed -->')).toBe(true);

    const edited = `${fresh.replace(
      'applyTo: "src/api/**"\n',
      'applyTo: "src/api/**"\nexcludeAgent: "code-review"\n',
    )}User notes\n`;
    const stale = edited.replace("- Follow api conventions", "- Old managed advice");
    expect(renderDirectoryInstructionsFile(instruction, stale)).toBe(edited);

    const withoutFrontmatter = "<!-- agentsmith:managed -->\nold\n<!-- /agentsmith:managed -->\n";
    expect(renderDirectoryInstructionsFile(instruction, withoutFrontmatter)).toBe(fresh);
  });
});

describe("copilot-instructions.md", () => {
  it("lists each test command and testing pattern once", () => {
    const unitTests = { ...skill("unit-tests", "tests"), category: "quality" as const };
    const testTool = { name: "test", command: "npm test", description: "Run the test suite" };
    const content = buildCopilotInstructions({
      ...analysis([unitTests, { ...unitTests, name: "e2e-tests" }]),
      tools: [testTool, testTool, testTool],
    });

    const testing = content.split("## Testing\n")[1].split("\n## ")[0];
    expect(testing.trim().split("\n")).toEqual([
      "- Run tests: `npm test`",
      "- Follow unit-tests conventions",
    ]);
  });
});
