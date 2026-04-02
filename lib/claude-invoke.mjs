import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, unlinkSync } from "fs";

export async function generateViaCLI(systemPrompt, userPrompt, prefix = "claude-prompt") {
  const tmpFile = join(tmpdir(), `${prefix}-${Date.now()}.txt`);
  writeFileSync(tmpFile, `${systemPrompt}\n\n---\n\n${userPrompt}`, "utf8");
  try {
    return execSync(`cat "${tmpFile}" | claude -p --dangerously-skip-permissions`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    }).trim();
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}
