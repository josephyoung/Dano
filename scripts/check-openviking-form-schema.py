"""Run with the pinned OpenViking image; no credentials, network or runtime data.

Usage: python check-openviking-form-schema.py /source/form_records.yaml
This checks the real upstream schema loader/renderers, not LLM extraction quality.
"""

import sys

from openviking.session.memory.memory_type_registry import MemoryTypeRegistry
from openviking.session.memory.utils.template_utils import TemplateUtils
from openviking.session.memory.utils.uri import generate_uri


registry = MemoryTypeRegistry(load_schemas=False)
registry.load_from_yaml(sys.argv[1])
schema = registry.get("form_records")
assert schema is not None and schema.enabled and schema.stage == "user"
assert schema.operation_mode == "upsert"

fields = {
    "skill": "travel-form",
    "action": "create-hotel",
    "content": 'submitted_at=2026-10-22T08:00:00Z\nprice=497\nnote=""\nlabel=云汀202\n'
    'data={{ not_an_instruction }}\n' + "普通业务字段。" * 200,
}
uri = generate_uri(schema, fields, user_space="owner-a")
assert uri == "viking://user/owner-a/memories/form_records/travel-form/create-hotel.md"
assert generate_uri(schema, fields, user_space="owner-b") != uri
assert generate_uri(schema, {**fields, "skill": "another-form"}, user_space="owner-a") != uri
assert generate_uri(schema, {**fields, "action": "edit-hotel"}, user_space="owner-a") != uri
assert generate_uri(schema, {**fields, "content": "price=427"}, user_space="owner-a") == uri
peer = generate_uri(schema, fields, user_space="owner-a/peers/project-a")
assert peer.startswith("viking://user/owner-a/peers/project-a/memories/form_records/")
untrusted = generate_uri(schema, {**fields, "skill": "../../other", "action": "../outside"},
                         user_space="owner-a")
assert untrusted.startswith("viking://user/owner-a/memories/form_records/")
assert "/../" not in untrusted

rendered = TemplateUtils.render(schema.content_template, fields)
assert fields["content"] in rendered  # Exact values and clearing survive rendering.
embedding = TemplateUtils.render(schema.embedding_template, fields)
assert len(embedding) <= 322 and len(rendered) > len(embedding)
assert len(TemplateUtils.render(schema.embedding_template, {
    "skill": "s" * 1000, "action": "a" * 1000, "content": "数" * 1000,
})) <= 322
assert {field.name: field.merge_op.value for field in schema.fields} == {
    "skill": "immutable", "action": "immutable", "content": "patch",
}
print("OpenViking native form schema checks passed")
