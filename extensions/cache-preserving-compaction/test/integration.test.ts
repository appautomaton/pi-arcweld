import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

test("compacts a real Pi session while retaining the complete provider request prefix", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-compaction-transcript-"));
	const requests: TranscriptContext[] = [];
	const reasoning: Array<SimpleStreamOptions["reasoning"]> = [];
	const faux = fauxProvider({
		provider: "compaction-probe", api: "faux:compaction-probe",
		models: [{ id: "reasoning-model", reasoning: true }],
	});
	for (const text of ["first result", "second result", "continuation checkpoint"]) {
		faux.appendResponses([(context, options) => {
			requests.push(structuredClone(context));
			reasoning.push(options?.reasoning);
			return fauxAssistantMessage(text);
		}]);
	}
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(faux.provider.id, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false, keepRecentTokens: 1 },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		settingsManager,
		extensionFactories: [extension],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "STABLE_COMPACTION_SYSTEM",
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: agentDir,
		agentDir,
		model: faux.getModel(),
		thinkingLevel: "high",
		modelRuntime,
		resourceLoader: loader,
		tools: ["read"],
		sessionManager: SessionManager.inMemory(agentDir),
		settingsManager,
	});
	await session.bindExtensions({ mode: "json" });
	try {
		await session.prompt("Complete the first step.");
		await session.prompt("Complete the second step and retain both results.");
		const result = await session.compact();
		assert.equal(requests.length, 3);
		assert.deepEqual(reasoning, ["high", "high", "high"]);
		const native = requests[1];
		const summary = requests[2];
		assert.deepEqual(summary.messages.slice(0, native.messages.length), native.messages);
		assert.equal(summary.messages.filter((message) => message.role === "system").length, 1);
		assert.equal(getCurrentSystemPrompt(summary.messages), getCurrentSystemPrompt(native.messages));
		assert.ok(getCurrentTools(native.messages).some((tool) => tool.name === "read"));
		assert.deepEqual(getCurrentTools(summary.messages), getCurrentTools(native.messages));
		assert.match(getCurrentSystemPrompt(summary.messages), /^STABLE_COMPACTION_SYSTEM/);
		assert.equal(result.summary, "continuation checkpoint");
		assert.ok((result.usage?.cacheRead ?? 0) > 0, "faux provider did not reuse the request prefix");
		assert.ok(session.sessionManager.getEntries().some((entry) => entry.type === "compaction" && entry.fromHook));
	} finally {
		session.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});
