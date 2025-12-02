import fs from "node:fs";
import path from "node:path";

function loadPrompt(name: string) {
  const file = path.resolve(__dirname, "..", "prompts", `${name}.md`);
  return fs.readFileSync(file, "utf8");
}

export const prompts = {
  planner: loadPrompt("planner"),
  summarizer: loadPrompt("summarizer"),
  critic: loadPrompt("critic"),
  synthesizer: loadPrompt("synthesizer"),
  clarifier: loadPrompt("clarifier"),
};
