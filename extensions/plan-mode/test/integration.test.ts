import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import planMode from "../index.ts";

test("plan mode blocks nested writes and survives custom-message runs without changing prompt or tools", { timeout: 5000 }, async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-plan-runtime-"));
	const target = join(agentDir, "blocked.txt");
	const requests: TranscriptContext[] = [];
	const faux = fauxProvider({ provider: "plan-runtime", api: "faux:plan-runtime" });
	faux.setResponses([
		(context) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage(fauxToolCall("codemode", {
				code: `await tools.write({ path: ${JSON.stringify(target)}, content: "must be blocked" });`,
			}), { stopReason: "toolUse" });
		},
		(context) => { requests.push(structuredClone(context)); return fauxAssistantMessage("Inspection complete."); },
		(context) => { requests.push(structuredClone(context)); return fauxAssistantMessage("Still in plan mode."); },
	]);
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let api!: ExtensionAPI;
	const starts: string[] = [];
	const loader = new DefaultResourceLoader({
		cwd: agentDir, agentDir, settingsManager: settings, noExtensions: true,
		extensionFactories: [planMode, createCodemodeExtension(), (pi) => {
			api = pi;
			pi.on("before_agent_start", (event) => { starts.push(event.messageType); });
		}],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Stable plan-mode compatibility fixture.",
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: agentDir, agentDir, model: faux.getModel(), modelRuntime: runtime, thinkingLevel: "off",
		resourceLoader: loader, tools: ["read", "write", "codemode"],
		sessionManager: SessionManager.inMemory(agentDir), settingsManager: settings,
	});
	try {
		await session.bindExtensions({ mode: "json" });
		await session.prompt("/plan");
		await session.prompt("Inspect without changing files.");
		assert.equal(existsSync(target), false);
		const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
		assert.ok(result?.role === "toolResult" && result.isError);
		await new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "agent_settled") { unsubscribe(); resolve(); }
			});
			api.sendMessage({ customType: "compatibility-check", content: "Continue inspecting.", display: false }, { triggerTurn: true });
		});
		assert.deepEqual(starts, ["user", "custom"]);
		assert.equal(requests.length, 3);
		for (const request of requests) {
			assert.equal(getCurrentSystemPrompt(request.messages), getCurrentSystemPrompt(requests[0].messages));
			assert.deepEqual(getCurrentTools(request.messages), getCurrentTools(requests[0].messages));
		}
		assert.match(JSON.stringify(requests[2].messages), /PLAN MODE: read-only/);
	} finally {
		session.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});
