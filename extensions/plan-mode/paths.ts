import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isInside(root: string, target: string): boolean {
	const relativePath = relative(root, target);
	return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && typeof error.code === "string";
}

async function lstatIfExists(path: string) {
	try {
		return await lstat(path);
	} catch (error: unknown) {
		if (isErrnoException(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Returns whether a write or edit target is a canonical, non-symlinked Markdown
 * file under the session's plan-document directory. This is a preflight guard,
 * not a defense against a concurrent local process replacing paths afterward.
 */
export async function isPlanDocumentPath(path: string, cwd: string, configDirName: string): Promise<boolean> {
	try {
		const lexicalPlanRoot = resolve(cwd, configDirName, "plans");
		const lexicalTarget = resolve(cwd, path);
		if (!lexicalTarget.endsWith(".md") || !isInside(lexicalPlanRoot, lexicalTarget)) return false;

		const canonicalCwd = await realpath(cwd);
		const target = resolve(canonicalCwd, relative(cwd, lexicalTarget));
		const planRoot = resolve(canonicalCwd, configDirName, "plans");
		if (!isInside(planRoot, target)) return false;

		const segments = relative(canonicalCwd, target).split(sep);
		let currentPath = canonicalCwd;
		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index];
			if (!segment) return false;

			currentPath = resolve(currentPath, segment);
			const stats = await lstatIfExists(currentPath);
			if (!stats) return true;
			if (stats.isSymbolicLink()) return false;

			const isTarget = index === segments.length - 1;
			if (isTarget) return stats.isFile() && stats.nlink === 1;
			if (!stats.isDirectory()) return false;
		}
	} catch {
		return false;
	}

	return false;
}
