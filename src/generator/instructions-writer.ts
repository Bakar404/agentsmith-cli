/**
 * Instructions Writer - Copilot Instructions Generator
 * Generates .github/copilot-instructions.md and path-specific
 * .github/instructions/*.instructions.md files from analysis results.
 * "I'd like to share a revelation that I've had..."
 */

import type { AnalysisResult, SkillDefinition, ToolDefinition } from "../analyzer/types.js";

export interface DirectoryInstruction {
  directory: string;
  /** Repository-relative path of the path-specific instructions file. */
  file: string;
  /** Glob for the file's `applyTo` frontmatter. */
  applyTo: string;
  /** Managed block, without frontmatter. */
  content: string;
}

const MAX_INSTRUCTIONS_SLUG_LENGTH = 80;
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function buildDirectoryInstructions(analysis: AnalysisResult): DirectoryInstruction[] {
  const grouped = new Map<string, SkillDefinition[]>();
  for (const skill of analysis.skills) {
    const directory = skill.sourceDir.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
    if (!directory || directory === "." || directory.includes("..")) continue;
    const list = grouped.get(directory) ?? [];
    list.push(skill);
    grouped.set(directory, list);
  }

  const usedSlugs = new Set<string>();
  return Array.from(grouped.entries()).map(([directory, skills]) => {
    const patterns = Array.from(new Set(skills.flatMap((skill) => skill.patterns)));
    const antiPatterns = Array.from(new Set(skills.flatMap((skill) => skill.antiPatterns ?? [])));
    const references = Array.from(new Set(skills.flatMap((skill) => skill.codebaseReferences ?? [])));
    const sections = [
      "<!-- agentsmith:managed -->",
      `# Copilot Instructions for \`${directory}/\``,
      "",
      "## Conventions",
      "",
      ...(patterns.length > 0 ? patterns.map((item) => `- ${item}`) : ["- Follow nearby implementation patterns."]),
    ];
    if (antiPatterns.length > 0) {
      sections.push("", "## Anti-Patterns", "", ...antiPatterns.map((item) => `- ${item}`));
    }
    if (references.length > 0) {
      sections.push(
        "",
        "## Codebase References",
        "",
        "Use `#codebase` to inspect:",
        ...references.map((item) => `- \`${item}\``),
      );
    }
    sections.push("", "<!-- /agentsmith:managed -->");
    return {
      directory,
      file: `.github/instructions/agentsmith-${uniqueSlug(directory, usedSlugs)}.instructions.md`,
      applyTo: toApplyToGlob(directory),
      content: sections.join("\n"),
    };
  });
}

/**
 * Render a path-specific instructions file. Copilot reads `applyTo` only from
 * frontmatter at the top of the file, so existing frontmatter (including user
 * edits) stays first and only the managed block in the body is replaced.
 */
export function renderDirectoryInstructionsFile(
  instruction: DirectoryInstruction,
  existingContent?: string,
): string {
  const frontmatter = `---\napplyTo: "${instruction.applyTo}"\n---\n`;
  if (existingContent === undefined) {
    return `${frontmatter}\n${instruction.content}\n`;
  }
  const existingFrontmatter = FRONTMATTER_PATTERN.exec(existingContent)?.[0];
  const body = existingFrontmatter
    ? existingContent.slice(existingFrontmatter.length)
    : existingContent;
  return (existingFrontmatter ?? `${frontmatter}\n`) + mergeWithExisting(body, instruction.content);
}

const MANAGED_START = "<!-- agentsmith:managed -->";
const MANAGED_END = "<!-- /agentsmith:managed -->";

/**
 * Build the managed copilot-instructions.md content from analysis results.
 * Kept factual - all data derived from the AnalysisResult, nothing hallucinated.
 */
export function buildCopilotInstructions(analysis: AnalysisResult): string {
  const sections: string[] = [];

  sections.push(MANAGED_START);
  sections.push("# Copilot Instructions");
  sections.push("");

  // 1. Project identity
  if (analysis.summary) {
    sections.push(analysis.summary);
    sections.push("");
  }

  // 2. Language & Framework
  sections.push("## Language & Framework");
  sections.push("");
  const language = analysis.repo?.language || detectLanguageFromSkills(analysis.skills);
  const framework = analysis.repo?.framework || null;
  sections.push(`- **Language:** ${language || "Not detected"}`);
  sections.push(`- **Framework:** ${framework || "None detected"}`);
  sections.push("");

  // 3. Coding Conventions (derived from skill patterns)
  const conventions = collectConventions(analysis.skills);
  if (conventions.length > 0) {
    sections.push("## Coding Conventions");
    sections.push("");
    for (const convention of conventions) {
      sections.push(`- ${convention}`);
    }
    sections.push("");
  }

  // 4. Project Structure (from skills' sourceDirs)
  const structureEntries = collectStructure(analysis.skills);
  if (structureEntries.length > 0) {
    sections.push("## Project Structure");
    sections.push("");
    for (const entry of structureEntries) {
      sections.push(`- \`${entry.dir}/\` -- ${entry.description}`);
    }
    sections.push("");
  }

  // 5. Testing conventions
  const testingInfo = collectTestingInfo(analysis.skills, analysis.tools);
  if (testingInfo.length > 0) {
    sections.push("## Testing");
    sections.push("");
    for (const info of testingInfo) {
      sections.push(`- ${info}`);
    }
    sections.push("");
  }

  // 6. Build & Tools
  const toolEntries = collectToolInfo(analysis.tools);
  if (toolEntries.length > 0) {
    sections.push("## Build & Tools");
    sections.push("");
    for (const tool of toolEntries) {
      sections.push(`- \`${tool.command}\` -- ${tool.description}`);
    }
    sections.push("");
  }

  sections.push(MANAGED_END);

  return sections.join("\n");
}

