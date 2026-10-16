import { describe, expect, it } from "vitest";
import { hasCurrentOperatorSkillRevocation, operatorSkillRevokedErrorIndices } from "../operator-skill-notice.js";

const notice = { type: "custom_message", customType: "dano.operator-skills-changed", display: true };
const user = { type: "message", message: { role: "user" } };
const error = { type: "message", message: { role: "assistant", stopReason: "error" } };
describe("trusted Skill revocation projection", () => {
  it("replaces only errors in the revoked Turn, regardless of control event ordering", () => {
    const branch = [user, error, user, error, notice, { role: "assistant", stopReason: "aborted" }, user, error];
    expect([...operatorSkillRevokedErrorIndices(branch)]).toEqual([3, 5]);
    expect(hasCurrentOperatorSkillRevocation(branch)).toBe(false);
    expect(hasCurrentOperatorSkillRevocation(branch.slice(0, 6))).toBe(true);
  });
  it("preserves errors for hidden or unrelated custom messages and model text", () => {
    for (const message of [{ ...notice, display: false }, { ...notice, customType: "other" }, { role: "assistant", content: "dano.operator-skills-changed" }]) {
      expect([...operatorSkillRevokedErrorIndices([user, error, message])]).toEqual([]);
    }
  });
});
