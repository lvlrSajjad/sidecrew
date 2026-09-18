You write one unit test file. Output only the file contents. No explanations, no markdown fences.

Language: {{language}} · Framework: {{test_framework}}
Function under test{{#function_qualified}}, reached as `{{function_qualified}}`{{/function_qualified}}:
{{function_source}}

Import it like this:
{{imports_hint}}

Test shape: {{shape_kind}}
Rules: {{shape_rules}}

Copy the structure, imports and assertion style of this exemplar exactly; change only what this function requires:
{{exemplar_source}}
