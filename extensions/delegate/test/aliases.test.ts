import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	loadAliases,
	parseAliasFile,
	parseModelRef,
	resetAliasCache,
	resolveTarget,
} from "../aliases.ts";

test("parseModelRef splits on the first slash", () => {
	assert.deepEqual(parseModelRef("openrouter-glm/z-ai/glm-5.3"), {
		provider: "openrouter-glm",
		modelId: "z-ai/glm-5.3",
	});
	assert.equal(parseModelRef("flash"), undefined);
	assert.equal(parseModelRef("/nope"), undefined);
});

test("parseAliasFile accepts the machine-local shape", () => {
	const aliases = parseAliasFile(
		JSON.stringify({
			aliases: {
				flash: "cli-proxy-api-google/gemini-3.7-flash-high",
				glm: "openrouter-glm/z-ai/glm-5.3",
			},
		}),
	);
	assert.equal(aliases.get("flash"), "cli-proxy-api-google/gemini-3.7-flash-high");
	assert.equal(aliases.get("glm"), "openrouter-glm/z-ai/glm-5.3");
});

test("resolveTarget prefers an explicit provider/model over an alias name", () => {
	const aliases = new Map([["flash", "cli-proxy-api-google/gemini-3.7-flash-high"]]);
	const direct = resolveTarget("cli-proxy-api/gpt-5.6-sol", aliases);
	assert.equal(direct.ok, true);
	if (direct.ok) {
		assert.equal(direct.ref.provider, "cli-proxy-api");
		assert.equal(direct.ref.modelId, "gpt-5.6-sol");
		assert.equal(direct.ref.alias, undefined);
	}
	const aliased = resolveTarget("flash", aliases);
	assert.equal(aliased.ok, true);
	if (aliased.ok) {
		assert.equal(aliased.ref.alias, "flash");
		assert.equal(aliased.ref.provider, "cli-proxy-api-google");
	}
	const unknown = resolveTarget("nope", aliases);
	assert.equal(unknown.ok, false);
});

test("loadAliases rereads after mtime change", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-arcweld-delegate-aliases-"));
	const path = join(dir, "delegate.json");
	try {
		resetAliasCache();
		await writeFile(
			path,
			JSON.stringify({ aliases: { flash: "cli-proxy-api-google/gemini-3.7-flash-high" } }),
		);
		assert.equal(loadAliases(path).get("flash"), "cli-proxy-api-google/gemini-3.7-flash-high");
		await writeFile(path, JSON.stringify({ aliases: { glm: "openrouter-glm/z-ai/glm-5.3" } }));
		// Ensure mtime actually moves on fast filesystems.
		await writeFile(path, JSON.stringify({ aliases: { glm: "openrouter-glm/z-ai/glm-5.3" } }));
		const next = loadAliases(path);
		assert.equal(next.get("flash"), undefined);
		assert.equal(next.get("glm"), "openrouter-glm/z-ai/glm-5.3");
	} finally {
		resetAliasCache();
		await rm(dir, { recursive: true, force: true });
	}
});
