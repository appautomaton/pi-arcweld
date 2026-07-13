import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPlanDocumentPath } from "../paths.ts";

const CONFIG_DIR = ".pi";

async function withProject(run: (project: string) => Promise<void>): Promise<void> {
	const project = await mkdtemp(join(tmpdir(), "pi-arcweld-plan-mode-"));
	try {
		await run(project);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
}

test("accepts a new Markdown plan document", async () => {
	await withProject(async (project) => {
		assert.equal(await isPlanDocumentPath(".pi/plans/review.md", project, CONFIG_DIR), true);
	});
});

test("rejects paths outside the plan directory and non-Markdown files", async () => {
	await withProject(async (project) => {
		assert.equal(await isPlanDocumentPath(".pi/plans/../outside.md", project, CONFIG_DIR), false);
		assert.equal(await isPlanDocumentPath(".pi/plans/review.txt", project, CONFIG_DIR), false);
		assert.equal(await isPlanDocumentPath("../.pi/plans/review.md", project, CONFIG_DIR), false);
	});
});

test("rejects a symlinked target", async () => {
	await withProject(async (project) => {
		const plans = join(project, ".pi", "plans");
		const outside = join(project, "outside.md");
		await mkdir(plans, { recursive: true });
		await writeFile(outside, "outside\n");
		await symlink(outside, join(plans, "escape.md"));

		assert.equal(await isPlanDocumentPath(".pi/plans/escape.md", project, CONFIG_DIR), false);
	});
});

test("rejects a symlinked parent directory", async () => {
	await withProject(async (project) => {
		const configDir = join(project, ".pi");
		const outsidePlans = join(project, "outside-plans");
		await mkdir(configDir, { recursive: true });
		await mkdir(outsidePlans);
		await symlink(outsidePlans, join(configDir, "plans"));

		assert.equal(await isPlanDocumentPath(".pi/plans/escape.md", project, CONFIG_DIR), false);
	});
});

test("rejects an existing hard-linked target", async () => {
	await withProject(async (project) => {
		const plans = join(project, ".pi", "plans");
		const original = join(project, "original.md");
		await mkdir(plans, { recursive: true });
		await writeFile(original, "original\n");
		await link(original, join(plans, "shared.md"));

		assert.equal(await isPlanDocumentPath(".pi/plans/shared.md", project, CONFIG_DIR), false);
	});
});
