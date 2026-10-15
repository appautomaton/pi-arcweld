import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import todosExtension from "../index.ts";
import { reconstructFromEntries, RESURFACE_AFTER_QUIET_TURNS } from "../utils.ts";

test("JSON-mode todos remain durable across codemode calls and a fresh session load", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-todos-resume-"));
	const todos = [{ content: "Verify persistence", activeForm: "Verifying persistence", status: "in_progress" as const }];
	const faux = fauxProvider({ provider: "todos-resume-probe", api: "faux:todos-resume-probe" });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("update_todos", { todos }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Recorded."),
		fauxAssistantMessage(fauxToolCall("codemode", { code: "await tools.update_todos({ todos: [] });" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Use the direct todo tool."),
		...Array.from({ length: RESURFACE_AFTER_QUIET_TURNS }, () => fauxAssistantMessage("Continuing.")),
	]);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const open = async (sessionManager: SessionManager): Promise<AgentSession> => {
		const loader = new DefaultResourceLoader({
			cwd: agentDir, agentDir, settingsManager, noExtensions: true,
			extensionFactories: [todosExtension, createCodemodeExtension()],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Test task progress without external services.",
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: agentDir, agentDir, model: faux.getModel(), thinkingLevel: "off",
			modelRuntime, resourceLoader: loader, noTools: "builtin", sessionManager, settingsManager,
		});
		session.setActiveToolsByName(["codemode", "update_todos"]);
		await session.bindExtensions({ mode: "json" });
		return session;
	};
	let session: AgentSession | undefined;
	try {
		session = await open(SessionManager.create(agentDir, agentDir));
		await session.prompt("Record the task.");
		assert.deepEqual(reconstructFromEntries(session.sessionManager.getBranch()), todos);
		await session.prompt("Try to clear the task through a script.");
		const nestedResult = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
		assert.ok(nestedResult?.role === "toolResult" && nestedResult.isError);
		assert.deepEqual(reconstructFromEntries(session.sessionManager.getBranch()), todos);
		const sessionFile = session.sessionManager.getSessionFile();
		assert.ok(sessionFile);
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "resume" });
		session.dispose();
		session = await open(SessionManager.open(sessionFile));
		for (let turn = 0; turn < RESURFACE_AFTER_QUIET_TURNS; turn++) await session.prompt("Continue the recorded task.");
		const reminder = session.messages.find((message) => message.role === "custom" && message.customType === "todos-reminder");
		assert.ok(reminder?.role === "custom");
		assert.match(String(reminder.content), /Verifying persistence/);
		assert.deepEqual(reconstructFromEntries(session.sessionManager.getBranch()), todos);
	} finally {
		await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session?.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});
