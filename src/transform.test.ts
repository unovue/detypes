import { describe, it, expect } from "vitest";
import {
	transform,
	processMagicComments,
	removeMagicComments,
} from "./transform";
import fs from "node:fs";
import path from "node:path";

async function readFile(fileName: string): Promise<string> {
	return fs.promises
		.readFile(path.resolve(__dirname, fileName), "utf8")
		.then((s) => s.replaceAll("\r\n", "\n"));
}

describe("transform function", () => {
	it("transforms TypeScript file", async () => {
		const input = await readFile("../test-files/input.ts");

		const expected = await readFile("../test-files/expected.js");

		const output = await transform(input, "input.ts", {
			removeTsComments: true,
		});

		expect(output).toBe(expected);
	});

	it("transforms Vue file", async () => {
		const input = await readFile("../test-files/input.vue");

		const output = await transform(
			input,
			path.resolve(__dirname, "../test-files/input.vue"),
		);

		expect(output).toMatchFileSnapshot("../test-files/expected/input.vue");
	});

	it("transforms vue with defineProps", async () => {
		const output = await transform(
			`
				<script setup lang="ts">
					const props = defineProps<{ a: string }>()
				</script>
			`,
			"test.vue",
		);

		expect(output).toMatchInlineSnapshot(`
			"<script setup>
			const props = defineProps({
			  a: { type: String, required: true },
			});
			</script>
			"
		`);
	});

	it("processes magic comments", async () => {
		const input = `// @detype: replace\nconsole.log("Hello from TypeScript");\n// @detype: with\n// console.log("Hello from JavaScript");\n// @detype: end\n`;
		const output = processMagicComments(input);
		expect(output.trim()).toBe(`console.log("Hello from JavaScript");`);
	});

	it("removes magic comments", async () => {
		const input = await readFile("../test-files/input.ts");

		const expected = await readFile("../test-files/expected.ts");

		const output = removeMagicComments(input, "input.ts");

		expect(output).toBe(expected);
	});

	it("preserves new lines", async () => {
		const input = (await readFile("../test-files/input.ts")).replaceAll(
			"\n",
			"\r\n",
		);

		const expected = await readFile("../test-files/expected.js");

		const output = await transform(input, "input.ts", {
			removeTsComments: true,
		});

		expect(output).toBe(expected);
	});
});
