/**
 * Read-only command classification for plan mode.
 *
 * Plan mode is a research space, so the model's bash tool is allowed to run
 * read-only exploration (search, inspect, read) but not commands that change
 * files or state. This is a conservative, application-layer best-effort guard
 * against accidental mutation, not an adversarial sandbox.
 *
 * A command is allowed only when it begins with a known read-only tool AND
 * contains no mutation. Mutating verbs are matched in command position only
 * (line start, or right after |, ;, &, (, or xargs), so searching for a word
 * like `rg "rm -rf"` or `rg "=>"` is not mistaken for running it, while
 * `rg foo; rm bar` and `... | xargs rm` still are.
 */

/** Prefix that puts the next token in command position. */
const CMD = "(?:^|[|;&(\\n]|\\bxargs\\s+(?:-[^\\s]+\\s+)*)\\s*";

/** Verbs that mutate files, processes, or the system when invoked as a command. */
const MUTATING_COMMANDS = [
	"rm",
	"rmdir",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tee",
	"truncate",
	"dd",
	"shred",
	"install",
	"rsync",
	"sudo",
	"su",
	"doas",
	"kill",
	"pkill",
	"killall",
	"reboot",
	"shutdown",
	"halt",
	"vi",
	"vim",
	"nvim",
	"nano",
	"emacs",
	"code",
	"subl",
	"pico",
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"eval",
	"exec",
	"source",
];

/** Multi-word mutating subcommands, also matched in command position. */
const MUTATING_SUBCOMMANDS = [
	String.raw`npm\s+(install|uninstall|update|ci|link|publish|run|exec|dedupe|prune|rebuild)`,
	String.raw`(yarn|pnpm)\s+(add|remove|install|publish|dlx|run)`,
	String.raw`npx\s`,
	String.raw`pip\d?\s+(install|uninstall)`,
	String.raw`apt(-get)?\s+(install|remove|purge|update|upgrade)`,
	String.raw`brew\s+(install|uninstall|upgrade|reinstall)`,
	String.raw`git\s+(add|commit|push|pull|fetch|merge|rebase|reset|restore|checkout|switch|stash|cherry-pick|revert|tag|init|clone|clean|mv|rm|apply|am|worktree|gc|branch\s+-[dDmM])`,
	String.raw`systemctl\s+(start|stop|restart|enable|disable|mask)`,
	String.raw`service\s+\S+\s+(start|stop|restart)`,
	String.raw`docker\s+(run|rm|rmi|build|exec|start|stop|kill|compose)`,
];

/** Side-effecting syntax, dangerous wherever it appears. */
const MUTATING_SYNTAX: RegExp[] = [
	/(?:^|\s)>>?/, // output/append redirect: `cmd > file`, `cmd >> file`
	/\bsed\b[^|&;]*\s-i/i, // sed in-place edit
	/--in-place/i,
	/\s-delete\b/i, // find -delete
	/\s-exec(dir)?\b/i, // find -exec / -execdir
	/\s-ok(dir)?\b/i, // find -ok / -okdir
	/\s-fprint(f)?\b/i, // find -fprint / -fprintf
];

const MUTATING_PATTERNS: RegExp[] = [
	...MUTATING_COMMANDS.map((name) => new RegExp(`${CMD}${name}\\b`, "i")),
	...MUTATING_SUBCOMMANDS.map((pattern) => new RegExp(`${CMD}${pattern}\\b`, "i")),
	...MUTATING_SYNTAX,
];

/** Read-only tools. The command must start with one of these to be allowed. */
const SAFE_START = new RegExp(
	"^\\s*(?:" +
		[
			"cat",
			"head",
			"tail",
			"grep",
			"egrep",
			"fgrep",
			"rg",
			"ag",
			"ack",
			"find",
			"fd",
			"ls",
			"eza",
			"exa",
			"tree",
			"bat",
			"pwd",
			"echo",
			"printf",
			"wc",
			"sort",
			"uniq",
			"cut",
			"tr",
			"nl",
			"comm",
			"join",
			"paste",
			"column",
			"fold",
			"diff",
			"file",
			"stat",
			"du",
			"df",
			"basename",
			"dirname",
			"realpath",
			"readlink",
			"which",
			"whereis",
			"type",
			"env",
			"printenv",
			"uname",
			"whoami",
			"id",
			"date",
			"cal",
			"uptime",
			"ps",
			"free",
			"jq",
			"yq",
			"awk",
			"xxd",
			"od",
			"hexdump",
			"sha256sum",
			"shasum",
			"md5sum",
			String.raw`sed\s+-n`,
			String.raw`git\s+(status|log|diff|show|branch|remote|blame|reflog|shortlog|whatchanged|rev-parse|rev-list|describe|ls-files|ls-tree|ls-remote|cat-file|grep|config\s+(--get|--list|-l))`,
			String.raw`npm\s+(list|ls|view|info|search|outdated|audit|why|root|prefix)`,
			String.raw`pnpm\s+(list|ls|why|outdated)`,
			String.raw`yarn\s+(list|info|why|audit)`,
			String.raw`node\s+--version`,
			String.raw`(python|python3)\s+--version`,
		].join("|") +
		")\\b",
	"i",
);

/**
 * Whether a bash command is a read-only exploration command that plan mode
 * should allow. Errs toward blocking: an unknown or ambiguous command is denied.
 */
export function isReadOnlyCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (MUTATING_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
	return SAFE_START.test(trimmed);
}
