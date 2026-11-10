# ACM-9: init keeps working when the board kind changes

Status: v1. Folded into ACM-8 by the approver's settled decision, built on `acm-8-jira-board`.

## Steps

1. **Pin existing projects.** A new `pinProjects(prev, kind)` in `lib/config.mjs` takes the old
   config and the new top level kind. For each project whose resolved kind under the old config
   differs from the new one, it writes the board values the project resolved to before: the kind,
   team, project, all five statuses (own, else the old top level ones when the kinds matched, else
   the kind's suggestion), the ids from `boardIds`, and on Jira the space it shared. A value the
   project set itself is kept. init calls it right after step 3 and says which projects stay on
   which board. A project with no team or project to inherit stays as it is, and validation names it.
2. **Check Jira answers when asked.** `askJira` and `askSpace` match a typed name to a listed key,
   uppercase a project key, and ask again on an answer that fails `JIRA_SITE`,
   `JIRA_PROJECT_KEY` or `CONFLUENCE_SPACE_KEY`. With an answers file a bad answer is a usage error
   naming the key. Empty stays allowed.
3. **Keep the answers on a failed save.** The asker records every answer by key. When validation
   fails at step 6, init writes them to `config.answers.json` beside the config and names it in the
   failure, with the rerun command. The config is not written.
4. **Tests** in `test/init.test.mjs` and `test/config-kinds.test.mjs`, as the brief lists.
5. **CHANGELOG** line in 0.7.0.
