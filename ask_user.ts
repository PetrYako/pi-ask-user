/**
 * Ask User Tool
 *
 * Lets the model ask the user one or more questions and block until they
 * answer (or cancel). Each question is either multiple-choice (2+ options,
 * multi-select) or free-text (no options — a pure clarification). Either
 * way the user can also type a free-form note/answer alongside a selection.
 *
 * The result carries the selected option labels (if any) and the typed
 * text (if any). If the user cancelled the picker, the model receives a
 * cancellation marker and stops or picks a sensible default.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short label for the option" }),
	description: Type.Optional(
		Type.String({ description: "One-line explanation of the option" }),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question to ask" }),
	header: Type.Optional(
		Type.String({ description: "Optional short label for the question" }),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description: "Choices for a multiple-choice question (2+). Omit for a free-text answer.",
			minItems: 2,
		}),
	),
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

// The picker talks to the real ExtensionUIContext (so theme colors, the
// custom() factory contract, and requestRender are all compile-checked
// against pi's types). For unit tests, inject any object that satisfies
// { ui: ExtensionUIContext } structurally.

type AskDetails = {
	answers: AskAnswer[];
	cancelled: boolean;
};

// Only shape constraints the picker actually needs: a non-empty question,
// and — when options are given — at least 2 of them with non-empty unique
// labels (one option isn't a choice; duplicate labels would be ambiguous).
// options may be omitted entirely for a free-text question. Everything else
// (lengths, wording) is left to the model since the user sees it, not pi.
function validateQuestions(questions: Question[]): string | null {
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		if (!q.question.trim()) {
			return `questions[${i}].question must not be empty`;
		}
		if (q.options.length === 1) {
			return `questions[${i}].options must have at least 2 entries, or be omitted for a free-text question`;
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
		lines.push(q.options.length > 0 ? "  - Note (optional free text)" : "  (free-text answer)");
	}
	return lines.join("\n");
}

// The picker renders checkboxes for a multiple-choice question, or just a
// text input for a free-text question. The text input is always present
// ("Note" for multiple-choice, "Answer" for free-text) so the user can add
// free-form context in the same step.
//
// For multi-question calls, each question has its own state (selections +
// note) and the user can move freely between them: ← → from a choice, or
// ↑/↓ while answering a free-text question. Enter on the last question
// commits all answers; Esc cancels everything.

// focusTarget tracks whether the highlight is on the choices or the note
// input. The highlighted choice row lives in QuestionState.choiceIndex so it
// persists per question — there's no separate local cursor to keep in sync.
type FocusTarget = "choice" | "input";

type QuestionState = {
	question: Question;
	checked: boolean[];
	note: string;
	choiceIndex: number;
};

async function runPicker(
	ctx: { ui: ExtensionUIContext },
	questions: Question[],
	signal: AbortSignal | undefined,
): Promise<AskAnswer[] | undefined> {
	const states: QuestionState[] = questions.map((q) => ({
		question: q,
		checked: q.options.map(() => false),
		note: "",
		choiceIndex: 0,
	}));

	return ctx.ui.custom<AskAnswer[] | undefined>((tui, theme, _kb, done) => {
		const input = new Input();
		let currentIndex = 0;
		let focusTarget: FocusTarget = "choice";

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
			// Start on the choices when there are any, otherwise the text input
			// (free-text question). choiceIndex is restored from per-question
			// state, so returning to a question keeps the highlight where it was.
			focusTarget = states[currentIndex].question.options.length > 0 ? "choice" : "input";
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
			const state = states[currentIndex];
			const opts = state.question.options;
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
				state.choiceIndex = Math.max(0, state.choiceIndex - 1);
				refresh();
				return true;
			}
			if (matchesKey(data, Key.down)) {
				if (state.choiceIndex < opts.length - 1) {
					state.choiceIndex++;
				} else {
					focusTarget = "input";
				}
				refresh();
				return true;
			}
			if (matchesKey(data, Key.tab)) {
				focusTarget = "input";
				refresh();
				return true;
			}
			if (matchesKey(data, Key.space)) {
				const ci = state.choiceIndex;
				state.checked[ci] = !state.checked[ci];
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
			const hasOptions = states[currentIndex].question.options.length > 0;
			if (matchesKey(data, Key.enter)) {
				if (currentIndex < states.length - 1) advance();
				else commitAll();
				return true;
			}
			// Esc cancels from the input too — matches the on-screen hint.
			if (matchesKey(data, Key.escape)) {
				safeDone(undefined);
				return true;
			}
			if (!hasOptions) {
				// Free-text question (no choices to return to): ↑/↓ navigate
				// between questions. Everything else, including ←/→ for caret
				// movement, goes to the text input.
				if (matchesKey(data, Key.up)) {
					goBack();
					return true;
				}
				if (matchesKey(data, Key.down)) {
					advance();
					return true;
				}
			} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.up)) {
				// Tab/Up move focus back to the choices (preserves typed text and
				// the highlighted choice row).
				focusTarget = "choice";
				refresh();
				return true;
			}
			input.handleInput(data);
			refresh();
			return true;
		}

		function handleInputKeyStroke(data: string) {
			if (focusTarget === "choice") {
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

			if (state.question.options.length > 0) {
				for (let i = 0; i < state.question.options.length; i++) {
					const isFocused = focusTarget === "choice" && state.choiceIndex === i;
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
			}
			const inputFocused = focusTarget === "input";
			const inputMarker = inputFocused ? theme.fg("accent", "> ") : "  ";
			const inputLabel = `${inputMarker}${state.question.options.length > 0 ? "Note" : "Answer"}: `;
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
			// Hint reflects current focus and question type. ←/→ switch questions
			// only from the choices (from the text input they move the caret),
			// so free-text questions use ↑/↓ for navigation instead.
			const hasOptions = state.question.options.length > 0;
			let hint: string;
			if (focusTarget === "input") {
				hint = hasOptions
					? "Tab/↑ back to choices • Enter submit • Esc cancel"
					: showProgress
						? "↑ prev • ↓ next question • Enter submit • Esc cancel"
						: "Enter submit • Esc cancel";
			} else {
				hint = `${showProgress ? "← → question • " : ""}↑↓ / Tab move • Space toggle • Enter submit • Esc cancel`;
			}
			addWrappedWithPrefix(" ", theme.fg("dim", hint));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			return lines;
		}

		// Focusable: propagate focus state to the embedded Input so it emits
		// CURSOR_MARKER and IME candidate windows get positioned correctly.
		let _focused = false;
		// Returned through a typed const so the focused get/set pair is allowed
		// (a fresh object literal returned directly would trip excess-property
		// checks against Component, which has no `focused` property).
		const component: Component & { dispose?: () => void; focused?: boolean } = {
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
		return component;
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question and wait for their answer. Use it to clarify " +
			"intent, get a decision, or confirm a direction you can't safely infer. " +
			"Provide 2+ options for a multiple-choice question, or omit options for a " +
			"free-text answer. Returns the selected options and any written answer, " +
			"or a cancellation marker if the user cancelled.",
		promptSnippet:
			"Ask the user a question (multiple-choice or free-text) and wait for the answer.",
		promptGuidelines: [
			"Use ask_user to clarify ambiguous intent or get a decision before proceeding, rather than guessing.",
			"Don't use ask_user for anything you can determine yourself by reading files or running commands.",
		],
		parameters: AskUserParams,

		async execute(_toolCallId: string, params: Static<typeof AskUserParams>, signal: AbortSignal | undefined, _onUpdate, ctx) {
			// Normalize: options is optional in the schema (omit for a free-text
			// question). Internally we always carry an options array (empty =
			// free-text) so the rest of the code doesn't have to null-check.
			const questions: Question[] = params.questions.map((q) => ({
				question: q.question,
				header: q.header,
				options: q.options ?? [],
			}));
			const validationError = validateQuestions(questions);
			if (validationError !== null) {
				return {
					content: [{ type: "text", text: `Invalid ask_user call: ${validationError}` }],
					isError: true,
					details: { answers: [], cancelled: false } as AskDetails,
				};
			}

			if (!ctx.hasUI) {
				// Surface the question(s) as text. Not an error — the model can
				// still proceed with a sensible default — we just couldn't collect
				// answers without an interactive UI.
				const questionsText = printQuestionsForNoUI(questions);
				return {
					content: [
						{
							type: "text",
							text:
								questionsText + "\n\n" +
								"ask_user requires an interactive UI (TUI or RPC mode); " +
								"no answers could be collected. Proceed with a sensible " +
								"default, or ask the user to re-run in interactive mode.",
						},
					],
					details: { answers: [], cancelled: false } as AskDetails,
				};
			}

			const answers = await runPicker(ctx, questions, signal);
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
				.map((a) =>
					a.options.length === 0
						? `${a.question} -> ${a.comment ?? "(no answer)"}`
						: `${a.question} -> ${picksLabel(a.selected)}${a.comment ? ` (note: ${a.comment})` : ""}`,
				)
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
				if (a.options.length === 0) {
					blockLines.push(
						`    ${theme.fg("dim", "Answer: ")}${theme.fg("text", a.comment ?? "(no answer)")}`,
					);
				} else {
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
				}
				blocks.push(blockLines.join("\n"));
			}
			return new Text(blocks.join("\n\n"), 0, 0);
		},
	});
}