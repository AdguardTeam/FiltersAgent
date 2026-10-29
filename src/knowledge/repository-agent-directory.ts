/**
 * The checkout-relative directory a repository steers this agent from.
 *
 * Everything a repository hands the agent lives below it — the run instruction and the skills
 * directory beside it — so the action never mistakes a repository's own root files for agent
 * configuration. It is a `filters-agent` folder of its own under `.github/`, which holds no filter
 * list, so it cannot collide with the repository's own content, its `.github/` documents and
 * templates included.
 */
export const REPOSITORY_AGENT_DIRECTORY = '.github/filters-agent';
