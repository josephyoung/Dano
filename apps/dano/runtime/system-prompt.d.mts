export type SystemPromptWriteMode = "if-missing" | "replace";
export type SystemPromptWriteResult = "written" | "preserved";

export function resolveProductName(
  environmentName: string | undefined,
  configuredName: string | undefined,
): string;

export function renderSystemPrompt(
  template: string,
  productName: string,
): string;

export function writeSystemPromptFile(
  targetPath: string,
  content: string,
  options: { mode: SystemPromptWriteMode },
): Promise<SystemPromptWriteResult>;

export function syncSystemPrompt(options: {
  templatePath: string;
  targetPath: string;
  productName: string;
  mode: SystemPromptWriteMode;
}): Promise<SystemPromptWriteResult>;
