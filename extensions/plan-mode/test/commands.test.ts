import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyCommand } from "../commands.ts";

const allowed = [
	"rg -n -i 'license_id|get_packs|session' projects/ableton12/data",
	"rg '=>' src", // searching for an arrow, not a redirect
	"rg 'rm -rf' .", // searching for the text, not running it
	"rg foo | head -100",
	"rg -l foo | xargs cat",
	"grep -rn TODO .",
	"find . -name '*.ts'",
	"git log --oneline -20",
	"git diff HEAD~1",
	"git show HEAD",
	"git blame src/index.ts",
	"cat package.json",
	"jq '.dependencies' package.json",
	"wc -l src/index.ts",
	"ls -la",
	"tree -L 2",
	"sed -n '1,20p' file.ts",
	"awk '{print $1}' file.txt",
	"echo hello",
	"npm ls --depth=0",
	"sort file | uniq -c",
	"stat index.ts",
];

const blocked = [
	"", // empty
	"rm -rf build",
	"mv a b",
	"cp a b",
	"mkdir out",
	"touch new.ts",
	"git commit -m 'x'",
	"git checkout main",
	"git reset --hard",
	"npm install",
	"npm run build",
	"pnpm add left-pad",
	"rg foo > out.txt", // output redirect
	"cat a >> b", // append redirect
	"echo x > file",
	"find . -delete",
	"find . -exec rm {} \\;",
	"find . -exec cat {} \\;", // -exec blocked wholesale (conservative)
	"cat list | tee out",
	"cat evil.sh | sh", // pipe to a shell
	"rg -l foo | xargs rm",
	"sed -i 's/a/b/' file",
	"sudo systemctl restart nginx",
	"code .",
	"chmod +x script.sh",
	"unknown-tool --flag", // not on the allowlist
	"kill 1234",
];

test("allows read-only exploration commands", () => {
	for (const command of allowed) {
		assert.equal(isReadOnlyCommand(command), true, `expected allowed: ${command}`);
	}
});

test("blocks mutating, chaining, and unknown commands", () => {
	for (const command of blocked) {
		assert.equal(isReadOnlyCommand(command), false, `expected blocked: ${command}`);
	}
});
