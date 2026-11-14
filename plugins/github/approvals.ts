// Which GitHub calls go ahead on their own, which keep the owner's yes, and the audit line each one that went ahead
// leaves. Reads, new branches, commits on a branch other than the default, pull requests, comments and review
// requests only add to a repo, so they run without a prompt. Merging, deleting, force-pushing, writing to the default
// branch, repo settings, spend and mail ask first. Nothing merges, ever.

export type Risk = "safe" | "gated";

export interface Call {
  // The tool's name at GitHub's server, and the arguments it would run with.
  tool: string;
  args: Record<string, unknown>;
  // The server's readOnlyHint for that tool, when it has one.
  readOnly?: boolean;
}

export interface Verdict {
  risk: Risk;
  // What it does (the tool's name), the repo it does it to and the branch, for the audit line.
  operation: string;
  repo: string;
  branch?: string;
  // Why it may go ahead, or why it waits for the owner.
  why: string;
}

// Merging: never the agent's (the plugin leaves those tools out and refuses them by name too).
export const MERGES = /merge/i;
// Reads, whatever the tool is called.
const READS = /^(get_|list_|search_)/;
const READS_TOO = /_read$/;
// Tools that take something away, or hand it to someone else.
const DESTROYS = /(^|_)(delete|remove|destroy|archive|transfer|disable)/i;
const FORCES = /force/i;
// The repo itself: its settings, who can see it, push to it or run in it.
const SETTINGS = /(^|_)(settings?|permissions?|collaborators?|secrets?|webhooks?|hooks?|visibility|workflows?)/i;
// Spending, and mail.
const SPEND = /(billing|payment|purchase|sponsor|invoice|subscription|email|send_mail)/i;
// Committing files to a branch: fine anywhere but the default branch.
const COMMITS = /^(create_or_update_file|push_files|update_file|create_commit)$/;
const BRANCH = /^create_branch$/;
const PULL_REQUEST = /^create_pull_request$/;
const COMMENTS = /(comment|reaction)/i;
const REVIEWS = /(request_reviewers?|review_request)/i;

// One short line per action that went ahead on its own: the repo, what it did and the branch it did it to.
export const audit = (action: { operation: string; repo: string; branch?: string }, log: (line: string) => void = console.log) =>
  void log(`github: auto-approved ${action.operation}${action.repo ? ` on ${action.repo}` : ""}${action.branch ? ` (branch ${action.branch})` : ""}`);

const said = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

// The repo a call is about: owner and repo (or repository) for GitHub's tools, or a URL of one.
export function repoOf(args: Record<string, unknown>): string | undefined {
  const owner = said(args.owner) ?? said(args.org) ?? said(args.organization);
  const name = said(args.repo) ?? said(args.repository) ?? said(args.repo_name);
  if (owner && name) return `${owner}/${name}`;
  for (const key of ["url", "repo_url", "repository_url", "html_url"]) {
    const found = /github\.com\/([\w.-]+)\/([\w.-]+)/.exec(said(args[key]) ?? "");
    if (found) return `${found[1]}/${found[2]}`;
  }
  return name?.includes("/") ? name : undefined;
}

// The branch a call writes to, or wants reviewed.
const branchOf = (args: Record<string, unknown>) => said(args.branch) ?? said(args.head) ?? said(args.head_ref);

// owner/name as the owner writes them — "lucasgelfond/biscotti" or a github.com link — lowercased, since GitHub
// doesn't tell cases apart.
export function reposSaid(text: string): string[] {
  const found = [
    ...[...text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)/gi)].map(([, owner, name]) => `${owner}/${name}`),
    // Not inside another URL, an email or a path: "and/or" is a repo nobody has, but it does no harm here.
    ...[...text.replace(/github\.com\/([\w.-]+)\/([\w.-]+)(\/[\w./-]*)?/gi, " ").matchAll(/(?:^|[^\w.@-])([\w][\w.-]{1,38})\/([\w][\w.-]{0,99})/g)].map(([, owner, name]) => `${owner}/${name}`),
  ];
  const clean = found
    // A link's host and its /pull/12 aren't owners and repos.
    .filter((repo) => !repo.split("/")[0]!.includes(".") && !/^\d+$/.test(repo.split("/")[1] ?? ""))
    .map((repo) => repo.replace(/\.git$/i, "").replace(/[.,;:]+$/, "").toLowerCase());
  return [...new Set(clean.filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo)))];
}

export function approvals(opts: {
  // Where the audit line for each action that went ahead goes.
  log?: (line: string) => void;
  // A repo's default branch, when a commit's branch has to be compared to it.
  defaultBranch?: (repo: string) => Promise<string | undefined>;
} = {}) {
  // The repos the owner asked for work on this conversation: work there goes ahead for the rest of the session.
  const asked = new Set<string>();
  const log = opts.log ?? ((line: string) => console.log(line));
  const preAuthorized = (repo: string) => asked.has(repo.toLowerCase());

  async function decide(call: Call): Promise<Verdict> {
    const repo = repoOf(call.args) ?? "";
    const branch = branchOf(call.args);
    const gated = (why: string): Verdict => ({ risk: "gated", operation: call.tool, repo, branch, why });
    const safe = (why: string): Verdict => {
      const verdict: Verdict = { risk: "safe", operation: call.tool, repo, branch, why };
      audit(verdict, log);
      return verdict;
    };

    const name = call.tool;
    if (call.readOnly || READS.test(name) || READS_TOO.test(name)) return safe("it only reads");
    if (MERGES.test(name)) return gated("merging a pull request is the owner's");
    if (DESTROYS.test(name)) return gated("it deletes something or hands it over");
    if (FORCES.test(name)) return gated("it force-pushes");
    if (SETTINGS.test(name)) return gated("it changes the repo's settings");
    if (SPEND.test(name)) return gated("it spends money or sends mail");
    if (COMMITS.test(name)) {
      if (!branch) return gated("it doesn't say which branch it writes");
      // The default branch is the one the owner reviews before anything lands: never written without a yes.
      const base = repo ? await opts.defaultBranch?.(repo)?.catch(() => undefined) : undefined;
      if (base === branch) return gated("it writes the default branch");
      if (!base && !preAuthorized(repo)) return gated("biscotti couldn't look up which branch is the default, so this one might be");
      return safe(base ? `it commits to ${branch}, not the default branch` : "the owner asked for work in this repo");
    }
    if (BRANCH.test(name)) return safe("it adds a branch");
    if (PULL_REQUEST.test(name)) return safe("it opens a pull request for the owner to review");
    if (COMMENTS.test(name)) return safe("it's a comment");
    if (REVIEWS.test(name)) return safe("it asks for a review");
    // Anything else is a change biscotti can't tell the shape of by name: fine on a repo the owner asked about, not
    // elsewhere. Everything above that could take something away still asks either way.
    if (repo && preAuthorized(repo)) return safe("the owner asked for work in this repo");
    return gated("it isn't a change biscotti makes on its own");
  }

  return {
    // The owner's own words (never a report or a wake, which are data): the repos they name are the ones they asked
    // about.
    note(text: string) {
      for (const repo of reposSaid(text)) asked.add(repo);
    },
    decide,
  };
}

export type Approvals = ReturnType<typeof approvals>;
