# ACM-10: the Jira probe reads the real v2 server, and one bad space fails only its own check

Status: v1. Folded into ACM-8 by the approver's settled decision, built on `acm-8-jira-board`.

## What the live server showed

Checked through the approver's own Claude Code on 2026-11-10, read only (`getAccessibleAtlassianResources`
once, the tool schemas, and `discover`):

- `getAccessibleAtlassianResources` returns `{"data":{"resources":[{"cloudId","url","products":[{"id","access"}]}]}}`.
- `executeRead` takes `{ name, cloudId, inputs }`: the operation in `name`, `cloudId` at the top level,
  and the operation's own arguments flat in `inputs`. `cloudId` may be a UUID, a host or a URL.
- `getConfluenceSpace` takes `spaceIdOrKey`. `listConfluenceSpaces` is the read only operation that
  lists spaces with their keys and names (`keys`, `limit` up to 250, `cursor`).

Bollplank's fakes use the older shapes (`id` on the site, `arguments` or `input` holding `cloudId`), so
the suite passes while a real probe ties no project, status or space to its site. The same `inputs`
shape matters to the Jira critic's comment evidence, which also reads `innerCall`.

## Steps

1. **innerCall reads the v2 shape.** Arguments come from `inputs`, then the older fields. A top level
   `cloudId` is kept when the inner arguments have none. A conflicting pair is not merged.
2. **readJira reads sites in both shapes**, with `cloudId` before `id`, and only from an object with a
   `url`. A call's `cloudId` given as a host or URL is matched to the site it names.
3. **A failed call is not a failed probe.** The prompt says to go on after a failed project, status or
   space call, and to reply with an error only when no site can be read. A project keeps its key and id
   when its status read fails.
4. **Space lookup by name.** When `getConfluenceSpace` fails, the prompt asks for `listConfluenceSpaces`
   on that site, allowed only when a space is configured. `judgeJira` gives each site `spaces` (keys
   read) and `spaceList` (key and name of each listed space, or null when no list call worked).
5. **Doctor** names the key when the configured space is a listed space's name.
6. **init** looks a space up client by client: found (key, or a name match saved as its key), missing
   (a list worked with no match: asked again, or `usage` with an answers file) or unreadable (every
   client failed: kept as typed, and said).
7. **short()** cuts at a word boundary with an ellipsis.
8. **Fakes** serve the v2 shapes by default, with switches for the flat site list, a failed status call,
   a failed space read, a failed list, and a client without Confluence.
9. **CHANGELOG** line in 0.7.0.
