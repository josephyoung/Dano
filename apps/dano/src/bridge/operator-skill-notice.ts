/** Trusted session control message, not model-supplied Skill content. */
export const OPERATOR_SKILL_REVOCATION_NOTICE_TYPE = "dano.operator-skills-changed";
export const OPERATOR_SKILL_REVOCATION_NOTICE_TEXT = "管理员技能已更新，本轮调用已取消。请在当前聊天重新发送消息，以使用最新版本。";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function message(value: unknown): Record<string, unknown> | undefined {
  const entry = record(value);
  return entry?.type === "message" ? record(entry.message) : entry;
}

export function isOperatorSkillRevocationNotice(value: unknown): boolean {
  const entry = message(value);
  return (entry?.type === "custom_message" || entry?.role === "custom")
    && entry.customType === OPERATOR_SKILL_REVOCATION_NOTICE_TYPE
    && entry.display === true;
}

/** Keep persisted history intact. Only the affected Turn's browser projection
 * replaces incidental model/abort errors with its authoritative control notice. */
export function operatorSkillRevokedErrorIndices(branch: readonly unknown[]): ReadonlySet<number> {
  const hidden = new Set<number>();
  let start = 0;
  const flush = (end: number) => {
    if (!branch.slice(start, end).some(isOperatorSkillRevocationNotice)) return;
    for (let index = start; index < end; index++) {
      const value = message(branch[index]);
      if (value?.role === "assistant"
        && (value.stopReason === "error" || value.stopReason === "aborted")) {
        hidden.add(index);
      }
    }
  };
  for (let index = 0; index <= branch.length; index++) {
    if (index === branch.length || index > start && message(branch[index])?.role === "user") {
      flush(index);
      start = index;
    }
  }
  return hidden;
}

export function hasCurrentOperatorSkillRevocation(branch: readonly unknown[]): boolean {
  for (let index = branch.length - 1; index >= 0; index--) {
    if (message(branch[index])?.role === "user") return false;
    if (isOperatorSkillRevocationNotice(branch[index])) return true;
  }
  return false;
}
