export interface CenterFocusTarget {
  sessionKey: string;
  toolCallId: string;
  element: HTMLElement;
}

export interface CenterFocusStage {
  show(target: CenterFocusTarget): void;
  hide(toolCallId?: string): void;
  setSession(sessionKey: string | null): void;
  destroy(): void;
}

interface ActivePresentation {
  target: CenterFocusTarget;
  anchor: HTMLElement;
  anchorStyle: string | null;
  placeholderHeight: number;
  transcriptLock: TranscriptLock | null;
  composer: HTMLElement | null;
  composerWasInert: boolean;
  backgroundBranches: Array<{ element: HTMLElement; wasInert: boolean }>;
}

interface TranscriptLock {
  transcript: HTMLElement;
  guard: HTMLElement;
  scrollHeight: number;
  scrollTop: number;
  observer: MutationObserver;
  frame: number;
}

export function createCenterFocusStage(
  root: HTMLElement,
  onActiveChange: (active: boolean) => void = () => {},
): CenterFocusStage {
  let active: ActivePresentation | null = null;

  function runTransition(update: () => void, after?: () => void): void {
    if (prefersReducedMotion()) {
      update();
      after?.();
      return;
    }
    const startViewTransition = (
      document as Document & {
        startViewTransition?: (callback: () => void) => { finished: Promise<unknown> };
      }
    ).startViewTransition;
    if (typeof startViewTransition === "function") {
      startViewTransition.call(document, update).finished.finally(after);
    } else {
      update();
      after?.();
    }
  }

  function show(target: CenterFocusTarget): void {
    if (
      active?.target.sessionKey === target.sessionKey &&
      active.target.toolCallId === target.toolCallId &&
      active.target.element === target.element
    ) return;
    hide();

    const anchor = target.element.closest<HTMLElement>(".question-card-anchor");
    if (!anchor) return;
    const composer = root.querySelector<HTMLElement>("[data-center-focus-composer]");
    const presentation: ActivePresentation = {
      target,
      anchor,
      anchorStyle: anchor.getAttribute("style"),
      placeholderHeight: target.element.getBoundingClientRect().height,
      transcriptLock: null,
      composer,
      composerWasInert: composer?.inert ?? false,
      backgroundBranches: [],
    };
    active = presentation;
    presentation.transcriptLock = lockTranscriptScroll(presentation, root);
    target.element.classList.add("center-focus-transition-card");

    runTransition(() => {
      presentation.anchor.style.height = `${presentation.placeholderHeight}px`;
      root.dataset.centerFocusActive = "true";
      root.querySelector<HTMLElement>("[data-center-focus-transcript]")
        ?.setAttribute("data-center-focus-locked", "true");
      target.element.classList.add("center-focused-card");
      isolateBackground(presentation, root);
      if (composer) {
        if (composer.contains(document.activeElement)) {
          (document.activeElement as HTMLElement | null)?.blur();
        }
        composer.inert = true;
      }
      onActiveChange(true);
    });
  }

  function hide(toolCallId?: string): void {
    if (!active) return;
    if (toolCallId && active.target.toolCallId !== toolCallId) return;
    const presentation = active;
    active = null;
    runTransition(() => {
      delete root.dataset.centerFocusActive;
      root.querySelector<HTMLElement>("[data-center-focus-transcript]")
        ?.removeAttribute("data-center-focus-locked");
      releaseTranscriptScroll(presentation);
      presentation.target.element.classList.remove("center-focused-card");
      restoreStyle(presentation.anchor, presentation.anchorStyle);
      if (presentation.composer) {
        presentation.composer.inert = presentation.composerWasInert;
      }
      for (const branch of presentation.backgroundBranches) {
        branch.element.inert = branch.wasInert;
      }
      onActiveChange(false);
    }, () => presentation.target.element.classList.remove("center-focus-transition-card"));
  }

  function setSession(sessionKey: string | null): void {
    if (active && active.target.sessionKey !== sessionKey) hide();
  }

  function destroy(): void {
    hide();
  }

  return { show, hide, setSession, destroy };

  function lockTranscriptScroll(
    presentation: ActivePresentation,
    root: HTMLElement,
  ): TranscriptLock | null {
    const transcript = root.querySelector<HTMLElement>("[data-center-focus-transcript]");
    if (!transcript) return null;

    const guard = document.createElement("div");
    guard.dataset.centerFocusScrollGuard = "";
    guard.setAttribute("aria-hidden", "true");
    guard.style.cssText = [
      "flex: 0 0 auto",
      "height: 0",
      "min-height: 0",
      "margin-top: calc(-1 * var(--transcript-row-gap, 0px))",
      "pointer-events: none",
      "visibility: hidden",
      "width: 100%",
    ].join(";");

    let lock: TranscriptLock;
    const observer = new MutationObserver(() => scheduleTranscriptScrollSync(
      presentation,
      lock,
    ));
    lock = {
      transcript,
      guard,
      scrollHeight: transcript.scrollHeight,
      scrollTop: transcript.scrollTop,
      observer,
      frame: 0,
    };
    transcript.append(guard);
    lock.observer.observe(transcript, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return lock;
  }

  function scheduleTranscriptScrollSync(
    presentation: ActivePresentation,
    lock: TranscriptLock,
  ): void {
    if (lock.frame || active !== presentation) return;
    lock.frame = requestAnimationFrame(() => {
      lock.frame = 0;
      if (active !== presentation || !lock.guard.isConnected) return;
      lock.guard.style.height = "0px";
      const missingHeight = Math.max(
        0,
        lock.scrollHeight - lock.transcript.scrollHeight,
      );
      lock.guard.style.height = `${missingHeight}px`;
      lock.transcript.scrollTop = lock.scrollTop;
    });
  }

  function releaseTranscriptScroll(presentation: ActivePresentation): void {
    const lock = presentation.transcriptLock;
    if (!lock) return;
    lock.observer.disconnect();
    if (lock.frame) cancelAnimationFrame(lock.frame);
    lock.guard.remove();
    presentation.transcriptLock = null;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function hasActiveCenterFocusStage(root: ParentNode = document): boolean {
  return Boolean(root.querySelector('[data-center-focus-active="true"]'));
}

function isolateBackground(
  presentation: ActivePresentation,
  root: HTMLElement,
): void {
  const transcript = root.querySelector<HTMLElement>("[data-center-focus-transcript]");
  if (!transcript) return;
  let branch: HTMLElement | null = presentation.anchor;
  while (branch && branch !== transcript) {
    const parent: HTMLElement | null = branch.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      presentation.backgroundBranches.push({
        element: sibling,
        wasInert: sibling.inert,
      });
      sibling.inert = true;
    }
    branch = parent;
  }
}

function restoreStyle(element: HTMLElement, style: string | null): void {
  if (style === null) element.removeAttribute("style");
  else element.setAttribute("style", style);
}
