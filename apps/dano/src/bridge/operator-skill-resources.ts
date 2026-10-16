import { DefaultResourceLoader, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import type { OperatorSkillRevision } from "./operator-skill-snapshot.js";

export interface OperatorSkillClient {
  current(): Promise<OperatorSkillRevision>;
  subscribe(listener: (state: OperatorSkillRevision) => void): () => void;
}

/** Use Pi's public resource reload/getter interface for discovery. This cache
 * grants no execution authority: the supervisor independently checks revisions. */
export async function operatorSkillResources(client: OperatorSkillClient, cwd: string, agentDir: string, onInvalidate?: () => void) {
  const paths: string[] = [];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: paths });
  let loaded: ReturnType<ResourceLoader["getSkills"]> = { skills: [], diagnostics: [] };
  let revision = -1;
  let requested = -1;
  let disposed = false;
  let pending = Promise.resolve();
  const apply = (state: OperatorSkillRevision) => {
    if (disposed || state.revision <= requested) return pending;
    const replacing = requested >= 0;
    requested = state.revision;
    // Clear discovery immediately, even while a preceding reload is finishing.
    loaded = { skills: [], diagnostics: [] };
    if (replacing) onInvalidate?.();
    pending = pending.catch(() => {}).then(async () => {
      if (disposed || state.revision !== requested) return;
      paths.splice(0, paths.length, ...state.paths);
      await loader.reload();
      if (disposed || state.revision !== requested) return;
      loaded = loader.getSkills();
      if (state.error) loaded = { skills: [], diagnostics: [{ type: "warning", message: state.error }] };
      revision = state.revision;
    });
    return pending;
  };
  const unsubscribe = client.subscribe(state => { void apply(state).catch(() => {}); });
  const refresh = async () => {
    const state = await client.current();
    await apply(state);
    if (disposed || revision !== state.revision) throw new Error("OPERATOR_SKILLS_CHANGED");
    return revision;
  };
  try { await refresh(); }
  catch (error) { unsubscribe(); throw error; }
  return {
    refresh,
    getSkills: () => loaded,
    dispose() { disposed = true; loaded = { skills: [], diagnostics: [] }; unsubscribe(); },
  };
}