/**
 * Merge managed content into an existing file, preserving user content
 * outside the agentsmith:managed markers.
 */
export function mergeWithExisting(existingContent: string, managedBlock: string): string {
  const startIdx = existingContent.indexOf(MANAGED_START);
  const endIdx = existingContent.indexOf(MANAGED_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace content between markers (inclusive of markers)
    const before = existingContent.slice(0, startIdx);
    const after = existingContent.slice(endIdx + MANAGED_END.length);
    return before + managedBlock + after;
  }

  // No markers found - prepend managed block, keep existing content after
  return managedBlock + "\n\n" + existingContent;
}

// --- Internal helpers ---

/**
 * Glob for a directory's `applyTo` frontmatter. Characters that globs or the
 * comma-separated `applyTo` list treat specially become `?` (any one character),
 * so folders such as Next.js `[slug]` or `(group)` routes still match.
 */
function toApplyToGlob(directory: string): string {
  return `${directory.replace(/[\\*?[\]{}()!,#"|]/g, "?")}/**`;
}

function uniqueSlug(directory: string, used: Set<string>): string {
  const base = directory
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_INSTRUCTIONS_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "") || "folder";
  let slug = base;
  for (let suffix = 2; used.has(slug); suffix += 1) {
    slug = `${base}-${suffix}`;
  }
  used.add(slug);
  return slug;
}

function detectLanguageFromSkills(skills: SkillDefinition[]): string {
  for (const skill of skills) {
    for (const pattern of skill.patterns) {
      const lower = pattern.toLowerCase();
      if (lower.includes("typescript") || lower.includes(".ts")) return "TypeScript";
      if (lower.includes("python") || lower.includes(".py")) return "Python";
      if (lower.includes("javascript") || lower.includes(".js")) return "JavaScript";
      if (lower.includes("golang") || lower.includes(".go")) return "Go";
      if (lower.includes("rust") || lower.includes(".rs")) return "Rust";
    }
  }
  return "Not detected";
}

function collectConventions(skills: SkillDefinition[]): string[] {
  const conventions: string[] = [];
  const seen = new Set<string>();

  for (const skill of skills) {
    for (const pattern of skill.patterns) {
      // Deduplicate and limit total
      if (!seen.has(pattern) && conventions.length < 15) {
        seen.add(pattern);
        conventions.push(pattern);
      }
    }
  }

  return conventions;
}

interface StructureEntry {
  dir: string;
  description: string;
}

function collectStructure(skills: SkillDefinition[]): StructureEntry[] {
  const seen = new Set<string>();
  const entries: StructureEntry[] = [];

  for (const skill of skills) {
    const dir = skill.sourceDir;
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      entries.push({ dir, description: skill.description });
    }
  }

  return entries;
}

function collectTestingInfo(skills: SkillDefinition[], tools: ToolDefinition[]): string[] {
  const info: string[] = [];

  // Check tools for test commands
  for (const tool of tools) {
    const cmd = tool.command.toLowerCase();
    if (cmd.includes("test") || cmd.includes("jest") || cmd.includes("vitest") || cmd.includes("pytest")) {
      info.push(`Run tests: \`${tool.command}\``);
    }
  }

  // Check skills for testing patterns
  for (const skill of skills) {
    if (skill.category === "quality" || skill.name.includes("test")) {
      for (const pattern of skill.patterns) {
        if (info.length < 8) {
          info.push(pattern);
        }
      }
    }
  }

  return info;
}

function collectToolInfo(tools: ToolDefinition[]): ToolDefinition[] {
  // Return all detected tools, deduplicated by command
  const seen = new Set<string>();
  const result: ToolDefinition[] = [];

  for (const tool of tools) {
    if (!seen.has(tool.command)) {
      seen.add(tool.command);
      result.push(tool);
    }
  }

  return result;
}
