# projects

One hub per ACTIVE project. Template `_templates/project.md`.
Status + open loops + done loops + decisions.

## Hierarchy and workspace

- Hierarchy comes from the folder: `X/Y/Y.md` is the folder project (parent) of the other docs in `X/Y/`.
- Frontmatter `workspace: <name>` is the hub workspace that owns the project. A child inherits it from the parent.
- Frontmatter `parent: [[name]]` overrides the folder hierarchy.

## Tasks

- `- [ ]` to do, `- [-]` doing, `- [x]` done.
- Status in the title: `BLOCK - `, `HOLD - `, `ARCHIVED - ` (also `BLOCK:`). The reason is the text after the LAST ` - `.
- Priority: tag at the end of the first line, `#p0` (most urgent) to `#p3`, before the ` ✅ date` stamp.
- `## Open loops` holds live tasks. `## Done loops` comes right after it, before `## Decisões`.
