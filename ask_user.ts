/**
 * Ask User Tool
 *
 * Lets the model ask the user one or more multiple-choice questions and
 * block until they answer (or cancel). Each call may carry one or more
 * questions; each question has at least 2 options. The picker is always
 * multi-select and always shows a free-text "Note" input alongside the
 * choices, so the user can add free-form context to whatever they ticked
 * (or use it on its own if none of the choices fit).
 *
 * The result carries the selected option labels plus the typed note
 * (if any). If the user cancelled the picker, the model receives a
 * cancellation marker and stops or picks a sensible default.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short label shown in the picker" }),
	description: Type.Optional(
		Type.String({ description: "One-line explanation shown under the label" }),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	header: Type.Optional(
		Type.String({ description: "Optional short label shown above the question" }),
	),
	options: Type.Array(OptionSchema, {
		description: "Options the user can pick from (at least 2)",
		minItems: 2,
	}),
});

const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "One or more independent questions to ask in sequence",
		minItems: 1,
		maxItems: 4,
	}),
});

type Option = { label: string; description?: string };
type Question = {
	question: string;
	header?: string;
	options: Option[];
};

type AskAnswer = {
	question: string;
	header?: string;
	options: Option[];
	selected: string[];
	comment?: string;
};

// Minimum ctx.ui shape this extension needs. Defined locally so we don't
// have to import the full ExtensionUIContext (and so the helpers stay easy
// to unit-test with a fake ctx). The askTUI shape matches the part of pi-tui's
// TUI we actually call (requestRender) so the types line up with the real one.
type askTUI = { requestRender(force?: boolean): void };
type askTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};
type askKeybindings = unknown;

type AskUI = {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(
		title: string,
		placeholder?: string,
	): Promise<string | undefined>;
	custom<T>(
		factory: (
			tui: askTUI,
			theme: askTheme,
			keybindings: askKeybindings,
			done: (result: T) => void,
		) => Component & { focused?: boolean },
	): Promise<T>;
};

type AskDetails = {
	answers: AskAnswer[];
	cancelled: boolean;
};

// Only shape constraints the picker actually needs: non-empty labels,
// at least 2 options (a choice with 1 option is not a choice), unique
// labels (otherwise select() would return ambiguous matches). Everything
// else — question length, label length, description length — is left to
// the model since the user sees it, not the model.
function validateQuestions(questions: Question[]): string | null {
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		if (!q.question.trim()) {
			return `questions[${i}].question must not be empty`;
		}
		if (q.options.length < 2) {
			return `questions[${i}].options must have at least 2 entries`;
		}
		const seen = new Set<string>();
		for (let j = 0; j < q.options.length; j++) {
			const o = q.options[j];
			if (!o.label.trim()) {
				return `questions[${i}].options[${j}].label must not be empty`;
			}
			if (seen.has(o.label)) {
				return `questions[${i}].options[${j}].label duplicates another option`;
			}
			seen.add(o.label);
		}
	}
	return null;
}

function picksLabel(selected: string[]): string {
	return selected.length === 0 ? "(none)" : selected.join(", ");
}

function printQuestionsForNoUI(questions: Question[]): string {
	const lines: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const prefix = questions.length > 1 ? `(${i + 1}/${questions.length}) ` : "";
		lines.push(`${prefix}${q.question}`);
		if (q.header) lines.push(`Header: ${q.header}`);
		for (const o of q.options) {
			lines.push(`  - ${o.label}${o.description ? ` — ${o.description}` : ""}`);
		}
		lines.push("  - Note (optional free text)");
	}
	return lines.join("\n");
}

// The picker renders the choices as checkboxes plus a text input labelled
// "Note" at the bottom. The input is always part of the same pick —
// there's no separate follow-up input — so the user can add a free-text
// note alongside any ticked choices in one go.
//
// For multi-question calls, each question has its own state (selections +
// note) and the user can move freely between them. ← → from a choice moves
// to the previous/next question (the current note is saved automatically);
// Enter on the last question commits all answers; Esc cancels everything.

type Focus = { kind: "choice"; index: number } | { kind: "input" };

type QuestionState = {
	question: Question;
	checked: boolean[];
	note: string;
};

async function runPicker(
	ctx: { ui: AskUI },
	questions: Question[],
	signal: AbortSignal | undefined,
): Promise<AskAnswer[] | undefined> {
	const states: QuestionState[] = questions.map((q) => ({
		question: q,
		checked: q.options.map(() => false),
		note: "",
	}));

	return ctx.ui.custom<AskAnswer[] | undefined>((tui, theme, _kb, done) => {
		const input = new Input();
		let currentIndex = 0;
		let cursor = 0;
		let focus: Focus = { kind: "choice", index: 0 };

		// Guard against double-done if both Esc and abort signal fire.
		let finished = false;
		const safeDone = (result: AskAnswer[] | undefined) => {
			if (finished) return;
			finished = true;
			if (signal) signal.removeEventListener("abort", onAbort);
			done(result);
		};
		const onAbort = () => safeDone(undefined);
		if (signal) {
			if (signal.aborted) {
				// Defer one tick so the factory returns its component first;
				// done() before the picker mounts would be a no-op.
				queueMicrotask(() => safeDone(undefined));
			} else {
				signal.addEventListener("abort", onAbort);
			}
		}

		function refresh() {
			input.invalidate();
			tui.requestRender();
		}

		function saveCurrentNote() {
			states[currentIndex].note = input.getValue();
		}

		function loadCurrent() {
			input.setValue(states[currentIndex].note);
			input.invalidate();
			cursor = 0;
			focus = { kind: "choice", index: 0 };
		}
		loadCurrent();

		function advance() {
			saveCurrentNote();
			if (currentIndex < states.length - 1) {
				currentIndex++;
				loadCurrent();
				refresh();
			}
		}

		function goBack() {
			saveCurrentNote();
			if (currentIndex > 0) {
				currentIndex--;
				loadCurrent();
				refresh();
			}
		}

		function commitAll() {
			saveCurrentNote();
			const answers: AskAnswer[] = states.map((s) => {
				const picks: string[] = [];
				for (let i = 0; i < s.question.options.length; i++) {
					if (s.checked[i]) picks.push(s.question.options[i].label);
				}
				const trimmed = s.note.trim();
				const ans: AskAnswer = {
					question: s.question.question,
					header: s.question.header,
					options: s.question.options,
					selected: picks,
				};
				if (trimmed) ans.comment = trimmed;
				return ans;
			});
			safeDone(answers);
		}

		function handleChoiceKey(data: string): boolean {
			const opts = states[currentIndex].question.options;
			if (matchesKey(data, Key.left)) {
				goBack();
				return true;
			}
			// Right is navigation only — it never submits. Submitting is
			// always explicit, via Enter, so the user doesn't accidentally
			// commit the whole batch by reaching the last question.
			if (matchesKey(data, Key.right)) {
				if (currentIndex < states.length - 1) advance();
				return true;
			}
			if (matchesKey(data, Key.up)) {
				cursor = Math.max(0, cursor - 1);
				focus = { kind: "choice", index: cursor };
				refresh();
				return true;
			}
			if (matchesKey(data, Key.down)) {
				if (cursor < opts.length - 1) {
					cursor++;
					focus = { kind: "choice", index: cursor };
				} else {
					focus = { kind: "input" };
				}
				refresh();
				return true;
			}
			if (matchesKey(data, Key.tab)) {
				focus = { kind: "input" };
				refresh();
				return true;
			}
			if (matchesKey(data, Key.space)) {
				states[currentIndex].checked[cursor] = !states[currentIndex].checked[cursor];
				refresh();
				return true;
			}
			if (matchesKey(data, Key.enter)) {
				if (currentIndex < states.length - 1) advance();
				else commitAll();
				return true;
			}
			return false;
		}

		function handleInputKey(data: string): boolean {
			if (matchesKey(data, Key.enter)) {
				if (currentIndex < states.length - 1) advance();
				else commitAll();
				return true;
			}
			// Tab/Up move focus back to the choices (preserves typed text).
			if (
				matchesKey(data, Key.tab) ||
				matchesKey(data, Key.up)
			) {
				focus = { kind: "choice", index: cursor };
				refresh();
				return true;
			}
			// Esc cancels from the input too — matches the on-screen hint.
			if (matchesKey(data, Key.escape)) {
				safeDone(undefined);
				return true;
			}
			input.handleInput(data);
			refresh();
			return true;
		}

		function handleInputKeyStroke(data: string) {
			if (focus.kind === "choice") {
				if (!handleChoiceKey(data) && matchesKey(data, Key.escape)) {
					safeDone(undefined);
				}
				return;
			}
			handleInputKey(data);
		}

		function render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			const lines: string[] = [];

			function addWrapped(text: string) {
				lines.push(...wrapTextWithAnsi(text, renderWidth));
			}

			function addWrappedWithPrefix(prefix: string, text: string) {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= renderWidth) {
					addWrapped(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
				}
			}

			const totalQ = states.length;
			const state = states[currentIndex];
			const showProgress = totalQ > 1;

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			if (showProgress) {
				const dots: string[] = [];
				for (let i = 0; i < totalQ; i++) {
					const hasContent =
						states[i].checked.some((c) => c) ||
						states[i].note.trim().length > 0;
					if (i === currentIndex) {
						dots.push(theme.fg("accent", "●"));
					} else if (hasContent) {
						dots.push(theme.fg("success", "✓"));
					} else {
						dots.push(theme.fg("dim", "○"));
					}
				}
				const counter = theme.fg("dim", `(${currentIndex + 1}/${totalQ})`);
				lines.push(` ${dots.join(" ")}  ${counter}`);
			}

			const titleParts: string[] = [];
			if (state.question.header) titleParts.push(theme.fg("accent", `[${state.question.header}]`));
			titleParts.push(theme.fg("text", state.question.question));
			addWrappedWithPrefix(" ", titleParts.join(" "));
			lines.push("");

			for (let i = 0; i < state.question.options.length; i++) {
				const isFocused = focus.kind === "choice" && focus.index === i;
				const marker = isFocused ? theme.fg("accent", "> ") : "  ";
				const isPicked = state.checked[i];
				const box = isPicked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const color = isFocused ? "accent" : isPicked ? "text" : "muted";
				const desc = state.question.options[i].description;
				const descSuffix = desc
					? "  " + theme.fg(isFocused ? "muted" : "dim", desc)
					: "";
				addWrappedWithPrefix(
					"    ",
					theme.fg(color, `${marker}${box} ${state.question.options[i].label}`) + descSuffix,
				);
			}

			lines.push("");
			const inputFocused = focus.kind === "input";
			const inputMarker = inputFocused ? theme.fg("accent", "> ") : "  ";
			const inputLabel = `${inputMarker}Note: `;
			const inputValue = input.getValue();
			let inputLine: string;
			if (inputValue.length > 0) {
				inputLine = theme.fg(inputFocused ? "text" : "muted", inputLabel) +
					theme.fg(inputFocused ? "text" : "muted", inputValue) +
					(inputFocused ? theme.fg("accent", "_") : "");
			} else {
				inputLine = theme.fg(inputFocused ? "accent" : "muted", inputLabel) +
					(inputFocused ? theme.fg("accent", "_") : "");
			}
			addWrappedWithPrefix("    ", inputLine);

			lines.push("");
			const navHint = showProgress ? "← → question • " : "";
			const hint = `${navHint}↑↓ / Tab move • Space toggle • Enter submit • Esc cancel`;
			addWrappedWithPrefix(" ", theme.fg("dim", hint));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			return lines;
		}

		// Focusable: propagate focus state to the embedded Input so it emits
		// CURSOR_MARKER and IME candidate windows get positioned correctly.
		let _focused = false;
		return {
			render,
			invalidate: refresh,
			handleInput: handleInputKeyStroke,
			get focused() {
				return _focused;
			},
			set focused(value: boolean) {
				_focused = value;
				input.focused = value;
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more multiple-choice questions and wait for their answer. Each question needs 2+ options; the user picks one or more and can add a free-text note. With multiple questions, the user can navigate between them and revise answers before submitting.",
		promptSnippet:
			"Ask the user a multiple-choice question.",
		promptGuidelines: [
			"Use ask_user to get a decision or preference from the user before proceeding.",
		],
		parameters: AskUserParams,

		async execute(_toolCallId: string, params: Static<typeof AskUserParams>, signal: AbortSignal | undefined, _onUpdate, ctx) {
			const validationError = validateQuestions(params.questions);
			if (validationError !== null) {
				return {
					content: [{ type: "text", text: `Invalid ask_user call: ${validationError}` }],
					isError: true,
					details: { answers: [], cancelled: false } as AskDetails,
				};
			}

			if (!ctx.hasUI) {
				// Surface the question(s) as text and bail out.
				const questionsText = printQuestionsForNoUI(params.questions);
				return {
					content: [
						{
							type: "text",
							text:
								questionsText + "\n\n" +
								"ask_user requires an interactive UI (TUI or RPC mode). " +
								"The questions were surfaced but no answers could be collected. " +
								"Make a reasonable default choice or ask the user to switch to interactive mode.",
						},
					],
					isError: true,
					details: { answers: [], cancelled: false } as AskDetails,
				};
			}

			const answers = await runPicker(ctx, params.questions, signal);
			if (answers === undefined) {
				return {
					content: [
						{
							type: "text",
							text:
								"User cancelled the question prompt. Stop and ask for guidance " +
								"or pick a sensible default.",
						},
					],
					details: { answers: [], cancelled: true } as AskDetails,
				};
			}

			const summary = answers
				.map((a) => `${a.question} -> ${picksLabel(a.selected)}${a.comment ? ` (comment: ${a.comment})` : ""}`)
				.join("\n");
			return {
				content: [{ type: "text", text: summary }],
				details: { answers, cancelled: false } as AskDetails,
			};
		},

		renderCall(args, theme) {
			const questions = Array.isArray((args as { questions?: unknown }).questions)
				? ((args as { questions: Question[] }).questions)
				: [];
			const n = questions.length;
			const summary = n === 1
				? "1 question"
				: `${n} questions`;
			const line = n === 0
				? theme.fg("toolTitle", theme.bold("ask_user"))
				: `${theme.fg("toolTitle", theme.bold("ask_user"))} ${theme.fg("dim", summary)}`;
			return new Text(line, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			const details = result.details as AskDetails | undefined;
			if (!details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			}
			// isError is on the render context, not on AgentToolResult itself.
			if (context.isError) {
				return new Text(theme.fg("error", `error: ${result.content[0]?.type === "text" ? result.content[0].text : ""}`), 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "cancelled"), 0, 0);
			}
			// Render each answer as a static snapshot of the picker: question,
			// options with picked ones marked, and the note inline. Comment is
			// always shown so users can see what they typed without expanding.
			const blocks: string[] = [];
			for (const a of details.answers) {
				const blockLines: string[] = [];
				if (a.header) {
					blockLines.push(theme.fg("accent", `[${a.header}]`));
				}
				blockLines.push(theme.fg("text", a.question));
				for (const o of a.options) {
					const picked = a.selected.includes(o.label);
					const box = picked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
					const color = picked ? "text" : "muted";
					const descSuffix = o.description
						? "  " + theme.fg("dim", o.description)
						: "";
					blockLines.push(`    ${theme.fg(color, `${box} ${o.label}`)}${descSuffix}`);
				}
				if (a.comment) {
					blockLines.push(
						`    ${theme.fg("dim", "Note: ")}${theme.fg("text", a.comment)}`,
					);
				}
				blocks.push(blockLines.join("\n"));
			}
			return new Text(blocks.join("\n\n"), 0, 0);
		},
	});
}